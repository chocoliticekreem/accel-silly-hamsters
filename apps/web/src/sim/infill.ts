// Infill planner (decor only). Finds land inside the map bounds that the real map leaves empty and plans believable
// urban fabric for it: street-facing terraces, inner warehouses, yards, pocket parks, car parks, and for the
// biggest void a construction site + container market. Pure and deterministic (seeded); never feeds sim data.
// All coordinates are contract coords (x = east, z = north). The 3D module converts with toScene.
import { landmarkKeepouts } from "../world/models/plots";
import type { Building, CityMap } from "../api/contract";
import { rng, seedOf, type Rng } from "../mock/rng";
import { closestOnStreet, frontage } from "./geometry";
import { overgroundRoute, routeDistance, VIADUCT_W } from "./overground";
import { inAreaKeepout } from "./areaKeepouts";

export const CELL = 4;
/** Clear margin around real buildings, stores (bigger, so awnings breathe) and the station. */
export const BUILDING_PAD = 2;
export const STORE_PAD = 3;
export const STATION_PAD = 4;
/** Pavement kept clear beyond the roadway on each side. */
export const STREET_PAD = 3;
/** Kept clear in front of a store or club facade. */
export const STORE_FRONT = 4;

export const FREE = 0;
export const BUILDING = 1;
export const STREET = 2;
export const KEEPOUT = 3;

export interface Grid {
  cell: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  /** Row-major (index = j * nx + i), one of FREE/BUILDING/STREET/KEEPOUT. */
  state: Uint8Array;
}

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export const cellCenter = (g: Grid, i: number, j: number): [number, number] => [g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 0.5) * g.cell];

function padded(b: Building): number {
  if (b.kind === "station") return STATION_PAD;
  if (b.kind === "store" || b.kind === "club") return STORE_PAD;
  return BUILDING_PAD;
}

/** Rasterise the bounds. A cell is FREE only if its whole square clears every building, street and keep-out. */
export function occupancy(map: CityMap, cell = CELL): Grid {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const nx = Math.floor((maxX - minX) / cell);
  const nz = Math.floor((maxZ - minZ) / cell);
  const g: Grid = { cell, x0: minX, z0: minZ, nx, nz, state: new Uint8Array(nx * nz) };
  const half = cell / 2;
  const halfDiag = Math.SQRT2 * half;

  const keepouts: Rect[] = [];
  for (const b of map.buildings) {
    if (b.kind !== "store" && b.kind !== "club") continue;
    const f = frontage(b, map.streets);
    // a strip the width of the facade (+ the pad) reaching STORE_FRONT beyond the facade
    if (f.nx !== 0) keepouts.push({ x: f.facadeX + (f.nx * STORE_FRONT) / 2, z: b.z, w: STORE_FRONT + STORE_PAD * 2, d: b.d + STORE_PAD * 2 });
    else keepouts.push({ x: b.x, z: f.facadeZ + (f.nz * STORE_FRONT) / 2, w: b.w + STORE_PAD * 2, d: STORE_FRONT + STORE_PAD * 2 });
  }
  for (const e of map.entryPoints) keepouts.push({ x: e.x, z: e.z, w: 16, d: 16 });
  // hero landmark plots (world/models/plots) are built up: never infill inside one
  const landmarks = landmarkKeepouts(map);
  // the Overground viaduct's corridor (its arches stand there)
  const viaduct = overgroundRoute(map, 0);

  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const [cx, cz] = cellCenter(g, i, j);
      let s = FREE;
      for (const b of map.buildings) {
        const p = padded(b);
        if (Math.abs(cx - b.x) < b.w / 2 + p + half && Math.abs(cz - b.z) < b.d / 2 + p + half) {
          s = BUILDING;
          break;
        }
      }
      if (s === FREE)
        for (const k of landmarks)
          if (cx + half > k.x0 && cx - half < k.x1 && cz + half > k.z0 && cz - half < k.z1) {
            s = BUILDING;
            break;
          }
      if (s === FREE)
        for (const st of map.streets)
          if (closestOnStreet(st, cx, cz)[2] - halfDiag < st.width / 2 + STREET_PAD) {
            s = STREET;
            break;
          }
      if (s === FREE && inAreaKeepout(cx, cz)) s = KEEPOUT;
      if (s === FREE && viaduct && routeDistance(viaduct, cx, cz) - halfDiag < VIADUCT_W / 2 + 2) s = KEEPOUT;
      if (s === FREE)
        for (const k of keepouts)
          if (Math.abs(cx - k.x) < k.w / 2 + half && Math.abs(cz - k.z) < k.d / 2 + half) {
            s = KEEPOUT;
            break;
          }
      g.state[j * nx + i] = s;
    }
  return g;
}

