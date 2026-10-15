// The mock's walking network: any street map (the real OSM one or the schematic fallback) as a graph, so mock agents
// walk the same streets the 3D city draws. Mirrors the backend (backend/sim/movement.py): nodes are street points and
// crossings (T-junctions too), detached pieces are joined to the main network, shortest walks by Dijkstra.
// Places (doors, entry points, homes) hang off their nearest street segment; walks keep to one pavement
// (offset from the centre line by half the carriageway plus 2 m) and are cached per (from, to, side).
import type { Street } from "../api/contract";

const SNAP = 1; // points closer than this are one node; also the T-junction tolerance
const CELL = 40; // spatial grid for nearest-segment queries
const PAVEMENT = 2; // walk this far beyond the kerb

type P = [number, number];

/** A point people walk from or to, attached to the street segment u–v at (px, pz). */
export interface Place {
  id: number;
  x: number;
  z: number;
  px: number;
  pz: number;
  u: number;
  v: number;
  /** Metres from the projection to u and to v. */
  du: number;
  dv: number;
  /** The network this place belongs to. */
  net: WalkNet;
}

export interface WalkNet {
  /** Attach a point to its nearest street (cached by rounded position). */
  place(x: number, z: number): Place;
  /** Corner points from a to b along one pavement (side ±1), both ends included. */
  route(a: Place, b: Place, side: number): P[];
  /** Pavement point beside the street nearest (x, z), on the side (x, z) is on: where a door meets the street. */
  door(x: number, z: number): P;
  nodes: P[];
}

interface Seg {
  a: P;
  b: P;
  width: number;
}

function nearestOn(s: Seg, x: number, z: number): [number, number, number, number] {
  const dx = s.b[0] - s.a[0];
  const dz = s.b[1] - s.a[1];
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / len2));
  const px = s.a[0] + dx * t;
  const pz = s.a[1] + dz * t;
  return [t, px, pz, Math.hypot(px - x, pz - z)];
}

/** Binary min-heap of (dist, node) for Dijkstra. */
class Heap {
  d: number[] = [];
  n: number[] = [];
  push(d: number, n: number) {
    const { d: D, n: N } = this;
    let i = D.length;
    D.push(d);
    N.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (D[p] <= d) break;
      D[i] = D[p];
      N[i] = N[p];
      i = p;
    }
    D[i] = d;
    N[i] = n;
  }
  pop(): [number, number] {
    const { d: D, n: N } = this;
    const top: [number, number] = [D[0], N[0]];
    const ld = D.pop()!;
    const ln = N.pop()!;
    if (D.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= D.length) break;
        const c = l + 1 < D.length && D[l + 1] < D[l] ? l + 1 : l;
        if (D[c] >= ld) break;
        D[i] = D[c];
        N[i] = N[c];
        i = c;
      }
      D[i] = ld;
      N[i] = ln;
    }
    return top;
  }
  get size() {
    return this.d.length;
  }
}

