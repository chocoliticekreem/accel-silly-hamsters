// Construction site on the Goodsyard void (decor only, never feeds sim data). Pure helpers for world/modules/Construction:
// - the site timetable: working hours (weekdays 07:30–17:30 with a lunch break, Saturday mornings, no Sunday work)
//   and lorry deliveries, all from the sim clock;
// - how far the building has got at sim time t (Day 1 = ground slab … topped out before the last day);
// - the site layout (building, tower cranes, laydown, lorry bay, gate) planned from the infill plan's site plots;
// - the tower-crane work cycle as a pose at `s` real seconds into a cycle, and a hook-pendulum integrator.
// Layout is in contract coords (x east, z north). The crane cycle works in any planar frame (the module uses scene).
import type { CityMap } from "../api/contract";
import { MINUTES_PER_DAY, RUN_MINUTES } from "../api/contract";
import { closestOnStreet } from "./geometry";
import { planInfill, type Grid, type Hoarding, type InfillPlan, type Rect } from "./infill";
import { weekdayIndex } from "./storeState";
import { dayOf, minuteOfDay } from "./time";

// ---------------------------------------------------------------- timetable

export interface Shift {
  /** Minutes of the day. */
  start: number;
  end: number;
  lunch?: [number, number];
}

const WEEKDAY_SHIFT: Shift = { start: 7 * 60 + 30, end: 17 * 60 + 30, lunch: [12 * 60 + 30, 13 * 60 + 15] };
const SATURDAY_SHIFT: Shift = { start: 8 * 60, end: 13 * 60 };

/** The shift worked on a (1-based) day: Monday–Friday full days, Saturday morning, Sunday none. Day 1 is a Monday. */
export function shiftFor(day: number): Shift | null {
  const wd = weekdayIndex(day);
  if (wd === 6) return null;
  return wd === 5 ? SATURDAY_SHIFT : WEEKDAY_SHIFT;
}

export type SiteState = "off" | "work" | "lunch";

export function siteState(t: number): SiteState {
  const s = shiftFor(dayOf(t));
  if (!s) return "off";
  const m = minuteOfDay(t);
  if (m < s.start || m >= s.end) return "off";
  if (s.lunch && m >= s.lunch[0] && m < s.lunch[1]) return "lunch";
  return "work";
}

/** Minutes of the shift actually worked (lunch excluded) between the start of a day and minute `m` of it. */
function workedToday(s: Shift | null, m: number): number {
  if (!s) return 0;
  const clamp = (x: number) => Math.max(s.start, Math.min(s.end, x));
  let w = clamp(m) - s.start;
  if (s.lunch) w -= Math.max(0, Math.min(clamp(m), s.lunch[1]) - s.lunch[0]);
  return Math.max(0, w);
}

/** Working minutes on site from the start of the run to t. */
export function workedMinutes(t: number): number {
  const tt = Math.max(0, Math.min(RUN_MINUTES, t));
  const day = Math.floor(tt / MINUTES_PER_DAY) + 1;
  let total = 0;
  for (let d = 1; d < day; d++) total += workedToday(shiftFor(d), MINUTES_PER_DAY);
  return total + workedToday(shiftFor(day), tt - (day - 1) * MINUTES_PER_DAY);
}

export const TOTAL_WORK_MINUTES = workedMinutes(RUN_MINUTES);

/** How many of `n` workers are on site: they drift in over the half hour before the shift and out after it. */
export function workersPresent(t: number, n: number): number {
  const s = shiftFor(dayOf(t));
  if (!s) return 0;
  const m = minuteOfDay(t);
  const k = Math.min((m - (s.start - 30)) / 30, (s.end + 30 - m) / 30);
  return Math.round(n * Math.max(0, Math.min(1, k)));
}

// ---------------------------------------------------------------- deliveries

const WEEKDAY_DELIVERIES = [7 * 60 + 50, 10 * 60 + 20, 13 * 60 + 40, 15 * 60 + 50];
const SATURDAY_DELIVERIES = [8 * 60 + 20, 11 * 60];
/** Sim minutes for each part of a lorry visit. */
export const LORRY_TIMES = { arrive: 6, unload: 40, depart: 5 };

