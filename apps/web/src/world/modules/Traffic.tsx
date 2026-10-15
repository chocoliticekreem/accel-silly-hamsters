// Module: Traffic (decorative). Red double-deckers on the main roads, black cabs, cars, white vans, the odd police
// car and ambulance, and hire bikes, driving the real streets on the left. The sim doesn't model traffic: this is
// ambience, not data, so it never feeds a KPI. Fewer vehicles late at night; lights glow after dark.
//
// Motion: every street is a closed "racetrack" loop: up the left lane, a U-turn at the junction, back down the
// other lane, a U-turn at the start. Vehicles on a loop keep their order and follow the one ahead with the
// intelligent driver model, so they never drive into each other; they give way at each end of the street (and
// wait until the junction is clear of other traffic), and buses dwell at a stop mid-street. Brake lights come on
// when a vehicle slows down.
// Draw calls: one BatchedMesh per model part (paint, trim, glass, headlights, tail lights) for all vehicles.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BatchedMesh, Color, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry, type Material } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { extendStreets } from "../../sim/edges";
import { isOldGyratory } from "../../sim/oldStreetArea";
import { newPoint, polyline, type Polyline } from "../../sim/polyline";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { groundY } from "../ground";
import { newTrafficVehicle, publishTraffic, respawnScale, speedFactor, vehicleSize, type TrafficVehicle } from "../physics/traffic";
import { buildVehicle, GLASS, LENGTH, PALETTES, PARTS, VEHICLE_KINDS, type Part, type VehicleKind } from "../vehicleModels";

/** Traffic share still out by hour (0–24): busy daytime, thin after midnight. */
function presence(hour: number) {
  if (hour >= 7 && hour < 20) return 1;
  if (hour >= 20 || hour < 1) return 0.6;
  return 0.25;
}

/** Everything but buses and cabs: [kind, weight]. */
const MIX: [VehicleKind, number][] = [
  ["hatch", 24],
  ["saloon", 20],
  ["suv", 14],
  ["estate", 8],
  ["van", 16],
  ["bike", 7],
  ["police", 3],
  ["ambulance", 2],
];

function pickKind(r: () => number, main: boolean): VehicleKind {
  if (main && r() < 0.22) return "bus";
  if (r() < 0.25) return "cab";
  const total = MIX.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [k, w] of MIX) if ((x -= w) <= 0) return k;
  return "hatch";
}

/** Desired speed (m/s): [base, random extra]. A touch quicker than life so the city feels busy. */
const SPEED: Partial<Record<VehicleKind, [number, number]>> = { bus: [7, 1.5], bike: [5, 1.5], van: [8.5, 2.5] };
// intelligent driver model
const A_MAX = 1.6;
const B_COMF = 2.6;
const S0 = 2.2;
const T_HEAD = 1.1;
const GIVE_WAY: [number, number] = [0.6, 2.4];
const BUS_DWELL = 7;
/** A U-turn waits until no other street's vehicle is this close to the turn centre (m). */
const JUNCTION_CLEAR = 9;

interface Loop {
  path: Polyline;
  /** Lane offset = U-turn radius (m). */
  R: number;
  /** Straight length per side, from s = R to s = L - R. */
  Ls: number;
  /** Loop length. */
  C: number;
  vehicles: Vehicle[];
}

interface Stop {
  u: number;
  /** Seconds to wait (0 = a random give-way pause). */
  dwell: number;
  /** A junction: wait until it is clear before going on. */
  junction: boolean;
}

interface Vehicle {
  kind: VehicleKind;
  loop: Loop;
  u: number;
  v: number;
  v0: number;
  len: number;
  stops: Stop[];
  next: number;
  wait: number;
  braking: boolean;
  /** 0..1: vehicles with a higher value park up first as the night empties the streets. */
  shy: number;
  color: Color;
  /** Instance ids per part, in PARTS order (-1 = this model has no such part). */
  ids: number[];
  x: number;
  z: number;
  visible: boolean;
  /** Shared with the physics layer: pose out, crash takeover / hold-back in (world/physics/traffic.ts). */
  live: TrafficVehicle;
}

const p = newPoint();
const pos = new Vector3();
const quat = new Quaternion();
const up = new Vector3(0, 1, 0);
const scl = new Vector3(1, 1, 1);
/** Live mounts per built set (see the dispose effect). */
const mounts = new WeakMap<object, number>();
const m4 = new Matrix4();
const tailCol = new Color();
const pose = { x: 0, z: 0, h: 0 };

