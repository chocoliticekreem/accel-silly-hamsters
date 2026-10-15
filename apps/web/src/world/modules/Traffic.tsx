// Module: Traffic (decorative). Red double-deckers on the main roads, black cabs, cars, vans, the odd police car,
// ambulance, lorry and motorbike, driving back and forth along the real street polylines in their (left-hand) lane.
// The sim doesn't model traffic: this is ambience, not data, so it never feeds a KPI. Fewer vehicles late at night;
// head and tail lights glow after dark and the buses' decks light up.
// Models: world/vehicleModels.ts (low-poly, one instanced mesh per model part: ~45 draw calls for all traffic).
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, DynamicDrawUsage, InstancedMesh, MeshStandardMaterial, Object3D, type Material } from "three";
import { rng } from "../../mock/rng";
import { extendStreets } from "../../sim/edges";
import { newPoint, pingPong, polyline, type Polyline } from "../../sim/polyline";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { newTrafficVehicle, publishTraffic, respawnScale, speedFactor, vehicleSize, type TrafficVehicle } from "../physics/traffic";
import { groundY } from "../ground";
import { buildVehicle, LENGTH, PALETTES, PARTS, VEHICLE_KINDS, type Part, type VehicleKind } from "../vehicleModels";

interface Vehicle {
  kind: VehicleKind;
  path: Polyline;
  lane: number;
  speed: number; // m/s
  /** Distance travelled along the back-and-forth trip (metres). */
  d: number;
  /** 0..1: vehicles with a higher value disappear first as the night empties the streets. */
  shy: number;
  color: Color;
  /** Shared with the physics layer: pose out, crash takeover / hold-back in (world/physics/traffic.ts). */
  live: TrafficVehicle;
}

/** Traffic share still out by hour (0–24): busy daytime, thin after midnight. */
function presence(hour: number) {
  if (hour >= 7 && hour < 20) return 1;
  if (hour >= 20 || hour < 1) return 0.6;
  return 0.25;
}

/** Everything but buses and cabs: [kind, weight]. Lorries only on the main roads. */
const MIX: [VehicleKind, number][] = [
  ["hatch", 22],
  ["saloon", 20],
  ["suv", 14],
  ["estate", 10],
  ["van", 14],
  ["moto", 5],
  ["police", 3],
  ["ambulance", 2],
];

function pickKind(r: () => number, main: boolean): VehicleKind {
  if (main && r() < 0.28) return "bus";
  if (r() < 0.28) return "cab";
  if (main && r() < 0.05) return "hgv";
  const total = MIX.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [k, w] of MIX) if ((x -= w) <= 0) return k;
  return "hatch";
}

const SPEED: Partial<Record<VehicleKind, [number, number]>> = { bus: [6, 2], hgv: [6, 2], moto: [10, 4], police: [10, 4], ambulance: [10, 4] };

const o = new Object3D();
const p = newPoint();

