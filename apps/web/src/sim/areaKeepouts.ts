// Areas that a hand-built area module fills itself from real OSM data, so the generic Infill planner leaves them
// alone (no made-up blocks on top of real gardens, yards and buildings). Contract coords (x east, z north).
// Area modules add their outline here; keep each entry one polygon.
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

export const AREA_KEEPOUTS: AreaKeepout[] = [{ name: "Hoxton", poly: HOXTON_AREA }, ...SPITALFIELDS_SITES];

export function inPoly(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Map buildings an area module redraws itself (the Buildings module skips them). b579: Best Mangal, Hoxton. */
export const REPLACED_BUILDINGS: ReadonlySet<string> = new Set(["b579"]);

/** Is (x, z) inside any area module's own patch? */
export const inAreaKeepout = (x: number, z: number) => AREA_KEEPOUTS.some((a) => inPoly(x, z, a.poly));
