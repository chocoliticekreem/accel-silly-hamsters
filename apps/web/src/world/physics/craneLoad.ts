// Crane hoist physics for the cranes module (world/modules/Construction.tsx).
//
// The crane module owns the steel: it slews the jib and runs the trolley kinematically, and every frame tells the
// load where the hook anchor (the trolley sheave) is. Physics does the rest: the hook block hangs on a rope joint
// (max length = rope out) and the load hangs off the hook on a spherical joint, so the pair swings as a real
// double pendulum when the jib slews or the trolley brakes, twists on the sling, and sets down on the ground.
//
//   const load = useCraneLoad({ ropeLength: 30, mass: 1500, size: [2.4, 1, 1.2] });
//   useFrame(() => { trolley.getWorldPosition(v); load.setAnchor(v.x, v.y, v.z); load.setRopeLength(rope); });
//   <CraneHoist load={load} cargo="bricks" />   // optional renderer (rope, hook block, slings, pallet)
//   // or draw your own from load.hook / load.position / load.quaternion
//
// With Rapier running (Runtime.tsx) the bodies live in the physics world; otherwise (?physics=off, WASM still
// loading, or no <PhysicsLayer>) a position-based double pendulum gives the same swing for almost nothing.
// Paused sim → frozen. 100× → hangs straight down (snap). Scene coordinates throughout.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Quaternion, Vector3 } from "three";
import { useSim } from "../../state/store";
import { PHYS_RATE } from "./engine";

export interface CraneLoadOptions {
  /** Hoist rope paid out, anchor → hook (m). */
  ropeLength: number;
  /** Load mass (kg). Default 1200. */
  mass?: number;
  /** Load box [width, height, depth] (m). Default a pallet of bricks, [1.6, 1.1, 1.2]. */
  size?: [number, number, number];
  /** Sling length from the hook to the top of the load (m). Default 1.8. */
  sling?: number;
}

export interface CraneLoad {
  /** Hook anchor (trolley) position. Write it with setAnchor every frame. */
  readonly anchor: Vector3;
  readonly ropeLength: number;
  /** Hook block centre. */
  readonly hook: Vector3;
  /** Load centre and orientation. */
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly size: [number, number, number];
  readonly sling: number;
  readonly mass: number;
  /** True while the Rapier world is simulating it (false: the cheap pendulum fallback). */
  readonly physical: boolean;
  setAnchor(x: number, y: number, z: number): void;
  /** Hoist (shorter) or lower (longer). The load is lifted/lowered smoothly by the rope constraint. */
  setRopeLength(m: number): void;
  /** Hang straight down at rest under the anchor right now (e.g. after a big teleport of the crane). */
  settle(): void;
  dispose(): void;
}

/** Hook block half-height (m): the rope ties on at its top, the slings at its bottom. */
export const HOOK_HALF = 0.35;

export class CraneLoadImpl implements CraneLoad {
  readonly anchor = new Vector3();
  readonly hook = new Vector3();
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly size: [number, number, number];
  readonly sling: number;
  readonly mass: number;
  ropeLength: number;
  physical = false;
  disposed = false;
  /** Bumped when the rope length changes (the runtime rebuilds the rope joint). */
  ropeVersion = 0;
  settleRequested = true;
  /** Opaque Rapier handles, owned by the runtime. */
  rt: unknown = null;
  // position-based fallback state
  private hp = new Vector3();
  private lp = new Vector3();
  private yaw = 0;

  constructor(o: CraneLoadOptions) {
    this.ropeLength = Math.max(1, o.ropeLength);
    this.mass = o.mass ?? 1200;
    this.size = o.size ?? [1.6, 1.1, 1.2];
    this.sling = o.sling ?? 1.8;
  }

  setAnchor(x: number, y: number, z: number) {
    this.anchor.set(x, y, z);
  }
  setRopeLength(m: number) {
    const v = Math.max(1, m);
    if (Math.abs(v - this.ropeLength) < 1e-3) return;
    this.ropeLength = v;
    this.ropeVersion++;
  }
  settle() {
    this.settleRequested = true;
  }
  dispose() {
    this.disposed = true;
    craneLoads.delete(this);
  }

