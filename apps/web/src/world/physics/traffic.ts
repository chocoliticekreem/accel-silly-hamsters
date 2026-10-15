// The bridge between the Traffic module (kinematic, path-following) and the physics layer.
// Traffic publishes one TrafficVehicle per car/bus and writes its pose every frame; physics reads them to drive
// kinematic bodies, and takes a vehicle over (override) when it crashes: Traffic then draws it where physics says,
// until it is towed away and handed back. Crash sites also hold traffic back (speedFactor).
// Scene coordinates throughout (x east, z = -north), heading = rotation.y (forward = local +z).
import { Color, Quaternion, Vector3 } from "three";

export interface VehicleOverride {
  position: Vector3;
  quaternion: Quaternion;
  /** 0..1 (tow-away fade). */
  scale: number;
}

export interface TrafficVehicle {
  id: number;
  kind: string;
  /** Length (along local z), height, width in metres. */
  length: number;
  height: number;
  width: number;
  color: Color;
  /** Street this vehicle drives (contract Street.id). */
  streetId: string;
  // ---- live, written by Traffic each frame ----
  x: number;
  z: number;
  heading: number;
  /** m/s along its heading right now. */
  speed: number;
  /** Drawn this frame (false late at night when the streets empty). */
  shown: boolean;
  // ---- written by physics ----
  /** Set while physics owns the vehicle (crashed / being towed). */
  override: VehicleOverride | null;
  /** performance.now() when it was handed back after a tow: Traffic scales it back in. */
  respawnAt: number;
  /** Smoothed traffic-hold factor (0 stopped .. 1 free), see speedFactor. */
  hold: number;
}

let nextId = 1;

export function newTrafficVehicle(kind: string, size: [number, number, number], color: Color, streetId: string): TrafficVehicle {
  const [length, height, width] = size;
  return { id: nextId++, kind, length, height, width, color, streetId, x: 0, z: 0, heading: 0, speed: 0, shown: false, override: null, respawnAt: -1e9, hold: 1 };
}

/** All published vehicles (every mounted Traffic module). */
export const trafficVehicles: TrafficVehicle[] = [];

/** Publish a Traffic module's vehicles; returns the unpublish function (use as an effect cleanup). */
export function publishTraffic(list: TrafficVehicle[]): () => void {
  trafficVehicles.push(...list);
  return () => {
    for (const v of list) {
      const i = trafficVehicles.indexOf(v);
      if (i >= 0) trafficVehicles.splice(i, 1);
    }
  };
}

/** Places traffic must stop short of (active crash scenes), scene coords. */
export const trafficHolds: { x: number; z: number }[] = [];

/**
 * How fast this vehicle may go (0..1 of its cruise speed): traffic queues behind a crash scene ahead of it in
 * either lane, then pulls away once the scene clears. Smoothed so cars brake and accelerate instead of snapping.
 */
export function speedFactor(v: TrafficVehicle, dt: number): number {
  let target = 1;
  if (trafficHolds.length) {
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    // stagger stop lines so a queue doesn't stack into one car
    const stop = 9 + (v.id % 4) * 6.5;
    for (const h of trafficHolds) {
      const dx = h.x - v.x;
      const dz = h.z - v.z;
      const along = dx * fx + dz * fz;
      const lateral = Math.abs(dx * fz - dz * fx);
      if (along < 5 || along > stop + 22 || lateral > 7) continue; // behind us, already through, or another street
      target = Math.min(target, Math.max(0, (along - stop) / 18));
    }
  }
  const k = Math.min(1, dt * (target < v.hold ? 3 : 0.8));
  v.hold += (target - v.hold) * k;
  return v.hold < 0.02 ? 0 : v.hold;
}

/** Scale for a vehicle just handed back after a tow (grows in over 0.7 s). */
export function respawnScale(v: TrafficVehicle, now = performance.now()): number {
  const k = (now - v.respawnAt) / 700;
  return k >= 1 ? 1 : Math.max(0.001, 1 - (1 - k) * (1 - k));
}
