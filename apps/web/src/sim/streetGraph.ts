// A walkable graph from the map's street polylines, for routing the background crowd door to door.
// Nodes: every polyline vertex, merged within MERGE m, plus a node wherever two streets cross mid-segment.
// Edges: consecutive points along each street. Shortest paths: Dijkstra, cached per node pair.
import type { Street } from "../api/contract";

const MERGE = 2;

export interface StreetGraph {
  nodes: [number, number][];
  /** adjacency: node → [neighbour, metres][] */
  adj: [number, number][][];
  nearest(x: number, z: number): number;
  /** Routable nodes within `radius` m of (x, z), nearest first; at least the `atLeast` nearest ones. */
  near(x: number, z: number, radius: number, atLeast?: number): number[];
  /** Node path a → b as points (empty if unreachable). */
  route(a: number, b: number): [number, number][];
  /** Carriageway width (m) of each segment of route(a, b): one entry per consecutive point pair. */
  routeWidths(a: number, b: number): number[];
}

function segIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | null {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

export function buildStreetGraph(streets: Street[]): StreetGraph {
  // 1. split every street at crossings with other streets
  const lines = streets.map((s) => s.points.map((p) => [p[0], p[1]] as [number, number]));
  const splits = lines.map((pts) => pts.map(() => [] as { t: number; p: [number, number] }[]));
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      for (let a = 0; a < lines[i].length - 1; a++)
        for (let b = 0; b < lines[j].length - 1; b++) {
          const x = segIntersect(lines[i][a], lines[i][a + 1], lines[j][b], lines[j][b + 1]);
          if (!x) continue;
          const ti = Math.hypot(x[0] - lines[i][a][0], x[1] - lines[i][a][1]);
          const tj = Math.hypot(x[0] - lines[j][b][0], x[1] - lines[j][b][1]);
          splits[i][a].push({ t: ti, p: x });
          splits[j][b].push({ t: tj, p: x });
        }
  const chains = lines.map((pts, i) => {
    const out: [number, number][] = [];
    pts.forEach((p, k) => {
      out.push(p);
      splits[i][k].sort((u, v) => u.t - v.t).forEach((s) => out.push(s.p));
    });
    return out;
  });

  // 2. merge nearby points into nodes
  const nodes: [number, number][] = [];
  const nodeOf = (p: [number, number]) => {
    for (let n = 0; n < nodes.length; n++) if (Math.hypot(nodes[n][0] - p[0], nodes[n][1] - p[1]) < MERGE) return n;
    nodes.push(p);
    return nodes.length - 1;
  };
  const adj: [number, number][][] = [];
  // widest street using each edge (two streets can share a merged edge)
  const widths = new Map<string, number>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const link = (a: number, b: number, width: number) => {
    if (a === b) return;
    const key = edgeKey(a, b);
    const known = widths.get(key);
    widths.set(key, Math.max(known ?? 0, width));
    if (known !== undefined) return;
    const d = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
    (adj[a] ??= []).push([b, d]);
    (adj[b] ??= []).push([a, d]);
  };
  chains.forEach((c, i) => {
    let prev = nodeOf(c[0]);
    for (let k = 1; k < c.length; k++) {
      const n = nodeOf(c[k]);
      link(prev, n, streets[i].width);
      prev = n;
    }
  });
  for (let n = 0; n < nodes.length; n++) adj[n] ??= [];

  const cache = new Map<number, number[]>();
  const N = nodes.length;
  const routeNodes = (a: number, b: number): number[] => {
    const key = a * N + b;
    const hit = cache.get(key);
    if (hit) return hit;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    dist[a] = 0;
    for (;;) {
      let u = -1;
      for (let n = 0; n < N; n++) if (!done[n] && dist[n] < Infinity && (u < 0 || dist[n] < dist[u])) u = n;
      if (u < 0 || u === b) break;
      done[u] = 1;
      for (const [v, w] of adj[u])
        if (dist[u] + w < dist[v]) {
          dist[v] = dist[u] + w;
          prev[v] = u;
        }
    }
    const path: number[] = [];
    if (dist[b] !== Infinity) for (let n = b; n >= 0; n = prev[n]) path.unshift(n);
    cache.set(key, path);
    return path;
  };
  return {
    nodes,
    adj,
    nearest(x, z) {
      let best = 0;
      let bd = Infinity;
      for (let n = 0; n < N; n++) {
        const d = (nodes[n][0] - x) ** 2 + (nodes[n][1] - z) ** 2;
        if (d < bd && adj[n].length) {
          bd = d;
          best = n;
        }
      }
      return best;
    },
    near(x, z, radius, atLeast = 1) {
      const all: [number, number][] = [];
      for (let n = 0; n < N; n++) if (adj[n].length) all.push([n, Math.hypot(nodes[n][0] - x, nodes[n][1] - z)]);
      all.sort((u, v) => u[1] - v[1]);
      return all.filter(([, d], k) => d <= radius || k < atLeast).map(([n]) => n);
    },
    route(a, b) {
      return routeNodes(a, b).map((n) => nodes[n]);
    },
    routeWidths(a, b) {
      const path = routeNodes(a, b);
      const out: number[] = [];
      for (let k = 1; k < path.length; k++) out.push(widths.get(edgeKey(path[k - 1], path[k])) ?? 8);
      return out;
    },
  };
}

// ---------- what people are doing at each hour (background crowd trip mix) ----------

export type TripKind = "toWork" | "fromWork" | "lunch" | "shopping" | "evening" | "nightOut" | "through";

/** Relative weight of each trip kind at an hour of the day (weekday shape; Shoreditch nightlife on top). */
export function tripMix(hour: number): Record<TripKind, number> {
  const h = ((hour % 24) + 24) % 24;
  const bump = (centre: number, width: number) => {
    const d = ((h - centre + 36) % 24) - 12; // wrapped distance in hours, -12..12
    return Math.exp(-(d * d) / (2 * width * width));
  };
  return {
    toWork: 5 * bump(8.5, 0.9),
    fromWork: 4 * bump(18, 1),
    lunch: 2.5 * bump(13, 0.7),
    shopping: 1.5 * bump(14.5, 2.5),
    evening: 2 * bump(20.5, 1.5),
    nightOut: 2.2 * bump(2.5, 1.2),
    through: 0.6 + 0.4 * bump(12, 4),
  };
}