export interface Delivery {
  /** Unique per delivery across the run (picks the cargo). */
  index: number;
  phase: "arrive" | "unload" | "depart";
  /** 0..1 through the phase. */
  p: number;
}

export function deliveriesFor(day: number): number[] {
  const wd = weekdayIndex(day);
  return wd === 6 ? [] : wd === 5 ? SATURDAY_DELIVERIES : WEEKDAY_DELIVERIES;
}

/** The lorry visit in progress at t, if any. */
export function deliveryAt(t: number): Delivery | null {
  const day = dayOf(t);
  const m = minuteOfDay(t);
  const list = deliveriesFor(day);
  const { arrive, unload, depart } = LORRY_TIMES;
  for (let k = 0; k < list.length; k++) {
    const x = m - list[k];
    if (x < 0 || x >= arrive + unload + depart) continue;
    const index = day * 10 + k;
    if (x < arrive) return { index, phase: "arrive", p: x / arrive };
    if (x < arrive + unload) return { index, phase: "unload", p: (x - arrive) / unload };
    return { index, phase: "depart", p: (x - arrive - unload) / depart };
  }
  return null;
}

// ---------------------------------------------------------------- the building

/** Storeys above the ground slab. */
export const LEVELS = 12;
export const FLOOR_H = 3.6;
export const SLAB_T = 0.3;
/** Build progress runs 0..PROGRESS_MAX: one unit per level (ground slab, then each storey), then the roof plant. */
export const PROGRESS_MAX = LEVELS + 1.5;

/** Build progress at t: proportional to hours worked, so it stands still at night and on Sunday. */
export function buildProgress(t: number): number {
  return (PROGRESS_MAX * workedMinutes(t)) / TOTAL_WORK_MINUTES;
}

/** Slabs poured (ground slab included): slab 0 after a quarter of day 1's level, slab k once storey k's columns are up. */
export function slabCount(p: number): number {
  if (p < 0.25) return 0;
  return 1 + Math.max(0, Math.min(LEVELS, Math.floor(p - 0.7)));
}

/** 0..1 height of storey k's columns (k >= 1): they rise over the first 60% of the level. */
export function columnFrac(p: number, k: number): number {
  if (k < 1 || k > LEVELS || slabCount(p) < k) return 0;
  return Math.max(0, Math.min(1, (p - k) / 0.6));
}

/** Top of the highest slab (the working deck), metres above ground. */
export function deckHeight(p: number): number {
  const n = slabCount(p);
  return n === 0 ? 0 : (n - 1) * FLOOR_H + SLAB_T;
}

export const isToppedOut = (p: number) => p >= LEVELS + 1;
/** 0..1: roof plant room going up once the frame is topped out. */
export const roofFrac = (p: number) => Math.max(0, Math.min(1, (p - (LEVELS + 1)) / 0.5));

// ---------------------------------------------------------------- layout

export interface P2 {
  x: number;
  z: number;
}

export interface CraneSpec extends P2 {
  /** Mast height (top of the tower, where the slewing unit sits). */
  h: number;
  jib: number;
  /** Laydown spot this crane picks from when there is no lorry for it. */
  pick: P2;
  /** Picks from the lorry bed when a lorry is unloading. */
  lorry: boolean;
}

export interface SiteLayout {
  /** Biggest rectangle of site ground. */
  rect: Rect;
  /** Building footprint (axis-aligned, contract coords). */
  building: Rect;
  cranes: CraneSpec[];
  /** Laydown stacks: one per load type (index = LoadKind order). */
  laydown: P2[];
  /** Lorry parking spot (cab end) and unit heading (direction the lorry faces when parked). */
  bay: P2 & { hx: number; hz: number };
  /** Gate: centre on the hoarding line, outward unit normal (toward the street), the hoarding pieces it replaces. */
  gate: P2 & { nx: number; nz: number; pieces: Hoarding[] };
  /** Lorry routes (contract coords) street → bay and bay → street. */
  inPath: [number, number][];
  outPath: [number, number][];
  /** Welfare cabins (centre, alongX). */
  cabins: (P2 & { alongX: boolean })[];
  /** Floodlight masts. */
  lights: P2[];
  /** Ground waypoints for the gang (laydown, bay, building corners, cabins). */
  groundSpots: P2[];
}

