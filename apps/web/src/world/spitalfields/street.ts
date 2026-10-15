// Street-level planning for the Spitalfields module (pure, contract coords x east / z north):
// kerbs along the map's carriageways, Brick Lane's narrow pavements, zebra crossings at OSM crossing nodes,
// and a ray-cast to find the building face a sign or mural should sit on.
import type { Building, CityMap, Street } from "../../api/contract";
import { closestOnStreet } from "../../sim/geometry";
import { MARKING_LIFT, ROAD_TOP, roadClass } from "../../sim/roadLayers";
import { buildingKeptOut, keptOut } from "../keepOut";

/** The area this module dresses (contract coords). */
export const AREA = { minX: -620, maxX: 700, minZ: -750, maxZ: -55 };
export const inArea = (x: number, z: number, pad = 0) => x >= AREA.minX - pad && x <= AREA.maxX + pad && z >= AREA.minZ - pad && z <= AREA.maxZ + pad;

export interface Strip {
  /** Centre, contract coords. */
  x: number;
  z: number;
  len: number;
  /** Unit direction along the strip. */
  dx: number;
  dz: number;
}

// --- spatial grid over the map's street segments and buildings (the planners ask "what's here?" a lot) -------
const CELL = 16;
interface Seg {
  s: Street;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}
interface Index {
  segs: Map<number, Seg[]>;
  blds: Map<number, Building[]>;
}
const key = (cx: number, cz: number) => cx * 100003 + cz;
const indexes = new WeakMap<CityMap, Index>();
function put<T>(m: Map<number, T[]>, x0: number, z0: number, x1: number, z1: number, v: T) {
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
      const k = key(cx, cz);
      const l = m.get(k);
      if (l) l.push(v);
      else m.set(k, [v]);
    }
}
function index(map: CityMap): Index {
  let ix = indexes.get(map);
  if (ix) return ix;
  ix = { segs: new Map(), blds: new Map() };
  for (const s of map.streets) {
    const pad = s.width / 2 + 3;
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      put(ix.segs, Math.min(ax, bx) - pad, Math.min(az, bz) - pad, Math.max(ax, bx) + pad, Math.max(az, bz) + pad, { s, ax, az, bx, bz });
    }
  }
  for (const b of map.buildings) put(ix.blds, b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, b);
  indexes.set(map, ix);
  return ix;
}

/** Map buildings whose footprint may touch the cell of (x, z). */
export function buildingsNear(map: CityMap, x: number, z: number): Building[] {
  return index(map).blds.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
}

/** Is (x, z) on any street's carriageway other than `self` (plus a margin, at most 3 m)? */
export function onOtherRoad(map: CityMap, x: number, z: number, self: Street | null, pad = 0.4) {
  const segs = index(map).segs.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!segs) return false;
  for (const g of segs) {
    if (g.s === self) continue;
    const dx = g.bx - g.ax;
    const dz = g.bz - g.az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - g.ax) * dx + (z - g.az) * dz) / l2));
    if (Math.hypot(x - g.ax - dx * t, z - g.az - dz * t) < g.s.width / 2 + pad) return true;
  }
  return false;
}

/**
 * Kerb lines: both edges of every street segment in the area, cut where another carriageway crosses (junction
 * mouths stay open) and merged into runs. `inset` moves the line toward the centre (Brick Lane's pavements).
 */
export function kerbRuns(map: CityMap, streets: Street[], inset: (s: Street) => number, step = 1.5): Strip[] {
  const out: Strip[] = [];
  for (const s of streets) {
    const off = s.width / 2 - inset(s);
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.5) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      for (const side of [-1, 1]) {
        const nx = uz * side;
        const nz = -ux * side;
        let run: number | null = null;
        const flush = (end: number) => {
          if (run === null) return;
          const l = end - run;
          if (l > 0.8) {
            const m = (run + end) / 2;
            out.push({ x: ax + ux * m + nx * off, z: az + uz * m + nz * off, len: l, dx: ux, dz: uz });
          }
          run = null;
        };
        for (let d = 0; d < len; d += step) {
          const e = Math.min(len, d + step);
          const m = (d + e) / 2;
          const px = ax + ux * m + nx * (off + 0.2);
          const pz = az + uz * m + nz * (off + 0.2);
          const ok = inArea(px, pz) && !onOtherRoad(map, px, pz, s, 0.2);
          if (ok && run === null) run = d;
          if (!ok) flush(d);
        }
        flush(len);
      }
    }
  }
  return out;
}

export interface Crossing {
  x: number;
  z: number;
  /** Unit direction along the road (stripes run this way). */
  dx: number;
  dz: number;
  width: number;
  top: number;
}

/** Zebra crossings at OSM crossing nodes that lie on one of the map's carriageways. */
export function crossings(map: CityMap, pts: [number, number][]): Crossing[] {
  const out: Crossing[] = [];
  for (const [x, z] of pts) {
    if (!inArea(x, z)) continue;
    let best: { s: Street; d: number; i: number } | null = null;
    for (const s of map.streets) {
      for (let i = 0; i < s.points.length - 1; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
        if (d < s.width / 2 && (!best || d < best.d)) best = { s, d, i };
      }
    }
    if (!best || best.s.width < 6) continue;
    const [ax, az] = best.s.points[best.i];
    const [bx, bz] = best.s.points[best.i + 1];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    const c = closestOnStreet(best.s, x, z);
    // skip if it sits in a junction (another road crosses here)
    if (onOtherRoad(map, c[0], c[1], best.s, 1)) continue;
    if (out.some((o) => Math.hypot(o.x - c[0], o.z - c[1]) < 9)) continue;
    out.push({ x: c[0], z: c[1], dx: (bx - ax) / l, dz: (bz - az) / l, width: best.s.width, top: ROAD_TOP[roadClass(best.s.width)] + MARKING_LIFT });
  }
  return out;
}

