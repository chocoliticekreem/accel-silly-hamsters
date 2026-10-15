// Surroundings planner (decor only): the rest of London from the map edge out to the horizon, as one street network.
//
// - A perimeter road runs round the map PERIM metres outside its bounds; every street that leaves the map runs
//   straight on to it and then out to the horizon as a line of the grid, so no street ends at the edge.
// - The grid: lines facing each side of the map are placed on that side's exits and filled in between
//   (blocks get bigger further out); outside the map's own x/z range the lines span everything. Every line ends on
//   another line or in the fog: no dead ends.
// - The real main roads (Old Street, City Road, Bishopsgate, ... see sim/london.ts) cut across the grid.
// - Blocks are the grid cells inside the roads: London terraces on the frontages close in, simpler slabs far out,
//   taller toward the City (south-west) and Old Street, low brick terraces to the north and east; the odd park,
//   council tower and the Thames to the south.
// Pure and deterministic. Contract coords (x east, z north).
import type { CityMap, Street } from "../api/contract";
import { rng, seedOf, type Rng } from "../mock/rng";
import { ARTERIALS, CITY_CENTRE, OLD_STREET, resolveLandmarks, SKYLINE_SPOTS, THAMES } from "./london";
import { overgroundRoute, routeDistance, VIADUCT_W } from "./overground";

/** Perimeter road centreline, metres outside the bounds. */
export const PERIM = 16;
export const PERIM_W = 10;
/** The network reaches this far from the map centre (the fog does the rest). */
export const REACH = 2900;
const PAVEMENT = 2.5;

export type Side = "n" | "s" | "e" | "w";

export interface Exit {
  street: Street;
  side: Side;
  /** Where the street meets the bounds. */
  x: number;
  z: number;
  width: number;
}

export interface Road {
  a: [number, number];
  b: [number, number];
  width: number;
  /** Main roads get street lights and traffic. */
  main: boolean;
}

export type BlockStyle = "brick" | "stock" | "warehouse" | "office" | "glass" | "concrete";

export interface OuterBuilding {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  style: BlockStyle;
}

export interface Park {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface SurroundingsPlan {
  exits: Exit[];
  roads: Road[];
  buildings: OuterBuilding[];
  parks: Park[];
  /** Inner square (the map + its perimeter road), the area the surroundings never build on. */
  inner: { x0: number; x1: number; z0: number; z1: number };
}

/** Streets that leave the map: an endpoint on the bounds. */
export function mapExits(map: CityMap): Exit[] {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const out: Exit[] = [];
  for (const s of map.streets) {
    if (s.points.length < 2) continue;
    for (const k of [0, s.points.length - 1]) {
      const [x, z] = s.points[k];
      const side: Side | null = Math.abs(z - maxZ) < 2 ? "n" : Math.abs(z - minZ) < 2 ? "s" : Math.abs(x - maxX) < 2 ? "e" : Math.abs(x - minX) < 2 ? "w" : null;
      if (side) out.push({ street: s, side, x, z, width: Math.max(8, s.width) });
    }
  }
  return out;
}

/**
 * Each exiting street continued outward `length` metres along the surroundings network: straight to the perimeter
 * road, then along its own grid line. Same ids/names/widths as the street, so routing and traffic can use them.
 */
export function exitContinuations(map: CityMap, length = 260): Street[] {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  return mapExits(map).map((e, i) => {
    const out: [number, number] =
      e.side === "n" ? [e.x, maxZ + PERIM] : e.side === "s" ? [e.x, minZ - PERIM] : e.side === "e" ? [maxX + PERIM, e.z] : [minX - PERIM, e.z];
    const far: [number, number] =
      e.side === "n" ? [e.x, maxZ + PERIM + length] : e.side === "s" ? [e.x, minZ - PERIM - length] : e.side === "e" ? [maxX + PERIM + length, e.z] : [minX - PERIM - length, e.z];
    return { id: `${e.street.id}~out${i}`, name: e.street.name, width: e.width, points: [[e.x, e.z], out, far] };
  });
}

/** Grid line positions in (lo, hi): the fixed ones, plus fill so no gap exceeds `gap(position)`. Sorted. */
export function fillLines(fixed: number[], lo: number, hi: number, gap: (p: number) => number, r: Rng, minSep = 38): number[] {
  const pts = [...new Set(fixed.filter((p) => p > lo && p < hi).map((p) => Math.round(p * 10) / 10))].sort((a, b) => a - b);
  const anchors = [lo, ...pts, hi];
  const out = [...pts];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const g = gap((a + b) / 2);
    const n = Math.floor((b - a) / g);
    for (let k = 1; k <= n; k++) {
      const p = a + ((b - a) * k) / (n + 1) + (r() - 0.5) * g * 0.25;
      if (p - a >= minSep && b - p >= minSep) out.push(Math.round(p * 10) / 10);
    }
  }
  return out.sort((a, b) => a - b);
}