export const LOAD_KINDS = ["beams", "bricks", "skip", "panels"] as const;
export type LoadKind = (typeof LOAD_KINDS)[number];

/** Site cells from the plan's "site" plots. */
function siteCells(g: Grid, plan: InfillPlan): Set<number> {
  const set = new Set<number>();
  for (const p of plan.plots) {
    if (p.kind !== "site") continue;
    const i0 = Math.round((p.x - p.w / 2 - g.x0) / g.cell);
    const j0 = Math.round((p.z - p.d / 2 - g.z0) / g.cell);
    for (let j = j0; j < j0 + Math.round(p.d / g.cell); j++) for (let i = i0; i < i0 + Math.round(p.w / g.cell); i++) set.add(j * g.nx + i);
  }
  return set;
}

/** Largest axis-aligned rectangle of cells in the set (histogram method). */
export function maxRect(g: Grid, set: Set<number>): { i: number; j: number; w: number; d: number } | null {
  const heights = new Array<number>(g.nx).fill(0);
  let best: { i: number; j: number; w: number; d: number } | null = null;
  for (let j = 0; j < g.nz; j++) {
    for (let i = 0; i < g.nx; i++) heights[i] = set.has(j * g.nx + i) ? heights[i] + 1 : 0;
    const stack: number[] = [];
    for (let i = 0; i <= g.nx; i++) {
      const h = i < g.nx ? heights[i] : 0;
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const hh = heights[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const w = i - left;
        if (hh > 0 && (!best || w * hh > best.w * best.d)) best = { i: left, j: j - hh + 1, w, d: hh };
      }
      stack.push(i);
    }
  }
  return best;
}

/** The two hoarding pieces nearest a street wide enough for a lorry: the site gate. */
export function gatePieces(map: CityMap, plan: InfillPlan): Hoarding[] {
  const streets = map.streets.filter((s) => s.width >= 8);
  if (!plan.hoardings.length || !streets.length) return [];
  const dist = (h: Hoarding) => Math.min(...streets.map((s) => closestOnStreet(s, h.x, h.z)[2]));
  let best = plan.hoardings[0];
  let bestD = Infinity;
  for (const h of plan.hoardings) {
    const d = dist(h);
    if (d < bestD) [best, bestD] = [h, d];
  }
  const cell = plan.grid.cell;
  const nb = plan.hoardings
    .filter((h) => h.alongX === best.alongX && Math.abs(Math.hypot(h.x - best.x, h.z - best.z) - cell) < 0.01 && (best.alongX ? h.z === best.z : h.x === best.x))
    .sort((a, b) => dist(a) - dist(b))[0];
  return nb ? [best, nb] : [best];
}

const planCache = new WeakMap<CityMap, InfillPlan>();
export function infillPlanFor(map: CityMap): InfillPlan {
  let p = planCache.get(map);
  if (!p) planCache.set(map, (p = planInfill(map)));
  return p;
}