export default function Traffic() {
  const { map, interactive } = useWorld();

  const vehicles = useMemo(() => {
    const r = rng(7);
    const out: Vehicle[] = [];
    // streets that leave the map run on into the surroundings: cars drive out of sight and come back in
    for (const s of extendStreets(map)) {
      if (s.width < 7) continue; // footpaths and alleys
      const path = polyline(s.points);
      if (path.length < 40) continue;
      const main = s.width >= 14;
      const n = Math.max(1, Math.round((path.length / (main ? 70 : 120)) * (main ? 1 : 0.8)));
      for (let i = 0; i < n; i++) {
        const kind = pickKind(r, main);
        const [base, spread] = SPEED[kind] ?? [8, 4];
        const pal = PALETTES[kind];
        const speed = base + r() * spread;
        const d = r() * path.length * 2;
        const shy = kind === "bus" ? r() * 0.7 : r();
        const color = new Color(pal[Math.floor(r() * pal.length)]);
        out.push({ kind, path, lane: s.width / 4, speed, d, shy, color, live: newTrafficVehicle(kind, vehicleSize(kind, LENGTH[kind]), color, s.id) });
      }
    }
    return out;
  }, [map]);
  // the main view's traffic is the one physics drives (the compare view stays plain ambience)
  useEffect(() => (interactive ? publishTraffic(vehicles.map((v) => v.live)) : undefined), [vehicles, interactive]);

  const built = useMemo(() => {
    const counts = Object.fromEntries(VEHICLE_KINDS.map((k) => [k, 0])) as Record<VehicleKind, number>;
    for (const v of vehicles) counts[v.kind]++;
    const mats = {
      paint: new MeshStandardMaterial({ roughness: 0.32, metalness: 0.35 }),
      fixed: new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }),
      glass: new MeshStandardMaterial({ color: "#2a3646", roughness: 0.08, metalness: 0.6 }),
      busGlass: new MeshStandardMaterial({ color: "#2a3646", roughness: 0.1, metalness: 0.5, emissive: "#ffd78a", emissiveIntensity: 0 }),
      head: new MeshStandardMaterial({ color: "#fffaf0", emissive: "#fff2d0", emissiveIntensity: 0.3, roughness: 0.2 }),
      tail: new MeshStandardMaterial({ color: "#8a1010", emissive: "#ff1a0a", emissiveIntensity: 0.3, roughness: 0.3 }),
    };
    const meshes = {} as Record<VehicleKind, InstancedMesh[]>;
    const paint = {} as Record<VehicleKind, InstancedMesh | null>;
    for (const kind of VEHICLE_KINDS) {
      meshes[kind] = [];
      paint[kind] = null;
      if (!counts[kind]) continue;
      const geos = buildVehicle(kind);
      for (const part of PARTS) {
        const g = geos[part];
        if (!g) continue;
        const mat: Material = part === "glass" && kind === "bus" ? mats.busGlass : mats[part as Part];
        const m = new InstancedMesh(g, mat, counts[kind]);
        m.instanceMatrix.setUsage(DynamicDrawUsage);
        m.frustumCulled = false;
        m.castShadow = part === "paint" || part === "fixed";
        m.receiveShadow = part === "paint";
        m.count = 0;
        if (part === "paint") {
          m.setColorAt(0, new Color());
          paint[kind] = m;
        }
        meshes[kind].push(m);
      }
    }
    return { mats, meshes, paint, all: VEHICLE_KINDS.flatMap((k) => meshes[k]) };
  }, [vehicles]);

  useEffect(
    () => () => {
      for (const m of built.all) {
        m.geometry.dispose();
        m.dispose();
      }
      Object.values(built.mats).forEach((m) => m.dispose());
    },
    [built],
  );

  useFrame((_, delta) => {
    const hour = hourOf(useSim.getState().t);
    const keep = presence(hour);
    const night = nightLevel(hour);
    built.mats.busGlass.emissiveIntensity = night * 1.4;
    built.mats.head.emissiveIntensity = 0.3 + night * 3.5;
    built.mats.tail.emissiveIntensity = 0.3 + night * 2.2;
    const idx = Object.fromEntries(VEHICLE_KINDS.map((k) => [k, 0])) as Record<VehicleKind, number>;
    const dt = Math.min(delta, 0.1);
    const now = performance.now();
    for (const v of vehicles) {
      const ov = v.live.override;
      if (ov) {
        // crashed: physics owns the pose until the tow truck's been
        o.position.copy(ov.position);
        o.quaternion.copy(ov.quaternion);
        o.scale.setScalar(ov.scale);
      } else {
        v.live.shown = v.shy <= keep;
        if (!v.live.shown) continue;
        const k = speedFactor(v.live, dt); // queues behind a crash scene
        v.d += dt * v.speed * k;
        const [s, forward] = pingPong(v.d, v.path.length);
        // keep left: lateral is to the right of the polyline's direction, so going forward means a negative offset
        v.path.at(s, forward ? -v.lane : v.lane, p);
        const [x, z] = toScene(p.x, p.z);
        const dir = forward ? 1 : -1;
        // scene z = -north, so heading in scene is atan2(dx, -dz)
        const heading = Math.atan2(p.dx * dir, -p.dz * dir);
        v.live.x = x;
        v.live.z = z;
        v.live.heading = heading;
        v.live.speed = v.speed * k;
        o.position.set(x, groundY(x, z), z);
        o.rotation.set(0, heading, 0);
        o.scale.setScalar(respawnScale(v.live, now));
      }
      o.updateMatrix();
      const i = idx[v.kind]++;
      for (const m of built.meshes[v.kind]) m.setMatrixAt(i, o.matrix);
      built.paint[v.kind]?.setColorAt(i, v.color);
    }
    for (const k of VEHICLE_KINDS)
      for (const m of built.meshes[k]) {
        m.count = idx[k];
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
  });

  return (
    <group name="traffic">
      {built.all.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
    </group>
  );
}
