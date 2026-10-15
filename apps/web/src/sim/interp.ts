// Agent playback: keyframes [t, x, z] → position at any t, with linear interpolation (contract rule).
// Agents exist only between their first and last keyframe and are hidden while inside a store.
// sampleAgent is called for every agent every frame, so it caches the last segment index and allocates nothing.
import type { AgentDay } from "../api/contract";

export interface PreparedAgent {
  id: string;
  persona: string;
  returning: boolean;
  ts: Float64Array;
  xs: Float32Array;
  zs: Float32Array;
  visitsIn: Float64Array;
  visitsOut: Float64Array;
  /** Store id of each visit (same index as visitsIn/visitsOut). */
  visitStores: string[];
  t0: number;
  t1: number;
  /** Cached segment index for the last sample. */
  seg: number;
  /** Small per-agent jitter so agents on the same street don't overlap (metres). */
  offX: number;
  offZ: number;
}

export interface Sample {
  visible: boolean;
  x: number;
  z: number;
  heading: number;
  moving: boolean;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/**
 * Merges consecutive day files into one trip list. A trip that crosses midnight is listed in both
 * day files with the same id and identical path (backend/CONTRACT_CHANGES.md), and a regular can make
 * two trips in one file, so a trip's identity is id + start time. Later files never re-add a trip.
 */
export function mergeDays(days: { agents: AgentDay[] }[]): AgentDay[] {
  const seen = new Set<string>();
  const out: AgentDay[] = [];
  for (const d of days)
    for (const a of d.agents) {
      const key = `${a.id}@${a.path[0]?.[0] ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  return out;
}

export function prepareAgents(agents: AgentDay[], opts: { jitter?: number } = {}): PreparedAgent[] {
  const jitter = opts.jitter ?? 2.5;
  return agents
    .filter((a) => a.path.length > 0)
    .map((a) => {
      const n = a.path.length;
      const ts = new Float64Array(n);
      const xs = new Float32Array(n);
      const zs = new Float32Array(n);
      a.path.forEach(([t, x, z], i) => {
        ts[i] = t;
        xs[i] = x;
        zs[i] = z;
      });
      const h1 = hash(a.id);
      const h2 = hash(a.id + "z");
      return {
        id: a.id,
        persona: a.persona,
        returning: a.returning,
        ts,
        xs,
        zs,
        visitsIn: Float64Array.from(a.visits.map((v) => v.tIn)),
        visitsOut: Float64Array.from(a.visits.map((v) => v.tOut)),
        visitStores: a.visits.map((v) => v.storeId),
        t0: ts[0],
        t1: ts[n - 1],
        seg: 0,
        offX: (h1 - 0.5) * 2 * jitter,
        offZ: (h2 - 0.5) * 2 * jitter,
      };
    });
}

const out: Sample = { visible: false, x: 0, z: 0, heading: 0, moving: false };

/** Returns a shared object: read it before the next call. */
export function sampleAgent(a: PreparedAgent, t: number): Sample {
  out.visible = false;
  out.moving = false;
  if (t < a.t0 || t > a.t1) return out;
  for (let i = 0; i < a.visitsIn.length; i++) if (t >= a.visitsIn[i] && t < a.visitsOut[i]) return out;

  const ts = a.ts;
  let i = a.seg;
  if (i >= ts.length - 1 || ts[i] > t) i = 0;
  while (i < ts.length - 2 && ts[i + 1] < t) i++;
  a.seg = i;

  const n = ts.length;
  if (n === 1) {
    out.visible = true;
    out.x = a.xs[0];
    out.z = a.zs[0];
    return out;
  }
  const ta = ts[i];
  const tb = ts[i + 1];
  const k = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 1;
  const dx = a.xs[i + 1] - a.xs[i];
  const dz = a.zs[i + 1] - a.zs[i];
  out.visible = true;
  out.x = a.xs[i] + dx * k + a.offX;
  out.z = a.zs[i] + dz * k + a.offZ;
  out.moving = dx !== 0 || dz !== 0;
  // heading: rotation about y so that +z local faces travel; 0 = north (+z), π/2 = east (+x)
  if (out.moving) out.heading = Math.atan2(dx, dz);
  return out;
}
