// "Popular times" for every business, from the simulation (pure, no React).
// - Average day: StoreRunResult.visitsByHour (arrivals per clock hour, averaged over the 14 days).
// - A weekday / today: counted from the day files (each visit's tIn; the owner behind the counter is not a visit),
//   the same way backend/sim/kpis.py builds visitsByHour.
// - kWh by hour: the store insights' hourly kWh when served, else the backend's energy formula
//   (backend/sim/energy.py with data/processed/energy.json): open share x m2 x open rate + closed share x m2 x
//   standby rate + facade lighting kW.
import type { DayData, LightLevel, StoreType } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";

const pad = (n: number) => String(n).padStart(2, "0");
export const hourLabel = (h: number) => `${pad(((h % 24) + 24) % 24)}:00`;

/** storeId → visit arrival minutes (tIn) that fall on that day, sorted. */
export type DayArrivals = Map<string, number[]>;

/** Arrivals per store on `day` (a day file also carries the previous night's trips; those are dropped). */
export function arrivalsOfDay(data: DayData): DayArrivals {
  const lo = (data.day - 1) * MINUTES_PER_DAY;
  const hi = lo + MINUTES_PER_DAY;
  const out: DayArrivals = new Map();
  for (const a of data.agents) {
    if (a.persona === "owner" || (a as { role?: string }).role === "owner") continue;
    for (const v of a.visits) {
      if (v.tIn < lo || v.tIn >= hi) continue;
      const list = out.get(v.storeId);
      if (list) list.push(v.tIn);
      else out.set(v.storeId, [v.tIn]);
    }
  }
  for (const list of out.values()) list.sort((x, y) => x - y);
  return out;
}

