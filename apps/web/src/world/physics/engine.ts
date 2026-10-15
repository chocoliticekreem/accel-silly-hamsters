// Physics engine state shared by every physics system and by the public APIs (crash.ts, craneLoad.ts).
// The Rapier world itself lives in Runtime.tsx (lazy-loaded WASM); this file holds no Rapier code, only types,
// so importing an API never pulls the WASM into the main bundle. ?physics=off disables the whole layer.
import type { RapierContext } from "@react-three/rapier";
import type { Speed } from "../../state/store";

// Rapier types come from @react-three/rapier's own copy of rapier3d-compat (another, older copy is in node_modules
// via @types/three, so never import types from "@dimforge/rapier3d-compat" directly).
export type Rapier = RapierContext["rapier"];
export type World = RapierContext["world"];
export type RigidBody = ReturnType<World["createRigidBody"]>;
export type Collider = ReturnType<World["createCollider"]>;
export type ImpulseJoint = ReturnType<World["createImpulseJoint"]>;

/** ?physics=off switches the layer off (no WASM load, no crashes, crane loads fall back to a cheap pendulum). */
export const PHYSICS_ON = typeof window === "undefined" || new URLSearchParams(window.location.search).get("physics") !== "off";

/** Fixed physics timestep (s). */
export const STEP = 1 / 60;
/** Most fixed steps per rendered frame: a slow frame drops physics time instead of spiralling. */
export const MAX_SUBSTEPS = 3;
/**
 * Physics seconds per real second at each playback speed. Physics is ambience at street scale, so it runs near
 * real time; 10× hurries it a little so a crash settles inside the shorter scene; 100× doesn't step at all: things
 * snap to their resting pose instead ("snap" mode).
 */
export const PHYS_RATE: Record<Speed, number> = { 1: 1, 10: 1.5, 100: 0 };

/** Collision groups (membership bits). */
export const G = { STATIC: 1, TRAFFIC: 2, WRECK: 4, DEBRIS: 8, PROP: 16, CRANE: 32, LITTER: 64 } as const;
/** Rapier interaction groups: what I am, what I collide with. */
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

type Hook = (dt: number) => void;

export const engine = {
  world: null as World | null,
  rapier: null as Rapier | null,
  /** Physics seconds stepped this frame (0 when paused or snapping). */
  dt: 0,
  /** Real seconds since the last frame (for VFX that run in real time). */
  frameDt: 0.016,
  /** The sim is paused: nothing moves. */
  paused: true,
  /** 100×: no stepping; systems place things at rest. */
  snap: false,
  /** Run before the world steps (set kinematic targets, apply forces). `dt` = physics seconds about to be stepped. */
  pre: new Set<Hook>(),
  /** Run after the world steps, every frame even when nothing stepped (read poses, write instance matrices). */
  post: new Set<Hook>(),
  stats: { stepMs: 0, stepMsAvg: 0, stepMsMax: 0, bodies: 0, colliders: 0, awake: 0, substeps: 0 },
};

declare global {
  interface Window {
    /** Debug handle: window.__physics.stats, .crash(), .crashes */
    __physics?: Record<string, unknown>;
  }
}
