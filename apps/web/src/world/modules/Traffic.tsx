// Module: Traffic (decorative). Red double-deckers on the main roads, black cabs and cars everywhere else, driving
// back and forth along the real street polylines in their lane. The sim doesn't model traffic: this is ambience,
// not data, so it never feeds a KPI. Fewer vehicles late at night; headlights come on after dark.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, Color, DynamicDrawUsage, MeshStandardMaterial, Object3D, type InstancedMesh } from "three";
import { rng } from "../../mock/rng";
import { newPoint, pingPong, polyline, type Polyline } from "../../sim/polyline";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { newTrafficVehicle, publishTraffic, respawnScale, speedFactor, type TrafficVehicle } from "../physics/traffic";

type Kind = "bus" | "cab" | "car";

interface Vehicle {
  kind: Kind;
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

const SIZE: Record<Kind, [number, number, number]> = {
  // length, height, width (metres)
  bus: [11, 4.4, 2.6],
  cab: [4.6, 1.8, 1.8],
  car: [4.3, 1.5, 1.8],
};
const CAR_COLORS = ["#c8ced6", "#3b4252", "#8a96a8", "#e6e2d8", "#5a6b5c", "#7a3e3e", "#2f4a6b"];

/** Traffic share still out by hour (0–24): busy daytime, thin after midnight. */
function presence(hour: number) {
  if (hour >= 7 && hour < 20) return 1;
  if (hour >= 20 || hour < 1) return 0.6;
  return 0.25;
}

const o = new Object3D();
const p = newPoint();

export default function Traffic() {
  const { map, interactive } = useWorld();
  const meshes = { bus: useRef<InstancedMesh>(null), cab: useRef<InstancedMesh>(null), car: useRef<InstancedMesh>(null) };
  const windows = { bus: useRef<InstancedMesh>(null), cab: useRef<InstancedMesh>(null), car: useRef<InstancedMesh>(null) };
  const glassMat = useMemo(() => new MeshStandardMaterial({ color: "#27303d", emissive: "#ffe2a8", emissiveIntensity: 0.15, roughness: 0.2 }), []);

  const vehicles = useMemo(() => {
    const r = rng(7);
    const out: Vehicle[] = [];
    for (const s of map.streets) {
      if (s.width < 7) continue; // footpaths and alleys
      const path = polyline(s.points);
      if (path.length < 40) continue;
      const main = s.width >= 14;
      const n = Math.max(1, Math.round((path.length / (main ? 70 : 120)) * (main ? 1 : 0.8)));
      for (let i = 0; i < n; i++) {
        const kind: Kind = main && r() < 0.35 ? "bus" : r() < 0.3 ? "cab" : "car";
        const speed = kind === "bus" ? 6 + r() * 2 : 8 + r() * 4;
        const d = r() * path.length * 2;
        const shy = r();
        const color = new Color(kind === "bus" ? "#d42a2a" : kind === "cab" ? "#1d1f24" : CAR_COLORS[Math.floor(r() * CAR_COLORS.length)]);
        out.push({ kind, path, lane: s.width / 4, speed, d, shy, color, live: newTrafficVehicle(kind, SIZE[kind], color, s.id) });
      }
    }
    return out;
  }, [map]);
  // the main view's traffic is the one physics drives (the compare view stays plain ambience)
  useEffect(() => (interactive ? publishTraffic(vehicles.map((v) => v.live)) : undefined), [vehicles, interactive]);

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { bus: 0, cab: 0, car: 0 };
    for (const v of vehicles) c[v.kind]++;
    return c;
  }, [vehicles]);

  const geo = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(SIZE) as Kind[]).map((k) => {
          const [l, h, w] = SIZE[k];
          return [k, { body: new BoxGeometry(w, h, l).translate(0, h / 2 + 0.3, 0), glass: new BoxGeometry(w + 0.05, k === "bus" ? 0.9 : 0.6, l * 0.55).translate(0, k === "bus" ? h * 0.72 : h * 0.85, -l * 0.05) }];
        }),
      ) as Record<Kind, { body: BoxGeometry; glass: BoxGeometry }>,
    [],
  );

  useFrame((_, delta) => {
    const hour = hourOf(useSim.getState().t);
    const keep = presence(hour);
    const night = nightLevel(hour);
    glassMat.emissiveIntensity = 0.15 + night * 1.6;
    const idx: Record<Kind, number> = { bus: 0, cab: 0, car: 0 };
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
        v.path.at(s, forward ? v.lane : -v.lane, p);
        const [x, z] = toScene(p.x, p.z);
        const dir = forward ? 1 : -1;
        // scene z = -north, so heading in scene is atan2(dx, -dz)
        const heading = Math.atan2(p.dx * dir, -p.dz * dir);
        v.live.x = x;
        v.live.z = z;
        v.live.heading = heading;
        v.live.speed = v.speed * k;
        o.position.set(x, 0, z);
        o.rotation.set(0, heading, 0);
        o.scale.setScalar(respawnScale(v.live, now));
      }
      o.updateMatrix();
      const i = idx[v.kind]++;
      meshes[v.kind].current?.setMatrixAt(i, o.matrix);
      meshes[v.kind].current?.setColorAt(i, v.color);
      windows[v.kind].current?.setMatrixAt(i, o.matrix);
    }
    for (const k of Object.keys(idx) as Kind[]) {
      for (const m of [meshes[k].current, windows[k].current]) {
        if (!m) continue;
        m.count = idx[k];
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
  });

  const body = (k: Kind) => (
    <instancedMesh
      key={`b-${k}`}
      ref={(m) => {
        meshes[k].current = m;
        if (m) {
          m.instanceMatrix.setUsage(DynamicDrawUsage);
          m.setColorAt(0, new Color());
        }
      }}
      args={[geo[k].body, undefined, Math.max(1, counts[k])]}
      castShadow
      frustumCulled={false}
    >
      <meshStandardMaterial roughness={0.45} metalness={0.1} />
    </instancedMesh>
  );
  const glass = (k: Kind) => (
    <instancedMesh
      key={`g-${k}`}
      ref={(m) => {
        windows[k].current = m;
        m?.instanceMatrix.setUsage(DynamicDrawUsage);
      }}
      args={[geo[k].glass, glassMat, Math.max(1, counts[k])]}
      frustumCulled={false}
    />
  );

  return (
    <group name="traffic">
      {(Object.keys(SIZE) as Kind[]).map((k) => [body(k), glass(k)])}
    </group>
  );
}
