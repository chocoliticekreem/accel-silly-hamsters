// Click anyone in the 3D city → their life card (docs/PEOPLE_ECONOMY.md "Click anyone, read their life").
// Citizens: persona, home, today's trips, a few plain lines of story. Owners: name, shop, hours worked today,
// business and personal balance with the fortnight's trend. Close with Esc or X.
import { Store, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { api } from "../api/client";
import type { DayData } from "../api/contract";
import type { PersonDay } from "../api/economy";
import { navigate, storePath } from "../router";
import { nearestStreetName } from "../sim/heatmap";
import { dayOf, formatHHMM } from "../sim/time";
import { useMap, useResource } from "../state/data";
import { personOf, useEconomy, useOwners, usePersonStory } from "../state/economy";
import { useSim } from "../state/store";
import { personaColor, STORE_COLORS } from "../world/palette";
import "./economy.css";
import { fmtInt } from "./format";
import { Sparkline } from "./Sparkline";

const money = (n: number) => `${n < 0 ? "−" : ""}£${fmtInt(Math.abs(n))}`;
const STATUS_LABEL = { trading: "trading", cautious: "cautious", bust: "bust" } as const;

export function PersonCard() {
  const personId = useEconomy((s) => s.personId);
  const close = () => useEconomy.getState().selectPerson(null);
  useEffect(() => {
    if (!personId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useEconomy.getState().selectPerson(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [personId]);
  if (!personId) return null;
  return <Card key={personId} personId={personId} onClose={close} />;
}

function Card({ personId, onClose }: { personId: string; onClose: () => void }) {
  const run = useSim((s) => s.run);
  const day = useSim((s) => dayOf(s.t));
  const map = useMap().data;
  const story = usePersonStory(run, personId);
  const owner = useOwners(run).data?.find((o) => o.personId === personId);
  // the same cache key as the 3D agents' day file, so this is free
  const dayData = useResource<DayData>(`day:${run}:${day}`, () => api.day(run, day)).data;
  const trips = useMemo(() => ((dayData?.agents ?? []) as PersonDay[]).filter((a) => personOf(a.id) === personId), [dayData, personId]);
  const s = story.data;
  const storeName = (id: string) => map?.stores.find((x) => x.id === id)?.name ?? id;
  const shop = owner ? map?.stores.find((x) => x.id === owner.storeId) : undefined;
  const persona = s?.persona ?? trips[0]?.persona ?? "";
  const isOwner = !!owner || s?.role === "owner" || persona === "owner";
  const home = s?.home ?? owner?.home ?? null;
  const accent = shop ? STORE_COLORS[shop.type].awning : personaColor(persona);

  const visits = trips.flatMap((a) => a.visits.map((v) => ({ ...v, trip: a.id })));
  const out = trips.length ? { from: Math.min(...trips.map((a) => a.path[0]?.[0] ?? Infinity)), to: Math.max(...trips.map((a) => a.path.at(-1)?.[0] ?? 0)) } : null;

  return (
    <aside className="person-card panel" aria-label="Person" style={{ ["--accent" as string]: accent }}>
      <header className="pc-head">
        <span className="pc-dot" aria-hidden />
        <div className="pc-title">
          <h2>{isOwner ? (owner?.name ?? s?.name ?? "Shop owner") : cap(persona.replace("-", " ")) || "Someone"}</h2>
          <div className="card-sub">
            {isOwner ? `owner · ${shop?.name ?? "their shop"}` : s?.visits.length !== undefined && trips[0]?.returning === false ? "visitor · here once" : "regular"}
            {home && map && <> · lives near {nearestStreetName(map, home.x, home.z)}</>}
            {!home && !isOwner && " · comes in by the station"}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      {owner && (
        <div className="pc-money">
          <div>
            <span className="kpi-label">Business</span>
            <b className={owner.business.daily[day - 1] < 0 ? "bad" : ""}>{money(owner.business.daily[day - 1] ?? owner.business.endGbp)}</b>
            <span className={`pc-status pc-${owner.status}`}>{STATUS_LABEL[owner.status]}</span>
          </div>
          <Sparkline values={[owner.business.startGbp, ...owner.business.daily]} at={day} width={132} />
          <div>
            <span className="kpi-label">Personal</span>
            <b>{money(owner.personal.daily[day - 1] ?? owner.personal.endGbp)}</b>
            <span className="muted mono">{owner.commuteMinutes} min walk</span>
          </div>
        </div>
      )}

      <section className="pc-today">
        <span className="kpi-label">Day {day}</span>
        {!trips.length && <div className="muted">{isOwner ? "Shop shut: stayed home" : "Not out today"}</div>}
        {isOwner && visits.length > 0 && (
          <div className="pc-trip">
            <span className="mono">
              {formatHHMM(visits[0].tIn)}–{formatHHMM(visits[0].tOut)}
            </span>
            <span>
              worked {((visits[0].tOut - visits[0].tIn) / 60).toFixed(1)} h at {storeName(visits[0].storeId)}
            </span>
          </div>
        )}
        {!isOwner &&
          visits.map((v) => (
            <div key={`${v.trip}-${v.tIn}`} className="pc-trip">
              <span className="mono">{formatHHMM(v.tIn)}</span>
              <span>
                {storeName(v.storeId)} <span className="muted">· {Math.max(1, Math.round(v.tOut - v.tIn))} min</span>
              </span>
            </div>
          ))}
        {!isOwner && trips.length > 0 && !visits.length && <div className="muted">Walked through, no stops</div>}
        {out && (
          <div className="pc-trip muted">
            <span className="mono">
              {formatHHMM(out.from)}–{formatHHMM(out.to)}
            </span>
            <span>out and about</span>
          </div>
        )}
      </section>

      <section className="pc-story">
        {story.loading && !s && <div className="muted">Reading their fortnight…</div>}
        {s?.story.map((line, i) => <p key={i}>{line}</p>)}
        {!story.loading && !s && <div className="muted">No story for this person yet</div>}
      </section>

      {owner && (
        <button className="sp-link pc-shop" onClick={() => navigate(storePath(owner.storeId, run))}>
          <Store size={14} /> Open {shop?.name ?? "the shop"}'s page
        </button>
      )}
    </aside>
  );
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
