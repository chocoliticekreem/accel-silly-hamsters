// Estimated electricity for a business the sim doesn't model (a real OSM shop, or a landmark like Encode Hub),
// from the same factors the backend uses (data/processed/energy.json): kWh per m² per open hour and per closed
// hour by store type, facade lighting (off / low / high kW), the London carbon intensity by clock hour and the
// flat non-domestic price. Floor area = the unit's share of its OSM footprint (× levels where the whole building
// is the business), clamped like map.json. Hours = its OSM opening_hours, else the type's typical hours.
// Pure: no React, no three.
import energy from "../../../../data/processed/energy.json";
import type { StoreType } from "../api/contract";
import { openAt, parseOpeningHours, weeklyOpenHours, type WeekHours } from "./openingHours";
import { nightLevel } from "./sky";

/** Typical hours per type (the backend's energy.json assumptions), used when OSM has no opening_hours. */
export const TYPICAL_HOURS: Record<StoreType, string> = {
  cafe: "Mo-Su 07:00-18:00",
  restaurant: "Mo-Su 12:00-23:00",
  takeaway: "Mo-Su 11:00-23:00",
  bar: "Mo-Su 16:00-24:00",
  shop: "Mo-Su 10:00-19:00",
  offlicence: "Mo-Su 08:00-23:00",
  club: "Th-Sa 22:00-03:00",
};

/** Same range as backend/pipeline/map_fallback.py FLOOR_AREA_RANGE_M2. */
export const clampArea = (m2: number) => Math.min(600, Math.max(30, m2 || 0));

export interface EnergyUnit {
  name: string;
  /** Energy class: which kWh/m² factors apply. */
  type: StoreType;
  areaM2: number;
  /** Parsed week; null = always closed. */
  week: WeekHours;
  /** True when the hours are the type's typical ones, not the business's own. */
  typicalHours: boolean;
}

export function unitHours(type: StoreType, osm: string): { week: WeekHours; typicalHours: boolean } {
  const own = parseOpeningHours(osm);
  return own ? { week: own, typicalHours: false } : { week: parseOpeningHours(TYPICAL_HOURS[type])!, typicalHours: true };
}

const OPEN = energy.kwhPerM2PerOpenHour as Record<StoreType, number>;
const STANDBY = energy.standbyKwhPerM2PerHour as Record<StoreType, number>;
const LIGHT = energy.lightingKw as Record<"off" | "low" | "high", number>;
const CARBON = energy.carbonGPerKwh as number[];
const PRICE = energy.priceGbpPerKwh as number[];

/** kWh in clock hour `h` of weekday `wd` (open = most of the hour; facade lights low by day, high after dark). */
export function unitKwh(u: EnergyUnit, wd: number, h: number): number {
  const open = openAt(u.week, wd, h * 60 + 30);
  const base = u.areaM2 * (open ? OPEN[u.type] : STANDBY[u.type]);
  const light = open ? (nightLevel(h + 0.5) > 0.3 ? LIGHT.high : LIGHT.low) : 0;
  return base + light;
}

export interface EnergyEstimate {
  /** kWh per clock hour on the given weekday (all units). */
  hourly: number[];
  dayKwh: number;
  weekKwh: number;
  weekCostGbp: number;
  weekCo2Kg: number;
  /** Open hours a week (the longest-open unit). */
  openHoursWeek: number;
  areaM2: number;
}

export function estimate(units: EnergyUnit[], wd: number): EnergyEstimate {
  const hourly = Array.from({ length: 24 }, (_, h) => units.reduce((s, u) => s + unitKwh(u, wd, h), 0));
  let weekKwh = 0;
  let weekCostGbp = 0;
  let co2g = 0;
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) {
      const k = units.reduce((s, u) => s + unitKwh(u, d, h), 0);
      weekKwh += k;
      weekCostGbp += k * PRICE[h];
      co2g += k * CARBON[h];
    }
  return {
    hourly,
    dayKwh: hourly.reduce((a, b) => a + b, 0),
    weekKwh,
    weekCostGbp,
    weekCo2Kg: co2g / 1000,
    openHoursWeek: Math.max(0, ...units.map((u) => weeklyOpenHours(u.week))),
    areaM2: units.reduce((s, u) => s + u.areaM2, 0),
  };
}
