// The inner learning loop as numbers: one row per sim day (RunAreaSummary.daily), shops only (clubs are anchors).
// Visits come from that day's file, kWh from the owners' evolving schedule, profit = margin on visits minus energy
// (sim/economics.ts, the same terms as profitPerWeek), ownerActions = owner events decided that day.
import type { DayData, OwnerEvent, RunDay, StoreType } from "../api/contract";
import { GBP_PER_KWH, marginPerVisit } from "../sim/economics";

export interface DailyInput {
  days: DayData[];
  /** storeId → kWh drawn on each day (index 0 = day 1). */
  kwhByDay: Record<string, number[]>;
  types: Record<string, StoreType>;
  ownerEvents: OwnerEvent[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function aggregateDaily({ days, kwhByDay, types, ownerEvents }: DailyInput): RunDay[] {
  const shop = (id: string) => types[id] !== undefined && types[id] !== "club";
  return days.map(({ day, agents }) => {
    let visits = 0;
    let takings = 0;
    for (const a of agents)
      for (const v of a.visits)
        if (shop(v.storeId)) {
          visits += 1;
          takings += marginPerVisit(types[v.storeId]);
        }
    let kwh = 0;
    for (const [id, perDay] of Object.entries(kwhByDay)) if (shop(id)) kwh += perDay[day - 1] ?? 0;
    const ownerActions = ownerEvents.filter((e) => e.day === day && shop(e.storeId)).length;
    return {
      day,
      visits,
      kwh: r1(kwh),
      visitsPerKwh: kwh > 0 ? r2(visits / kwh) : 0,
      profitGbp: r2(takings - kwh * GBP_PER_KWH),
      ownerActions,
    };
  });
}
