// Areas that a hand-built area module fills itself from real OSM data, so the generic Infill planner leaves them
// alone (no made-up blocks on top of real gardens, yards and buildings). Contract coords (x east, z north).
// Area modules add their outline here; keep each entry one polygon.
import { OLD_STREET_AREA, OLD_STREET_REPLACED_SPOTS, WHITE_COLLAR_AREA } from "./oldStreetArea";
import { SPITALFIELDS_SITES } from "./spitalfieldsSites";

export interface AreaKeepout {
  name: string;
  /** Closed polygon (first point not repeated). */
  poly: [number, number][];
}

/** Hoxton: north of Old Street between East Rd and Kingsland Rd, plus the Rivington St / Curtain Rd wedge. */
export const HOXTON_AREA: [number, number][] = [
  [-880, 752],
  [-243, 752],
  [-243, 250],
  [-617, 250],
  [-700, 312],
  [-731, 343],
  [-880, 296],
];

/**
 * Bishopsgate Goodsyard (OSM landuse=construction "The Goodsyard", way 387346794) with its north edge taken up to the
 * Shoreditch High Street station box: the fenced site, its hoarding and the Braithwaite Viaduct are drawn by
 * world/modules/ShoreditchStation (world/shoreditch/area.ts, same outline).
 */
export const GOODSYARD_AREA: [number, number][] = [
  [-47.4, -11], [55, -11], [80.2, -28.1], [196.4, -28.9], [194.4, -49.7], [131.7, -63.1], [78.7, -70.4], [29.3, -75.4],
  [-55.3, -82.5], [-62.4, -83.1], [-68.7, -83.6], [-78.5, -83.2], [-101.1, -85.1], [-137.7, -90.9], [-160.1, -95.8],
  [-172.6, -81.8], [-197, -53.1], [-198.1, -50.4], [-199.5, -46.9], [-200.4, -43.4], [-200.9, -40.2], [-200.5, -36],
  [-197.7, -28.4], [-198.4, -25.5], [-196.9, -10.3], [-191.3, 7], [-185.3, 8.9], [-184.7, 10.7], [-183, 9.8],
  [-183.4, 8.3], [-184.1, -11], [-157.5, -11], [-69.9, -11],
];

export const AREA_KEEPOUTS: AreaKeepout[] = [
  { name: "Hoxton", poly: HOXTON_AREA },
  { name: "Goodsyard", poly: GOODSYARD_AREA },
  { name: "Old Street", poly: OLD_STREET_AREA },
  { name: "White Collar Factory", poly: WHITE_COLLAR_AREA },
  ...SPITALFIELDS_SITES,
];

export function inPoly(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Spots (contract) where an area module redraws the map's box itself: Best Mangal (Hoxton), and Old Street's. By
 * position, not building id, because ids are renumbered whenever the map is rebuilt. */
const REPLACED_SPOTS: [number, number][] = [[-625.2, 395.1], ...OLD_STREET_REPLACED_SPOTS];

/** Does an area module redraw this map building itself (the Buildings module skips it)? Never a store's own box. */
export function isReplacedBuilding(b: { kind: string; x: number; z: number; w: number; d: number }): boolean {
  if (b.kind === "store" || b.kind === "club" || b.kind === "station") return false;
  return REPLACED_SPOTS.some(([x, z]) => Math.abs(b.x - x) <= b.w / 2 + 1 && Math.abs(b.z - z) <= b.d / 2 + 1);
}

/** Is (x, z) inside any area module's own patch? */
export const inAreaKeepout = (x: number, z: number) => AREA_KEEPOUTS.some((a) => inPoly(x, z, a.poly));
