// Vehicles as physics bodies.
//
// Driving stays path-following (Traffic.tsx). The ~20 vehicles nearest the camera also get kinematic
// position-based bodies that follow their lane pose, so a wreck sliding into the next lane is shoved, not ghosted.
// On a crash the two vehicles involved switch to DYNAMIC bodies (real mass, low centre of mass, CCD), meet with
// their approach speeds, and an impact impulse at the contact point spins them; they skid on tyre friction and come
// to rest. Glass and bumper bits fly off as short-lived dynamic debris, skid marks are laid where tyres scrub,
// sparks and dust at impact, steam from a holed radiator, hazard lights blink, traffic queues either side, wheelie
// bins on the corner go over. When the scene clears the wrecks are towed (lifted and faded out) and the cars are
// handed back to Traffic, which grows them back in.
//
// Sources: crash.ts requests (triggerCrash/crashAt from other modules) and a sim-time schedule (the incidents
// module's via setCrashSchedule, else the built-in fallback in schedule.ts). Scrubbing into a crash's window shows
// it already at rest; 100× always snaps (no stepping).
import { useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { toScene } from "../../sim/geometry";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { activeCrashes, crashQueue, emitCrash, externalSchedule, type CrashInfo, type CrashRequest, type CrashSpec } from "./crash";
import { binsNear, resetBins, toppleBin } from "./Details";
import { engine, G, groups, PHYS_RATE, type Collider, type RigidBody, removeBody } from "./engine";
import { DecalPool, ParticlePool } from "./fx";
import { fallbackSchedule, streetDirAt, streetsAt, type Junction } from "./schedule";
import { trafficHolds, trafficVehicles, type TrafficVehicle, type VehicleOverride } from "./traffic";
import { makeParticleMesh, markParticlesDirty } from "./vfx";

const MAX_CRASHES = 4;
const DEBRIS_PER = 18;
const POOL = 20; // kinematic traffic bodies near the camera
const POOL_RADIUS = 160;
const TOW_SEC = 1.6;
/** Real seconds a scene stays at least, per speed (the sim window alone flashes by at 10×/100×). */
const MIN_SCENE_SEC: Record<number, number> = { 1: 0, 10: 7, 100: 2.5 };
const MASS: Record<string, number> = { bus: 11500, cab: 1850, car: 1400 };
const WHEEL_GAP = 0.3;

interface Wreck {
  v: TrafficVehicle;
  body: RigidBody;
  collider: Collider;
  ov: VehicleOverride;
  mass: number;
  /** Last skid mark point per wheel (x, z) ×4; NaN = lifted. */
  skid: Float32Array;
}

interface Debris {
  body: RigidBody;
  scale: Vector3;
  color: Color;
}

interface Crash {
  info: CrashInfo;
  owner: number;
  spec: CrashSpec | null;
  holdSec: number;
  wrecks: Wreck[];
  debris: Debris[];
  p: Vector3;
  dirA: Vector3;
  dirB: Vector3;
  severity: 1 | 2 | 3;
  /** Physics seconds since spawn. */
  physAge: number;
  /** Real seconds on screen while playing. */
  playAge: number;
  impacted: boolean;
  towAge: number;
  hold: { x: number; z: number };
  bins: { at: number; i: number; done: boolean }[];
  steamAcc: number;
}

const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const m4 = new Matrix4();
const v3 = new Vector3();
const s3 = new Vector3();
const zero = { x: 0, y: 0, z: 0 };
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

export default function Crashes({ junctions }: { junctions: Junction[] }) {
  const { world, rapier } = useRapier();
  const { map } = useWorld();
  const camera = useThree((s) => s.camera);
  const fallback = useMemo(() => fallbackSchedule(map, junctions), [map, junctions]);

  const fx = useMemo(() => {
    const sparks = new ParticlePool(220);
    const dust = new ParticlePool(140);
    const skids = new DecalPool(480);
    const unit = new BoxGeometry(1, 1, 1);
    const debrisMesh = new InstancedMesh(unit, new MeshStandardMaterial({ roughness: 0.35, metalness: 0.3 }), MAX_CRASHES * DEBRIS_PER);
    const hazardMesh = new InstancedMesh(new SphereGeometry(0.13, 8, 6), new MeshBasicMaterial({ color: new Color(2.4, 1.2, 0.1), toneMapped: false }), MAX_CRASHES * 8);
    const skidMesh = new InstancedMesh(
      new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: "#16171a", transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      skids.n,
    );
    for (const m of [debrisMesh, hazardMesh, skidMesh]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
    }
    debrisMesh.castShadow = true;
    debrisMesh.setColorAt(0, new Color());
    skidMesh.renderOrder = 2;
    return { sparks, dust, skids, debrisMesh, hazardMesh, skidMesh, sparkMesh: makeParticleMesh(sparks, true), dustMesh: makeParticleMesh(dust, false) };
  }, []);

  useEffect(
    () => () => {
      for (const m of [fx.debrisMesh, fx.hazardMesh, fx.skidMesh, fx.sparkMesh, fx.dustMesh]) {
        m.geometry.dispose();
        (m.material as MeshBasicMaterial).dispose();
      }
    },
    [fx],
  );

  const lastT = useRef(useSim.getState().t);

  useEffect(() => {
    const crashes = new Map<string, Crash>();
    /** Scheduled crashes already played out while their window is still open (don't respawn). */
    const done = new Set<string>();
    const pool = new Map<TrafficVehicle, { body: RigidBody; collider: Collider }>();
    let poolAge = 1;
    let ownerSeq = 0;

    // ---------- bodies ----------
    const carCollider = (v: TrafficVehicle, mass: number, member: number, filter: number) => {
      const hy = (v.height + WHEEL_GAP) / 2;
      const [W, H, L] = [v.width, v.height + WHEEL_GAP, v.length];
      return rapier.ColliderDesc.cuboid(v.width / 2, hy, v.length / 2)
        .setTranslation(0, hy, 0)
        // low centre of mass: engine, floorpan and axles sit low, so cars spin rather than roll
        .setMassProperties(mass, { x: 0, y: H * 0.36, z: 0 }, { x: (mass / 12) * (H * H + L * L), y: (mass / 12) * (W * W + L * L), z: (mass / 12) * (W * W + H * H) }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.75)
        .setRestitution(0.12)
        .setCollisionGroups(groups(member, filter));
    };

    const releasePooled = (v: TrafficVehicle) => {
      const p = pool.get(v);
      if (!p) return;
      pool.delete(v);
      try {
        removeBody(world, p.body);
      } catch {
        // freed
      }
    };

    /** Turn a vehicle into a dynamic wreck at pose (x, z, yaw) moving at `vel`. Re-uses its kinematic body. */
    const makeWreck = (v: TrafficVehicle, x: number, z: number, yaw: number, vel: Vector3): Wreck => {
      const mass = MASS[v.kind] ?? 1500;
      q.setFromAxisAngle(UP, yaw);
      const rot = { x: q.x, y: q.y, z: q.z, w: q.w };
      const pooled = pool.get(v);
      let body: RigidBody;
      let collider: Collider;
      if (pooled) {
        // the kinematic body becomes dynamic: same body, same collider, now with mass and a will of its own
        pool.delete(v);
        body = pooled.body;
        collider = pooled.collider;
        body.setBodyType(rapier.RigidBodyType.Dynamic, true);
        body.setTranslation({ x, y: 0.02, z }, true);
        body.setRotation(rot, true);
        collider.setCollisionGroups(groups(G.WRECK, G.STATIC | G.WRECK | G.TRAFFIC | G.PROP));
      } else {
        body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(x, 0.02, z).setRotation(rot));
        collider = world.createCollider(carCollider(v, mass, G.WRECK, G.STATIC | G.WRECK | G.TRAFFIC | G.PROP), body);
      }
      body.setLinearDamping(0.12);
      body.setAngularDamping(0.7);
      body.enableCcd(true);
      body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
      body.setAngvel(zero, true);
      const ov: VehicleOverride = { position: new Vector3(x, 0, z), quaternion: q.clone(), scale: 1 };
      v.override = ov;
      return { v, body, collider, ov, mass, skid: new Float32Array(8).fill(NaN) };
    };

    const pickVehicle = (px: number, pz: number, streetId: string | undefined, not: TrafficVehicle | null) => {
      let best: TrafficVehicle | null = null;
      let bd = Infinity;
      for (const v of trafficVehicles) {
        if (v === not || !v.shown || v.override) continue;
        const d = Math.hypot(v.x - px, v.z - pz) - (streetId && v.streetId === streetId ? 400 : 0);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
      return best;
    };

    // ---------- spawn ----------
    const spawn = (req: CrashRequest) => {
      if (crashes.size >= MAX_CRASHES || crashes.has(req.id)) return;
      const [px, pz] = toScene(req.x, req.z);
      const streets = streetsAt(map, req.x, req.z, 3);
      const sceneDir = (s: (typeof streets)[number] | undefined, out: Vector3) => {
        if (!s) return null;
        const d = streetDirAt(s, req.x, req.z);
        return out.set(d.dx, 0, -d.dz).normalize();
      };
      const a = req.a ?? pickVehicle(px, pz, streets[0]?.id, null);
      const b = req.b ?? pickVehicle(px, pz, streets[1]?.id, a);
      if (!a || !b || a.override || b.override) return;
      const r = hash(req.id);
      const sev = req.severity;
      const fwd = (v: TrafficVehicle) => new Vector3(Math.sin(v.heading), 0, Math.cos(v.heading));

      // approach directions: A along the main road (keeping its own direction of travel), B on the crossing street
      const dirA = sceneDir(streets[0], new Vector3()) ?? fwd(a);
      if (dirA.dot(fwd(a)) < 0) dirA.negate();
      let dirB = sceneDir(streets[1], new Vector3());
      let rearEnd = false;
      if (dirB) {
        if (b.streetId === streets[1].id ? dirB.dot(fwd(b)) < 0 : r < 0.5) dirB.negate();
      } else if (sev === 1) {
        dirB = dirA.clone(); // single road: a shunt from behind
        rearEnd = true;
      } else {
        dirB = dirA.clone().applyAxisAngle(UP, (r < 0.5 ? 1 : -1) * 1.35);
      }
      const p = new Vector3(px, 0, pz);
      const yawA = Math.atan2(dirA.x, dirA.z);
      const yawB = Math.atan2(dirB.x, dirB.z);
      const vA = Math.max(a.speed, 7) * (rearEnd ? 0.35 : 1);
      const vB = rearEnd ? vA + 7 + sev * 2 : 9 + sev * 2.5;
      const snap = req.mode === "snap";
      const s = r < 0.5 ? 1 : -1;

      let wa: Wreck;
      let wb: Wreck;
      if (!snap) {
        const ca = p.clone().addScaledVector(dirA, -a.length / 2);
        const cb = rearEnd
          ? ca.clone().addScaledVector(dirA, -(a.length / 2 + b.length / 2 + 1.4))
          : p.clone().addScaledVector(dirA, 0.3).addScaledVector(dirB, -(b.length / 2 + a.width / 2 + 0.8));
        wa = makeWreck(a, ca.x, ca.z, yawA, dirA.clone().multiplyScalar(vA));
        wb = makeWreck(b, cb.x, cb.z, yawB, dirB.clone().multiplyScalar(vB));
      } else {
        // resting pose: A shoved off line and turned, B stopped nose-in, turned the other way
        const ca = p.clone().addScaledVector(dirA, 1.5).addScaledVector(dirB, 1.6 + sev * 0.5);
        const cb = p.clone().addScaledVector(dirB, -(b.length / 2 + 0.4)).addScaledVector(dirA, 0.6);
        wa = makeWreck(a, ca.x, ca.z, yawA + s * (0.35 + sev * 0.3), new Vector3());
        wb = makeWreck(b, cb.x, cb.z, yawB - s * (0.2 + sev * 0.12), new Vector3());
      }

      const owner = ownerSeq++ % 30000;
      const info: CrashInfo = { id: req.id, x: req.x, z: req.z, vehicles: [a.id, b.id], phase: "impact", severity: sev };
      const hold = { x: px, z: pz };
      trafficHolds.push(hold);
      const crash: Crash = {
        info,
        owner,
        spec: req.spec,
        holdSec: req.holdSec,
        wrecks: [wa, wb],
        debris: [],
        p,
        dirA,
        dirB,
        severity: sev,
        physAge: 0,
        playAge: 0,
        impacted: false,
        towAge: -1,
        hold,
        bins: binsNear(px, pz, 13).map((i, k) => ({ at: 0.25 + k * 0.15, i, done: false })),
        steamAcc: 0,
      };
      crashes.set(req.id, crash);
      activeCrashes.set(req.id, info);
      if (snap) {
        for (const b of crash.bins) {
          b.done = true;
          toppleBin(b.i, px, pz, true);
        }
        impact(crash, true);
        for (const w of crash.wrecks) w.body.sleep();
        info.phase = "scene";
      }
    };

    /** The moment of impact: impulses at the contact, debris, sparks, dust. */
    const impact = (c: Crash, snap: boolean) => {
      c.impacted = true;
      const [wa, wb] = c.wrecks;
      const sev = c.severity;
      // contact point: A's flank where B's nose is
      const pa = wa.body.translation();
      const pb = wb.body.translation();
      const cp = new Vector3((pa.x + pb.x) / 2, 0.75, (pa.z + pb.z) / 2);
      if (!snap) {
        const vb = wb.body.linvel();
        const k = 0.35 + sev * 0.12;
        // B's momentum knocks A sideways at the contact point (off its centre → spin), with a little lift
        wa.body.applyImpulseAtPoint({ x: vb.x * wb.mass * k * 0.35, y: wa.mass * (0.4 + sev * 0.5), z: vb.z * wb.mass * k * 0.35 }, { x: cp.x, y: cp.y, z: cp.z }, true);
        // B bounces back and yaws away
        wb.body.applyImpulseAtPoint({ x: -vb.x * wb.mass * k * 0.25, y: wb.mass * 0.3, z: -vb.z * wb.mass * k * 0.25 }, { x: cp.x + c.dirA.x * 0.6, y: cp.y, z: cp.z + c.dirA.z * 0.6 }, true);
        wb.body.applyTorqueImpulse({ x: 0, y: (hash(c.info.id + "y") - 0.5) * wb.mass * 4 * sev, z: 0 }, true);
      }
      // debris: glass shards and bumper / trim bits, thrown out from the contact (or lying there, snapped)
      const r = hash(c.info.id + "d");
      let seed = Math.floor(r * 1e9);
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const glass = new Color("#cfe3ee");
      for (let i = 0; i < DEBRIS_PER; i++) {
        const isGlass = i < 11;
        const scale = isGlass ? new Vector3(0.1 + rnd() * 0.14, 0.012, 0.08 + rnd() * 0.1) : new Vector3(0.2 + rnd() * 0.5, 0.06, 0.08 + rnd() * 0.12);
        const color = isGlass ? glass : i % 3 === 0 ? c.wrecks[i % 2].v.color : new Color("#1d1f22");
        const ang = rnd() * Math.PI * 2;
        const out = new Vector3(Math.cos(ang), 0, Math.sin(ang));
        const spread = snap ? 1.5 + rnd() * 4 : 0.3;
        const x = cp.x + out.x * spread + c.dirB.x * (snap ? 1.5 : 0);
        const z = cp.z + out.z * spread + c.dirB.z * (snap ? 1.5 : 0);
        const body = world.createRigidBody(
          rapier.RigidBodyDesc.dynamic()
            .setTranslation(x, snap ? scale.y / 2 + 0.01 : 0.6 + rnd() * 0.5, z)
            .setRotation(snap ? { x: 0, y: Math.sin(ang), z: 0, w: Math.cos(ang) } : { x: rnd() - 0.5, y: rnd() - 0.5, z: rnd() - 0.5, w: 1 })
            .setLinearDamping(0.4)
            .setAngularDamping(0.6)
            .setCanSleep(true),
        );
        world.createCollider(
          rapier.ColliderDesc.cuboid(scale.x / 2, scale.y / 2, scale.z / 2)
            .setDensity(isGlass ? 2500 : 1100)
            .setFriction(0.8)
            .setRestitution(isGlass ? 0.25 : 0.15)
            .setCollisionGroups(groups(G.DEBRIS, G.STATIC)),
          body,
        );
        if (!snap) {
          const sp = 2.5 + rnd() * (4 + sev * 2);
          // thrown mostly along B's travel (what hit) and outwards, a little up
          body.setLinvel({ x: out.x * sp * 0.7 + c.dirB.x * sp * 0.6, y: 1 + rnd() * 3.5, z: out.z * sp * 0.7 + c.dirB.z * sp * 0.6 }, true);
          body.setAngvel({ x: (rnd() - 0.5) * 25, y: (rnd() - 0.5) * 25, z: (rnd() - 0.5) * 25 }, true);
        } else body.sleep();
        c.debris.push({ body, scale, color });
      }
      if (!snap) {
        for (let i = 0; i < 40 + sev * 25; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 3 + Math.random() * 8;
          fx.sparks.spawn({ x: cp.x, y: 0.6 + Math.random() * 0.4, z: cp.z, vx: Math.cos(a) * sp, vy: 1 + Math.random() * 5, vz: Math.sin(a) * sp, life: 0.25 + Math.random() * 0.5, size0: 0.16, size1: 0.03, r: 1, g: 0.75, b: 0.35, r1: 1, g1: 0.3, b1: 0.05, gravity: 14, drag: 1.5, owner: c.owner });
        }
        for (let i = 0; i < 10 + sev * 6; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 0.6 + Math.random() * 2.2;
          fx.dust.spawn({ x: cp.x, y: 0.4, z: cp.z, vx: Math.cos(a) * sp, vy: 0.3 + Math.random() * 0.8, vz: Math.sin(a) * sp, life: 1.6 + Math.random() * 1.6, size0: 0.8, size1: 3.2 + Math.random() * 1.5, alpha: 0.38, r: 0.62, g: 0.6, b: 0.56, gravity: -0.15, drag: 1.2, spin: (Math.random() - 0.5) * 0.8, owner: c.owner });
        }
      }
      emitCrash({ type: "impact", crash: c.info });
    };

    const remove = (c: Crash) => {
      for (const w of c.wrecks) {
        try {
          removeBody(world, w.body);
        } catch {
          // freed
        }
        w.v.override = null;
        w.v.respawnAt = performance.now();
        w.v.hold = 0;
      }
      for (const d of c.debris)
        try {
          removeBody(world, d.body);
        } catch {
          // freed
        }
      const hi = trafficHolds.indexOf(c.hold);
      if (hi >= 0) trafficHolds.splice(hi, 1);
      fx.skids.killOwner(c.owner);
      fx.sparks.killOwner(c.owner, 0.3);
      fx.dust.killOwner(c.owner, 0.6);
      resetBins(c.bins.map((b) => b.i));
      crashes.delete(c.info.id);
      activeCrashes.delete(c.info.id);
      emitCrash({ type: "cleared", crash: c.info });
    };

    const startTow = (c: Crash) => {
      if (c.towAge >= 0) return;
      c.towAge = 0;
      c.info.phase = "tow";
    };

    // ---------- kinematic traffic near the camera ----------
    const refreshPool = () => {
      const cx = camera.position.x;
      const cz = camera.position.z;
      const near = trafficVehicles
        .filter((v) => v.shown && !v.override && Math.hypot(v.x - cx, v.z - cz) < POOL_RADIUS + camera.position.y)
        .sort((u, w) => Math.hypot(u.x - cx, u.z - cz) - Math.hypot(w.x - cx, w.z - cz))
        .slice(0, POOL);
      const keep = new Set(near);
      for (const v of [...pool.keys()]) if (!keep.has(v)) releasePooled(v);
      for (const v of near) {
        if (pool.has(v)) continue;
        q.setFromAxisAngle(UP, v.heading);
        const body = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(v.x, 0, v.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
        const collider = world.createCollider(carCollider(v, MASS[v.kind] ?? 1500, G.TRAFFIC, G.WRECK | G.PROP | G.DEBRIS), body);
        pool.set(v, { body, collider });
      }
    };

    const syncPool = () => {
      for (const [v, p] of pool) {
        if (!v.shown || v.override) {
          releasePooled(v);
          continue;
        }
        q.setFromAxisAngle(UP, v.heading);
        p.body.setNextKinematicTranslation({ x: v.x, y: 0, z: v.z });
        p.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      }
    };

    // ---------- the schedule (sim time) ----------
    const runSchedule = () => {
      const { t, playing, speed } = useSim.getState();
      const prev = lastT.current;
      lastT.current = t;
      const list = externalSchedule().list ?? fallback;
      for (const spec of list) {
        const end = spec.t + spec.durationMin;
        const inWin = t >= spec.t && t < end;
        const c = crashes.get(spec.id);
        if (!inWin) done.delete(spec.id);
        if (c) {
          if (t < spec.t - 1) remove(c); // scrubbed back before it happened
          else if (t >= end && c.playAge >= (MIN_SCENE_SEC[speed] ?? 0)) startTow(c);
          continue;
        }
        if (!inWin || done.has(spec.id)) continue;
        const live = playing && prev < spec.t && PHYS_RATE[speed] > 0 && t - prev < 30;
        spawn({ kind: "crash", id: spec.id, a: null, b: null, x: spec.x, z: spec.z, severity: spec.severity ?? 2, holdSec: 0, mode: live ? "live" : "snap", spec, at: performance.now() });
      }
    };

    const pre = (dt: number) => {
      // requests from other modules
      while (crashQueue.length) {
        const req = crashQueue.shift()!;
        if (performance.now() - req.at > 5000) continue;
        if (req.kind === "clear") {
          const c = crashes.get(req.id);
          if (c) {
            if (c.spec) done.add(c.spec.id);
            if (req.immediate) remove(c);
            else startTow(c);
          }
        } else spawn(engine.snap ? { ...req, mode: "snap" } : req);
      }
      runSchedule();
      if ((poolAge += Math.max(dt, 0.016)) > 0.4) {
        poolAge = 0;
        refreshPool();
      }
      syncPool();
      if (dt <= 0) return;
      for (const c of crashes.values()) {
        c.physAge += dt;
        if (!c.impacted) {
          let touching = false;
          world.contactPair(c.wrecks[0].collider, c.wrecks[1].collider, (m) => {
            if (m.numContacts() > 0) touching = true;
          });
          if (touching || c.physAge > 0.45) impact(c, false);
        }
        for (const b of c.bins) {
          if (b.done || c.physAge < b.at || !c.impacted) continue;
          b.done = true;
          toppleBin(b.i, c.p.x, c.p.z, false);
        }
      }
    };

    // ---------- per frame: read back, lifecycle, draw ----------
    const corners = [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ];
    const post = (dt: number) => {
      const { playing } = useSim.getState();
      const realDt = playing ? Math.min(engine.frameDt, 0.1) : 0;
      let nh = 0;
      let nd = 0;
      const blink = Math.sin(performance.now() / 1000 * Math.PI * 2 * 1.4) > 0;
      for (const c of [...crashes.values()]) {
        c.playAge += realDt;
        // tow-away: lift and fade, then hand the cars back
        let fade = 1;
        if (c.towAge >= 0) {
          c.towAge += realDt;
          const k = Math.min(1, c.towAge / TOW_SEC);
          fade = 1 - k * k;
          if (k >= 1) {
            if (c.spec) done.add(c.spec.id);
            remove(c);
            continue;
          }
        } else if (!c.spec && c.playAge > c.holdSec) startTow(c);
        if (c.info.phase === "impact" && (c.physAge > 6 || c.wrecks.every((w) => w.body.isSleeping()))) c.info.phase = "scene";

        for (const w of c.wrecks) {
          const t = w.body.translation();
          const r = w.body.rotation();
          w.ov.position.set(t.x, t.y + (1 - fade) * 0.8, t.z);
          w.ov.quaternion.set(r.x, r.y, r.z, r.w);
          w.ov.scale = Math.max(0.001, fade);
          // hazard lights at the four corners, blinking together
          if (blink && fade > 0.2)
            for (const [cx, cz] of corners) {
              v3.set(cx * w.v.width * 0.47, w.v.height * 0.45 + WHEEL_GAP, cz * w.v.length * 0.49).applyQuaternion(w.ov.quaternion).add(w.ov.position);
              m4.compose(v3, w.ov.quaternion, s3.setScalar(fade));
              fx.hazardMesh.setMatrixAt(nh++, m4);
            }
          // skid marks where the tyres scrub (fast and not airborne)
          if (dt > 0 && c.towAge < 0) {
            const lv = w.body.linvel();
            const fast = Math.hypot(lv.x, lv.z) > 1.4 && t.y < 0.25;
            for (let k = 0; k < 4; k++) {
              const [cx, cz] = corners[k];
              v3.set(cx * w.v.width * 0.4, 0, cz * w.v.length * 0.33).applyQuaternion(w.ov.quaternion).add(w.ov.position);
              const lx = w.skid[k * 2];
              const lz = w.skid[k * 2 + 1];
              if (!fast) w.skid[k * 2] = NaN;
              else if (Number.isNaN(lx)) {
                w.skid[k * 2] = v3.x;
                w.skid[k * 2 + 1] = v3.z;
              } else if (Math.hypot(v3.x - lx, v3.z - lz) > 0.35) {
                fx.skids.add(lx, lz, v3.x, v3.z, 0.24, c.owner);
                w.skid[k * 2] = v3.x;
                w.skid[k * 2 + 1] = v3.z;
              }
            }
          }
        }
        // steam from A's radiator in a serious one
        if (c.severity >= 2 && c.impacted && realDt > 0 && fade > 0.5) {
          c.steamAcc += realDt;
          while (c.steamAcc > 0.12) {
            c.steamAcc -= 0.12;
            const w = c.wrecks[1];
            v3.set(0, w.v.height * 0.8 + WHEEL_GAP, w.v.length * 0.42).applyQuaternion(w.ov.quaternion).add(w.ov.position);
            fx.dust.spawn({ x: v3.x, y: v3.y, z: v3.z, vx: (Math.random() - 0.5) * 0.4, vy: 0.9 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.4, life: 1.8, size0: 0.35, size1: 1.8, alpha: 0.32, r: 0.92, g: 0.93, b: 0.95, gravity: -0.6, drag: 0.8, spin: 0.5, owner: c.owner });
          }
        }
        for (const d of c.debris) {
          if (nd >= fx.debrisMesh.instanceMatrix.count) break;
          const t = d.body.translation();
          const r = d.body.rotation();
          m4.compose(v3.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), s3.copy(d.scale).multiplyScalar(fade));
          fx.debrisMesh.setMatrixAt(nd, m4);
          fx.debrisMesh.setColorAt(nd++, d.color);
        }
      }
      fx.hazardMesh.count = nh;
      fx.hazardMesh.instanceMatrix.needsUpdate = true;
      fx.debrisMesh.count = nd;
      fx.debrisMesh.instanceMatrix.needsUpdate = true;
      if (fx.debrisMesh.instanceColor) fx.debrisMesh.instanceColor.needsUpdate = true;
      if (fx.skids.dirty) {
        fx.skids.dirty = false;
        let ns = 0;
        for (let i = 0; i < fx.skids.n; i++) {
          if (!fx.skids.alive[i]) continue;
          q.setFromAxisAngle(UP, fx.skids.yaw[i]);
          m4.compose(v3.set(fx.skids.x[i], 0.04, fx.skids.z[i]), q, s3.set(fx.skids.width[i], 1, fx.skids.len[i] + 0.05));
          fx.skidMesh.setMatrixAt(ns++, m4);
        }
        fx.skidMesh.count = ns;
        fx.skidMesh.instanceMatrix.needsUpdate = true;
      }
      fx.sparks.update(realDt);
      fx.dust.update(realDt);
      markParticlesDirty(fx.sparkMesh);
      markParticlesDirty(fx.dustMesh);
    };

    engine.pre.add(pre);
    engine.post.add(post);
    if (window.__physics) window.__physics.crashState = crashes;
    return () => {
      engine.pre.delete(pre);
      engine.post.delete(post);
      for (const c of [...crashes.values()]) remove(c);
      for (const v of [...pool.keys()]) releasePooled(v);
    };
  }, [world, rapier, map, fallback, camera, fx]);

  return (
    <group name="physics-crashes">
      <primitive object={fx.skidMesh} />
      <primitive object={fx.debrisMesh} />
      <primitive object={fx.hazardMesh} />
      <primitive object={fx.dustMesh} />
      <primitive object={fx.sparkMesh} />
    </group>
  );
}