export function buildWalkNet(streets: Street[]): WalkNet {
  const segs: Seg[] = [];
  for (const s of streets)
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1] as P;
      const b = s.points[i] as P;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) segs.push({ a, b, width: s.width });
    }

  // 1. cut every segment where it meets another (crossings and T-junctions within SNAP)
  const cuts: { t: number; p: P }[][] = segs.map((s) => [
    { t: 0, p: s.a },
    { t: 1, p: s.b },
  ]);
  const box = segs.map((s) => [Math.min(s.a[0], s.b[0]) - 2 * SNAP, Math.min(s.a[1], s.b[1]) - 2 * SNAP, Math.max(s.a[0], s.b[0]) + 2 * SNAP, Math.max(s.a[1], s.b[1]) + 2 * SNAP]);
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const A = box[i];
      const B = box[j];
      if (B[0] > A[2] || B[2] < A[0] || B[1] > A[3] || B[3] < A[1]) continue;
      const s1 = segs[i];
      const s2 = segs[j];
      const r = [s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]];
      const q = [s2.b[0] - s2.a[0], s2.b[1] - s2.a[1]];
      const den = r[0] * q[1] - r[1] * q[0];
      if (Math.abs(den) > 1e-9) {
        const t = ((s2.a[0] - s1.a[0]) * q[1] - (s2.a[1] - s1.a[1]) * q[0]) / den;
        const u = ((s2.a[0] - s1.a[0]) * r[1] - (s2.a[1] - s1.a[1]) * r[0]) / den;
        const tolT = SNAP / Math.hypot(r[0], r[1]);
        const tolU = SNAP / Math.hypot(q[0], q[1]);
        if (t >= -tolT && t <= 1 + tolT && u >= -tolU && u <= 1 + tolU) {
          const tc = Math.max(0, Math.min(1, t));
          const uc = Math.max(0, Math.min(1, u));
          const p: P = [s1.a[0] + r[0] * tc, s1.a[1] + r[1] * tc];
          cuts[i].push({ t: tc, p });
          cuts[j].push({ t: uc, p });
        }
      } else {
        // parallel: shared stretches only meet where an endpoint of one lies on the other
        for (const [k, other, ends] of [
          [i, s2, [s1.a, s1.b]],
          [j, s1, [s2.a, s2.b]],
        ] as [number, Seg, P[]][]) {
          ends.forEach((e, ei) => {
            const [t, px, pz, d] = nearestOn(other, e[0], e[1]);
            if (d > SNAP) return;
            cuts[k].push({ t: ei, p: e });
            cuts[k === i ? j : i].push({ t, p: [px, pz] });
          });
        }
      }
    }

  // 2. nodes: cut points merged within SNAP (spatial hash)
  const nodes: P[] = [];
  const hash = new Map<string, number[]>();
  const nodeOf = (p: P) => {
    const cx = Math.floor(p[0] / SNAP);
    const cz = Math.floor(p[1] / SNAP);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const n of hash.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(nodes[n][0] - p[0], nodes[n][1] - p[1]) <= SNAP) return n;
    nodes.push([p[0], p[1]]);
    const key = `${cx},${cz}`;
    hash.set(key, [...(hash.get(key) ?? []), nodes.length - 1]);
    return nodes.length - 1;
  };
  const adj: Map<number, number>[] = [];
  const widthOf = new Map<number, number>(); // edge key → carriageway width
  const ekey = (a: number, b: number) => (a < b ? a * 1e6 + b : b * 1e6 + a);
  const link = (a: number, b: number, w: number) => {
    if (a === b) return;
    const d = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
    (adj[a] ??= new Map()).set(b, Math.min(adj[a].get(b) ?? Infinity, d));
    (adj[b] ??= new Map()).set(a, Math.min(adj[b].get(a) ?? Infinity, d));
    const k = ekey(a, b);
    widthOf.set(k, Math.max(widthOf.get(k) ?? 0, w));
  };
  // each piece of each segment, for attaching places later
  const pieces: { a: number; b: number; seg: Seg }[] = [];
  segs.forEach((s, i) => {
    const ns = cuts[i].sort((x, y) => x.t - y.t).map((c) => nodeOf(c.p));
    for (let k = 1; k < ns.length; k++)
      if (ns[k] !== ns[k - 1]) {
        link(ns[k - 1], ns[k], s.width);
        pieces.push({ a: ns[k - 1], b: ns[k], seg: { a: nodes[ns[k - 1]], b: nodes[ns[k]], width: s.width } });
      }
  });
  for (let n = 0; n < nodes.length; n++) adj[n] ??= new Map();

  // 3. join detached pieces to the largest one through their closest node pair
  const comp = new Int32Array(nodes.length).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < nodes.length; s++) {
    if (comp[s] >= 0) continue;
    const c: number[] = [];
    const stack = [s];
    comp[s] = comps.length;
    while (stack.length) {
      const n = stack.pop()!;
      c.push(n);
      for (const m of adj[n].keys())
        if (comp[m] < 0) {
          comp[m] = comps.length;
          stack.push(m);
        }
    }
    comps.push(c);
  }
  if (comps.length > 1) {
    const order = comps.map((_, i) => i).sort((a, b) => comps[b].length - comps[a].length);
    const main = [...comps[order[0]]];
    for (const ci of order.slice(1)) {
      let best: [number, number, number] = [-1, -1, Infinity];
      for (const a of comps[ci])
        for (const b of main) {
          const d = (nodes[a][0] - nodes[b][0]) ** 2 + (nodes[a][1] - nodes[b][1]) ** 2;
          if (d < best[2]) best = [a, b, d];
        }
      if (best[0] >= 0) link(best[0], best[1], 3);
      main.push(...comps[ci]);
    }
  }
  const N = nodes.length;
  const adjArr = adj.map((m) => [...m.entries()]);

  // 4. spatial grid of pieces for nearest-street queries
  const grid = new Map<string, number[]>();
  pieces.forEach((p, i) => {
    const x0 = Math.floor(Math.min(p.seg.a[0], p.seg.b[0]) / CELL);
    const x1 = Math.floor(Math.max(p.seg.a[0], p.seg.b[0]) / CELL);
    const z0 = Math.floor(Math.min(p.seg.a[1], p.seg.b[1]) / CELL);
    const z1 = Math.floor(Math.max(p.seg.a[1], p.seg.b[1]) / CELL);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        const l = grid.get(k);
        if (l) l.push(i);
        else grid.set(k, [i]);
      }
  });
  const nearestPiece = (x: number, z: number): [number, number, number, number, number] => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: [number, number, number, number, number] = [-1, 0, x, z, Infinity];
    for (let r = 0; r < 60; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const i of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            const [t, px, pz, d] = nearestOn(pieces[i].seg, x, z);
            if (d < best[4]) best = [i, t, px, pz, d];
          }
        }
      // anything in a further ring is at least r * CELL away
      if (best[0] >= 0 && best[4] <= r * CELL) break;
    }
    return best;
  };

  // 5. shortest-path trees, one per source node, cached
  const trees = new Map<number, { dist: Float64Array; prev: Int32Array }>();
  const tree = (src: number) => {
    let t = trees.get(src);
    if (t) return t;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    dist[src] = 0;
    const h = new Heap();
    h.push(0, src);
    while (h.size) {
      const [d, u] = h.pop();
      if (d > dist[u]) continue;
      for (const [v, w] of adjArr[u]) {
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          h.push(nd, v);
        }
      }
    }
    t = { dist, prev };
    trees.set(src, t);
    return t;
  };

  // assigned below, before any place is made
  let self: WalkNet | undefined;
  const places = new Map<string, Place>();
  const placeList: Place[] = [];
  const place = (x: number, z: number): Place => {
    const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const hit = places.get(key);
    if (hit) return hit;
    const [i, , px, pz] = nearestPiece(x, z);
    const pc = pieces[Math.max(0, i)];
    const p: Place = {
      id: placeList.length,
      x,
      z,
      px,
      pz,
      u: pc.a,
      v: pc.b,
      du: Math.hypot(px - nodes[pc.a][0], pz - nodes[pc.a][1]),
      dv: Math.hypot(px - nodes[pc.b][0], pz - nodes[pc.b][1]),
      net: self!,
    };
    places.set(key, p);
    placeList.push(p);
    return p;
  };

  /** Centre-line corners a → b (projection to projection), with each piece's carriageway width. */
  const centreCache = new Map<number, { pts: P[]; widths: number[] }>();
  const centre = (a: Place, b: Place) => {
    const key = a.id * 100000 + b.id;
    const hit = centreCache.get(key);
    if (hit) return hit;
    let out: { pts: P[]; widths: number[] };
    const sameEdge = (a.u === b.u && a.v === b.v) || (a.u === b.v && a.v === b.u);
    if (sameEdge) {
      out = { pts: [[a.px, a.pz], [b.px, b.pz]], widths: [widthOf.get(ekey(a.u, a.v)) ?? 8] };
    } else {
      let best: [number, number, number] = [a.u, b.u, Infinity];
      for (const [sa, da] of [
        [a.u, a.du],
        [a.v, a.dv],
      ])
        for (const [sb, db] of [
          [b.u, b.du],
          [b.v, b.dv],
        ]) {
          const d = da + tree(sa).dist[sb] + db;
          if (d < best[2]) best = [sa, sb, d];
        }
      const [sa, sb] = best;
      const { prev } = tree(sa);
      const chain = [sb];
      for (let n = sb; n !== sa && prev[n] >= 0; ) chain.push((n = prev[n]));
      chain.reverse();
      const pts: P[] = [[a.px, a.pz]];
      const widths: number[] = [widthOf.get(ekey(a.u, a.v)) ?? 8];
      for (let k = 0; k < chain.length; k++) {
        pts.push(nodes[chain[k]]);
        if (k > 0) widths.push(widthOf.get(ekey(chain[k - 1], chain[k])) ?? 8);
      }
      widths.push(widthOf.get(ekey(b.u, b.v)) ?? 8);
      pts.push([b.px, b.pz]);
      out = { pts, widths };
    }
    // drop zero-length pieces (projections that sit on a node)
    const pts: P[] = [out.pts[0]];
    const widths: number[] = [];
    for (let k = 1; k < out.pts.length; k++) {
      if (Math.hypot(out.pts[k][0] - pts[pts.length - 1][0], out.pts[k][1] - pts[pts.length - 1][1]) < 0.3) continue;
      pts.push(out.pts[k]);
      widths.push(out.widths[k - 1]);
    }
    out = { pts, widths };
    centreCache.set(key, out);
    return out;
  };

  const routeCache = new Map<number, P[]>();
  const route = (a: Place, b: Place, side: number): P[] => {
    const key = (a.id * 100000 + b.id) * 2 + (side > 0 ? 1 : 0);
    const hit = routeCache.get(key);
    if (hit) return hit;
    const { pts, widths } = centre(a, b);
    const walk: P[] = [[a.x, a.z]];
    if (pts.length >= 2) walk.push(...offsetLine(pts, widths, side));
    walk.push([b.x, b.z]);
    const out = douglasPeucker(simplify(walk), 1.2);
    routeCache.set(key, out);
    return out;
  };

  const door = (x: number, z: number): P => {
    const [i, , px, pz, d] = nearestPiece(x, z);
    if (i < 0) return [x, z];
    const off = pieces[i].seg.width / 2 + PAVEMENT;
    if (d < 1e-6) return [px, pz];
    return [px + ((x - px) / d) * off, pz + ((z - pz) / d) * off];
  };

  self = { place, route, door, nodes };
  return self;
}

