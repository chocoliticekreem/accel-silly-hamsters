// "Busy times" for every business: one row per shop, 24 hourly cells coloured by visits (greyed and hatched where
// it is shut), with its hours today, peak hour and 14-day totals. Sort, filter by type, search; click a row to fly
// there and open its card. Each row's 24 cells are one gradient (no per-cell elements), so hundreds of rows stay cheap.
// The other real businesses (state/businesses, OSM) and map stores without visit data get an hours-only band.
import { Search } from "lucide-react";
import { memo, useMemo, useState, type MouseEvent } from "react";
import type { StoreType } from "../api/contract";
import { heat, hourLabel, summarize } from "../sim/busyTimes";
import { eventsByStore, weekdayIndex, weekGrid } from "../sim/storeState";
import { dayOf, openByHour } from "../sim/time";
import { useWeekdayHours } from "../state/busyData";
import { useMap, useOwnerEvents, useRunStores } from "../state/data";
import { useSim } from "../state/store";
import { useBusinesses, useBusinessList } from "../state/businesses";
import { openAt } from "../sim/openingHours";
import { flyTo } from "../world/flyTo";
import { fmtInt, TYPE_LABEL, WEEKDAYS } from "./format";
import { Icon } from "./icons";
import { TypeIcon } from "./TypeIcon";
import "./busy.css";

const TYPES: StoreType[] = ["cafe", "restaurant", "takeaway", "bar", "shop", "offlicence", "club"];
type SortKey = "name" | "type" | "visits" | "kwh" | "vpk" | "peak";

interface Row {
  id: string;
  name: string;
  type: StoreType;
  simulated: boolean;
  visits: number[];
  open: boolean[];
  hours: string;
  peak: number | null;
  total: number;
  kwh: number;
  vpk: number;
  /** Set for a real business outside the sim (opens its business card). */
  biz?: { x: number; z: number; far: boolean };
}

const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const SORTS: { key: SortKey; label: string; cls: string }[] = [
  { key: "peak", label: "Peak", cls: "c-peak" },
  { key: "visits", label: "Visits", cls: "c-num" },
  { key: "kwh", label: "kWh", cls: "c-num" },
  { key: "vpk", label: "v/kWh", cls: "c-num" },
];

function stripBackground(r: Row, max: number, each: boolean): string {
  const m = each ? Math.max(1e-6, ...r.visits) : max;
  const stops = r.visits.map((v, h) => {
    const c = !r.open[h] ? "transparent" : r.simulated ? heat(Math.sqrt(v / m)) : "rgba(160,172,196,0.5)";
    return `${c} ${(h / 24) * 100}% ${((h + 1) / 24) * 100}%`;
  });
  return `linear-gradient(to right, ${stops.join(",")})`;
}

const BusyRow = memo(function BusyRow({ r, bg, selected }: { r: Row; bg: string; selected: boolean }) {
  const hover = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const h = Math.max(0, Math.min(23, Math.floor(((e.clientX - box.left) / box.width) * 24)));
    e.currentTarget.title = `${r.name} · ${hourLabel(h)} · ${r.open[h] ? "open" : "closed"}${r.simulated ? ` · ${r.visits[h].toFixed(1)} visits` : ""}`;
  };
  const pick = () => {
    if (r.biz) {
      useBusinesses.getState().select(r.id);
      flyTo(r.biz.x, r.biz.z, r.biz.far ? 140 : 70, r.biz.far ? 6 : 3);
    } else useSim.getState().selectStore(r.id);
    // phones: the card and this sheet share the bottom of the screen
    if (window.matchMedia("(max-width: 900px)").matches) useSim.getState().openPanel(null);
  };
  return (
    <div className={`busy-row ${selected ? "sel" : ""} ${r.simulated ? "" : "nosim"}`} role="row" tabIndex={0} onClick={pick} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick())}>
      <span className="c-name" role="cell">
        <TypeIcon type={r.type} />
        <span className="busy-name">{r.name}</span>
      </span>
      <div className="busy-strip" role="cell" style={{ backgroundImage: `${bg}, var(--busy-hatch)` }} onMouseMove={hover} />
      <span className="c-hours mono" role="cell">
        {r.hours}
      </span>
      <span className="c-peak mono" role="cell">
        {r.peak == null ? "—" : String(r.peak).padStart(2, "0")}
      </span>
      {r.simulated ? (
        <>
          <span className="c-num mono" role="cell">{fmtInt(r.total)}</span>
          <span className="c-num mono" role="cell">{fmtInt(r.kwh)}</span>
          <span className="c-num mono" role="cell">{r.vpk.toFixed(2)}</span>
        </>
      ) : (
        <span className="c-nosim" role="cell" />
      )}
    </div>
  );
});

