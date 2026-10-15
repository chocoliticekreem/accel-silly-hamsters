// Click anyone in the 3D city → their life card. Two paths:
// - owners (docs/PEOPLE_ECONOMY.md): name, shop, hours worked today, business and personal balance with the
//   fortnight's trend, and their story from /people/{id};
// - citizens (docs/CITIZENS.md): profile, routine, today's diary and memory lines from /citizens/{id}/diary
//   (falls back to /people/{id} and the day file when a backend has no diaries). Always "Simulated, not a real person."
// With nobody picked, a small "Featured people" list jumps to someone worth following. Close with Esc or X.
import { ChevronDown, ChevronRight, Clock3, Store, Users, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { DayData } from "../api/contract";
import type { DiaryEntry, PersonDay } from "../api/economy";
import { navigate, storePath } from "../router";
import { nearestStreetName } from "../sim/heatmap";
import { dayOf, formatHHMM } from "../sim/time";
import { useMap, useResource } from "../state/data";
import { personOf, useCitizens, useDiary, useEconomy, useOwners, usePersonStory } from "../state/economy";
import { useSim } from "../state/store";
import { personaColor, STORE_COLORS } from "../world/palette";
import "./economy.css";
import { fmtInt } from "./format";
import { Sparkline } from "./Sparkline";

const money = (n: number) => `${n < 0 ? "−" : ""}£${fmtInt(Math.abs(n))}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function PersonCard() {
  const personId = useEconomy((s) => s.personId);
  const compare = useSim((s) => s.compare);
  useEffect(() => {
    if (!personId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useEconomy.getState().selectPerson(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [personId]);
  if (compare) return null;
  if (!personId) return <FeaturedPeople />;
  return <PersonPanel key={personId} personId={personId} />;
}

function PersonPanel({ personId }: { personId: string }) {
  const run = useSim((s) => s.run);
  const owners = useOwners(run);
  const owner = owners.data?.find((o) => o.personId === personId);
  const isOwner = !!owner || (!owners.data && /^o\d/.test(personId));
  return isOwner ? <OwnerCard personId={personId} /> : <CitizenCardView personId={personId} />;
}

/** Today's trips for a person, straight from the day file the 3D agents already loaded. */
function useTodayTrips(personId: string) {
  const run = useSim((s) => s.run);
  const day = useSim((s) => dayOf(s.t));
  const dayData = useResource<DayData>(`day:${run}:${day}`, () => api.day(run, day)).data;
  return useMemo(() => ((dayData?.agents ?? []) as PersonDay[]).filter((a) => personOf(a.id) === personId), [dayData, personId]);
}

function Head({ title, sub, accent }: { title: string; sub: ReactNode; accent: string }) {
  return (
    <header className="pc-head" style={{ ["--accent" as string]: accent }}>
      <span className="pc-dot" aria-hidden />
      <div className="pc-title">
        <h2>{title}</h2>
        <div className="card-sub">{sub}</div>
      </div>
      <button className="icon-btn" onClick={() => useEconomy.getState().selectPerson(null)} aria-label="Close">
        <X size={16} />
      </button>
    </header>
  );
}

function OwnerCard({ personId }: { personId: string }) {
  const run = useSim((s) => s.run);
  const day = useSim((s) => dayOf(s.t));
  const map = useMap().data;
  const owner = useOwners(run).data?.find((o) => o.personId === personId);
  const story = usePersonStory(run, personId);
  const trips = useTodayTrips(personId);
  const shop = owner ? map?.stores.find((x) => x.id === owner.storeId) : undefined;
  const v = trips.flatMap((a) => a.visits)[0];
  const accent = shop ? STORE_COLORS[shop.type].awning : "#ffc857";
  return (
    <aside className="person-card panel" aria-label="Shop owner" style={{ ["--accent" as string]: accent }}>
      <Head
        title={owner?.name ?? story.data?.name ?? "Shop owner"}
        accent={accent}
        sub={
          <>
            owner · {shop?.name ?? "their shop"}
            {owner && map && <> · lives near {nearestStreetName(map, owner.home.x, owner.home.z)}</>}
          </>
        }
      />
      {owner && (
        <div className="pc-money">
          <div>
            <span className="kpi-label">Business</span>
            <b className={(owner.business.daily[day - 1] ?? 0) < 0 ? "bad" : ""}>{money(owner.business.daily[day - 1] ?? owner.business.endGbp)}</b>
            <span className={`pc-status pc-${owner.status}`}>{owner.status}</span>
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
        {v ? (
          <div className="pc-trip">
            <span className="mono">
              {formatHHMM(v.tIn)}–{formatHHMM(v.tOut)}
            </span>
            <span>worked {((v.tOut - v.tIn) / 60).toFixed(1)} h</span>
          </div>
        ) : (
          <div className="muted">Shop shut today: stayed home</div>
        )}
      </section>
      <section className="pc-story">
        {story.loading && !story.data && <div className="muted">Reading their fortnight…</div>}
        {story.data?.story.map((line, i) => <p key={i}>{line}</p>)}
      </section>
      {owner && (
        <button className="sp-link pc-shop" onClick={() => navigate(storePath(owner.storeId, run))}>
          <Store size={14} /> Open {shop?.name ?? "the shop"}'s page
        </button>
      )}
    </aside>
  );
}

function entryText(e: DiaryEntry): string {
  switch (e.kind) {
    case "arrive":
      return e.note?.startsWith("left") ? `left ${e.place ?? "home"}` : `arrived via ${e.place ?? "the area's edge"}`;
    case "visit":
      return `${e.purpose ? `${e.purpose} at ` : ""}${e.storeName ?? e.storeId} · ${Math.max(1, Math.round((e.tOut ?? e.t) - e.t))} min${e.note && e.note !== "first visit" ? ` · ${e.note}` : ""}`;
    case "found_shut":
      return `${e.storeName ?? e.storeId} was shut${e.note ? `, ${e.note}` : ""}`;
    case "seen_shut":
      return `saw ${e.storeName ?? e.storeId} was shut`;
    case "noticed_open":
      return `noticed ${e.storeName ?? e.storeId} open`;
    case "skip":
      return e.note ?? "skipped a stop";
    case "enter":
      return `into ${e.place ?? e.storeName ?? "the area"}`;
    case "leave":
      return e.place?.startsWith("home") ? "home" : e.place?.startsWith("work") ? `at ${e.place}` : `left via ${e.place ?? "the edge"}`;
  }
}

function CitizenCardView({ personId }: { personId: string }) {
  const run = useSim((s) => s.run);
  const t = useSim((s) => Math.floor(s.t / 5) * 5); // 5-minute steps: enough for "now" and cheap at 100x
  const day = dayOf(t);
  const map = useMap().data;
  const diary = useDiary(run, personId);
  const d = diary.data;
  // no diary from this backend: the plain /people story and the day file
  const story = usePersonStory(run, !diary.loading && !d ? personId : null);
  const trips = useTodayTrips(personId);
  const c = d?.citizen;
  const persona = c?.persona ?? trips[0]?.persona ?? story.data?.persona ?? "";
  const today = d?.days.find((x) => x.day === day);
  const next = d?.days.flatMap((x) => x.entries).find((e) => e.kind === "arrive" && e.t > t);
  const home = story.data?.home;
  const sub = c ? (
    <>
      {c.home !== "outside the area" ? `lives near ${c.home}` : c.arrivesVia ? `comes in via ${c.arrivesVia}` : "from outside the area"}
      {c.work && <> · works on {c.work}</>}
      {c.returning ? "" : " · here once"}
    </>
  ) : (
    <>{home && map ? `lives near ${nearestStreetName(map, home.x, home.z)}` : trips[0]?.returning === false ? "visitor · here once" : "regular"}</>
  );
  return (
    <aside className="person-card panel" aria-label="Citizen" style={{ ["--accent" as string]: personaColor(persona) }}>
      <Head title={c?.label ?? (cap(persona.replace("-", " ")) || "Someone")} sub={sub} accent={personaColor(persona)} />
      {c && (
        <div className="pc-facts">
          <span className="tag">{c.occupation}</span>
          <span className="tag">budget {c.budget}</span>
          <span className="tag" title="How strongly habit pulls them back to the same places">loyal {Math.round(c.loyalty * 100)}%</span>
        </div>
      )}
      {c && c.routine.length > 0 && (
        <section className="pc-routine">
          <span className="kpi-label">Routine</span>
          {c.routine.map((r) => (
            <span key={r} className="pc-chip">
              {r}
            </span>
          ))}
        </section>
      )}
      <section className="pc-today">
        <span className="kpi-label">Day {day}</span>
        {today ? (
          today.entries.map((e, i) => (
            <div key={i} className={`pc-trip pc-${e.kind} ${t >= e.t && t < (e.tOut ?? e.t + 1) ? "now" : ""}`}>
              <span className="mono">{formatHHMM(e.t)}</span>
              <span>{entryText(e)}</span>
            </div>
          ))
        ) : d ? (
          <div className="muted">Not out today</div>
        ) : (
          <TripsFallback trips={trips} />
        )}
        {next && next.t - t > 60 && (
          <button className="sp-link" onClick={() => useSim.getState().setT(next.t - 2)}>
            <Clock3 size={13} /> Next out: Day {dayOf(next.t)} · {formatHHMM(next.t)}
          </button>
        )}
      </section>
      {d && d.memory.length > 0 && (
        <section className="pc-story">
          <span className="kpi-label">Remembers</span>
          {d.memory.map((m) => (
            <p key={m}>{cap(m)}</p>
          ))}
        </section>
      )}
      {!d && story.data && (
        <section className="pc-story">
          {story.data.story.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </section>
      )}
      {diary.loading && !d && <div className="muted pc-story">Reading their diary…</div>}
    </aside>
  );
}

function TripsFallback({ trips }: { trips: PersonDay[] }) {
  const map = useMap().data;
  const name = (id: string) => map?.stores.find((s) => s.id === id)?.name ?? id;
  const visits = trips.flatMap((a) => a.visits);
  if (!trips.length) return <div className="muted">Not out today</div>;
  if (!visits.length) return <div className="muted">Walked through, no stops</div>;
  return (
    <>
      {visits.map((v) => (
        <div key={`${v.storeId}-${v.tIn}`} className="pc-trip">
          <span className="mono">{formatHHMM(v.tIn)}</span>
          <span>
            {name(v.storeId)} · {Math.max(1, Math.round(v.tOut - v.tIn))} min
          </span>
        </div>
      ))}
    </>
  );
}

/** A handful of regulars worth following (docs/CITIZENS.md §6), collapsed into one chip until opened. */
function FeaturedPeople() {
  const run = useSim((s) => s.run);
  const [open, setOpen] = useState(false);
  const idx = useCitizens(open ? run : null).data;
  return (
    <section className={`featured ${open ? "panel open" : ""}`} aria-label="Featured people">
      <button className="chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Users size={14} /> People to follow {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="featured-list">
          {!idx && <div className="muted">Loading…</div>}
          {idx?.featured.map((c) => (
            <button key={c.id} className="featured-item" style={{ ["--accent" as string]: personaColor(c.persona) }} onClick={() => useEconomy.getState().selectPerson(c.id)} title={c.story}>
              <span className="pc-dot" aria-hidden />
              <span className="featured-text">
                <b>{c.label}</b>
                <span>{c.headline}</span>
              </span>
              <span className="mono muted">{c.visits}</span>
            </button>
          ))}
          {idx && <div className="pc-note">{idx.note} Or click anyone in the street.</div>}
        </div>
      )}
    </section>
  );
}
