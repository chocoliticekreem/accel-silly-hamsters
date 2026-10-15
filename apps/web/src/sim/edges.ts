// The map edge is not a spawn wall: people and vehicles that leave the map keep going out along the street they
// left by (into the Surroundings network) and arrivals come in from out there. Purely visual: the sim's entry
// points, trips and counts are unchanged. Contract coords (x east, z north).
import type { CityMap, Street } from "../api/contract";
import type { PreparedAgent } from "./interp";
import { exitContinuations } from "./surroundings";

/** How far beyond the map edge people/vehicles keep going (m). */
export const OUT_REACH = 260;

/** The map's streets, with every end that leaves the map continued outward along its surroundings road. */
export function extendStreets(map: CityMap, length = OUT_REACH): Street[] {
  const cont = exitContinuations(map, length);
  const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  return map.streets.map((s) => {
    let pts = s.points.map((p) => [p[0], p[1]] as [number, number]);
    for (const c of cont) {
      if (!c.id.startsWith(`${s.id}~out`)) continue;
      const tail = c.points.slice(1) as [number, number][];
      if (near(pts[pts.length - 1], c.points[0] as [number, number])) pts = [...pts, ...tail];
      else if (near(pts[0], c.points[0] as [number, number])) pts = [...[...tail].reverse(), ...pts];
    }
    return { ...s, points: pts };
  });
}

/** Where a street entry point at (x, z) on the edge leads out to (the far end of its continuation), or null. */
export function outerPoint(map: CityMap, x: number, z: number, length = OUT_REACH): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = 6;
  for (const c of exitContinuations(map, length)) {
    const d = Math.hypot(c.points[0][0] - x, c.points[0][1] - z);
    if (d < bestD) {
      bestD = d;
      best = c.points[c.points.length - 1] as [number, number];
    }
  }
  return best;
}

/** Walking pace (sim metres per sim minute) for the made-up stretch outside the map. */
const PACE = 80;

/**
 * Agents whose trip starts (or ends) on the map edge walk in from (out to) `length` m along the street outside.
 * Adds keyframes before t0 / after t1; everything inside the map is untouched. Returns new objects only for
 * agents it changes.
 */
export function extendAgentEdges(agents: PreparedAgent[], map: CityMap, length = OUT_REACH): PreparedAgent[] {
  const cont = exitContinuations(map, length);
  const lead = (x: number, z: number) => {
    let best: [number, number][] | null = null;
    let bestD = 5;
    for (const c of cont) {
      const d = Math.hypot(c.points[0][0] - x, c.points[0][1] - z);
      if (d < bestD) {
        bestD = d;
        best = c.points as [number, number][];
      }
    }
    return best;
  };
  return agents.map((a) => {
    const n = a.ts.length;
    if (n === 0) return a;
    const inPath = lead(a.xs[0], a.zs[0]);
    const outPath = lead(a.xs[n - 1], a.zs[n - 1]);
    if (!inPath && !outPath) return a;
    const ts: number[] = [];
    const xs: number[] = [];
    const zs: number[] = [];
    if (inPath) {
      // walk the continuation backwards: far → perimeter → the edge point (keyframe 0)
      const pts = [...inPath].reverse().slice(0, -1);
      let t = a.ts[0];
      const back: [number, number, number][] = [];
      let prev: [number, number] = [a.xs[0], a.zs[0]];
      for (let k = pts.length - 1; k >= 0; k--) {
        t -= Math.hypot(pts[k][0] - prev[0], pts[k][1] - prev[1]) / PACE;
        back.push([t, pts[k][0], pts[k][1]]);
        prev = pts[k];
      }
      for (let k = back.length - 1; k >= 0; k--) {
        ts.push(back[k][0]);
        xs.push(back[k][1]);
        zs.push(back[k][2]);
      }
    }
    for (let i = 0; i < n; i++) {
      ts.push(a.ts[i]);
      xs.push(a.xs[i]);
      zs.push(a.zs[i]);
    }
    if (outPath) {
      let t = a.ts[n - 1];
      let prev: [number, number] = [a.xs[n - 1], a.zs[n - 1]];
      for (const p of outPath.slice(1)) {
        t += Math.hypot(p[0] - prev[0], p[1] - prev[1]) / PACE;
        ts.push(t);
        xs.push(p[0]);
        zs.push(p[1]);
        prev = p;
      }
    }
    return { ...a, ts: Float64Array.from(ts), xs: Float32Array.from(xs), zs: Float32Array.from(zs), t0: ts[0], t1: ts[ts.length - 1], seg: 0 };
  });
}
