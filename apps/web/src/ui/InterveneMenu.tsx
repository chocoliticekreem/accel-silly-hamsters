// "Intervene": fork the same 14 days with one change (docs/PEOPLE_ECONOMY.md §2) and watch both side by side.
// Levers: close the station, roadworks on a street, double the electricity price, a big night at the club, rain.
// POST /api/interventions → poll /api/runs → compare mode (baseline vs the fork) with a delta strip.
import { CloudRain, Construction, FlaskConical, Music, TrainFront, Zap } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CityMap } from "../api/contract";
import { economyApi, type InterventionKind, type InterventionParams } from "../api/economy";
import { dayOf } from "../sim/time";
import { useMap, watchRun } from "../state/data";
import { useEconomy } from "../state/economy";
import { useSim } from "../state/store";
import "./economy.css";

const DAYS = Array.from({ length: 14 }, (_, i) => i + 1);

/** Plain label for a lever, as the compare view shows it. */
export function describeIntervention(map: CityMap | undefined, kind: InterventionKind, p: InterventionParams): string {
  const street = (id: unknown) => map?.streets.find((s) => s.id === id)?.name ?? String(id);
  const club = (id: unknown) => map?.stores.find((s) => s.id === id)?.name ?? "the club";
  switch (kind) {
    case "station_closed":
      return p.day === "all" ? "Station closed all fortnight" : `Station closed on Day ${p.day}`;
    case "roadworks":
      return `Roadworks on ${street(p.streetId)}, Day ${p.fromDay}–${Math.min(14, Number(p.fromDay) + Number(p.days) - 1)}`;
    case "energy_price":
      return `Electricity price ×${p.factor}`;
    case "club_event":
      return `Big event at ${club(p.clubId)}, Day ${p.day}`;
    case "rain":
      return `Rain, Day ${p.fromDay}–${Math.min(14, Number(p.fromDay) + Number(p.days) - 1)}`;
  }
}

export function InterveneMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="intervene-wrap" ref={wrap}>
      <button className={`chip ${open ? "on" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <FlaskConical size={14} /> Intervene
      </button>
      {open && <Levers onDone={() => setOpen(false)} />}
    </div>
  );
}

function Levers({ onDone }: { onDone: () => void }) {
  const map = useMap().data;
  const today = useSim((s) => dayOf(s.t));
  const run = useSim((s) => s.run);
  const streets = map?.streets ?? [];
  const clubs = map?.stores.filter((s) => s.type === "club") ?? [];
  const [kind, setKind] = useState<InterventionKind>("roadworks");
  const [stationDay, setStationDay] = useState<string>(String(today));
  const defaultStreet = streets.find((s) => s.name.includes("Brick"))?.id ?? streets[0]?.id ?? "";
  const [streetId, setStreetId] = useState<string>(defaultStreet);
  const [fromDay, setFromDay] = useState(today);
  const [works, setWorks] = useState(3);
  const [factor, setFactor] = useState(2);
  const [clubId, setClubId] = useState(clubs[0]?.id ?? "");
  const [clubDay, setClubDay] = useState(today);
  const [rainFrom, setRainFrom] = useState(today <= 7 ? 1 : 8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params = (): InterventionParams => {
    switch (kind) {
      case "station_closed":
        return { day: stationDay === "all" ? "all" : Number(stationDay) };
      case "roadworks":
        // the map may have loaded after the menu opened: fall back to the first shopping street
        return { streetId: streetId || defaultStreet, fromDay, days: works };
      case "energy_price":
        return { factor };
      case "club_event":
        return { clubId: clubId || clubs[0]?.id || null, day: clubDay };
      case "rain":
        return { fromDay: rainFrom, days: 7 };
    }
  };

  const go = async () => {
    const p = params();
    const label = describeIntervention(map, kind, p);
    setBusy(true);
    setError(null);
    try {
      const { queuedRun } = await economyApi.intervene({ kind, params: p, baseRun: run });
      useSim.getState().showToast(`Simulating: ${label}`);
      const status = await watchRun(queuedRun, 1500, 400);
      if (status !== "done") throw new Error(status);
      useEconomy.getState().setComparePair({ base: run, other: queuedRun, label });
      useSim.getState().setCompare(true);
      onDone();
    } catch {
      setError("Couldn't run that what-if");
    } finally {
      setBusy(false);
    }
  };

  const daySelect = (value: number, set: (n: number) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => set(Number(e.target.value))}>
      {DAYS.map((d) => (
        <option key={d} value={d}>
          Day {d}
        </option>
      ))}
    </select>
  );

  const lever = (k: InterventionKind, icon: ReactNode, title: string, body: ReactNode) => (
    <label className={`lever ${kind === k ? "on" : ""}`}>
      <input type="radio" name="lever" checked={kind === k} onChange={() => setKind(k)} />
      <span className="lever-icon">{icon}</span>
      <span className="lever-body">
        <b>{title}</b>
        {kind === k && <span className="lever-opts">{body}</span>}
      </span>
    </label>
  );

  return (
    <div className="intervene panel" role="dialog" aria-label="Intervene">
      <header>
        <h2>What if…</h2>
        <span className="card-sub">same seed, same 14 days, one change · from run {run}</span>
      </header>
      {lever(
        "station_closed",
        <TrainFront size={15} />,
        "Close the station",
        <select aria-label="When" value={stationDay} onChange={(e) => setStationDay(e.target.value)}>
          {DAYS.map((d) => (
            <option key={d} value={d}>
              Day {d} only
            </option>
          ))}
          <option value="all">All fortnight</option>
        </select>,
      )}
      {lever(
        "roadworks",
        <Construction size={15} />,
        "Roadworks",
        <>
          <select aria-label="Street" value={streetId || defaultStreet} onChange={(e) => setStreetId(e.target.value)}>
            {streets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {daySelect(fromDay, setFromDay, "From")}
          <select aria-label="For" value={works} onChange={(e) => setWorks(Number(e.target.value))}>
            {[1, 2, 3, 5, 7].map((n) => (
              <option key={n} value={n}>
                {n} day{n > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </>,
      )}
      {lever(
        "energy_price",
        <Zap size={15} />,
        "Electricity price",
        <select aria-label="Price" value={factor} onChange={(e) => setFactor(Number(e.target.value))}>
          {[1.5, 2, 3].map((f) => (
            <option key={f} value={f}>
              ×{f}
            </option>
          ))}
        </select>,
      )}
      {lever(
        "club_event",
        <Music size={15} />,
        "Big night at the club",
        <>
          <select aria-label="Club" value={clubId || clubs[0]?.id || ""} onChange={(e) => setClubId(e.target.value)}>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {daySelect(clubDay, setClubDay, "Night")}
        </>,
      )}
      {lever(
        "rain",
        <CloudRain size={15} />,
        "A rainy week",
        <select aria-label="Week" value={rainFrom} onChange={(e) => setRainFrom(Number(e.target.value))}>
          <option value={1}>Week 1 (Day 1–7)</option>
          <option value={8}>Week 2 (Day 8–14)</option>
        </select>,
      )}
      <footer>
        {error && <span className="bad">{error}</span>}
        <button className="btn btn-lamp" disabled={busy || !map} onClick={go}>
          <FlaskConical size={14} /> {busy ? "Simulating…" : "Run the what-if"}
        </button>
      </footer>
    </div>
  );
}