/** Lay out the live construction site; null when the map has no site big enough. */
export function planSite(map: CityMap, plan: InfillPlan = infillPlanFor(map)): SiteLayout | null {
  const g = plan.grid;
  const cells = siteCells(g, plan);
  const mr = maxRect(g, cells);
  if (!mr || mr.w * g.cell < 36 || mr.d * g.cell < 30) return null;
  const rect: Rect = { x: g.x0 + (mr.i + mr.w / 2) * g.cell, z: g.z0 + (mr.j + mr.d / 2) * g.cell, w: mr.w * g.cell, d: mr.d * g.cell };
  const alongX = rect.w >= rect.d;
  const L = alongX ? rect.w : rect.d;
  const W = alongX ? rect.d : rect.w;

  // gate first: the lorry end of the site (laydown, bay, cabins) goes on the gate's side, the building away from it
  const pieces = gatePieces(map, plan);
  const gx = pieces.length ? pieces.reduce((a, h) => a + h.x, 0) / pieces.length : rect.x + (alongX ? L / 2 : 0);
  const gz = pieces.length ? pieces.reduce((a, h) => a + h.z, 0) / pieces.length : rect.z + (alongX ? 0 : L / 2);
  const gu = alongX ? gx - rect.x : gz - rect.z;
  const sgn = gu >= 0 ? 1 : -1;
  /** (u along the long axis toward the gate end, v across) → contract coords. */
  const at = (u: number, v: number): P2 => (alongX ? { x: rect.x + sgn * u, z: rect.z + v } : { x: rect.x + v, z: rect.z + sgn * u });

  const m = 5;
  const bl = Math.max(16, Math.min(34, L * 0.38, L - 2 * m - 40));
  const bw = Math.max(14, Math.min(24, W - 2 * m - 10));
  const ub = -L / 2 + m + bl / 2;
  const bc = at(ub, 0);
  const building: Rect = alongX ? { x: bc.x, z: bc.z, w: bl, d: bw } : { x: bc.x, z: bc.z, w: bw, d: bl };

  const c1u = ub + bl / 2 + 4.5;
  const edgeU = L / 2 - m;
  const lay = (u: number, v: number) => at(Math.min(u, edgeU - 2), Math.max(-W / 2 + m, Math.min(W / 2 - m, v)));
  const laydown = [lay(c1u + 12, 8), lay(c1u + 12, -3), lay(c1u + 17, -9), lay(c1u + 18, 3)];
  const cranes: CraneSpec[] = [{ ...at(c1u, 0), h: 60, jib: 46, pick: laydown[0], lorry: true }];
  if (W >= bw + 2 * m + 8 && L >= 60) {
    const c2 = at(ub - bl / 4, -(bw / 2 + 4.5));
    cranes.push({ ...c2, h: 53, jib: 40, pick: lay(c1u + 6, -(W / 2 - m - 1)), lorry: false });
  }

  const bayU = Math.min(c1u + 27, edgeU - 4);
  const bayP = at(bayU, 0);
  // gate geometry: outward normal from the site toward the street
  const cellSet = cells;
  let nx = 0;
  let nz = 0;
  if (pieces.length) {
    const p0 = pieces[0];
    const probe = (x: number, z: number) => {
      const i = Math.floor((x - g.x0) / g.cell);
      const j = Math.floor((z - g.z0) / g.cell);
      return cellSet.has(j * g.nx + i);
    };
    if (p0.alongX) nz = probe(p0.x, p0.z - g.cell / 2) ? 1 : -1;
    else nx = probe(p0.x - g.cell / 2, p0.z) ? 1 : -1;
  } else if (alongX) nx = sgn;
  else nz = sgn;
  const gate = { x: gx, z: gz, nx, nz, pieces };
  const gateIn: [number, number] = [gx - nx * 9, gz - nz * 9];
  let hx = bayP.x - gateIn[0];
  let hz = bayP.z - gateIn[1];
  const hl = Math.hypot(hx, hz) || 1;
  hx /= hl;
  hz /= hl;
  const bay = { ...bayP, hx, hz };

  // out on the street: drive along it (on the left, UK) into the gate, and away the other way afterwards
  const streets = map.streets.filter((s) => s.width >= 8);
  let inPath: [number, number][] = [
    [gx + nx * 40, gz + nz * 40],
    [gx + nx * 3, gz + nz * 3],
  ];
  let outPath: [number, number][] = [
    [gx + nx * 3, gz + nz * 3],
    [gx + nx * 40, gz + nz * 40],
  ];
  if (streets.length) {
    let best = streets[0];
    let bp = closestOnStreet(best, gx, gz);
    for (const s of streets) {
      const c = closestOnStreet(s, gx, gz);
      if (c[2] < bp[2]) [best, bp] = [s, c];
    }
    // street direction near the closest point
    let dx = 1;
    let dz = 0;
    let bestSeg = Infinity;
    for (let k = 0; k < best.points.length - 1; k++) {
      const [ax, az] = best.points[k];
      const [bx, bz] = best.points[k + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const tt = Math.max(0, Math.min(1, ((bp[0] - ax) * (bx - ax) + (bp[1] - az) * (bz - az)) / (len * len)));
      const d = Math.hypot(ax + (bx - ax) * tt - bp[0], az + (bz - az) * tt - bp[1]);
      if (d < bestSeg) [bestSeg, dx, dz] = [d, (bx - ax) / len, (bz - az) / len];
    }
    // drive so the gate is on our left (UK): left of travel (dx, dz) is (-dz, dx); it must point toward the gate
    if (-dz * (gx - bp[0]) + dx * (gz - bp[1]) < 0) [dx, dz] = [-dx, -dz];
    const lane = Math.min(3, best.width / 4);
    const lx = -dz * lane;
    const lz = dx * lane;
    const S: [number, number] = [bp[0] + lx, bp[1] + lz];
    inPath = [[S[0] - dx * 70, S[1] - dz * 70], [S[0] - dx * 6, S[1] - dz * 6], [gx + nx * 3, gz + nz * 3]];
    outPath = [[gx + nx * 3, gz + nz * 3], [S[0] + dx * 6, S[1] + dz * 6], [S[0] + dx * 70, S[1] + dz * 70]];
  }
  inPath.push(gateIn, [bay.x, bay.z]);
  outPath.unshift([bay.x, bay.z], gateIn);

  const cabins = [
    { ...at(edgeU - 4, W / 2 - m - 2), alongX },
    { ...at(edgeU - 4, W / 2 - m - 5), alongX },
  ];
  const lights = [at(-L / 2 + 2, -W / 2 + 2), at(-L / 2 + 2, W / 2 - 2), at(L / 2 - 2, -W / 2 + 2), at(L / 2 - 2, W / 2 - 2)];
  const groundSpots = [
    ...laydown,
    at(bayU - 3, 3),
    at(bayU - 3, -3),
    at(ub - bl / 2 - 2, -bw / 2 - 2),
    at(ub + bl / 2 + 2, bw / 2 + 2),
    at(ub + bl / 2 + 2, -bw / 2 - 2),
    at(ub - bl / 2 - 2, bw / 2 + 2),
    at(edgeU - 8, W / 2 - m - 2),
  ];
  return { rect, building, cranes, laydown, bay, gate, inPath, outPath, cabins, lights, groundSpots };
}

// ---------------------------------------------------------------- crane cycle

/** One lift: where to pick up and set down, in polar coords around the mast (angle, radius) and hook heights. */
export interface CraneJob {
  pickA: number;
  pickR: number;
  /** Hook height when rigged to the load at the pick spot. */
  pickY: number;
  dropA: number;
  dropR: number;
  dropY: number;
  /** Travel height: clears the building and the load stacks. */
  clearY: number;
}

export type CraneStage = "rig" | "hoist" | "slew" | "trolley" | "lower" | "release" | "return" | "descend";
/** Real seconds per stage: cycles run in real time so they look right at every playback speed. */
export const STAGES: [CraneStage, number][] = [
  ["rig", 4],
  ["hoist", 6],
  ["slew", 9],
  ["trolley", 5],
  ["lower", 6],
  ["release", 3],
  ["return", 10],
  ["descend", 5],
];
export const CYCLE_S = STAGES.reduce((a, [, d]) => a + d, 0);

export interface CranePose {
  slew: number;
  radius: number;
  hookY: number;
  /** The load hangs from the hook. */
  loaded: boolean;
  /** The load has been set down at the drop spot (later stages of the cycle). */
  delivered: boolean;
  stage: CraneStage;
}

const ease = (k: number) => {
  const x = Math.max(0, Math.min(1, k));
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Shortest signed angle from a to b, in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Crane pose `s` real seconds into a cycle (wraps). */
export function cranePose(job: CraneJob, s: number): CranePose {
  let x = ((s % CYCLE_S) + CYCLE_S) % CYCLE_S;
  let i = 0;
  while (i < STAGES.length - 1 && x >= STAGES[i][1]) x -= STAGES[i++][1];
  const [stage, dur] = STAGES[i];
  const k = ease(x / dur);
  const dA = angleDelta(job.pickA, job.dropA);
  const out: CranePose = { slew: job.pickA, radius: job.pickR, hookY: job.pickY, loaded: true, delivered: false, stage };
  switch (stage) {
    case "rig":
      out.loaded = x / dur > 0.6; // slingers hook on, then take the weight
      break;
    case "hoist":
      out.hookY = lerp(job.pickY, job.clearY, k);
      break;
    case "slew":
      out.hookY = job.clearY;
      out.slew = job.pickA + dA * k;
      break;
    case "trolley":
      out.hookY = job.clearY;
      out.slew = job.dropA;
      out.radius = lerp(job.pickR, job.dropR, k);
      break;
    case "lower":
      out.slew = job.dropA;
      out.radius = job.dropR;
      out.hookY = lerp(job.clearY, job.dropY, k);
      break;
    case "release":
      out.slew = job.dropA;
      out.radius = job.dropR;
      out.hookY = job.dropY + ease((x / dur - 0.5) * 2) * 1.5;
      out.loaded = x / dur < 0.5;
      out.delivered = !out.loaded;
      break;
    case "return": {
      // up clear first, then slew and trolley back together
      const up = ease(x / (dur * 0.3));
      const go = ease((x / dur - 0.25) / 0.75);
      out.hookY = lerp(job.dropY + 1.5, job.clearY, up);
      out.slew = job.dropA - dA * go;
      out.radius = lerp(job.dropR, job.pickR, go);
      out.loaded = false;
      out.delivered = true;
      break;
    }
    case "descend":
      out.hookY = lerp(job.clearY, job.pickY, k);
      out.loaded = false;
      out.delivered = true;
      break;
  }
  return out;
}

/** Move `cur` toward `target` by at most `maxStep`. */
export function approach(cur: number, target: number, maxStep: number): number {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
}

/** Same for angles, the short way round. */
export function approachAngle(cur: number, target: number, maxStep: number): number {
  const d = angleDelta(cur, target);
  return Math.abs(d) <= maxStep ? cur + d : cur + Math.sign(d) * maxStep;
}

/** Where idle cranes point: free to slew, the jib weather-vanes downwind. Slowly varying with sim time. */
export function windAngle(t: number): number {
  return 0.9 + 0.5 * Math.sin(t / 1300) + 0.25 * Math.sin(t / 310 + 1.7);
}

// ---------------------------------------------------------------- hook pendulum

export interface Pendulum {
  /** Hook offset from straight below the trolley (horizontal, metres) and its velocity. */
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export const newPendulum = (): Pendulum => ({ x: 0, z: 0, vx: 0, vz: 0 });

/**
 * Advance a small-angle pendulum of cable length `len` whose suspension point accelerates by (ax, az).
 * In the trolley's frame the hook feels −a; gravity pulls it back under the trolley; a little damping.
 */
export function stepPendulum(p: Pendulum, ax: number, az: number, len: number, dt: number, damping = 0.25): Pendulum {
  const w2 = 9.81 / Math.max(1, len);
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let k = 0; k < n; k++) {
    p.vx += (-w2 * p.x - ax - damping * p.vx) * h;
    p.vz += (-w2 * p.z - az - damping * p.vz) * h;
    p.x += p.vx * h;
    p.z += p.vz * h;
  }
  // keep it believable however hard the trolley is yanked
  const lim = Math.max(0.3, len * 0.12);
  const r = Math.hypot(p.x, p.z);
  if (r > lim) {
    p.x *= lim / r;
    p.z *= lim / r;
  }
  return p;
}
