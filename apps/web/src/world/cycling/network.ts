// The cycling network: which streets bikes may use, where the real cycle lanes are (OSM, public/areas/cycle.json),
// and routes along them. Routes keep to the left-hand kerb: each route carries its own "lane offset" per segment,
// in the painted cycle lane on main roads, a little out from the kerb on side streets, never mid-road.
// Contract coords throughout (x east, z north).
import type { CityMap, Street } from "../../api/contract";
import { frontage } from "../../sim/geometry";
import { buildStreetGraph, type StreetGraph } from "../../sim/streetGraph";
import { fetchJsonTracked } from "../../state/loading";

export interface CycleLane {
  name: string;
  kind: "track" | "lane" | "shared";
  side: string;
  oneway: boolean;
  points: [number, number][];
}
export interface Dock {
  name: string;
  kind: "santander" | "bay";
  x: number;
  z: number;
  capacity: number;
}
export interface CycleData {
  source: string;
  lanes: CycleLane[];
  docks: Dock[];
  parking: { x: number; z: number; capacity: number }[];
}

export const EMPTY_CYCLE: CycleData = { source: "", lanes: [], docks: [], parking: [] };

let pending: Promise<CycleData> | null = null;
/** public/areas/cycle.json, fetched once (empty data if it can't be read: everything falls back to map.streets). */
export function loadCycleData(): Promise<CycleData> {
  pending ??= fetchJsonTracked<CycleData>(`${import.meta.env.BASE_URL ?? "/"}areas/cycle.json`, "people", "cycle", { optional: true })
    .then((d) => d ?? EMPTY_CYCLE)
    .catch(() => EMPTY_CYCLE);
  return pending;
}

/** Streets too narrow for bikes (footways, pavements drawn as streets). */
const MIN_WIDTH = 5;

/** Centre-line distance (m) of the bike line on a street of width w, keeping left. */
export function laneOffset(w: number, lane: boolean) {
  if (w >= 12) return w / 2 - (lane ? 1.2 : 1.35);
  if (w >= 7) return w / 2 - 0.8;
  return Math.max(0.7, w / 2 - 0.7);
}

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
  name: string;
}

/** Uniform grid of segments for nearest-street lookups. */
class SegGrid {
  private cells = new Map<number, Seg[]>();
  constructor(private cell: number) {}
  private key(cx: number, cz: number) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }
  add(s: Seg) {
    const c = this.cell;
    const x0 = Math.floor(Math.min(s.ax, s.bx) / c);
    const x1 = Math.floor(Math.max(s.ax, s.bx) / c);
    const z0 = Math.floor(Math.min(s.az, s.bz) / c);
    const z1 = Math.floor(Math.max(s.az, s.bz) / c);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = this.key(x, z);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(s);
      }
  }
  /** Nearest segment within ~one cell of (x, z), and its distance. */
  nearest(x: number, z: number): [Seg | null, number] {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best: Seg | null = null;
    let bd = Infinity;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const s of this.cells.get(this.key(cx + i, cz + j)) ?? []) {
          const d = segDist(x, z, s);
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
    return [best, bd];
  }
}

function segDist(px: number, pz: number, s: Seg) {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz || 1;
  const k = Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / l2));
  return Math.hypot(px - s.ax - dx * k, pz - s.az - dz * k);
}

/** A planned ride: points along the street centre line, with each segment's bike-line offset. */
export interface Route {
  points: [number, number][];
  /** Offset (m, to the left of travel) of the bike line on each segment. */
  offsets: number[];
  /** Width of each segment's street (overtaking only on wide roads). */
  widths: number[];
  /** Distance along the route of each junction passed (sorted), and how sharp the turn there is (0..1). */
  junctions: { s: number; turn: number; x: number; z: number }[];
  length: number;
  /** Share of the route on real cycle lanes (0..1). */
  laneShare: number;
}

export interface Network {
  graph: StreetGraph;
  /** Edge cost multipliers (cycle lanes cheaper), keyed a*N+b. */
  edgeWidth: Map<number, number>;
  edgeLane: Map<number, boolean>;
  degree: number[];
  route(points: [number, number][]): Route | null;
  nearestNode(x: number, z: number): number;
  streetName(x: number, z: number): string;
  /** A point on the pavement-side kerb of the nearest street to (x, z): [x, z, dirX, dirZ, width]. */
  kerb(x: number, z: number, inset: number): [number, number, number, number, number] | null;
}