/** 24 counts by clock hour; only arrivals before `until` (sim minute) when given. */
export function hourlyCounts(arrivals: readonly number[] | undefined, until = Infinity): number[] {
  const out = new Array<number>(24).fill(0);
  for (const t of arrivals ?? []) {
    if (t > until) break;
    out[Math.floor((((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60)]++;
  }
  return out;
}

/** The run's days that fall on weekday `w` (0 = Monday; Day 1 is a Monday). */
export const daysOfWeekday = (w: number): number[] => Array.from({ length: DAYS_PER_RUN }, (_, i) => i + 1).filter((d) => (d - 1) % 7 === w);

/** Per-store hourly average over several days' arrivals. Stores absent on a day count as 0 that day. */
export function averageDays(days: readonly DayArrivals[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!days.length) return out;
  for (const d of days)
    for (const [id, list] of d) {
      const acc = out.get(id) ?? new Array<number>(24).fill(0);
      hourlyCounts(list).forEach((n, h) => (acc[h] += n));
      out.set(id, acc);
    }
  for (const acc of out.values()) for (let h = 0; h < 24; h++) acc[h] /= days.length;
  return out;
}

export interface BusySummary {
  /** Index of the busiest hour, or null when nothing happens. */
  peak: number | null;
  /** The busy stretch around the peak, [from, to) in hours. */
  busiest: [number, number] | null;
  /** Hour after which it stays quiet while still open, if any. */
  quietAfter: number | null;
  /** Hour until which it is quiet after opening, if any. */
  quietUntil: number | null;
}

/** Peak, busiest stretch and quiet tails. `open` limits the quiet hints to opening hours. */
export function summarize(visits: readonly number[], open?: readonly boolean[]): BusySummary {
  const max = Math.max(0, ...visits);
  if (max <= 0) return { peak: null, busiest: null, quietAfter: null, quietUntil: null };
  const peak = visits.indexOf(max);
  // grow the stretch while neighbours stay near the peak (at most 3 hours, Popular-Times style)
  let a = peak;
  let b = peak + 1;
  while (b - a < 3) {
    const left = a > 0 ? visits[a - 1] : -1;
    const right = b < 24 ? visits[b] : -1;
    const best = Math.max(left, right);
    if (best < max * 0.8) break;
    if (left >= right) a--;
    else b++;
  }
  const busy = visits.map((v) => v >= max * 0.3);
  const openH = open ?? visits.map(() => true);
  const lastBusy = busy.lastIndexOf(true);
  const firstBusy = busy.indexOf(true);
  const openAfter = openH.some((o, h) => o && h > lastBusy);
  const openBefore = openH.some((o, h) => o && h < firstBusy);
  return {
    peak,
    busiest: [a, b],
    quietAfter: openAfter && lastBusy < 23 ? lastBusy + 1 : null,
    quietUntil: openBefore && firstBusy > 0 ? firstBusy : null,
  };
}

/** "Usually busiest 12:00–14:00 · quiet after 20:00". */
export function captionOf(s: BusySummary, usually = true): string {
  if (s.busiest == null) return "No visits in the simulation";
  const parts = [`${usually ? "Usually busiest" : "Busiest"} ${hourLabel(s.busiest[0])}–${hourLabel(s.busiest[1])}`];
  if (s.quietUntil != null) parts.push(`quiet until ${hourLabel(s.quietUntil)}`);
  if (s.quietAfter != null) parts.push(`quiet after ${hourLabel(s.quietAfter)}`);
  return parts.join(" · ");
}

export type LiveLevel = "busier" | "usual" | "quiet" | "closed";

export const LIVE_TEXT: Record<LiveLevel, string> = {
  busier: "busier than usual",
  usual: "as busy as usual",
  quiet: "not busy",
  closed: "closed now",
};

/**
 * Live busyness: arrivals in the last hour vs the usual for that hour (interpolated between clock hours).
 * `today` = today's arrival minutes; `usual` = 24 per-hour averages; `t` = now (sim minutes).
 */
export function liveLevel(today: readonly number[] | undefined, usual: readonly number[], t: number, open: boolean): { level: LiveLevel; now: number; usual: number } {
  const m = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  const f = (m % 60) / 60;
  const expected = usual[h] * f + usual[(h + 23) % 24] * (1 - f);
  const now = (today ?? []).filter((x) => x > t - 60 && x <= t).length;
  if (!open) return { level: "closed", now, usual: expected };
  let level: LiveLevel;
  if (expected < 0.75) level = now >= 3 ? "busier" : now >= 1 ? "usual" : "quiet";
  else {
    const r = now / expected;
    level = r >= 1.3 ? "busier" : r <= 0.7 ? "quiet" : "usual";
  }
  return { level, now, usual: expected };
}

// ---------- energy (mirrors backend/sim/energy.py + data/processed/energy.json) ----------

export const KWH_PER_M2_OPEN: Record<StoreType, number> = { cafe: 0.03223, restaurant: 0.03385, takeaway: 0.05444, bar: 0.03653, shop: 0.02466, offlicence: 0.04566, club: 0.09506 };
export const KWH_PER_M2_STANDBY: Record<StoreType, number> = { cafe: 0.00645, restaurant: 0.00508, takeaway: 0.01633, bar: 0.00913, shop: 0.00493, offlicence: 0.01826, club: 0.00951 };
export const LIGHTING_KW: Record<LightLevel, number> = { off: 0, low: 0.25, high: 0.6 };

/** kWh in each clock hour of a day with these opening hours and lighting. */
export function kwhByHour(type: StoreType, areaM2: number, open: readonly boolean[], lighting: readonly LightLevel[]): number[] {
  return Array.from({ length: 24 }, (_, h) => {
    const f = open[h] ? 1 : 0;
    return f * areaM2 * KWH_PER_M2_OPEN[type] + (1 - f) * areaM2 * KWH_PER_M2_STANDBY[type] + LIGHTING_KW[lighting[h] ?? "off"];
  });
}

/** Rescale an hourly shape so it sums to `total` (keeps the shape, matches the run's kWh). */
export function scaleTo(xs: readonly number[], total: number): number[] {
  const s = xs.reduce((a, b) => a + b, 0);
  return s > 0 && total > 0 ? xs.map((x) => (x * total) / s) : [...xs];
}

// ---------- heat colour ----------

/** 0..1 → a CSS colour from deep ink-blue through warm lamp yellow (perceptually ordered, dark = quiet). */
export function heat(v: number): string {
  const x = Math.max(0, Math.min(1, v));
  if (x <= 0) return "rgba(255,255,255,0.05)";
  // ink blue (#25345a) → amber (#d9822b) → lamp (#ffc857) → near white (#fff1c9)
  const stops: [number, [number, number, number]][] = [
    [0, [37, 52, 90]],
    [0.45, [217, 130, 43]],
    [0.8, [255, 200, 87]],
    [1, [255, 241, 201]],
  ];
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
  const [a, ca] = stops[i];
  const [b, cb] = stops[i + 1];
  const k = (x - a) / (b - a);
  const c = ca.map((u, j) => Math.round(u + (cb[j] - u) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
