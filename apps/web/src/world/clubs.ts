// Notable venues for the nightlife layer: the map's clubs plus real Shoreditch anchors. XOYO (32–37 Cowper St,
// EC2A 4AP, near Old Street) sits west of today's map; when the map doesn't carry it, it is drawn in the surroundings
// at its real position and has no data effects (no sim visits, no incidents). Pure helpers, testable without WebGL.
import type { Building, CityMap, StoreRunResult } from "../api/contract";
import { MINUTES_PER_DAY } from "../api/contract";
import { frontage } from "../sim/geometry";
import { daySpan, storeStateAt, weekdayIndex } from "../sim/storeState";

/** XOYO's real position: contract metres from Shoreditch High St station (x east, z north). */
export const XOYO = { name: "XOYO", x: -640, z: 220, w: 22, d: 34, h: 13 } as const;

/** Store names that make a building a landmark (distinct exterior, interior on click). */
export const LANDMARK_NAMES = /xoyo|boxpark|art'?\s?otel|encode/i;

export interface Venue {
  key: string;
  /** Map store id, or null for a surroundings-only venue (XOYO off the map). */
  storeId: string | null;
  name: string;
  b: Pick<Building, "x" | "z" | "w" | "d" | "h">;
  /** Unit vector (contract) from the building toward its street. */
  nx: number;
  nz: number;
  club: boolean;
}

/** Clubs and landmark stores on the map, plus XOYO in the surroundings when the map doesn't have it. */
export function venues(map: CityMap): Venue[] {
  const out: Venue[] = [];
  for (const s of map.stores) {
    if (s.type !== "club" && !LANDMARK_NAMES.test(s.name)) continue;
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (!b) continue;
    const f = frontage(b, map.streets);
    out.push({ key: s.id, storeId: s.id, name: s.name, b, nx: f.nx, nz: f.nz, club: s.type === "club" });
  }
  if (!map.stores.some((s) => /xoyo/i.test(s.name)))
    // the front faces east, towards Shoreditch (and the default camera)
    out.push({ key: "xoyo", storeId: null, name: XOYO.name, b: XOYO, nx: 1, nz: 0, club: true });
  return out;
}

/** The club night a sim minute belongs to: before noon it is still the previous day's night. */
export const nightOf = (t: number) => {
  const day = Math.floor(t / MINUTES_PER_DAY) + 1;
  return ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY < 12 * 60 ? day - 1 : day;
};

/** Thursday, Friday and Saturday are club nights (docs/OWNER_ACTIONS.md club_night). */
export const isClubNight = (night: number) => {
  const w = weekdayIndex(night);
  return w >= 3 && w <= 5;
};

/** XOYO's own hours (no sim data): Thu–Sat 22:00–04:00. */
export const XOYO_HOURS = { open: "22:00", close: "04:00" };

export interface VenueNight {
  open: boolean;
  /** Absolute sim minute the current/most recent night opens and closes, or null when shut that night. */
  openT: number | null;
  closeT: number | null;
}

/** Is the venue open at t, and when does tonight's session run? */
export function venueNight(v: Venue, result: StoreRunResult | undefined, t: number): VenueNight {
  const night = nightOf(t);
  const start = (night - 1) * MINUTES_PER_DAY;
  if (v.storeId && result) {
    const span = daySpan(result, [], night);
    return { open: storeStateAt(result, [], t).open, openT: span ? start + span.o : null, closeT: span ? start + span.c : null };
  }
  if (v.storeId) return { open: false, openT: null, closeT: null };
  if (!isClubNight(night)) return { open: false, openT: null, closeT: null };
  const openT = start + 22 * 60;
  const closeT = start + 28 * 60;
  return { open: t >= openT && t < closeT, openT, closeT };
}

/**
 * People queueing at the door at t: builds from 45 minutes before opening, peaks around midnight, gone by 02:00.
 * `max` = the night's peak queue.
 */
export function queueLength(n: VenueNight, t: number, max: number): number {
  if (n.openT == null || n.closeT == null) return 0;
  const m = t - n.openT;
  if (m < -45 || t >= n.closeT) return 0;
  const ramp = m < 60 ? (m + 45) / 105 : m < 150 ? 1 : Math.max(0, 1 - (m - 150) / 90);
  return Math.round(max * Math.max(0, Math.min(1, ramp)));
}

/** Bass pulse at ~124 BPM: a sharp kick every beat (0..1), in real seconds. */
export const beat = (seconds: number, bpm = 124) => Math.pow(Math.max(0, Math.cos(((seconds * bpm) / 60) * Math.PI * 2)), 6);

/** A building's local frame (StoreBox convention): +z faces the street; width runs along the facade. */
export interface LocalFrame {
  rot: number;
  width: number;
  depth: number;
  /** Scene position of the centre. */
  x: number;
  z: number;
}

export function localFrame(b: Pick<Building, "x" | "z" | "w" | "d">, nx: number, nz: number): LocalFrame {
  return { rot: Math.atan2(nx, -nz), width: nx !== 0 ? b.d : b.w, depth: nx !== 0 ? b.w : b.d, x: b.x, z: -b.z };
}

/** Local (lx, lz) → scene [x, z]. */
export function toWorld(f: LocalFrame, lx: number, lz: number): [number, number] {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
}
