// The background crowd, strictly from the sim (drawn by world/modules/Footfall.tsx):
//  - crowdSize: how many walkers. The backend's mean count of sim citizens on the street in each hour of each day
//    (GET /api/runs/{run}/footfall) × the real people one sim citizen stands for (GET /api/health peoplePerAgent).
//  - legsOf / legsAround / pickOpenLeg / legIsStale: which trips they walk. Each walker repeats a leg of a sim citizen
//    who is out around now (entry → shop, shop → shop, shop → exit), never one into a shop that is shut, and takes a
//    new one once its own drifts away from the clock. So origins, destinations and their mix follow the run, the day
//    of the week and the shops' hours instead of a hand-made daily curve.
//  - clockSeconds / walkStep: how much playback ran this frame and how far walkers move in it, on the sim clock, at a
//    pace squeezed into a legible range.
import type { PreparedAgent } from "./interp";

/** One stretch of a sim citizen's trip on the street: from where it set off to the shop it went into, or out of the area. */
export interface Leg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Sim minutes: set off, arrived. */
  tA: number;
  tB: number;
  /** The shop it walked into; null when it left the area. */
  store: string | null;
}

/** The legs on the street around one moment, with running totals of their weights for weighted picks. */
export interface ActiveLegs {
  legs: Leg[];
  cum: number[];
}

/**
 * Walkers to draw at sim time `t`: the sim's mean count on the street × people per sim citizen, capped for
 * performance. Each hour's mean sits at the middle of its hour and `t` blends the two nearest, so the crowd follows
 * the clock instead of stepping on the hour. 0 for the whole of any hour the sim spent with nobody out, and without
 * data or a scale.
 */
export function crowdSize(onStreetByDayHour: number[][], t: number, peoplePerAgent: number, cap: number): number {
  const slots = onStreetByDayHour.length * 24;
  if (!slots || !(peoplePerAgent > 0) || !Number.isFinite(t)) return 0;
  const at = (slot: number) => {
    const s = Math.min(slots - 1, Math.max(0, slot));
    return onStreetByDayHour[Math.floor(s / 24)][s % 24] ?? 0;
  };
  // counts are never negative, so an hour whose mean is 0 had nobody on the street at any minute of it
  if (at(Math.floor(t / 60)) === 0) return 0;
  const x = t / 60 - 0.5;
  const k = Math.floor(x);
  const f = x - k;
  const agents = at(k) * (1 - f) + at(k + 1) * f;
  return Math.min(cap, Math.round(agents * peoplePerAgent));
}

/** Where an agent's keyframe path is at `t` (linear between keyframes, clamped to its ends). */
function positionAt(a: PreparedAgent, t: number): [number, number] {
  const ts = a.ts;
  const last = ts.length - 1;
  if (t <= ts[0]) return [a.xs[0], a.zs[0]];
  if (t >= ts[last]) return [a.xs[last], a.zs[last]];
  let i = 0;
  while (i < last - 1 && ts[i + 1] <= t) i++;
  const k = ts[i + 1] > ts[i] ? (t - ts[i]) / (ts[i + 1] - ts[i]) : 1;
  return [a.xs[i] + (a.xs[i + 1] - a.xs[i]) * k, a.zs[i] + (a.zs[i + 1] - a.zs[i]) * k];
}

/** Every agent's trip cut at its store visits: spawn → first shop → … → last shop → exit. Legs with no street time are dropped. */
export function legsOf(agents: PreparedAgent[]): Leg[] {
  const legs: Leg[] = [];
  for (const a of agents) {
    let tA = a.t0;
    let [ax, az] = positionAt(a, tA);
    for (let k = 0; k < a.visitsIn.length; k++) {
      const tB = a.visitsIn[k];
      const [bx, bz] = positionAt(a, tB);
      if (tB > tA) legs.push({ ax, az, bx, bz, tA, tB, store: a.visitStores[k] });
      tA = a.visitsOut[k];
      [ax, az] = positionAt(a, tA);
    }
    const [bx, bz] = positionAt(a, a.t1);
    if (a.t1 > tA) legs.push({ ax, az, bx, bz, tA, tB: a.t1, store: null });
  }
  return legs;
}

/** Legs with street time inside [t − half, t + half], each weighted by those minutes: the sim's street around `t`. */
export function legsAround(legs: Leg[], t: number, half: number): ActiveLegs {
  const out: Leg[] = [];
  const cum: number[] = [];
  let total = 0;
  for (const leg of legs) {
    const minutes = Math.min(leg.tB, t + half) - Math.max(leg.tA, t - half);
    if (minutes <= 0) continue;
    total += minutes;
    out.push(leg);
    cum.push(total);
  }
  return { legs: out, cum };
}

/** A leg drawn with probability ∝ its weight, for `u` uniform in [0, 1); null when no leg is active. */
export function pickLeg(active: ActiveLegs, u: number): Leg | null {
  const { legs, cum } = active;
  if (!legs.length) return null;
  const x = u * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > x) hi = mid;
    else lo = mid + 1;
  }
  return legs[lo];
}

/** A weighted pick that never heads into a shop in `shut`; null when nothing is active or `tries` picks all hit shut shops. */
export function pickOpenLeg(active: ActiveLegs, shut: ReadonlySet<string>, random: () => number, tries = 4): Leg | null {
  for (let i = 0; i < tries; i++) {
    const leg = pickLeg(active, random());
    if (!leg) return null;
    if (leg.store === null || !shut.has(leg.store)) return leg;
  }
  return null;
}

/**
 * Whether a walker repeating `leg` must take another one: it has none, its leg is more than `window` sim minutes from
 * the clock (over, or not started after a seek back), or the leg heads into a shop that is shut now.
 */
export function legIsStale(leg: Leg | null, t: number, window: number, shut: ReadonlySet<string>): boolean {
  return !leg || leg.tB < t - window || leg.tA > t + window || (leg.store !== null && shut.has(leg.store));
}

/** Longest stretch of real time one frame may cover; a bigger clock jump is a seek, not a stride. */
const MAX_FRAME_S = 0.25;
/** Pace doubles per tenfold playback speed. */
const PACE_GAIN = Math.log10(2);

/**
 * Real seconds of playback this frame: how long the clock ran, given it advanced `dtSim` sim minutes at `rate` sim
 * minutes per real second. 0 while it stands still (paused, end of the run) or jumps (a seek). Everything the crowd
 * animates runs on this, so a paused city stays exactly still.
 */
export function clockSeconds(dtSim: number, rate: number): number {
  if (!(dtSim > 0) || !(rate > 0)) return 0;
  const seconds = dtSim / rate;
  return seconds > MAX_FRAME_S ? 0 : seconds;
}

/**
 * Metres a walker moves this frame. Walkers move on the sim clock: not at all while it stands still (paused, seeking,
 * end of the run). The clock runs hundreds to thousands of times faster than life, far too fast to watch anyone walk,
 * so the on-screen pace only grows gently with playback speed: `pace` m/s at `baseRate`, ×2 at ten times that, ×4 at
 * a hundred. `dtSim`: sim minutes the clock advanced this frame; `rate`: sim minutes per real second right now.
 */
export function walkStep(dtSim: number, rate: number, baseRate: number, pace: number): number {
  const seconds = clockSeconds(dtSim, rate);
  if (!(seconds > 0) || !(baseRate > 0)) return 0;
  return seconds * pace * Math.pow(rate / baseRate, PACE_GAIN);
}
