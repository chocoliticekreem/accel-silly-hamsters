// Owner economics shared by the store page and the mock: what a customer is worth, what a kWh costs.
// Mirrors backend/economics.py in spirit; the backend's numbers win whenever it sends them.
import type { StoreType } from "../api/contract";

/** Average spend per visit (£) by type. */
export const SPEND_GBP: Record<StoreType, number> = { cafe: 6, restaurant: 22, takeaway: 9, bar: 14, shop: 15, offlicence: 8, club: 0 };
/** London small-business electricity price (£/kWh), data/processed/energy.json. */
export const GBP_PER_KWH = 0.32;
/** Share of extra takings an owner keeps (the £/week line is profit, not revenue). */
export const GROSS_MARGIN = 0.3;

/** Profit change per week from extra visits and extra kWh (both per week). */
export const profitPerWeek = (type: StoreType, dVisits: number, dKwh: number) => dVisits * SPEND_GBP[type] * GROSS_MARGIN - dKwh * GBP_PER_KWH;