/** Scene position + heading of loop coordinate u. */
function poseOnLoop(l: Loop, u: number, out: { x: number; z: number; h: number }) {
  const { path, R, Ls } = l;
  const L = path.length;
  const arc = Math.PI * R;
  let cx: number;
  let cz: number;
  let dx: number;
  let dz: number;
  if (u < Ls) {
    path.at(R + u, -R, p); // lateral is to the right of the street direction: keep left = negative
    cx = p.x;
    cz = p.z;
    dx = p.dx;
    dz = p.dz;
  } else if (u < Ls + arc) {
    // U-turn at the far end: centre on the centreline at s = L - R, from the left lane round to the right one
    const th = (u - Ls) / R;
    path.at(L - R, 0, p);
    const nx = p.dz;
    const nz = -p.dx; // right-hand normal
    cx = p.x + R * (-Math.cos(th) * nx + Math.sin(th) * p.dx);
    cz = p.z + R * (-Math.cos(th) * nz + Math.sin(th) * p.dz);
    dx = Math.sin(th) * nx + Math.cos(th) * p.dx;
    dz = Math.sin(th) * nz + Math.cos(th) * p.dz;
  } else if (u < 2 * Ls + arc) {
    path.at(L - R - (u - Ls - arc), R, p);
    cx = p.x;
    cz = p.z;
    dx = -p.dx;
    dz = -p.dz;
  } else {
    // U-turn at the start: centre at s = R, from the right lane back round to the left one
    const th = (u - 2 * Ls - arc) / R;
    path.at(R, 0, p);
    const nx = p.dz;
    const nz = -p.dx;
    cx = p.x + R * (Math.cos(th) * nx - Math.sin(th) * p.dx);
    cz = p.z + R * (Math.cos(th) * nz - Math.sin(th) * p.dz);
    dx = -Math.sin(th) * nx - Math.cos(th) * p.dx;
    dz = -Math.sin(th) * nz - Math.cos(th) * p.dz;
  }
  const [x, z] = toScene(cx, cz);
  out.x = x;
  out.z = z;
  // scene z = -north, so heading in scene is atan2(dx, -dz)
  out.h = Math.atan2(dx, -dz);
  return out;
}

/** Scene position of the U-turn centre that a stop at loop coordinate u leads into. */
function turnCentre(l: Loop, u: number): [number, number] {
  l.path.at(u < l.Ls + 1 ? l.path.length - l.R : l.R, 0, p);
  return toScene(p.x, p.z);
}

function build(map: CityMap) {
  const r = rng(7);
  const loops: Loop[] = [];
  const all: Vehicle[] = [];
  // streets that leave the map run on into the surroundings: cars drive out of sight and come back in
  for (const s of extendStreets(map)) {
    if (s.width < 7 || isOldGyratory(s)) continue; // footpaths and alleys; the removed gyratory (OldStreet runs that)
    const path = polyline(s.points);
    const R = s.width / 4;
    const Ls = path.length - 2 * R;
    if (Ls < 30) continue;
    const C = 2 * Ls + 2 * Math.PI * R;
    const loop: Loop = { path, R, Ls, C, vehicles: [] };
    const main = s.width >= 14;
    const want = Math.max(1, Math.round((path.length / (main ? 55 : 95)) * 2));
    const kinds: VehicleKind[] = [];
    for (let i = 0; i < want; i++) kinds.push(pickKind(r, main));
    // keep what fits with room to move
    let room = C * 0.55;
    const fit = kinds.filter((k) => (room -= LENGTH[k] + S0 + 8) > 0);
    // spread round the loop in order, with a little jitter
    const step = C / Math.max(1, fit.length);
    fit.forEach((kind, i) => {
      const [base, extra] = SPEED[kind] ?? [9, 3];
      const pal = PALETTES[kind];
      const stops: Stop[] = [
        { u: Ls - 1, dwell: 0, junction: true },
        { u: 2 * Ls + Math.PI * R - 1, dwell: 0, junction: true },
      ];
      if (kind === "bus" && Ls > 70) stops.push({ u: Ls * 0.5, dwell: BUS_DWELL, junction: false }, { u: Ls * 1.5 + Math.PI * R, dwell: BUS_DWELL, junction: false });
      stops.sort((a, b) => a.u - b.u);
      const u = (i * step + r() * step * 0.3) % C;
      const ahead = stops.findIndex((st) => st.u > u);
      const v: Vehicle = {
        kind,
        loop,
        u,
        v: base * 0.5,
        v0: base + r() * extra,
        len: LENGTH[kind],
        stops,
        next: ahead < 0 ? 0 : ahead,
        wait: 0,
        braking: false,
        shy: kind === "bus" ? r() * 0.7 : r(),
        color: new Color(pal[Math.floor(r() * pal.length)]),
        ids: [],
        x: 0,
        z: 0,
        visible: true,
        live: undefined as unknown as TrafficVehicle,
      };
      v.live = newTrafficVehicle(kind, vehicleSize(kind, LENGTH[kind]), v.color, s.id);
      loop.vehicles.push(v);
      all.push(v);
    });
    if (loop.vehicles.length) loops.push(loop);
  }
  return { loops, all };
}

