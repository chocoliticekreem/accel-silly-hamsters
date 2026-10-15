// Pure helpers for public-safety incidents (docs/INCIDENTS.md), shared by the mock sim, the 3D modules and the UI.
// Place-based only: everything here takes a time and a place, never a person.
import type { HoursWindow, ScheduleEntry } from "../api/contract";
import { MINUTES_PER_DAY } from "../api/contract";
import type { Incident } from "../api/incidents";
import type { StreetGraph } from "./streetGraph";
import { weekdayIndex } from "./storeState";

/** Is the response on scene at sim minute t? */
export const isActive = (i: Incident, t: number) => t >= i.t && t < i.t + i.response.durationMin;

/**
 * First night a licence closure covers. A venue's night belongs to the day it opens, so an incident in the early
 * hours (before noon) of day D closes the venue from the evening of D; a later one from the next evening.
 */
export function closureStartDay(i: Pick<Incident, "day" | "t">): number {
  const minute = ((i.t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return minute < 12 * 60 ? i.day : i.day + 1;
}

/** The nights (opening days) a licence review keeps the venue shut, or [] when the incident closed nothing. */
export function closureNights(i: Incident): number[] {
  const n = i.effects.closedDays ?? 0;
  if (!i.effects.closedStoreId || n <= 0) return [];
  const start = closureStartDay(i);
  return Array.from({ length: n }, (_, k) => start + k);
}

/** The incident that has `storeId` shut by a licence review on the night of `day`, if any. */
export function licenceClosure(incidents: readonly Incident[], storeId: string, day: number): Incident | null {
  for (const i of incidents) if (i.effects.closedStoreId === storeId && closureNights(i).includes(day)) return i;
  return null;
}

/**
 * The venue's weekly schedule with licence-review nights shut (docs/OWNER_ACTIONS.md `schedule`): one entry per
 * change, so sim/storeState.ts (3D, UI and the mock's customers) reads the closure like any other closed day.
 * Closures longer than 6 nights are capped (the schedule is weekly).
 */
export function licenceSchedule(base: HoursWindow, nights: number[]): ScheduleEntry[] {
  const full = () => Array.from({ length: 7 }, () => ({ ...base }));
  const days = [...new Set(nights)].sort((a, b) => a - b);
  const out: ScheduleEntry[] = [{ fromDay: 1, week: full() }];
  let k = 0;
  while (k < days.length) {
    // a run of consecutive nights, at most 6
    let end = k;
    while (end + 1 < days.length && days[end + 1] === days[end] + 1 && end - k < 5) end++;
    const week: (HoursWindow | null)[] = full();
    for (let j = k; j <= end; j++) week[weekdayIndex(days[j])] = null;
    if (out[out.length - 1].fromDay === days[k]) out[out.length - 1].week = week;
    else out.push({ fromDay: days[k], week });
    out.push({ fromDay: days[end] + 1, week: full() });
    k = end + 1;
  }
  return out;
}

// ---------- the response on the street ----------

/** Metres per sim minute police drive at (~40 km/h through town). */
export const POLICE_M_PER_MIN = 670;
/** Shortest and longest drive to a call, in sim minutes (a response car is never there instantly). */
const MIN_DRIVE = 4;
const MAX_DRIVE = 9;

export interface Route {
  points: [number, number][];
  /** Cumulative metres at each point. */
  cum: number[];
  length: number;
}

export function makeRoute(points: [number, number][]): Route {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, cum, length: cum[cum.length - 1] };
}

/** Point and heading (contract coords, atan2(dx, dz)) `s` metres along a route. */
export function along(r: Route, s: number): { x: number; z: number; heading: number } {
  const p = r.points;
  if (p.length === 1) return { x: p[0][0], z: p[0][1], heading: 0 };
  const d = Math.max(0, Math.min(r.length, s));
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < d) i++;
  const seg = r.cum[i] - r.cum[i - 1] || 1;
  const k = (d - r.cum[i - 1]) / seg;
  const dx = p[i][0] - p[i - 1][0];
  const dz = p[i][1] - p[i - 1][1];
  return { x: p[i - 1][0] + dx * k, z: p[i - 1][1] + dz * k, heading: Math.atan2(dx, dz) };
}

/** Where response cars come from: the map edge entry nearest the city's south-west (towards Bishopsgate police station). */
export function policeBase(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }): [number, number] {
  return [bounds.minX + (bounds.maxX - bounds.minX) * 0.5, bounds.minZ];
}