export interface Region {
  id: number;
  /** Cell indices (j * nx + i). */
  cells: number[];
  /** Cells whose neighbourhood touches a street: where frontages go. */
  touchesStreet: boolean;
  bbox: { i0: number; j0: number; i1: number; j1: number };
}

/** 4-connected components of FREE cells, biggest first; regions smaller than minCells are dropped. */
export function findRegions(g: Grid, minCells = 4): Region[] {
  const label = new Int32Array(g.nx * g.nz).fill(-1);
  const out: Region[] = [];
  const stack: number[] = [];
  for (let start = 0; start < label.length; start++) {
    if (g.state[start] !== FREE || label[start] !== -1) continue;
    const id = out.length;
    const cells: number[] = [];
    let touches = false;
    const bbox = { i0: Infinity, j0: Infinity, i1: -Infinity, j1: -Infinity };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const i = c % g.nx;
      const j = (c - i) / g.nx;
      bbox.i0 = Math.min(bbox.i0, i);
      bbox.i1 = Math.max(bbox.i1, i);
      bbox.j0 = Math.min(bbox.j0, j);
      bbox.j1 = Math.max(bbox.j1, j);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= g.nx || b >= g.nz) continue;
        const n = b * g.nx + a;
        if (g.state[n] === STREET) touches = true;
        if (g.state[n] === FREE && label[n] === -1) {
          label[n] = id;
          stack.push(n);
        }
      }
    }
    out.push({ id, cells, touchesStreet: touches, bbox });
  }
  return out
    .filter((r) => r.cells.length >= minCells)
    .sort((a, b) => b.cells.length - a.cells.length)
    .map((r, k) => ({ ...r, id: k }));
}

/** Steps (4-neighbour, inside the region) from the nearest cell that borders a street; Infinity if none. */
export function streetDepth(g: Grid, region: Region): Map<number, number> {
  const depth = new Map<number, number>();
  const inRegion = new Set(region.cells);
  const queue: number[] = [];
  for (const c of region.cells) {
    const i = c % g.nx;
    const j = (c - i) / g.nx;
    let edge = false;
    for (let dj = -1; dj <= 1 && !edge; dj++)
      for (let di = -1; di <= 1; di++) {
        const a = i + di;
        const b = j + dj;
        if (a >= 0 && b >= 0 && a < g.nx && b < g.nz && g.state[b * g.nx + a] === STREET) {
          edge = true;
          break;
        }
      }
    depth.set(c, edge ? 0 : Infinity);
    if (edge) queue.push(c);
  }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    const i = c % g.nx;
    const d = depth.get(c)! + 1;
    for (const n of [i + 1 < g.nx ? c + 1 : -1, i > 0 ? c - 1 : -1, c + g.nx, c - g.nx]) {
      if (!inRegion.has(n) || depth.get(n)! <= d) continue;
      depth.set(n, d);
      queue.push(n);
    }
  }
  return depth;
}