  /** Distance from the hook centre to the load centre. */
  get hang() {
    return HOOK_HALF + this.sling + this.size[1] / 2;
  }

  /** Straight-down rest pose under the anchor. */
  restPose() {
    this.hook.copy(this.anchor);
    this.hook.y -= this.ropeLength;
    this.position.copy(this.hook);
    this.position.y -= this.hang;
    // sitting on the ground: everything stacks up from y = 0
    const floor = this.size[1] / 2;
    if (this.position.y < floor) {
      this.position.y = floor;
      this.hook.y = Math.max(this.hook.y, floor + this.hang);
    }
    this.quaternion.setFromAxisAngle(UP, this.yaw);
    this.hp.copy(this.hook);
    this.lp.copy(this.position);
    this.settleRequested = false;
  }

  /** Position-based double pendulum (Verlet + distance constraints). Used when Rapier isn't driving the load. */
  fallbackStep(dt: number) {
    if (this.settleRequested) this.restPose();
    if (dt <= 0) return;
    const sub = 2;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      verlet(this.hook, this.hp, h, 0.998);
      verlet(this.position, this.lp, h, 0.998);
      for (let it = 0; it < 3; it++) {
        // sling: the heavy load barely moves, the light hook block gives
        maxDist(this.position, this.hook, this.hang, 0.15, 0.85);
        // rope: hook within ropeLength of the (kinematic) anchor, slack allowed
        maxDist(this.hook, this.anchor, this.ropeLength, 1, 0);
      }
      const floor = this.size[1] / 2;
      if (this.position.y < floor) {
        this.position.y = floor;
        this.lp.x += (this.position.x - this.lp.x) * 0.5; // ground friction
        this.lp.z += (this.position.z - this.lp.z) * 0.5;
        this.lp.y = floor;
      }
    }
    // tilt the load to hang along the sling, keep its yaw
    t0.subVectors(this.hook, this.position).normalize();
    q0.setFromUnitVectors(UP, t0);
    this.quaternion.setFromAxisAngle(UP, this.yaw).premultiply(q0);
  }
}

const UP = new Vector3(0, 1, 0);
const G = 9.81;
const t0 = new Vector3();
const t1 = new Vector3();
const q0 = new Quaternion();

function verlet(p: Vector3, prev: Vector3, h: number, damp: number) {
  t1.copy(p);
  p.x += (p.x - prev.x) * damp;
  p.y += (p.y - prev.y) * damp - G * h * h;
  p.z += (p.z - prev.z) * damp;
  prev.copy(t1);
}

/** Pull `a` (weight wa) and `b` (weight wb) together so |a - b| ≤ len. */
function maxDist(a: Vector3, b: Vector3, len: number, wa: number, wb: number) {
  t0.subVectors(a, b);
  const d = t0.length();
  if (d <= len || d < 1e-6) return;
  const k = (d - len) / d;
  a.addScaledVector(t0, -k * wa);
  b.addScaledVector(t0, k * wb);
}

/** Every live crane load; the physics runtime adopts them. */
export const craneLoads = new Set<CraneLoadImpl>();

/** Create a crane load (call dispose() when done). Prefer useCraneLoad inside a component. */
export function createCraneLoad(o: CraneLoadOptions): CraneLoad {
  const l = new CraneLoadImpl(o);
  craneLoads.add(l);
  return l;
}

/**
 * A crane load for the lifetime of the component. Options are read once (use setRopeLength to hoist).
 * Runs the fallback pendulum itself whenever Rapier isn't simulating it.
 */
export function useCraneLoad(o: CraneLoadOptions): CraneLoad {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useMemo(() => new CraneLoadImpl(o), []);
  useEffect(() => {
    load.disposed = false;
    craneLoads.add(load);
    return () => load.dispose();
  }, [load]);
  useFrame((_, delta) => {
    if (load.physical) return;
    const { playing, speed } = useSim.getState();
    if (playing && PHYS_RATE[speed] === 0) load.settle();
    load.fallbackStep(playing ? Math.min(delta, 0.1) * (PHYS_RATE[speed] || 1) : 0);
  });
  return load;
}