/** One IDM step for every vehicle of a loop (they stay in order, so the leader is simply the next one). */
function stepLoop(l: Loop, dt: number, all: Vehicle[]) {
  const vs = l.vehicles;
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    const me = vs[i];
    const lead = vs[(i + 1) % n];
    let gap = n === 1 ? Infinity : ((lead.u - me.u + l.C) % l.C) - (me.len + lead.len) / 2;
    let dv = n === 1 ? 0 : me.v - lead.v;
    // the next stop line acts as a standing obstacle until the vehicle has waited there
    const st = me.stops[me.next];
    const toStop = ((st.u - me.u + l.C) % l.C) - me.len / 2;
    if (toStop < gap) {
      gap = toStop;
      dv = me.v;
    }
    if (toStop < 1.5 && me.v < 0.6) {
      if (me.wait <= 0) me.wait = st.dwell || GIVE_WAY[0] + Math.random() * (GIVE_WAY[1] - GIVE_WAY[0]);
      me.wait -= dt;
      let go = me.wait <= 0;
      if (go && st.junction) {
        // give way: the U-turn waits while other streets' traffic is moving through the junction (stopped vehicles
        // don't count, so two queues facing each other can't deadlock)
        const [cx, cz] = turnCentre(l, st.u);
        for (const o of all) if (o.loop !== l && o.visible && o.v > 0.5 && Math.abs(o.x - cx) < JUNCTION_CLEAR && Math.abs(o.z - cz) < JUNCTION_CLEAR) go = false;
        if (!go) me.wait = 0.3;
      }
      if (go) {
        me.next = (me.next + 1) % me.stops.length;
        me.wait = 0;
      }
    }
    const s = Math.max(0.05, gap);
    const sStar = S0 + Math.max(0, me.v * T_HEAD + (me.v * dv) / (2 * Math.sqrt(A_MAX * B_COMF)));
    const a = Math.max(-9, A_MAX * (1 - (me.v / me.v0) ** 4 - (sStar / s) ** 2));
    me.braking = a < -0.8 || (me.v < 0.5 && gap < 5);
    me.v = Math.max(0, me.v + a * dt);
  }
  for (let i = 0; i < n; i++) {
    const me = vs[i];
    const lead = vs[(i + 1) % n];
    let adv = me.v * dt;
    // hard limit: never into the vehicle ahead
    if (n > 1) adv = Math.min(adv, Math.max(0, ((lead.u - me.u + l.C) % l.C) - (me.len + lead.len) / 2 - 0.8));
    me.u = (me.u + adv) % l.C;
  }
}

