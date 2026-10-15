// The guided demo (docs/BUILD_SPEC.md "Demo plan"): six one-click steps from the analyst's overnight run to the
// area view. Pure helpers only (unit tested); the bar that drives the app lives in ui/DemoBar.tsx.
import type { RunStores } from "../api/contract";
import { MINUTES_PER_DAY } from "../api/contract";
import { openByHour } from "../sim/time";

export const DEMO_STEPS = [
  { key: "analyst", label: "Analyst overnight" },
  { key: "before", label: "Before · the night" },
  { key: "shop", label: "The dark shop" },
  { key: "after", label: "After · same night" },
  { key: "report", label: "Report · Approve" },
  { key: "area", label: "Zoom out" },
] as const;

export type DemoStepKey = (typeof DEMO_STEPS)[number]["key"];

/** Night hours in playback order: 18:00 → 05:00. */
const NIGHT = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5];
/** Day 6 of the run is a Saturday (day 1 = Monday): its small hours are Friday night, its evening Saturday night. */
const DEMO_DAY = 6;

export interface DemoMoment {
  storeId: string;
  /** Sim minute to show: a weekend night hour where the shop was shut in the baseline and open in the best run. */
  t: number;
  /** True when the pick is a shop that now opens later into the night (the pitch's "dark shop"). */
  night: boolean;
}

const at = (hour: number) => (DEMO_DAY - 1) * MINUTES_PER_DAY + hour * 60 + 30;

/**
 * Pick the demo's shop and moment from the baseline and best runs: the shop whose visits grew most among those
 * that now stay open into hours they used to be shut at night; the moment is its busiest newly opened hour.
 * Falls back to the changed shop with the biggest gain at 22:30, else null (nothing changed).
 */
export function pickDemoMoment(base: RunStores, best: RunStores, eligible?: (id: string) => boolean): DemoMoment | null {
  let pick: { id: string; gain: number; hour: number; night: boolean } | null = null;
  for (const id of Object.keys(base).sort()) {
    const a = base[id];
    const b = best[id];
    if (!b || (eligible && !eligible(id))) continue;
    const changed = a.open !== b.open || a.close !== b.close || a.lighting.some((l, h) => l !== b.lighting[h]);
    if (!changed) continue;
    const wasOpen = openByHour(a.open, a.close);
    const nowOpen = openByHour(b.open, b.close);
    const gained = NIGHT.filter((h) => !wasOpen[h] && nowOpen[h]);
    const night = gained.length > 0;
    const hour = night ? gained.reduce((m, h) => ((b.visitsByHour[h] ?? 0) > (b.visitsByHour[m] ?? 0) ? h : m), gained[0]) : 22;
    const gain = b.kpis.visits - a.kpis.visits;
    // a night opener always beats a daytime change; then the bigger visit gain
    if (!pick || (night && !pick.night) || (night === pick.night && gain > pick.gain)) pick = { id, gain, hour, night };
  }
  return pick && { storeId: pick.id, t: at(pick.hour), night: pick.night };
}

/** Baseline and best run for the demo: the analyst's, else the first and the best-scoring finished run. */
export function demoRuns(
  runs: { run: number; status: string; kpis: { visitsPerKwh: number } | null }[],
  analyst?: { baselineRun?: number | null; bestRun: number | null } | null,
): { base: number; best: number } | null {
  const done = runs.filter((r) => r.status === "done" && r.kpis);
  if (!done.length) return null;
  const base = analyst?.baselineRun ?? done[0].run;
  const top = done.reduce((m, r) => (r.kpis!.visitsPerKwh > m.kpis!.visitsPerKwh ? r : m), done[0]).run;
  return { base, best: analyst?.bestRun ?? top };
}