/** The polyline moved sideways by half its carriageway + the pavement, left (side -1) or right (+1) of travel. */
function offsetLine(pts: P[], widths: number[], side: number): P[] {
  const n = pts.length - 1;
  const segs = Array.from({ length: n }, (_, k) => {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[k + 1];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    const ux = (bx - ax) / l;
    const uz = (bz - az) / l;
    const off = side * ((widths[k] ?? 8) / 2 + PAVEMENT);
    // right-hand normal of travel (x east, z north): (uz, -ux)
    const ox = uz * off;
    const oz = -ux * off;
    return { a: [ax + ox, az + oz] as P, b: [bx + ox, bz + oz] as P, ux, uz };
  });
  const out: P[] = [segs[0].a];
  for (let k = 1; k < n; k++) {
    const s = segs[k - 1];
    const t = segs[k];
    // miter: intersect the two offset lines; fall back to both ends on near-parallel or wild miters
    const den = s.ux * t.uz - s.uz * t.ux;
    if (Math.abs(den) > 1e-3) {
      const dx = t.a[0] - s.a[0];
      const dz = t.a[1] - s.a[1];
      const k1 = (dx * t.uz - dz * t.ux) / den;
      const m: P = [s.a[0] + s.ux * k1, s.a[1] + s.uz * k1];
      if (Math.hypot(m[0] - pts[k][0], m[1] - pts[k][1]) < 14) {
        out.push(m);
        continue;
      }
    }
    out.push(s.b, t.a);
  }
  out.push(segs[n - 1].b);
  return out;
}