/** Greedy packing of a cell set into axis-aligned rectangles (in cells) no larger than maxW × maxD. */
export function packRects(g: Grid, cells: Iterable<number>, maxW: number, maxD: number): { i: number; j: number; w: number; d: number }[] {
  const todo = new Set(cells);
  const sorted = [...todo].sort((a, b) => a - b);
  const out: { i: number; j: number; w: number; d: number }[] = [];
  for (const c of sorted) {
    if (!todo.has(c)) continue;
    const i = c % g.nx;
    const j = (c - i) / g.nx;
    let w = 1;
    while (w < maxW && i + w < g.nx && todo.has(c + w)) w++;
    let d = 1;
    grow: while (d < maxD && j + d < g.nz) {
      for (let k = 0; k < w; k++) if (!todo.has(c + d * g.nx + k)) break grow;
      d++;
    }
    for (let b = 0; b < d; b++) for (let a = 0; a < w; a++) todo.delete(c + b * g.nx + a);
    out.push({ i, j, w, d });
  }
  return out;
}

export type PlotKind = "terrace" | "office" | "warehouse" | "park" | "carpark" | "yard" | "plaza" | "market" | "site";

export interface Plot extends Rect {
  kind: PlotKind;
  /** Building height (0 for open ground). */
  h: number;
  /** Fronts a street (gets a shopfront band / is the hoarding line). */
  front: boolean;
  /** Per-plot seed for render-time details (trees, cars, containers...). */
  seed: number;
}

export interface Hoarding {
  /** Centre of a CELL-long fence piece along a cell edge. */
  x: number;
  z: number;
  /** true: runs east-west; false: runs north-south. */
  alongX: boolean;
}

export interface InfillPlan {
  grid: Grid;
  regions: Region[];
  plots: Plot[];
  hoardings: Hoarding[];
  /** Tower crane positions (on site plots). */
  cranes: { x: number; z: number; h: number; jib: number }[];
}

const FLOOR = 3.5;
const FRONT_DEPTH = 3; // cells (12 m): the street-facing band built as terraces
const BIG_REGION = 380; // cells (~6000 m²): gets the special treatment when it is the biggest void

function rectOf(g: Grid, r: { i: number; j: number; w: number; d: number }): Rect {
  return { x: g.x0 + (r.i + r.w / 2) * g.cell, z: g.z0 + (r.j + r.d / 2) * g.cell, w: r.w * g.cell, d: r.d * g.cell };
}

/** Split a street-facing rect into house-wide plots along its long side, each its own height. */
function terraceRow(r: Rng, rect: Rect, out: Plot[]) {
  const long = rect.w >= rect.d;
  const len = long ? rect.w : rect.d;
  const office = r() < 0.18 && len >= 12;
  if (office) {
    out.push({ ...rect, kind: "office", h: FLOOR * Math.floor(5 + r() * 4), front: true, seed: Math.floor(r() * 1e9) });
    return;
  }
  const warehouse = r() < 0.25;
  let a = -len / 2;
  const storeys = 3 + Math.floor(r() * 3);
  while (a < len / 2 - 0.01) {
    const remaining = len / 2 - a;
    let plot = warehouse ? 8 + Math.floor(r() * 3) * 4 : 5 + Math.floor(r() * 3);
    if (remaining - plot < 3.5) plot = remaining;
    const mid = a + plot / 2;
    const h = FLOOR * Math.max(2, storeys + (r() < 0.35 ? (r() < 0.5 ? -1 : 1) : 0)) + (warehouse ? 0 : 0.6);
    out.push({
      x: long ? rect.x + mid : rect.x,
      z: long ? rect.z : rect.z + mid,
      w: long ? plot : rect.w,
      d: long ? rect.d : plot,
      kind: warehouse ? "warehouse" : "terrace",
      h,
      front: true,
      seed: Math.floor(r() * 1e9),
    });
    a += plot;
  }
}

function inner(r: Rng, rect: Rect, cells: number, out: Plot[]) {
  const seed = Math.floor(r() * 1e9);
  const small = cells < 6;
  const kinds: PlotKind[] = small ? ["yard", "park", "warehouse"] : ["park", "carpark", "warehouse", "yard", "office"];
  const weights = small ? [1, 2, 3] : [2, 1.5, 4, 1, rect.w * rect.d > 300 ? 1.5 : 0];
  let x = r() * weights.reduce((a, b) => a + b, 0);
  let k = 0;
  for (; k < kinds.length - 1; k++) if ((x -= weights[k]) <= 0) break;
  const kind = kinds[k];
  // car parks need room for two rows of bays
  const fixed = kind === "carpark" && Math.min(rect.w, rect.d) < 12 ? "yard" : kind;
  const h = fixed === "warehouse" ? FLOOR * (2 + Math.floor(r() * 3)) + 1 : fixed === "office" ? FLOOR * (5 + Math.floor(r() * 5)) : 0;
  out.push({ ...rect, kind: fixed, h, front: false, seed });
}

