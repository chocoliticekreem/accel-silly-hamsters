// The built-in crash schedule, used until an incidents source calls setCrashSchedule(): a few road traffic
// collisions per fortnight at real junctions, mostly in the rush hours and late at night (same shape as the mock
// incidents generator). Deterministic per map. Also the junction corners where wheelie bins stand.
import type { CityMap, Street } from "../../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../../api/contract";
import { between, intBetween, rng, weighted } from "../../mock/rng";
import { buildStreetGraph } from "../../sim/streetGraph";
import type { CrashSpec } from "./crash";

export interface Junction {
  x: number;
  z: number;
  /** The crossing streets, widest first (at least one). */
  streets: Street[];
}

/** Unit direction (contract coords) of a street at its closest point to (x, z), and the distance to it. */
export function streetDirAt(s: Street, x: number, z: number): { dx: number; dz: number; dist: number } {
  let best = { dx: 0, dz: 1, dist: Infinity };
  for (let i = 0; i < s.points.length - 1; i++) {
    const [ax, az] = s.points[i];
    const [bx, bz] = s.points[i + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez || 1;
    const k = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
    const d = Math.hypot(x - (ax + ex * k), z - (az + ez * k));
    if (d < best.dist) {
      const len = Math.sqrt(len2);
      best = { dx: ex / len, dz: ez / len, dist: d };
    }
  }
  return best;
}

/** Streets passing within their half-width (+margin) of a point, widest first. */
export function streetsAt(map: CityMap, x: number, z: number, margin = 2): Street[] {
  return map.streets
    .filter((s) => s.width >= 7 && streetDirAt(s, x, z).dist < s.width / 2 + margin)
    .sort((a, b) => b.width - a.width);
}

/** Road junctions (≥ 3 ways, two named roads crossing), spread at least 70 m apart. */
export function junctions(map: CityMap): Junction[] {
  const roads = map.streets.filter((s) => s.width >= 7);
  const g = buildStreetGraph(roads);
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const cand: Junction[] = [];
  for (let n = 0; n < g.nodes.length; n++) {
    if (g.adj[n].length < 3) continue;
    const [x, z] = g.nodes[n];
    if (x < minX + 20 || x > maxX - 20 || z < minZ + 20 || z > maxZ - 20) continue;
    const streets = streetsAt(map, x, z, 1);
    if (streets.length < 2) continue;
    cand.push({ x, z, streets });
  }
  // widest crossings first, then spread out
  cand.sort((a, b) => b.streets[0].width + b.streets[1].width - (a.streets[0].width + a.streets[1].width) || a.x - b.x || a.z - b.z);
  const out: Junction[] = [];
  for (const j of cand) if (out.every((o) => Math.hypot(o.x - j.x, o.z - j.z) > 70)) out.push(j);
  return out.slice(0, 10);
}

/** Opening shot: the app starts on day 5 at 21:00; the first crash happens a few minutes after you press play. */
const DEMO_T = 4 * MINUTES_PER_DAY + 21 * 60 + 9;

export function fallbackSchedule(map: CityMap, js: Junction[], seed = 41): CrashSpec[] {
  if (!js.length) return [];
  const r = rng(seed);
  const out: CrashSpec[] = [];
  const cx = (map.bounds.minX + map.bounds.maxX) / 2;
  const cz = (map.bounds.minZ + map.bounds.maxZ) / 2;
  const central = js.reduce((a, b) => (Math.hypot(a.x - cx, a.z - cz) <= Math.hypot(b.x - cx, b.z - cz) ? a : b));
  out.push({ id: "rtc-demo", t: DEMO_T, x: central.x, z: central.z, durationMin: 55, severity: 2 });
  // hour-of-day weights: quiet small hours, morning and evening rush, Friday/Saturday late nights
  const hourW = [3, 3, 2.5, 1.5, 0.5, 0.5, 1, 3, 5, 4, 2, 2, 2.5, 2.5, 2, 2.5, 3.5, 5, 5, 3.5, 2.5, 2.5, 3, 3.5];
  for (let day = 0; day < DAYS_PER_RUN; day++) {
    const n = r() < 0.7 ? 1 : r() < 0.4 ? 2 : 0;
    for (let k = 0; k < n; k++) {
      const hour = weighted(r, hourW) + r();
      const j = js[Math.floor(r() * js.length)];
      const t = Math.round(day * MINUTES_PER_DAY + hour * 60);
      if (Math.abs(t - DEMO_T) < 180) continue;
      const sev = (r() < 0.6 ? 1 : r() < 0.75 ? 2 : 3) as 1 | 2 | 3;
      out.push({ id: `rtc-${day}-${k}`, t, x: j.x + between(r, -3, 3), z: j.z + between(r, -3, 3), durationMin: intBetween(r, 35, 70), severity: sev });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