export default function Traffic() {
  const { map, interactive } = useWorld();
  const sim = useMemo(() => build(map), [map]);
  // the main view's traffic is the one physics drives (the compare view stays plain ambience)
  useEffect(() => (interactive ? publishTraffic(sim.all.map((v) => v.live)) : undefined), [sim, interactive]);

  const built = useMemo(() => {
    const kinds = VEHICLE_KINDS.filter((k) => sim.all.some((v) => v.kind === k));
    const geos = Object.fromEntries(kinds.map((k) => [k, buildVehicle(k)])) as Record<VehicleKind, Record<Part, BufferGeometry | null>>;
    const glass = new MeshStandardMaterial({ color: GLASS, roughness: 0.12, metalness: 0.35, emissive: "#ffd78a", emissiveIntensity: 0 });
    // buses' glass instances are coloured pure white: only they take the lit-interior glow at night
    glass.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n#ifdef USE_BATCHING_COLOR\ntotalEmissiveRadiance *= step(0.995, vColor.r);\n#endif",
      );
    };
    glass.customProgramCacheKey = () => "traffic-glass";
    const mats: Record<Part, Material> = {
      paint: new MeshStandardMaterial({ roughness: 0.3, metalness: 0.15 }),
      fixed: new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }),
      glass,
      head: new MeshBasicMaterial({ color: "#fff6e0", toneMapped: false }),
      tail: new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
    };
    const meshes = {} as Record<Part, BatchedMesh>;
    const n = sim.all.length;
    const white = new Color(1, 1, 1);
    const tint = new Color(0.97, 0.97, 0.97);
    const tailOff = new Color(0.4, 0.02, 0.01);
    PARTS.forEach((part, pi) => {
      let verts = 0;
      for (const k of kinds) verts += geos[k][part]?.getAttribute("position").count ?? 0;
      const bm = new BatchedMesh(Math.max(1, n), Math.max(3, verts), 0, mats[part]);
      bm.frustumCulled = false; // per-vehicle culling still applies (perObjectFrustumCulled)
      bm.castShadow = part === "paint" || part === "fixed";
      bm.receiveShadow = part === "paint";
      bm.raycast = () => {};
      const gid: Partial<Record<VehicleKind, number>> = {};
      for (const k of kinds) {
        const g = geos[k][part];
        if (g) gid[k] = bm.addGeometry(g);
      }
      for (const v of sim.all) {
        const g = gid[v.kind];
        const id = g === undefined ? -1 : bm.addInstance(g);
        v.ids[pi] = id;
        if (id < 0) continue;
        if (part === "paint") bm.setColorAt(id, v.color);
        else if (part === "glass") bm.setColorAt(id, v.kind === "bus" ? white : tint);
        else if (part === "tail") bm.setColorAt(id, tailOff);
      }
      meshes[part] = bm;
    });
    for (const k of kinds) for (const part of PARTS) geos[k][part]?.dispose();
    return { meshes, mats };
  }, [sim]);

  // dispose only once nothing holds `built` any more: StrictMode's mount → unmount → mount keeps the memo, and
  // disposing it there nulls the batch textures (setMatrixAt then throws every frame)
  useEffect(() => {
    mounts.set(built, (mounts.get(built) ?? 0) + 1);
    return () => {
      mounts.set(built, (mounts.get(built) ?? 1) - 1);
      window.setTimeout(() => {
        if ((mounts.get(built) ?? 0) > 0) return;
        Object.values(built.meshes).forEach((m) => m.dispose());
        Object.values(built.mats).forEach((m) => m.dispose());
      }, 0);
    };
  }, [built]);

  useFrame((_, delta) => {
    const hour = hourOf(useSim.getState().t);
    const keep = presence(hour);
    const night = nightLevel(hour);
    (built.mats.glass as MeshStandardMaterial).emissiveIntensity = night * 1.3;
    (built.mats.head as MeshBasicMaterial).color.setRGB(0.55 + night * 2.2, 0.53 + night * 2.0, 0.48 + night * 1.6);
    // integrate in small steps so a slow frame can't make anyone jump
    const total = Math.min(delta, 0.2);
    const steps = Math.ceil(total / 0.05);
    // a crash scene ahead holds traffic back (physics/traffic.ts); the IDM queues the rest behind
    for (const v of sim.all) {
      if (v.live.override) continue;
      const k = speedFactor(v.live, total);
      if (k < 0.999) v.v = Math.min(v.v, v.v0 * k);
    }
    const now = performance.now();
    for (let k = 0; k < steps; k++) for (const l of sim.loops) stepLoop(l, total / steps, sim.all);
    const tailIdx = PARTS.indexOf("tail");
    for (const v of sim.all) {
      v.visible = v.shy <= keep;
      poseOnLoop(v.loop, v.u, pose);
      v.x = pose.x;
      v.z = pose.z;
      const live = v.live;
      const ov = live.override;
      live.shown = v.visible && !ov;
      live.x = pose.x;
      live.z = pose.z;
      live.heading = pose.h;
      live.speed = v.v;
      if (ov) {
        // crashed: physics owns the pose until the tow truck's been (the loop slot drives on unseen)
        v.visible = true;
        m4.compose(ov.position, ov.quaternion, scl.setScalar(ov.scale));
      } else {
        pos.set(pose.x, groundY(pose.x, pose.z), pose.z);
        quat.setFromAxisAngle(up, pose.h);
        m4.compose(pos, quat, scl.setScalar(respawnScale(live, now)));
      }
      for (let pi = 0; pi < PARTS.length; pi++) {
        const id = v.ids[pi];
        if (id < 0) continue;
        const bm = built.meshes[PARTS[pi]];
        bm.setVisibleAt(id, v.visible);
        if (v.visible) bm.setMatrixAt(id, m4);
      }
      const tid = v.ids[tailIdx];
      if (tid >= 0 && v.visible) {
        const lvl = 0.35 + night * 0.9 + (v.braking ? 1.6 : 0);
        built.meshes.tail.setColorAt(tid, tailCol.setRGB(lvl, lvl * 0.06, lvl * 0.03));
      }
    }
  });

  return (
    <group name="traffic">
      {PARTS.map((part) => (
        <primitive key={part} object={built.meshes[part]} />
      ))}
    </group>
  );
}