/** Plan the whole infill for a map. Deterministic for a given (map, seed). */
export function planInfill(map: CityMap, seed = 7): InfillPlan {
  const g = occupancy(map);
  const regions = findRegions(g, 4);
  const plots: Plot[] = [];
  const hoardings: Hoarding[] = [];
  const cranes: InfillPlan["cranes"] = [];
  const station = map.entryPoints.find((e) => e.kind === "station") ?? map.buildings.find((b) => b.kind === "station");

  for (const region of regions) {
    const first = region.cells[0];
    const r = rng(seedOf(seed, first, region.cells.length));
    const n = region.cells.length;

    if (n < 10) {
      // pocket: a tiny garden square or one narrow building
      const rects = packRects(g, region.cells, 4, 4);
      for (const rc of rects) {
        const rect = rectOf(g, rc);
        const pick = r();
        if (pick < 0.5 || rc.w * rc.d < 2) plots.push({ ...rect, kind: "park", h: 0, front: false, seed: Math.floor(r() * 1e9) });
        else if (region.touchesStreet) terraceRow(r, rect, plots);
        else plots.push({ ...rect, kind: "yard", h: 0, front: false, seed: Math.floor(r() * 1e9) });
      }
      continue;
    }

    const depth = streetDepth(g, region);
    let rest = region.cells;

    if (region.id === 0 && n >= BIG_REGION) {
      // The biggest void (on the real map: Bishopsgate Goodsyard). Split along its long axis into thirds:
      // nearest the station a container market + plaza, the next a fenced construction site, the rest normal fabric.
      const { i0, i1, j0, j1 } = region.bbox;
      const alongI = i1 - i0 >= j1 - j0;
      const lo = alongI ? i0 : j0;
      const span = (alongI ? i1 - i0 : j1 - j0) + 1;
      const third = (c: number) => {
        const i = c % g.nx;
        const v = alongI ? i : (c - i) / g.nx;
        return Math.min(2, Math.floor(((v - lo) / span) * 3));
      };
      let marketThird = 1;
      if (station) {
        const [sx, sz] = [station.x, station.z];
        const sv = alongI ? (sx - g.x0) / g.cell : (sz - g.z0) / g.cell;
        marketThird = Math.max(0, Math.min(2, Math.floor(((sv - lo) / span) * 3)));
      }
      const siteThird = marketThird === 2 ? 1 : marketThird === 0 ? 1 : r() < 0.5 ? 0 : 2;
      const market = region.cells.filter((c) => third(c) === marketThird);
      const site = region.cells.filter((c) => third(c) === siteThird);
      rest = region.cells.filter((c) => third(c) !== marketThird && third(c) !== siteThird);

      // Boxpark-style container market along the frontage, ordinary fabric behind it
      const stalls = market.filter((c) => (depth.get(c) ?? Infinity) < 6);
      rest = [...rest, ...market.filter((c) => (depth.get(c) ?? Infinity) >= 6)];
      for (const rc of packRects(g, stalls, 12, 6)) {
        const rect = rectOf(g, rc);
        plots.push({ ...rect, kind: rc.w * rc.d >= 6 ? "market" : "plaza", h: 0, front: true, seed: Math.floor(r() * 1e9) });
      }

      const siteSet = new Set(site);
      for (const rc of packRects(g, site, 10, 10)) plots.push({ ...rectOf(g, rc), kind: "site", h: 0, front: false, seed: Math.floor(r() * 1e9) });
      // hoarding along every outside edge of the site
      for (const c of site) {
        const i = c % g.nx;
        const j = (c - i) / g.nx;
        const [cx, cz] = cellCenter(g, i, j);
        const h = g.cell / 2;
        if (i + 1 >= g.nx || !siteSet.has(c + 1)) hoardings.push({ x: cx + h, z: cz, alongX: false });
        if (i === 0 || !siteSet.has(c - 1)) hoardings.push({ x: cx - h, z: cz, alongX: false });
        if (!siteSet.has(c + g.nx)) hoardings.push({ x: cx, z: cz + h, alongX: true });
        if (!siteSet.has(c - g.nx)) hoardings.push({ x: cx, z: cz - h, alongX: true });
      }
      // a tower crane or two over the deepest part of the site
      const bySpace = [...site].sort((a, b) => clearance(g, siteSet, b) - clearance(g, siteSet, a));
      for (const c of bySpace.slice(0, 1)) {
        const i = c % g.nx;
        const [x, z] = cellCenter(g, i, (c - i) / g.nx);
        cranes.push({ x, z, h: 58, jib: 46 });
      }
      const far = bySpace.find((c) => {
        const i = c % g.nx;
        const [x, z] = cellCenter(g, i, (c - i) / g.nx);
        return cranes.every((k) => Math.hypot(k.x - x, k.z - z) > 60) && clearance(g, siteSet, c) >= 3;
      });
      if (far !== undefined) {
        const i = far % g.nx;
        const [x, z] = cellCenter(g, i, (far - i) / g.nx);
        cranes.push({ x, z, h: 44, jib: 36 });
      }
    }

    const front = rest.filter((c) => (depth.get(c) ?? Infinity) < FRONT_DEPTH);
    const back = rest.filter((c) => (depth.get(c) ?? Infinity) >= FRONT_DEPTH);
    for (const rc of packRects(g, front, 7, FRONT_DEPTH)) {
      const rect = rectOf(g, rc);
      if (rc.w * rc.d < 2) plots.push({ ...rect, kind: "yard", h: 0, front: false, seed: Math.floor(r() * 1e9) });
      else terraceRow(r, rect, plots);
    }
    for (const rc of packRects(g, back, 9, 9)) inner(r, rectOf(g, rc), rc.w * rc.d, plots);
  }

  return { grid: g, regions, plots, hoardings, cranes };
}

