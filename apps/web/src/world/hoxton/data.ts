// The real Hoxton from OpenStreetMap (public/areas/hoxton.json, written once by tools/areas/fetch-hoxton.mjs).
// Contract coords (x east, z north, metres), same projection as the backend map. © OpenStreetMap contributors (ODbL).

export type P2 = [number, number];

export interface HxBuilding {
  id: number;
  r: P2[];
  /** Height in metres (OSM height=) when tagged. */
  h?: number;
  /** Storeys (OSM building:levels + half the roof levels) when tagged. */
  l?: number;
  building?: string;
  name?: string;
  amenity?: string;
  shop?: string;
  "building:colour"?: string;
  "building:material"?: string;
  "building:min_level"?: string;
  min_height?: string;
}

export interface HxArea {
  id: number;
  r: P2[];
  landuse?: string;
  leisure?: string;
  amenity?: string;
  name?: string;
  parking?: string;
}

export interface HxWay {
  id: number;
  p: P2[];
  highway: string;
  name?: string;
  width?: string;
  cycleway?: string;
  "cycleway:left"?: string;
  "cycleway:right"?: string;
  "cycleway:both"?: string;
  footway?: string;
  oneway?: string;
}

export interface HxBarrier {
  id: number;
  p: P2[];
  barrier: string;
  height?: string;
}

export interface HxPoi {
  p: P2;
  amenity?: string;
  shop?: string;
  name?: string;
  highway?: string;
  leisure?: string;
  crossing?: string;
  crossing_ref?: string;
  capacity?: string;
  tourism?: string;
  bicycle_parking?: string;
  cuisine?: string;
}

export interface HoxtonData {
  source: string;
  buildings: HxBuilding[];
  areas: HxArea[];
  ways: HxWay[];
  barriers: HxBarrier[];
  trees: P2[];
  pois: HxPoi[];
}

let cache: Promise<HoxtonData> | null = null;

export function loadHoxton(): Promise<HoxtonData> {
  if (!cache) {
    cache = fetch(`${import.meta.env.BASE_URL}areas/hoxton.json`).then((r) => {
      if (!r.ok) throw new Error(`hoxton.json ${r.status}`);
      return r.json() as Promise<HoxtonData>;
    });
    cache.catch(() => (cache = null));
  }
  return cache;
}

// ---------- small 2D geometry helpers (contract coords) ----------

export function pip(x: number, z: number, r: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(r: P2[]): P2 {
  let x = 0;
  let z = 0;
  for (const p of r) {
    x += p[0];
    z += p[1];
  }
  return [x / r.length, z / r.length];
}

export function polyArea(r: P2[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

export function bbox(r: P2[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of r) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Closest point on segment ab to p: [x, z, distance, t]. */
export function closestSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): [number, number, number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return [cx, cz, Math.hypot(px - cx, pz - cz), t];
}