export function buildNetwork(map: CityMap, data: CycleData): Network {
  const streets: Street[] = map.streets.filter((s) => s.width >= MIN_WIDTH && s.points.length >= 2);
  const graph = buildStreetGraph(streets);
  const N = graph.nodes.length;
  const streetGrid = new SegGrid(40);
  for (const s of streets)
    for (let i = 0; i < s.points.length - 1; i++)
      streetGrid.add({ ax: s.points[i][0], az: s.points[i][1], bx: s.points[i + 1][0], bz: s.points[i + 1][1], width: s.width, name: s.name });
  const laneGrid = new SegGrid(40);
  for (const l of data.lanes) {
    if (l.kind === "shared") continue;
    for (let i = 0; i < l.points.length - 1; i++)
      laneGrid.add({ ax: l.points[i][0], az: l.points[i][1], bx: l.points[i + 1][0], bz: l.points[i + 1][1], width: 2, name: l.name });
  }
  const edgeWidth = new Map<number, number>();
  const edgeLane = new Map<number, boolean>();
  const cost = new Map<number, number>();
  const degree = graph.adj.map((a) => a.length);
  for (let a = 0; a < N; a++)
    for (const [b, d] of graph.adj[a]) {
      const mx = (graph.nodes[a][0] + graph.nodes[b][0]) / 2;
      const mz = (graph.nodes[a][1] + graph.nodes[b][1]) / 2;
      const [s] = streetGrid.nearest(mx, mz);
      const w = s?.width ?? 8;
      // a cycle lane/track running along this edge (within the road's half-width + a bit)
      const [, ld] = laneGrid.nearest(mx, mz);
      const lane = ld < w / 2 + 4;
      edgeWidth.set(a * N + b, w);
      edgeLane.set(a * N + b, lane);
      cost.set(a * N + b, d * (lane ? 0.55 : w >= 12 ? 1 : w >= 7 ? 1.12 : 1.5));
    }

  // Dijkstra with a binary heap on the cycling costs
  const routeNodes = (from: number, to: number): number[] => {
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const heap: [number, number][] = [];
    const push = (n: number, d: number) => {
      heap.push([d, n]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    dist[from] = 0;
    push(from, 0);
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      if (u === to) break;
      for (const [v] of graph.adj[u]) {
        const nd = d + (cost.get(u * N + v) ?? Infinity);
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          push(v, nd);
        }
      }
    }
    if (dist[to] === Infinity) return [];
    const path: number[] = [];
    for (let n = to; n >= 0; n = prev[n]) path.push(n);
    return path.reverse();
  };

  const nearestNode = (x: number, z: number) => graph.nearest(x, z);

  const route = (via: [number, number][]): Route | null => {
    const nodes: number[] = [];
    for (let i = 0; i < via.length - 1; i++) {
      const a = nearestNode(via[i][0], via[i][1]);
      const b = nearestNode(via[i + 1][0], via[i + 1][1]);
      if (a === b) continue;
      const leg = routeNodes(a, b);
      if (!leg.length) return null;
      if (nodes.length && nodes[nodes.length - 1] === leg[0]) leg.shift();
      nodes.push(...leg);
    }
    // drop immediate back-and-forths (a via point off the through route)
    for (let i = 1; i < nodes.length - 1; i++)
      if (nodes[i - 1] === nodes[i + 1]) {
        nodes.splice(i, 2);
        i = Math.max(0, i - 2);
      }
    if (nodes.length < 2) return null;
    const points = nodes.map((n) => graph.nodes[n]);
    const widths: number[] = [];
    const offsets: number[] = [];
    let laneLen = 0;
    let length = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
      const k = nodes[i] * N + nodes[i + 1];
      const w = edgeWidth.get(k) ?? 8;
      const lane = edgeLane.get(k) ?? false;
      const d = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
      widths.push(w);
      offsets.push(laneOffset(w, lane));
      length += d;
      if (lane) laneLen += d;
    }
    const junctions: Route["junctions"] = [];
    let s = 0;
    for (let i = 1; i < nodes.length; i++) {
      s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      if (i < nodes.length - 1 && degree[nodes[i]] >= 3) {
        const ax = points[i][0] - points[i - 1][0];
        const az = points[i][1] - points[i - 1][1];
        const bx = points[i + 1][0] - points[i][0];
        const bz = points[i + 1][1] - points[i][1];
        const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
        junctions.push({ s, turn: Math.max(0, Math.min(1, (1 - cos) / 1.2)), x: points[i][0], z: points[i][1] });
      }
    }
    return { points, offsets, widths, junctions, length, laneShare: length ? laneLen / length : 0 };
  };

  return {
    graph,
    edgeWidth,
    edgeLane,
    degree,
    route,
    nearestNode,
    streetName(x, z) {
      const [s] = streetGrid.nearest(x, z);
      return s?.name ?? "";
    },
    kerb(x, z, inset) {
      const [s, d] = streetGrid.nearest(x, z);
      if (!s || d > 60) return null;
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l = Math.hypot(dx, dz) || 1;
      const k = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (l * l)));
      const cx = s.ax + dx * k;
      const cz = s.az + dz * k;
      // which side of the street the point is on
      let nx = dz / l;
      let nz = -dx / l;
      if ((x - cx) * nx + (z - cz) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const off = s.width / 2 + inset;
      return [cx + nx * off, cz + nz * off, dx / l, dz / l, s.width];
    },
  };
}

/** Pickup points for delivery riders: the doors of the map's stores (restaurants and bars first). */
export function storeDoors(map: CityMap): { name: string; x: number; z: number }[] {
  const byId = new Map(map.buildings.map((b) => [b.id, b]));
  const out: { name: string; x: number; z: number; food: boolean }[] = [];
  for (const s of map.stores) {
    const b = byId.get(s.buildingId);
    if (!b) continue;
    const f = frontage(b, map.streets);
    out.push({ name: s.name, x: f.doorX, z: f.doorZ, food: /rest|cafe|food|bar|pub|takeaway/i.test(String(s.type)) });
  }
  const food = out.filter((o) => o.food);
  return food.length >= 4 ? food : out;
}