/** Chebyshev distance (cells, capped) from c to the edge of the set. */
function clearance(g: Grid, set: Set<number>, c: number): number {
  const i = c % g.nx;
  const j = (c - i) / g.nx;
  for (let k = 1; k < 12; k++)
    for (let dj = -k; dj <= k; dj++)
      for (let di = -k; di <= k; di++) {
        if (Math.abs(di) !== k && Math.abs(dj) !== k) continue;
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= g.nx || b >= g.nz || !set.has(b * g.nx + a)) return k - 1;
      }
  return 11;
}

/** Distance between an axis-aligned rect and a street centreline (0 if they cross). */
export function rectStreetDistance(rect: Rect, street: CityMap["streets"][number]): number {
  const x0 = rect.x - rect.w / 2;
  const x1 = rect.x + rect.w / 2;
  const z0 = rect.z - rect.d / 2;
  const z1 = rect.z + rect.d / 2;
  let best = Infinity;
  const inside = (x: number, z: number) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  for (const [x, z] of street.points) {
    if (inside(x, z)) return 0;
    best = Math.min(best, Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)));
  }
  for (const [x, z] of [
    [x0, z0],
    [x0, z1],
    [x1, z0],
    [x1, z1],
  ])
    best = Math.min(best, closestOnStreet(street, x, z)[2]);
  // a segment can cross the rect without a vertex inside or near a corner: sample it
  for (let k = 0; k < street.points.length - 1; k++) {
    const [ax, az] = street.points[k];
    const [bx, bz] = street.points[k + 1];
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 1);
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const z = az + ((bz - az) * s) / steps;
      if (inside(x, z)) return 0;
      best = Math.min(best, Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)));
    }
  }
  return best;
}