export function BusyPanel() {
  const run = useSim((s) => s.run);
  const day = useSim((s) => dayOf(s.t));
  const hourT = useSim((s) => Math.floor(s.t / 60) * 60);
  const nowFrac = useSim((s) => Math.floor((((s.t % 1440) + 1440) % 1440) / 5) / 288);
  const selStore = useSim((s) => s.selectedStoreId);
  const selBiz = useBusinesses((s) => s.selected);
  const selected = selStore ?? selBiz;
  const map = useMap().data;
  const stores = useRunStores(run).data;
  const owner = useOwnerEvents(run).data;
  const businesses = useBusinessList(map).list;
  const todayW = weekdayIndex(day);
  const [pick, setPick] = useState<number | "avg">("avg");
  const wd = useWeekdayHours(run, pick === "avg" ? null : pick);
  const [types, setTypes] = useState<Set<StoreType>>(new Set());
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "visits", desc: true });
  const [each, setEach] = useState(false);
  const close = () => useSim.getState().openPanel(null);

  const w = pick === "avg" ? todayW : pick;
  const rows = useMemo<Row[]>(() => {
    if (!map) return [];
    const byStore = eventsByStore((owner ?? []).filter((e) => e.t <= hourT));
    const extra: Row[] = businesses.map((b) => {
      const week = b.units[0]?.week;
      const spans = week?.[w] ?? [];
      return {
        id: b.id,
        name: b.name,
        type: b.cat,
        simulated: false,
        visits: new Array<number>(24).fill(0),
        open: Array.from({ length: 24 }, (_, h) => (week ? openAt(week, w, h * 60 + 30) : false)),
        hours: spans.length ? spans.map(([a, z]) => `${hhmm(a)}–${hhmm(z)}`).join(", ") : "closed",
        peak: null,
        total: 0,
        kwh: 0,
        vpk: 0,
        biz: { x: b.x, z: b.z, far: b.osmType === "landmark" },
      };
    });
    const sim = map.stores.map((s): Row => {
      const cfg = stores?.[s.id];
      if (!cfg) {
        const h = s.defaultHours;
        return { id: s.id, name: s.name, type: s.type, simulated: false, visits: new Array(24).fill(0), open: h ? openByHour(h.open, h.close) : new Array(24).fill(false), hours: h ? `${h.open}–${h.close}` : "—", peak: null, total: 0, kwh: 0, vpk: 0 };
      }
      const row = weekGrid(cfg, byStore.get(s.id) ?? [], day)[w];
      const visits = pick === "avg" || !wd.data ? cfg.visitsByHour : (wd.data.get(s.id) ?? new Array<number>(24).fill(0));
      const total = cfg.kpis.visits;
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        simulated: true,
        visits,
        open: row.open,
        hours: row.hours ? `${row.hours.open}–${row.hours.close}` : "closed",
        peak: summarize(visits).peak,
        total,
        kwh: cfg.kpis.kwh,
        vpk: cfg.kpis.kwh > 0 ? total / cfg.kpis.kwh : 0,
      };
    });
    return [...sim, ...extra];
  }, [map, stores, owner, businesses, hourT, day, w, pick, wd.data]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) => (!types.size || types.has(r.type)) && (!needle || r.name.toLowerCase().includes(needle) || TYPE_LABEL[r.type].toLowerCase().includes(needle)));
    const dir = sort.desc ? -1 : 1;
    const val = (r: Row): number | string =>
      sort.key === "name" ? r.name.toLowerCase() : sort.key === "type" ? TYPES.indexOf(r.type) * 1e6 - r.total : sort.key === "visits" ? r.total : sort.key === "kwh" ? r.kwh : sort.key === "vpk" ? r.vpk : (r.peak ?? 99);
    return list.sort((a, b) => {
      // not simulated rows always sink below the simulated ones for numeric sorts
      if (sort.key !== "name" && sort.key !== "type" && a.simulated !== b.simulated) return a.simulated ? -1 : 1;
      const x = val(a);
      const y = val(b);
      // ties: A to Z whatever the direction
      return x < y ? -dir : x > y ? dir : a.name.localeCompare(b.name);
    });
  }, [rows, types, q, sort]);

  const max = useMemo(() => {
    let m = 1e-6;
    for (const r of shown) if (r.simulated) for (const v of r.visits) if (v > m) m = v;
    return m;
  }, [shown]);
  const bgs = useMemo(() => shown.map((r) => stripBackground(r, max, each)), [shown, max, each]);

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" && key !== "type" && key !== "peak" }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.desc ? " ↓" : " ↑") : "");
  const toggleType = (t: StoreType) =>
    setTypes((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  return (
    <aside className="history busy-panel panel" aria-label="Busy times for every business">
      <header className="card-head">
        <div>
          <h2>Busy times</h2>
          <div className="card-sub">
            {rows.length} businesses · run {run} · {pick === "avg" ? "average day" : `${WEEKDAYS[pick]}s`}
          </div>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      <div className="busy-tools">
        <label className="busy-search">
          <Search size={13} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search businesses" aria-label="Search businesses" />
        </label>
        <div className="busy-days compact" role="tablist" aria-label="Day">
          <button role="tab" aria-selected={pick === "avg"} className={pick === "avg" ? "on" : ""} onClick={() => setPick("avg")}>
            Avg
          </button>
          {WEEKDAYS.map((d, i) => (
            <button key={d} role="tab" aria-selected={pick === i} className={`${pick === i ? "on" : ""} ${i === todayW ? "today" : ""}`} onClick={() => setPick(i)}>
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="busy-types">
        {TYPES.map((t) => (
          <button key={t} className={`busy-type ${types.has(t) ? "on" : ""}`} aria-pressed={types.has(t)} onClick={() => toggleType(t)}>
            <TypeIcon type={t} /> {TYPE_LABEL[t]}
          </button>
        ))}
        {types.size > 0 && (
          <button className="busy-type clear" onClick={() => setTypes(new Set())}>
            all
          </button>
        )}
        <button className="busy-type scale" onClick={() => setEach((x) => !x)} title="Colour scale">
          scale: {each ? "per shop" : "all shops"}
        </button>
      </div>

      <div className="busy-table" role="table" style={{ ["--now" as string]: nowFrac }}>
        <div className="busy-row busy-headrow" role="row">
          <span className="c-name" role="columnheader">
            <button onClick={() => sortBy("name")}>Name{arrow("name")}</button>
            <button onClick={() => sortBy("type")}>type{arrow("type")}</button>
          </span>
          <span className="busy-axis" role="columnheader" aria-label="Hours">
            {[0, 6, 12, 18].map((h) => (
              <i key={h} style={{ left: `${(h / 24) * 100}%` }}>
                {String(h).padStart(2, "0")}
              </i>
            ))}
          </span>
          <span className="c-hours" role="columnheader">
            {pick === "avg" || pick === todayW ? "Today" : WEEKDAYS[pick]}
          </span>
          {SORTS.map((s) => (
            <span key={s.key} className={s.cls} role="columnheader">
              <button onClick={() => sortBy(s.key)}>
                {s.label}
                {arrow(s.key)}
              </button>
            </span>
          ))}
        </div>
        {!map || (!stores && rows.every((r) => !r.simulated)) ? (
          <div className="empty">…</div>
        ) : shown.length === 0 ? (
          <div className="empty">No businesses match</div>
        ) : (
          shown.map((r, i) => <BusyRow key={r.id} r={r} bg={bgs[i]} selected={selected === r.id} />)
        )}
      </div>
      <div className="strip-legend busy-legend">
        <span>
          <i className="busy-ramp" /> visits/h (quiet → busy)
        </span>
        <span>
          <i className="sw busy-sw-shut" /> closed
        </span>
        <span>
          <i className="sw busy-sw-now" /> now
        </span>
      </div>
      <div className="foot-note">{pick === "avg" ? "Visits per hour averaged over 14 days" : `Visits per hour on the run's ${WEEKDAYS[pick]}s (2 days)${wd.loading ? " · loading" : ""}`} · totals = 14 days · click a row to fly there</div>
    </aside>
  );
}
