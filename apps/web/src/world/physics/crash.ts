// Public crash API for other modules (the incidents/police module, debug tools).
//
//   triggerCrash(a, b, at)       two specific vehicles collide at `at` (contract coords {x, z}) right now
//   crashAt(x, z, opts)          a collision at a place: physics picks the two nearest cars on the crossing streets
//   setCrashSchedule(list)       hand over a sim-time schedule (e.g. incidents of kind "collision"); replaces the
//                                built-in fallback (a few junction crashes per fortnight). null → back to fallback.
//   clearCrash(id)               tow it away now
//   onCrash(fn)                  impact / cleared events (to sync sirens, cordons, headlines...)
//   activeCrashes                what is on the street right now
//
// Scheduled crashes are deterministic in sim time: scrubbing into an incident shows the wreck already at rest;
// playing through its start time shows the impact. Everything here is plain data: the Rapier side (Crashes.tsx)
// consumes the queue, so importing this never loads the physics WASM. With ?physics=off every call is a no-op.
import { PHYSICS_ON } from "./engine";
import { trafficVehicles, type TrafficVehicle } from "./traffic";

/** A crash on a sim-time schedule. Contract coords (x east, z north). Mirrors Incident(kind "collision"). */
export interface CrashSpec {
  id: string;
  /** Sim minute of impact. */
  t: number;
  x: number;
  z: number;
  /** Sim minutes the scene stays before the tow (Incident.response.durationMin). */
  durationMin: number;
  /** 1 minor (a shunt) · 2 moderate · 3 serious (big spin, maybe a roll). */
  severity?: 1 | 2 | 3;
}

export interface CrashOptions {
  id?: string;
  severity?: 1 | 2 | 3;
  /** Real seconds the scene stays before the tow when not on a schedule (default 14). */
  holdSec?: number;
}

/** Internal: a request the physics runtime picks up next frame. */
export interface CrashRequest {
  kind: "crash" | "clear";
  id: string;
  a: TrafficVehicle | null;
  b: TrafficVehicle | null;
  /** Contract coords. */
  x: number;
  z: number;
  severity: 1 | 2 | 3;
  holdSec: number;
  /** "snap": appear already at rest (scrubbed into a scene, or 100×). */
  mode: "live" | "snap";
  spec: CrashSpec | null;
  at: number;
  immediate?: boolean;
}

export interface CrashInfo {
  id: string;
  /** Contract coords of the impact. */
  x: number;
  z: number;
  vehicles: number[];
  phase: "impact" | "scene" | "tow";
  severity: 1 | 2 | 3;
}

export type CrashEvent = { type: "impact" | "cleared"; crash: CrashInfo };

export const crashQueue: CrashRequest[] = [];
/** Crashes on the street right now (written by the physics runtime). */
export const activeCrashes = new Map<string, CrashInfo>();

let external: CrashSpec[] | null = null;
let version = 0;

/** Replace the built-in crash schedule (null restores it). Typically: incidents.filter(i => i.kind === "collision"). */
export function setCrashSchedule(list: CrashSpec[] | null) {
  external = list;
  version++;
}

/** Current external schedule and a version counter that bumps on every change. */
export const externalSchedule = () => ({ list: external, version });

let seq = 0;
const byId = (v: TrafficVehicle | number | null): TrafficVehicle | null =>
  v == null ? null : typeof v === "number" ? (trafficVehicles.find((x) => x.id === v) ?? null) : v;

/**
 * Two vehicles collide at `at` (contract coords). Vehicles are TrafficVehicle handles or their ids (from
 * trafficVehicles); either may be null to let physics pick the nearest. Returns the crash id, or null when
 * physics is off. The vehicles turn into dynamic bodies, spin and skid to rest, shed glass and bumper bits,
 * blink their hazards, and are towed away (fade out) when the scene clears; traffic queues behind it meanwhile.
 */
export function triggerCrash(a: TrafficVehicle | number | null, b: TrafficVehicle | number | null, at: { x: number; z: number }, opts: CrashOptions = {}): string | null {
  if (!PHYSICS_ON) return null;
  const id = opts.id ?? `crash-${++seq}`;
  crashQueue.push({ kind: "crash", id, a: byId(a), b: byId(b), x: at.x, z: at.z, severity: opts.severity ?? 2, holdSec: opts.holdSec ?? 14, mode: "live", spec: null, at: performance.now() });
  return id;
}

/** A collision at a place (contract coords): physics picks the two cars. */
export const crashAt = (x: number, z: number, opts: CrashOptions = {}) => triggerCrash(null, null, { x, z }, opts);

/** Tow a crash away now (immediate: no fade). */
export function clearCrash(id: string, immediate = false) {
  crashQueue.push({ kind: "clear", id, a: null, b: null, x: 0, z: 0, severity: 1, holdSec: 0, mode: "live", spec: null, at: performance.now(), immediate });
}

const listeners = new Set<(e: CrashEvent) => void>();
/** Subscribe to impact / cleared events; returns the unsubscribe function. */
export function onCrash(fn: (e: CrashEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitCrash(e: CrashEvent) {
  for (const fn of listeners) fn(e);
}
