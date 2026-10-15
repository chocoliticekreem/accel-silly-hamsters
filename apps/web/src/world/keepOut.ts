// Keep-out footprints: places where an area module draws its own hero model, so the generic layers (base map
// boxes, real-building bakes) must not draw a box there too. Rings are OSM outlines in contract coords
// (x east, z north, metres from Shoreditch High St station). A building is kept out when its centre falls inside.
// Add a ring here when a module takes over a footprint; generic layers call `keptOut(x, z)`.
import type { Building } from "../api/contract";

export interface KeepOut {
  name: string;
  /** Who draws it instead. */
  owner: string;
  ring: [number, number][];
}

export const KEEP_OUT: KeepOut[] = [
  {
    name: "Christ Church Spitalfields",
    owner: "Spitalfields",
    ring: [[33.5, -448.6], [82.3, -449.6], [82, -470.4], [61.4, -475.1], [50.4, -475.1], [33.5, -471.8], [21.1, -468], [21, -452.7], [33.5, -454.2]],
  },
  {
    name: "Old Spitalfields Market hall",
    owner: "Spitalfields",
    ring: [[-60.5, -444.8], [-28.8, -445.8], [-22.3, -368.4], [-46.5, -367.5], [-95, -365.9], [-102.9, -447.9]],
  },
  {
    name: "Liverpool Street station trainshed",
    owner: "Spitalfields",
    ring: [[-496.5, -392.2], [-401.1, -425], [-433.1, -517.5], [-462.7, -593.8], [-469, -612.6], [-447.6, -619.8], [-454.2, -639.5], [-520.9, -617.5], [-553.1, -614], [-570.4, -619.4], [-554.4, -563.7], [-506.6, -422]],
  },
];

function inRing(x: number, z: number, r: [number, number][]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[i];
    const [bx, bz] = r[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
}

/** Is this contract point inside a hero footprint some module draws itself? */
export function keptOut(x: number, z: number): boolean {
  return KEEP_OUT.some((k) => inRing(x, z, k.ring));
}

/** Convenience for map buildings (stores and clubs are never kept out: they are clickable). */
export const buildingKeptOut = (b: Building) => b.kind !== "store" && b.kind !== "club" && b.kind !== "station" && keptOut(b.x, b.z);