/** Douglas–Peucker: drop corners within `tol` m of the line through their neighbours (fewer keyframes, same street). */
function douglasPeucker(pts: P[], tol: number): P[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, az] = pts[i];
    const [bx, bz] = pts[j];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    let worst = -1;
    let wd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k][0] - ax) * dz - (pts[k][1] - az) * dx) / len;
      if (d > wd) (wd = d), (worst = k);
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Drop repeats and points where the direction barely changes (keeps keyframes few). */
function simplify(pts: P[]): P[] {
  const out: P[] = [];
  for (const [i, p] of pts.entries()) {
    if (out.length && Math.hypot(out[out.length - 1][0] - p[0], out[out.length - 1][1] - p[1]) < 0.5) {
      // the destination itself always stays (it replaces a corner that close to it)
      if (i === pts.length - 1 && out.length > 1) out[out.length - 1] = p;
      continue;
    }
    if (out.length >= 2) {
      const [ax, az] = out[out.length - 2];
      const [bx, bz] = out[out.length - 1];
      const v1x = bx - ax;
      const v1z = bz - az;
      const v2x = p[0] - bx;
      const v2z = p[1] - bz;
      const cross = v1x * v2z - v1z * v2x;
      const dot = v1x * v2x + v1z * v2z;
      if (dot > 0 && Math.abs(cross) <= Math.sin((4 * Math.PI) / 180) * Math.hypot(v1x, v1z) * Math.hypot(v2x, v2z)) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}
