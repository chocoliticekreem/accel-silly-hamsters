// Owner economics shared by the store page and the mock: what a customer is worth, what a kWh and an open hour cost.
// Mirrors backend/economics.py (same spend, margins and wages); the backend's numbers win whenever it sends them.
import type { StoreType } from "../api/contract";

/** Average spend per visit (£) by type. */
export const SPEND_GBP: Record<StoreType, number> = { cafe: 6, restaurant: 22, takeaway: 9, bar: 14, shop: 15, offlicence: 8, club: 0 };
/** London small-business electricity price (£/kWh), data/processed/energy.json. */
export const GBP_PER_KWH = 0.32;
/** Gross margin by type: the share of takings left after the cost of what was sold (wages counted separately). */
export const GROSS_MARGIN: Record<StoreType, number> = { cafe: 0.65, restaurant: 0.65, takeaway: 0.6, bar: 0.6, shop: 0.35, offlicence: 0.25, club: 0 };
/** UK National Living Wage (£/h, 21+, from April 2026) and default staff on shift by type. */
export const WAGE_GBP_PER_HOUR = 12.71;
export const STAFF_ON_SHIFT: Record<StoreType, number> = { cafe: 1, restaurant: 3, takeaway: 2, bar: 2, shop: 1, offlicence: 1, club: 0 };

/** £ one visit leaves after the cost of what was sold. */
export const marginPerVisit = (type: StoreType) => SPEND_GBP[type] * GROSS_MARGIN[type];
/** £ of wages for keeping the doors open one hour. */
export const staffPerOpenHour = (type: StoreType) => STAFF_ON_SHIFT[type] * WAGE_GBP_PER_HOUR;

/** Hours a daily "HH:MM"-"HH:MM" window is open (a close at or before the open wraps past midnight). */
export function windowHours(open: string, close: string): number {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const len = (((m(close) - m(open)) % 1440) + 1440) % 1440;
  return (len || 1440) / 60;
}

/** Profit change per week from extra visits, kWh and open hours (all per week). */
export const profitPerWeek = (type: StoreType, dVisits: number, dKwh: number, dOpenHours = 0) =>
  dVisits * marginPerVisit(type) - dKwh * GBP_PER_KWH - dOpenHours * staffPerOpenHour(type);
