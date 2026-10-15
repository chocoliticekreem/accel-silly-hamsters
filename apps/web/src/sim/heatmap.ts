// Heatmap binning and small place helpers (pure; used by the Heatmap module, the person card and the mock).
// Grids are in contract coordinates (x east, z north): cell (i, j) covers x in [minX + i·cell, +cell), z likewise.
import type { Bounds, CityMap, PathKey, StoreVisit } from "../api/contract";
import { frontage } from "./geometry";

export interface Grid {
  minX: number;
  minZ: number;
  cell: number;
  nx: number;
  nz: number;
  /** nx · nz values, row-major by z: v[j * nx + i]. */
  v: Float32Array;
}

export function makeGrid(b: Bounds, cell: number, pad = 0): Grid {
  const minX = b.minX - pad;
  const minZ = b.minZ - pad;
  const nx = Math.max(1, Math.ceil((b.maxX + pad - minX) / cell));
  const nz = Math.max(1, Math.ceil((b.maxZ + pad - minZ) / cell));
  return { minX, minZ, cell, nx, nz, v: new Float32Array(nx * nz) };
}

/** Cell index of a point, or -1 outside the grid. */
export function cellOf(g: Grid, x: number, z: number): number {
  const i = Math.floor((x - g.minX) / g.cell);
  const j = Math.floor((z - g.minZ) / g.cell);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return -1;
  return j * g.nx + i;
}

export function addPoint(g: Grid, x: number, z: number, w = 1) {
  const k = cellOf(g, x, z);
  if (k >= 0) g.v[k] += w;
}

/** Adds w spread over a disc of `radius` cells (linear falloff), so sparse points read as areas. */
export function splat(g: Grid, x: number, z: number, w: number, radius: number) {
  const ci = Math.floor((x - g.minX) / g.cell);
  const cj = Math.floor((z - g.minZ) / g.cell);
  const r = Math.max(0, Math.round(radius));
  const cells: [number, number][] = [];
  let total = 0;
  for (let dj = -r; dj <= r; dj++)
    for (let di = -r; di <= r; di++) {
      const d = Math.hypot(di, dj);
      if (d > r + 0.001) continue;
      const k = 1 - d / (r + 1);
      cells.push([dj * 1000 + di, k]);
      total += k;
    }
  for (const [code, k] of cells) {
    const dj = Math.round(code / 1000);
    const di = code - dj * 1000;
    const i = ci + di;
    const j = cj + dj;
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
    g.v[j * g.nx + i] += (w * k) / total;
  }
}

/**
 * Footfall: person-minutes per cell. Each path is walked in `step`-minute samples (linear interpolation, the
 * contract's playback rule) and every sample adds `step` minutes to its cell. Time spent inside a visit doesn't count.
 */
export function binFootfall(g: Grid, paths: { path: PathKey[]; visits?: StoreVisit[] }[], step = 2) {
  for (const p of paths) {
    const k = p.path;
    if (!k.length) continue;
    const t0 = k[0][0];
    const t1 = k[k.length - 1][0];
    let seg = 0;
    for (let t = t0; t <= t1; t += step) {
      if (p.visits?.some((v) => t >= v.tIn && t < v.tOut)) continue;
      while (seg < k.length - 2 && k[seg + 1][0] < t) seg++;
      const [ta, xa, za] = k[seg];
      const [tb, xb, zb] = k[Math.min(seg + 1, k.length - 1)];
      const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
      addPoint(g, xa + (xb - xa) * f, za + (zb - za) * f, step);
    }
  }
  return g;
}

export interface Door {
  storeId: string;
  x: number;
  z: number;
}

export function storeDoors(map: CityMap): Door[] {
  return map.stores.flatMap((s) => {
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (!b) return [];
    const f = frontage(b, map.streets);
    return [{ storeId: s.id, x: f.doorX, z: f.doorZ }];
  });
}

/**
 * "Found it shut": a stop of at most `maxWait` minutes at a shop door with no visit then (the trip walked over,
 * found the shutter down, and walked on). Read straight off the day file.
 */
export function shutStops(path: PathKey[], visits: StoreVisit[], doors: Door[], opts: { near?: number; maxWait?: number } = {}): { storeId: string; t: number; x: number; z: number }[] {
  const near = opts.near ?? 3;
  const maxWait = opts.maxWait ?? 2;
  const out: { storeId: string; t: number; x: number; z: number }[] = [];
  for (let i = 1; i < path.length; i++) {
    const [ta, xa, za] = path[i - 1];
    const [tb, xb, zb] = path[i];
    const dt = tb - ta;
    if (dt <= 0 || dt > maxWait || Math.abs(xb - xa) > 0.05 || Math.abs(zb - za) > 0.05) continue;
    if (visits.some((v) => ta >= v.tIn - 0.5 && ta < v.tOut)) continue;
    let best: Door | null = null;
    let bestD = near;
    for (const d of doors) {
      const dd = Math.hypot(d.x - xa, d.z - za);
      if (dd <= bestD) {
        best = d;
        bestD = dd;
      }
    }
    if (best) out.push({ storeId: best.storeId, t: ta, x: xa, z: za });
  }
  return out;
}

/** The street a point is nearest to (for "lives near Brick Ln"). */
export function nearestStreetName(map: CityMap, x: number, z: number): string {
  let best = "";
  let bestD = Infinity;
  for (const s of map.streets)
    for (let i = 1; i < s.points.length; i++) {
      const [ax, az] = s.points[i - 1];
      const [bx, bz] = s.points[i];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const d = Math.hypot(x - (ax + dx * k), z - (az + dz * k));
      if (d < bestD) {
        bestD = d;
        best = s.name;
      }
    }
  return best;
}

/** Largest absolute value in a grid (≥ a tiny floor so empty grids don't divide by zero). */
export function gridMax(g: Grid) {
  let m = 1e-6;
  for (let i = 0; i < g.v.length; i++) m = Math.max(m, Math.abs(g.v[i]));
  return m;
}