export interface Face {
  /** Hit point on the facade (contract). */
  x: number;
  z: number;
  /** Outward facade normal (toward the street). */
  nx: number;
  nz: number;
  /** Half-length of the face either side of the hit (how wide a sign may be). */
  room: number;
  /** Building height and an id (to space signs out per building). */
  h: number;
  id: string;
}

/** Something to cast facade rays against: the base map's boxes or the real OSM footprints. */
export type FacadeCaster = (x: number, z: number, dx: number, dz: number, max?: number) => Face | null;

/**
 * Facade caster over the real city's OSM footprints (scene-frame rings, see world/realcity/data.ts): ray against
 * every outer-ring edge of the buildings near the area, via a grid. Kept-out hero footprints are skipped.
 */
export function realCaster(buildings: { id: string; rings: [number, number][][]; h: number; part: boolean; cx: number; cz: number }[]): FacadeCaster {
  interface Edge {
    ax: number;
    az: number;
    bx: number;
    bz: number;
    h: number;
    id: string;
  }
  const grid = new Map<number, Edge[]>();
  for (const b of buildings) {
    const cx = b.cx;
    const cz = -b.cz;
    if (!inArea(cx, cz, 60) || keptOut(cx, cz)) continue;
    const ring = b.rings[0];
    for (let i = 0; i < ring.length; i++) {
      const [ax, sz0] = ring[i];
      const [bx, sz1] = ring[(i + 1) % ring.length];
      const e = { ax, az: -sz0, bx, bz: -sz1, h: b.h, id: b.id };
      put(grid, Math.min(e.ax, e.bx), Math.min(e.az, e.bz), Math.max(e.ax, e.bx), Math.max(e.az, e.bz), e);
    }
  }
  return (x, z, dx, dz, max = 18) => {
    const seen = new Set<Edge>();
    let best: Face | null = null;
    let bestT = max;
    for (let t = 0; t <= max + CELL / 2; t += CELL / 4) {
      const l = grid.get(key(Math.floor((x + dx * t) / CELL), Math.floor((z + dz * t) / CELL)));
      if (!l) continue;
      for (const e of l) {
        if (seen.has(e)) continue;
        seen.add(e);
        const ex = e.bx - e.ax;
        const ez = e.bz - e.az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const tt = ((e.ax - x) * ez - (e.az - z) * ex) / den;
        const u = ((e.ax - x) * dz - (e.az - z) * dx) / den;
        if (u < 0 || u > 1 || tt < 0.5 || tt >= bestT) continue;
        const len = Math.hypot(ex, ez) || 1;
        // edge normal, flipped to face the ray's origin
        let nx = -ez / len;
        let nz = ex / len;
        if (nx * dx + nz * dz > 0) {
          nx = -nx;
          nz = -nz;
        }
        bestT = tt;
        best = { x: x + dx * tt, z: z + dz * tt, nx, nz, room: Math.min(u, 1 - u) * len, h: e.h, id: e.id };
      }
    }
    return best;
  };
}

/** Facade caster over the base map's boxes. */
export const boxCaster = (map: CityMap): FacadeCaster => (x, z, dx, dz, max) => castToFacade(map, x, z, dx, dz, max);

/** Casts from (x, z) along (dx, dz) and returns the first base-building face it meets within `max` metres. */
export function castToFacade(map: CityMap, x: number, z: number, dx: number, dz: number, max = 18): Face | null {
  let best: Face | null = null;
  let bestT = max;
  const cand = new Set<Building>();
  for (let t = 0; t <= max + CELL / 2; t += CELL / 2) for (const b of buildingsNear(map, x + dx * t, z + dz * t)) if (!buildingKeptOut(b)) cand.add(b);
  for (const b of cand) {
    const x0 = b.x - b.w / 2;
    const x1 = b.x + b.w / 2;
    const z0 = b.z - b.d / 2;
    const z1 = b.z + b.d / 2;
    let tmin = -Infinity;
    let tmax = Infinity;
    let axis = -1;
    for (const [o, d, lo, hi, ax] of [
      [x, dx, x0, x1, 0],
      [z, dz, z0, z1, 1],
    ] as const) {
      if (Math.abs(d) < 1e-6) {
        if (o < lo || o > hi) {
          tmin = Infinity;
          break;
        }
        continue;
      }
      let t0 = (lo - o) / d;
      let t1 = (hi - o) / d;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > tmin) {
        tmin = t0;
        axis = ax;
      }
      tmax = Math.min(tmax, t1);
    }
    if (tmin > tmax || tmin < 0.5 || tmin >= bestT || axis < 0) continue;
    const hx = x + dx * tmin;
    const hz = z + dz * tmin;
    const nx = axis === 0 ? -Math.sign(dx) : 0;
    const nz = axis === 1 ? -Math.sign(dz) : 0;
    const room = axis === 0 ? Math.min(hz - z0, z1 - hz) : Math.min(hx - x0, x1 - hx);
    bestT = tmin;
    best = { x: hx, z: hz, nx, nz, room, h: b.h, id: b.id };
  }
  return best;
}

/** The base buildings the generic layer still draws (kept-out heroes excluded). */
export const visibleBuildings = (map: CityMap) => map.buildings.filter((b) => !buildingKeptOut(b));