/** Street route from `from` to the incident, ending at the kerb next to it. Always ends at (x, z). */
export function policeRoute(g: StreetGraph, from: [number, number], to: [number, number]): Route {
  const a = g.nearest(from[0], from[1]);
  const b = g.nearest(to[0], to[1]);
  const pts: [number, number][] = [from, ...g.route(a, b), to];
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
  return makeRoute(clean.length ? clean : [to]);
}

/** Minutes the drive to a call takes over this route. */
export const driveMinutes = (r: Route) => Math.max(MIN_DRIVE, Math.min(MAX_DRIVE, r.length / POLICE_M_PER_MIN));

/**
 * Where a response car is at sim minute t: driving in (dispatched at i.t), then parked at the scene until the
 * response ends. null outside that window. `offset` metres short of the scene (a second car parks behind).
 */
export function responseCarAt(i: Incident, r: Route, t: number, offset = 0): { x: number; z: number; heading: number; driving: boolean } | null {
  const end = i.t + i.response.durationMin;
  if (t < i.t || t >= end) return null;
  const drive = driveMinutes(r);
  const stop = Math.max(0, r.length - 9 - offset);
  const s = Math.min(1, (t - i.t) / drive) * stop;
  return { ...along(r, s), driving: t - i.t < drive };
}

/** Chase: a car pursued along the route over `minutes`, police `gap` m behind; afterwards both stopped at the end. */
export function chaseAt(r: Route, t0: number, minutes: number, t: number, gap = 22) {
  const k = Math.max(0, Math.min(1, (t - t0) / minutes));
  // ease out at the end: the car is boxed in
  const e = 1 - (1 - k) * (1 - k);
  const s = e * r.length;
  return { lead: along(r, s), police: along(r, Math.max(0, s - gap * (1 - e * 0.7))), moving: k < 1 };
}

// ---------- inside the venue ----------

export type FightPhase = "none" | "inside" | "door" | "outside";

/**
 * What a venue incident looks like at t: "inside" (a ring forms on the dancefloor, staff step in) for insideMin
 * before the call, "door" (staff walk it out) for the last 2 of those minutes, then "outside" while police attend.
 */
export function fightPhase(i: Incident, t: number): FightPhase {
  const inside = i.insideMin ?? 0;
  if (inside > 0 && t >= i.t - inside && t < i.t - Math.min(2, inside / 2)) return "inside";
  if (inside > 0 && t >= i.t - Math.min(2, inside / 2) && t < i.t) return "door";
  if (isActive(i, t)) return "outside";
  return "none";
}

// ---------- density (the Safety layer) ----------

/** Incident density on an n × n grid over the bounds (row 0 = minZ), each incident a severity-weighted blob. Max = 1. */
export function densityGrid(incidents: readonly Incident[], bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, n = 64, radius = 40): Float32Array {
  const g = new Float32Array(n * n);
  const w = (bounds.maxX - bounds.minX) / n;
  const h = (bounds.maxZ - bounds.minZ) / n;
  for (const i of incidents) {
    const cx = (i.x - bounds.minX) / w;
    const cz = (i.z - bounds.minZ) / h;
    const rx = radius / w;
    const rz = radius / h;
    for (let gz = Math.max(0, Math.floor(cz - 2 * rz)); gz <= Math.min(n - 1, Math.ceil(cz + 2 * rz)); gz++)
      for (let gx = Math.max(0, Math.floor(cx - 2 * rx)); gx <= Math.min(n - 1, Math.ceil(cx + 2 * rx)); gx++) {
        const d2 = ((gx + 0.5 - cx) / rx) ** 2 + ((gz + 0.5 - cz) / rz) ** 2;
        g[gz * n + gx] += i.severity * Math.exp(-d2);
      }
  }
  let max = 0;
  for (const v of g) max = Math.max(max, v);
  if (max > 0) for (let k = 0; k < g.length; k++) g[k] /= max;
  return g;
}

// ---------- copy ----------

/** Words incident copy must never use: graphic, sensational or about a person rather than a place. */
export const BANNED_TERMS = ["stab", "knife", "blood", "gore", "kill", "murder", "weapon", "gun", "shot", "dead", "victim", "suspect", "thug", "gang", "riot", "brutal", "horrific"];

/** "Police called · fight outside Basement 45" */
export function callLabel(i: Incident): string {
  const who = i.response.ambulance ? "Police and ambulance" : i.response.police ? "Police" : "Reported";
  const what = i.label.charAt(0).toLowerCase() + i.label.slice(1);
  return i.response.police || i.response.ambulance ? `${who} called · ${what}` : `${who} · ${what}`;
}
