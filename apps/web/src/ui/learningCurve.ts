// Shapes RunAreaSummary.daily for the "Days" chart: this run's visits/kWh per day, the baseline run's days as a
// faint reference, owner-action marker sizes, and the one-line caption.
import type { RunDay } from "../api/contract";

export interface DayPoint {
  day: number;
  v: number;
  base?: number;
  actions: number;
}

export function dayCurve(cur: RunDay[], base?: RunDay[] | null): DayPoint[] {
  const byDay = new Map((base ?? []).map((d) => [d.day, d.visitsPerKwh]));
  return [...cur]
    .sort((a, b) => a.day - b.day)
    .map((d) => ({ day: d.day, v: d.visitsPerKwh, base: byDay.get(d.day), actions: d.ownerActions }));
}

/** Marker radius for a day's owner actions: a small dot for none, growing with the square root. */
export const actionRadius = (n: number) => (n <= 0 ? 2.5 : Math.min(9, 3 + 1.6 * Math.sqrt(n)));

/** Mean of the first and last week's visits/kWh (days 1–7 vs 8–14): weekdays cancel out. */
function weekMeans(days: { day: number; v: number }[]) {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return { w1: mean(days.filter((d) => d.day <= 7).map((d) => d.v)), w2: mean(days.filter((d) => d.day > 7).map((d) => d.v)) };
}

export function dayCaption(points: DayPoint[]): string {
  if (!points.length) return "";
  const actions = points.reduce((n, p) => n + p.actions, 0);
  const { w1, w2 } = weekMeans(points);
  const changes = `${actions} owner change${actions === 1 ? "" : "s"}`;
  if (!Number.isFinite(w1) || !Number.isFinite(w2) || w1 <= 0) return `${changes} this run`;
  const d = (w2 - w1) / w1;
  const pct = `${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d * 100))}%`;
  return `${changes} · week 2 vs week 1 ${pct} visits/kWh (owners learning inside the run)`;
}