function segDist(px: number, pz: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const k = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - a[0] - dx * k, pz - a[1] - dz * k);
}

export function polyDist(px: number, pz: number, pts: [number, number][]) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, segDist(px, pz, pts[i], pts[i + 1]));
  return best;
}

/** Distance from a rect to a segment (0 if they touch), by sampling the rect's edges and the segment. */
function rectSegDist(cx: number, cz: number, w: number, d: number, a: [number, number], b: [number, number]) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / 4));
  let best = Infinity;
  for (let k = 0; k <= n; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / n;
    const z = a[1] + ((b[1] - a[1]) * k) / n;
    best = Math.min(best, Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)));
    if (best === 0) return 0;
  }
  return best;
}

export function planSurroundings(map: CityMap, seed = 31): SurroundingsPlan {
  const r = rng(seed);
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const xa = minX - PERIM;
  const xb = maxX + PERIM;
  const za = minZ - PERIM;
  const zb = maxZ + PERIM;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const R = REACH;
  const X0 = cx - R;
  const X1 = cx + R;
  const Z0 = cz - R;
  const Z1 = cz + R;
  const exits = mapExits(map);
  const width = new Map<string, number>();
  const key = (axis: "x" | "z", region: string, p: number) => `${axis}:${region}:${Math.round(p * 10) / 10}`;
  // blocks get bigger with distance from the map
  const gap = (dist: number) => 85 + Math.max(0, dist - 300) * 0.045;

  const exitPos = (side: Side) => exits.filter((e) => e.side === side).map((e) => (side === "n" || side === "s" ? e.x : e.z));
  const regionLines = (axis: "x" | "z", region: string, fixed: number[], lo: number, hi: number, centre: number) => {
    const lines = fillLines(fixed, lo, hi, (p) => gap(Math.abs(p - centre)), r);
    for (const p of lines) {
      const ex = exits.find((e) => Math.abs((axis === "x" ? e.x : e.z) - p) < 0.06 && (region === e.side || region === "outer"));
      width.set(key(axis, region, p), ex ? ex.width : 9);
    }
    return lines;
  };
  const westX = [...regionLines("x", "outer", [], X0, xa, cx), xa];
  const eastX = [xb, ...regionLines("x", "outer", [], xb, X1, cx)];
  const southZ = [...regionLines("z", "outer", [], Z0, za, cz), za];
  const northZ = [zb, ...regionLines("z", "outer", [], zb, Z1, cz)];
  const nX = regionLines("x", "n", exitPos("n"), xa, xb, cx);
  const sX = regionLines("x", "s", exitPos("s"), xa, xb, cx);
  const eZ = regionLines("z", "e", exitPos("e"), za, zb, cz);
  const wZ = regionLines("z", "w", exitPos("w"), za, zb, cz);
  for (const p of [xa, xb]) width.set(key("x", "outer", p), PERIM_W);
  for (const p of [za, zb]) width.set(key("z", "outer", p), PERIM_W);
  const wOf = (axis: "x" | "z", region: string, p: number) => width.get(key(axis, region, p)) ?? 9;

  // ---- roads ----
  const roads: Road[] = [];
  const thamesHalf = THAMES.width / 2;
  const bridgeEvery = 3;
  let lineNo = 0;
  /** Adds a straight grid road, cut where it would run through the Thames (except every few lines: bridges). */
  const addLine = (a: [number, number], b: [number, number], w: number) => {
    const bridge = lineNo++ % bridgeEvery === 0;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / 20));
    let start: [number, number] | null = null;
    let prev: [number, number] = a;
    for (let k = 0; k <= n; k++) {
      const p: [number, number] = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      const wet = (!bridge && polyDist(p[0], p[1], THAMES.points) < thamesHalf + 6) || SKYLINE_SPOTS.some((t) => Math.hypot(p[0] - t.x, p[1] - t.z) < t.r + w / 2 + 2);
      if (!wet && !start) start = p;
      if (wet && start) {
        roads.push({ a: start, b: prev, width: w, main: w >= 10 });
        start = null;
      }
      prev = p;
    }
    if (start) roads.push({ a: start, b, width: w, main: w >= 10 });
  };
  for (const x of [...westX, ...eastX]) addLine([x, Z0], [x, Z1], wOf("x", "outer", x));
  for (const z of [...southZ, ...northZ]) addLine([X0, z], [X1, z], wOf("z", "outer", z));
  for (const x of nX) addLine([x, zb], [x, Z1], wOf("x", "n", x));
  for (const x of sX) addLine([x, Z0], [x, za], wOf("x", "s", x));
  for (const z of eZ) addLine([xb, z], [X1, z], wOf("z", "e", z));
  for (const z of wZ) addLine([X0, z], [xa, z], wOf("z", "w", z));
  // stubs from each exit to the perimeter road
  for (const e of exits) {
    const to: [number, number] = e.side === "n" ? [e.x, zb] : e.side === "s" ? [e.x, za] : e.side === "e" ? [xb, e.z] : [xa, e.z];
    roads.push({ a: [e.x, e.z], b: to, width: e.width, main: e.width >= 12 });
  }
  // the named main roads (snapped onto the exit they leave the map by)
  const arterials = ARTERIALS.map((ar) => {
    const pts = ar.points.map((p) => [...p] as [number, number]);
    const ex = exits.find((e) => Math.hypot(e.x - pts[0][0], e.z - pts[0][1]) < 40);
    if (ex) pts[0] = [ex.x, ex.z];
    return { ...ar, points: pts };
  });
  const inInner = (x: number, z: number) => x > xa && x < xb && z > za && z < zb;
  for (const ar of arterials)
    for (let i = 0; i < ar.points.length - 1; i++) {
      let a = ar.points[i];
      let b = ar.points[i + 1];
      // never draw over the map itself: trim to the part outside the inner square
      if (inInner(...a) && inInner(...b)) continue;
      if (inInner(...a) || inInner(...b)) {
        const [inside, outside] = inInner(...a) ? [a, b] : [b, a];
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 24; k++) {
          const m = (lo + hi) / 2;
          if (inInner(inside[0] + (outside[0] - inside[0]) * m, inside[1] + (outside[1] - inside[1]) * m)) lo = m;
          else hi = m;
        }
        const edge: [number, number] = [inside[0] + (outside[0] - inside[0]) * hi, inside[1] + (outside[1] - inside[1]) * hi];
        if (inInner(...a)) a = edge;
        else b = edge;
      }
      roads.push({ a, b, width: ar.width, main: true });
    }

  // ---- keep-outs ----
  const viaduct = overgroundRoute(map);
  const landmarks = resolveLandmarks(map).filter((l) => !inInner(l.x, l.z));
  const clearOf = (x: number, z: number, w: number, d: number) => {
    const rad = Math.hypot(w, d) / 2;
    if (Math.hypot(x - OLD_STREET.x, z - OLD_STREET.z) < 62 + rad) return false;
    for (const l of landmarks) if (Math.hypot(x - l.x, z - l.z) < (l.key === "artotel" ? 30 : 24) + rad) return false;
    for (const s of SKYLINE_SPOTS) if (Math.hypot(x - s.x, z - s.z) < s.r + rad) return false;
    if (polyDist(x, z, THAMES.points) < thamesHalf + 10 + rad) return false;
    if (viaduct && routeDistance(viaduct, x, z) < VIADUCT_W / 2 + 3 + rad) return false;
    for (const ar of arterials)
      for (let i = 0; i < ar.points.length - 1; i++) {
        // cheap reject before the exact test
        if (segDist(x, z, ar.points[i], ar.points[i + 1]) > rad + ar.width) continue;
        if (rectSegDist(x, z, w, d, ar.points[i], ar.points[i + 1]) < ar.width / 2 + PAVEMENT) return false;
      }
    return true;
  };

  // ---- blocks ----
  const buildings: OuterBuilding[] = [];
  const parks: Park[] = [];
  const cells = (xs: { p: number; w: number }[], zs: { p: number; w: number }[]) => {
    for (let i = 0; i < xs.length - 1; i++)
      for (let j = 0; j < zs.length - 1; j++) {
        const bx0 = xs[i].p + xs[i].w / 2 + PAVEMENT;
        const bx1 = xs[i + 1].p - xs[i + 1].w / 2 - PAVEMENT;
        const bz0 = zs[j].p + zs[j].w / 2 + PAVEMENT;
        const bz1 = zs[j + 1].p - zs[j + 1].w / 2 - PAVEMENT;
        if (bx1 - bx0 < 8 || bz1 - bz0 < 8) continue;
        const mx = (bx0 + bx1) / 2;
        const mz = (bz0 + bz1) / 2;
        if (Math.hypot(mx - cx, mz - cz) > R) continue;
        block(bx0, bx1, bz0, bz1, rng(seedOf(seed, Math.round(mx), Math.round(mz))));
      }
  };
  const L = (ps: number[], axis: "x" | "z", region: string) => ps.map((p) => ({ p, w: wOf(axis, region, p) }));
  const Lx = (ps: number[], region: string) => L(ps, "x", region);
  const Lz = (ps: number[], region: string) => L(ps, "z", region);
  const W = Lx(westX, "outer");
  const E = Lx(eastX, "outer");
  const S = Lz(southZ, "outer");
  const N = Lz(northZ, "outer");
  const nXs = [{ p: xa, w: PERIM_W }, ...Lx(nX, "n"), { p: xb, w: PERIM_W }];
  const sXs = [{ p: xa, w: PERIM_W }, ...Lx(sX, "s"), { p: xb, w: PERIM_W }];
  const eZs = [{ p: za, w: PERIM_W }, ...Lz(eZ, "e"), { p: zb, w: PERIM_W }];
  const wZs = [{ p: za, w: PERIM_W }, ...Lz(wZ, "w"), { p: zb, w: PERIM_W }];

  function style(x: number, z: number, rr: Rng): { h: number; style: BlockStyle } {
    const dCity = Math.hypot(x - CITY_CENTRE.x, z - CITY_CENTRE.z);
    const dOld = Math.hypot(x - OLD_STREET.x, z - OLD_STREET.z);
    const dMap = Math.max(Math.abs(x - cx) - (maxX - minX) / 2, Math.abs(z - cz) - (maxZ - minZ) / 2, 0);
    if (dCity < 800) {
      const k = Math.pow(1 - dCity / 800, 1.3);
      return { h: 22 + 85 * k * (0.45 + rr() * 0.8), style: rr() < 0.6 ? "glass" : "office" };
    }
    // the City fringe and Tech City: mid-rise offices and converted warehouses
    const fringe = (x < cx && z < cz + 200 && dCity < 1500) || dOld < 450;
    if (fringe) return rr() < 0.55 ? { h: 16 + rr() * 26, style: rr() < 0.5 ? "office" : "glass" } : { h: 12 + rr() * 10, style: "warehouse" };
    if (rr() < 0.012 && dMap > 150) return { h: 38 + rr() * 40, style: "concrete" }; // a council tower
    if (rr() < 0.18) return { h: 11 + rr() * 8, style: "warehouse" };
    if (rr() < 0.12) return { h: 14 + rr() * 14, style: rr() < 0.5 ? "office" : "concrete" };
    return { h: 9 + rr() * 6.5, style: rr() < 0.6 ? "brick" : "stock" };
  }

  const put = (x: number, z: number, w: number, d: number, rr: Rng, styled?: { h: number; style: BlockStyle }) => {
    if (w < 3 || d < 3 || !clearOf(x, z, w, d)) return;
    const s = styled ?? style(x, z, rr);
    buildings.push({ x, z, w, d, h: s.h, style: s.style });
  };

  function block(x0: number, x1: number, z0: number, z1: number, rr: Rng) {
    const w = x1 - x0;
    const d = z1 - z0;
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    const dist = Math.hypot(mx - cx, mz - cz);
    if (rr() < 0.06 && clearOf(mx, mz, w, d) && polyDist(mx, mz, THAMES.points) > thamesHalf + 20) {
      parks.push({ x: mx, z: mz, w, d });
      return;
    }
    const s0 = style(mx, mz, rr);
    if (dist > 1100 || s0.style === "glass" || s0.style === "office" || (s0.style === "concrete" && s0.h > 35)) {
      // one to four slabs filling the block (cheap, and the City is made of big floorplates)
      const sx = w > 60 && rr() < 0.7 ? 2 : 1;
      const sz = d > 60 && rr() < 0.7 ? 2 : 1;
      for (let i = 0; i < sx; i++)
        for (let j = 0; j < sz; j++) {
          const bw = w / sx - (sx > 1 ? 3 : 0);
          const bd = d / sz - (sz > 1 ? 3 : 0);
          const bx = x0 + (w / sx) * (i + 0.5);
          const bz = z0 + (d / sz) * (j + 0.5);
          const st = i + j === 0 ? s0 : style(bx, bz, rr);
          put(bx, bz, bw * (0.8 + rr() * 0.2), bd * (0.8 + rr() * 0.2), rr, st);
        }
      return;
    }
    // London terraces round the edge of the block, a yard in the middle
    const depth = Math.min(15 + rr() * 5, Math.min(w, d) / 2);
    const row = (along: "x" | "z", a0: number, a1: number, fixed: number, sign: number) => {
      let a = a0;
      const storeys = rr();
      while (a < a1 - 2) {
        let len = 5 + rr() * 9;
        if (rr() < 0.15) len = 14 + rr() * 16; // a warehouse or mansion block
        if (a1 - a - len < 4) len = a1 - a;
        const c = a + len / 2;
        const off = fixed + (sign * depth) / 2;
        const s = style(along === "x" ? c : off, along === "x" ? off : c, rr);
        // terraces keep a common height along a row, give or take a storey
        if (s.style === "brick" || s.style === "stock") s.h = 9 + storeys * 5 + (rr() < 0.3 ? 3 : 0);
        if (along === "x") put(c, off, len - 0.3, depth, rr, s);
        else put(off, c, depth, len - 0.3, rr, s);
        a += len;
      }
    };
    row("x", x0, x1, z0, 1);
    row("x", x0, x1, z1, -1);
    if (d > depth * 2 + 4) {
      row("z", z0 + depth, z1 - depth, x0, 1);
      row("z", z0 + depth, z1 - depth, x1, -1);
    }
  }

  cells(W, N);
  cells(nXs, N);
  cells(E, N);
  cells(W, wZs);
  cells(E, eZs);
  cells(W, S);
  cells(sXs, S);
  cells(E, S);

  return { exits, roads, buildings, parks, inner: { x0: xa, x1: xb, z0: za, z1: zb } };
}
