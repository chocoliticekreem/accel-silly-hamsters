// Module: Overground (decorative). The East London line on its real alignment (OSM, sim/london.ts) and brick viaduct:
// from Haggerston through Hoxton and Shoreditch High Street, east into the cutting and tunnel toward Whitechapel.
// Arches (some let as lit workshops and bars), steel bridges where it crosses a street, ballast and rails, Hoxton's
// platforms, and four-car orange-striped Class 378 trains both ways. Trains brake into each platform, open their
// doors, people get off and walk to the stairs (and at Shoreditch High St the background crowd streams out of the
// station: world/stationPulse), the waiting passengers board, the doors close and the train pulls out. Frequency follows the sim clock's timetable
// (sim/overground.ts: peaks, evenings, no trains in the small hours except the Night Overground on Fri/Sat);
// motion runs in real seconds like the rest of the street life. Instanced: a few draw calls for every train.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, Color, Matrix4, MeshStandardMaterial, Object3D, Quaternion, Vector3, type InstancedMesh } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { DECK_Y, headwaySeconds, overgroundRoute, railLevel, routeAt, runMotion, TRACK_OFFSET, TRAIN, TRAIN_LENGTH, trainsPerHour, VIADUCT_W, type OvergroundRoute, type Stop } from "../../sim/overground";
import { exitContinuations } from "../../sim/surroundings";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { PLATFORM_IN, PLATFORM_OUT, PLATFORM_TOP, Roundel } from "../Station";
import { stationPulse } from "../stationPulse";

const noRaycast = () => null;
const PIER_EVERY = 13;
const POOL = 14; // trains alive at once, both directions
const FLOOR = DECK_Y + 0.55; // bottom of the car body
const PEOPLE = 260;

interface Static {
  m: Matrix4;
  c?: Color;
}

/** Everything that doesn't move, as instance lists. */
function viaduct(route: OvergroundRoute, map: CityMap) {
  const o = new Object3D();
  o.rotation.order = "YXZ";
  const mk = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rot: number, c?: string, pitch = 0): Static => {
    const [px, pz] = toScene(x, z);
    o.position.set(px, y, pz);
    o.rotation.set(-pitch, rot, 0);
    o.scale.set(sx, sy, sz);
    o.updateMatrix();
    return { m: o.matrix.clone(), c: c ? new Color(c) : undefined };
  };
  const deck: Static[] = [];
  const ballast: Static[] = [];
  const rails: Static[] = [];
  const parapets: Static[] = [];
  const piers: Static[] = [];
  const arches: Static[] = [];
  const girders: Static[] = [];
  const cutting: Static[] = [];
  const atStop = (s: number) => route.stops.some((st) => Math.abs(s - st.s) < st.platformLen / 2 + 0.5);
  const atMain = (s: number) => route.stops.some((st) => st.main && Math.abs(s - st.s) < st.platformLen / 2 + 0.5);
  // the deck in short pieces, so it can follow the curves and the ramp down into the cutting
  const STEP = 10;
  for (let s0 = 0; s0 < route.length; s0 += STEP) {
    const s1 = Math.min(route.length, s0 + STEP);
    const a = routeAt(route, s0);
    const b = routeAt(route, s1);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05) continue;
    const y0 = railLevel(route, s0);
    const y1 = railLevel(route, s1);
    if (y0 < -3 && y1 < -3) continue; // in the tunnel
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const ym = (y0 + y1) / 2;
    const pitch = Math.atan2(y1 - y0, len);
    const rot = Math.atan2(b.x - a.x, -(b.z - a.z));
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    if (!atMain((s0 + s1) / 2)) deck.push(mk(mx, ym - 0.8, mz, VIADUCT_W, 1.6, len + 0.6, rot, undefined, pitch));
    ballast.push(mk(mx, ym + 0.04, mz, VIADUCT_W - 1.4, 0.1, len + 0.6, rot, undefined, pitch));
    for (const lat of [-TRACK_OFFSET - 0.72, -TRACK_OFFSET + 0.72, TRACK_OFFSET - 0.72, TRACK_OFFSET + 0.72])
      rails.push(mk(mx + uz * lat, ym + 0.17, mz - ux * lat, 0.12, 0.14, len + 0.6, rot, undefined, pitch));
    if (!atStop((s0 + s1) / 2) && ym > 1)
      for (const lat of [-1, 1]) parapets.push(mk(mx + uz * lat * (VIADUCT_W / 2 - 0.2), ym + 0.5, mz - ux * lat * (VIADUCT_W / 2 - 0.2), 0.4, 1, len + 0.4, rot, undefined, pitch));
    // the cutting: once the rails are below the street, a dark trench between retaining walls
    if (ym < 1.5) {
      cutting.push(mk(mx, 0.2, mz, VIADUCT_W, 0.06, len + 0.4, rot, "#1d1f22"));
      for (const lat of [-1, 1]) cutting.push(mk(mx + uz * lat * (VIADUCT_W / 2 + 0.3), 0.6, mz - ux * lat * (VIADUCT_W / 2 + 0.3), 0.6, 1.2, len + 0.4, rot, "#8e8b85"));
    }
  }
  // tunnel portal headwall
  if (route.portal !== undefined) {
    const p = routeAt(route, route.portal);
    cutting.push(mk(p.x, 1, p.z, VIADUCT_W + 2.4, 2, 1.6, Math.atan2(p.dx, -p.dz), "#8e8b85"));
  }
  // piers every PIER_EVERY m, except under stations (they have their own) and where a street runs underneath
  const roads = [...map.streets, ...exitContinuations(map, 400)];
  const overRoad = (x: number, z: number) => roads.some((st) => closestOnStreet(st, x, z)[2] < st.width / 2 + 2.2);
  const r = rng(378);
  let prev: { s: number; ok: boolean } | null = null;
  for (let s = PIER_EVERY / 2; s < route.length; s += PIER_EVERY) {
    const p = routeAt(route, s);
    const level = railLevel(route, s);
    const rot = Math.atan2(p.dx, -p.dz);
    const high = level > 4.5;
    const ok = high && !atMain(s) && !overRoad(p.x, p.z);
    if (ok) piers.push(mk(p.x, (level - 1.6) / 2, p.z, VIADUCT_W - 0.2, level - 1.6, 1.8, rot, "#7a4a3a"));
    if (prev) {
      const ms = (prev.s + s) / 2;
      const mid = routeAt(route, ms);
      const mrot = Math.atan2(mid.dx, -mid.dz);
      const mlevel = railLevel(route, ms);
      if (ok && prev.ok && mlevel >= DECK_Y - 0.01) {
        // an arch: the brick spandrel under the deck, and the arch's own front set back inside it
        arches.push(mk(mid.x, DECK_Y - 2.4, mid.z, VIADUCT_W - 0.3, 1.6, PIER_EVERY - 1.6, mrot, "#6e4134"));
        const lit = r() < 0.45;
        const tone = lit ? ["#ffcf8a", "#ffb870", "#ffe2b0"][Math.floor(r() * 3)] : ["#2a2d33", "#3a3f47", "#4b3a2f", "#23362e"][Math.floor(r() * 4)];
        arches.push(mk(mid.x, (DECK_Y - 3.2) / 2, mid.z, VIADUCT_W - 1.4, DECK_Y - 3.2, PIER_EVERY - 2, mrot, tone));
      } else if (high && !atMain(ms) && (overRoad(mid.x, mid.z) || !ok || !prev.ok)) {
        // a bridge over the street: painted steel plate girders along both edges
        for (const lat of [-1, 1]) girders.push(mk(mid.x + mid.dz * lat * (VIADUCT_W / 2 + 0.1), mlevel - 0.5, mid.z - mid.dx * lat * (VIADUCT_W / 2 + 0.1), 0.35, 2.6, PIER_EVERY + 0.4, mrot));
      }
    }
    prev = { s, ok };
  }
  return { deck, ballast, rails, parapets, piers, arches, girders, cutting };
}

/** A smaller elevated station (Hoxton): side platforms, canopies, a ticket hall under the deck, roundels. */
function MinorStation({ route, stop }: { route: OvergroundRoute; stop: Stop }) {
  const p = routeAt(route, stop.s);
  const [x, z] = toScene(p.x, p.z);
  // local +x along the line
  const rot = Math.atan2(p.dz, p.dx);
  const L = stop.platformLen;
  return (
    <group position={[x, 0, z]} rotation-y={rot} name={`station-${stop.name}`}>
      <mesh position={[0, DECK_Y - 0.65, 0]} castShadow receiveShadow>
        <boxGeometry args={[L, 1, PLATFORM_OUT * 2 + 0.6]} />
        <meshStandardMaterial color="#8f8a84" roughness={0.9} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[0, (DECK_Y - 0.15 + PLATFORM_TOP) / 2, side * ((PLATFORM_IN + PLATFORM_OUT) / 2)]} receiveShadow>
            <boxGeometry args={[L - 1, PLATFORM_TOP - DECK_Y + 0.15, PLATFORM_OUT - PLATFORM_IN]} />
            <meshStandardMaterial color="#b9b5ae" roughness={0.85} />
          </mesh>
          <mesh position={[0, PLATFORM_TOP + 0.01, side * (PLATFORM_IN + 0.3)]}>
            <boxGeometry args={[L - 1, 0.02, 0.35]} />
            <meshStandardMaterial color="#f2c230" />
          </mesh>
          <mesh position={[0, PLATFORM_TOP + 3.3, side * (PLATFORM_OUT - 1.4)]} castShadow>
            <boxGeometry args={[L * 0.6, 0.25, 3.4]} />
            <meshStandardMaterial color="#3a3f47" roughness={0.6} />
          </mesh>
          {[-0.25, 0, 0.25].map((k) => (
            <mesh key={k} position={[k * L, PLATFORM_TOP + 1.6, side * (PLATFORM_OUT - 0.5)]}>
              <boxGeometry args={[0.25, 3.3, 0.25]} />
              <meshStandardMaterial color="#3a3f47" />
            </mesh>
          ))}
          <mesh position={[0, PLATFORM_TOP + 0.55, side * (PLATFORM_OUT + 0.15)]}>
            <boxGeometry args={[L, 1.1, 0.3]} />
            <meshStandardMaterial color="#6d6a66" roughness={0.9} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, (DECK_Y - 1.2) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[18, DECK_Y - 1.2, VIADUCT_W - 0.6]} />
        <meshStandardMaterial color="#5d7890" emissive="#ffe2b0" emissiveIntensity={0.4} roughness={0.3} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side} position={[10, 0, side * (VIADUCT_W / 2 + 2)]} rotation-y={side > 0 ? 0 : Math.PI}>
          <mesh position-y={2.8}>
            <cylinderGeometry args={[0.18, 0.18, 5.6, 8]} />
            <meshStandardMaterial color="#4a5260" />
          </mesh>
          <Roundel y={6.4} scale={0.62} />
        </group>
      ))}
      <Html position={[0, DECK_Y + 14, 0]} center distanceFactor={320} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="map-label">{stop.name} · Overground</div>
      </Html>
    </group>
  );
}

function StaticMesh({ items, geo, mat }: { items: Static[]; geo: BoxGeometry; mat: MeshStandardMaterial }) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      m.setMatrixAt(i, it.m);
      if (it.c) m.setColorAt(i, it.c);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return <instancedMesh ref={ref} args={[geo, mat, items.length]} castShadow receiveShadow raycast={noRaycast} />;
}

// ---- trains ----

interface Part {
  key: string;
  /** Local offset: x across (right), y up, z forward. */
  at: (car: number, doors: number) => [number, number, number][];
}

const CAR_HALF = TRAIN.carLen / 2;
const DOOR_Z = [-CAR_HALF * 0.5, CAR_HALF * 0.5];
const PARTS: Part[] = [
  { key: "body", at: () => [[0, FLOOR + 1.65, 0]] },
  { key: "roof", at: () => [[0, FLOOR + 3.45, 0]] },
  { key: "glass", at: () => [[0, FLOOR + 2.25, 0]] },
  { key: "stripe", at: () => [[0, FLOOR + 1.35, 0]] },
  { key: "skirt", at: () => [[0, FLOOR + 0.3, 0]] },
  { key: "bogie", at: () => [[0, DECK_Y + 0.42, -CAR_HALF + 3], [0, DECK_Y + 0.42, CAR_HALF - 3]] },
  { key: "doorway", at: () => DOOR_Z.flatMap((z) => [[1.41, FLOOR + 1.15, z] as [number, number, number], [-1.41, FLOOR + 1.15, z] as [number, number, number]]) },
  {
    key: "leaf",
    at: (_c, doors) =>
      DOOR_Z.flatMap((z) =>
        [1.45, -1.45].flatMap((x) => [
          [x, FLOOR + 1.15, z - 0.36 - doors * 0.62] as [number, number, number],
          [x, FLOOR + 1.15, z + 0.36 + doors * 0.62] as [number, number, number],
        ]),
      ),
  },
  // cab ends: yellow warning panel and lights, only on the outer ends of the end cars
  { key: "cab", at: (car) => (car === 0 ? [[0, FLOOR + 1.3, CAR_HALF + 0.03]] : car === TRAIN.cars - 1 ? [[0, FLOOR + 1.3, -CAR_HALF - 0.03]] : []) },
  { key: "head", at: (car) => (car === 0 ? [[-0.85, FLOOR + 0.6, CAR_HALF + 0.08], [0.85, FLOOR + 0.6, CAR_HALF + 0.08]] : []) },
  { key: "tail", at: (car) => (car === TRAIN.cars - 1 ? [[-0.85, FLOOR + 0.6, -CAR_HALF - 0.08], [0.85, FLOOR + 0.6, -CAR_HALF - 0.08]] : []) },
];
const PER_CAR: Record<string, number> = { body: 1, roof: 1, glass: 1, stripe: 1, skirt: 1, bogie: 2, doorway: 4, leaf: 8, cab: 1, head: 2, tail: 2 };

interface Train {
  dir: 1 | -1;
  t0: number;
  /** Highest stop index (in this train's order) whose arrival / departure has been handled. */
  arrived: number;
  departed: number;
}

/** People on the platforms: waiting (standing) and just off a train (walking to the stairs). */
interface Alighter {
  stop: number;
  side: -1 | 1;
  u0: number;
  lat: number;
  t0: number;
  speed: number;
  look: number;
}

export default function Overground() {
  const { map } = useWorld();
  const route = useMemo(() => overgroundRoute(map), [map]);
  const stat = useMemo(() => (route ? viaduct(route, map) : null), [route, map]);

  const res = useMemo(() => {
    const box = new BoxGeometry(1, 1, 1);
    const std = (color: string, extra: Partial<MeshStandardMaterial> = {}) => Object.assign(new MeshStandardMaterial({ color, roughness: 0.85 }), extra);
    const L = TRAIN.carLen;
    return {
      box,
      mats: {
        deck: std("#7a4a3a", { roughness: 0.95 }),
        ballast: std("#6d655c", { roughness: 1 }),
        rail: std("#8d9196", { roughness: 0.3, metalness: 0.7 }),
        parapet: std("#6b3f32", { roughness: 0.95 }),
        pier: std("#ffffff", { roughness: 0.95 }),
        arch: std("#ffffff", { roughness: 0.8, emissive: new Color("#ffffff"), emissiveIntensity: 0 }),
        girder: std("#2f4b45", { roughness: 0.55, metalness: 0.3 }),
      },
      parts: {
        body: { geo: new BoxGeometry(2.8, 3.3, L), mat: std("#f1f1ee", { roughness: 0.45 }) },
        roof: { geo: new BoxGeometry(2.45, 0.35, L - 0.3), mat: std("#9aa0a8", { roughness: 0.6 }) },
        glass: { geo: new BoxGeometry(2.84, 0.95, L - 1.4), mat: std("#1f2733", { roughness: 0.15, emissive: new Color("#fff1d6"), emissiveIntensity: 0.1 }) },
        stripe: { geo: new BoxGeometry(2.86, 0.24, L), mat: std("#ee7c0e", { emissive: new Color("#ee7c0e"), emissiveIntensity: 0.2 }) },
        skirt: { geo: new BoxGeometry(2.82, 0.6, L - 0.4), mat: std("#1d2a4a") },
        bogie: { geo: new BoxGeometry(2.3, 0.55, 3), mat: std("#22252a") },
        doorway: { geo: new BoxGeometry(0.05, 2.0, 1.4), mat: std("#fff3dc", { emissive: new Color("#fff1d6"), emissiveIntensity: 0.8, toneMapped: false }) },
        leaf: { geo: new BoxGeometry(0.07, 2.05, 0.72), mat: std("#ee7c0e", { roughness: 0.5 }) },
        cab: { geo: new BoxGeometry(2.7, 2.4, 0.08), mat: std("#f2c230", { roughness: 0.5 }) },
        head: { geo: new BoxGeometry(0.4, 0.25, 0.06), mat: std("#ffffff", { emissive: new Color("#fffbe8"), emissiveIntensity: 2, toneMapped: false }) },
        tail: { geo: new BoxGeometry(0.4, 0.25, 0.06), mat: std("#ff2a1a", { emissive: new Color("#ff2a1a"), emissiveIntensity: 1.5, toneMapped: false }) },
      } as Record<string, { geo: BoxGeometry; mat: MeshStandardMaterial }>,
    };
  }, []);
  useEffect(
    () => () => {
      res.box.dispose();
      Object.values(res.mats).forEach((m) => m.dispose());
      Object.values(res.parts).forEach((p) => {
        p.geo.dispose();
        p.mat.dispose();
      });
    },
    [res],
  );

  const partRefs = useRef<Record<string, InstancedMesh | null>>({});
  const trains = useRef<Train[]>([]);
  const next = useRef<{ e: number; w: number } | null>(null);
  /** Real time each platform (stop index × side) last saw a train leave. */
  const lastDeparture = useRef<Map<string, number>>(new Map());
  const alighters = useRef<Alighter[]>([]);
  const people = useMemo(() => createPeople(PEOPLE, { emissive: 0.08 }), []);
  useEffect(() => () => people.dispose(), [people]);
  const looks = useMemo(() => {
    const r = rng(1863);
    const shirts = ["#2f5fb3", "#e0559a", "#2fae6a", "#f2c230", "#e9e4d8", "#c0392b", "#8e6fd8", "#3d7fe0", "#1f3a68"].map((c) => new Color(c));
    return Array.from({ length: 64 }, () => ({ shirt: shirts[Math.floor(r() * shirts.length)], trousers: TROUSERS[Math.floor(r() * TROUSERS.length)], skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)], u: r(), lat: r() }));
  }, []);

  useEffect(() => {
    stationPulse.active = !!route;
    return () => {
      stationPulse.active = false;
    };
  }, [route]);

  const tmp = useMemo(() => ({ car: new Matrix4(), part: new Matrix4(), q: new Quaternion(), v: new Vector3(), s: new Vector3(1, 1, 1), up: new Vector3(0, 1, 0) }), []);

  useFrame(({ clock }) => {
    if (!route) return;
    const now = clock.elapsedTime;
    const t = useSim.getState().t;
    const night = nightLevel(hourOf(t));
    res.mats.arch.emissiveIntensity = 0.15 + 1.1 * night;
    res.parts.glass.mat.emissiveIntensity = 0.1 + 0.9 * night;
    const headway = headwaySeconds(trainsPerHour(t));
    // each direction's run: stops as distances from where its trains appear
    const half = TRAIN_LENGTH / 2;
    const runFor = (dir: 1 | -1) => {
      const order = dir === 1 ? route.stops.map((_, i) => i) : route.stops.map((_, i) => route.stops.length - 1 - i);
      const dist = order.map((i) => (dir === 1 ? route.stops[i].s : route.length - route.stops[i].s) - half);
      return { order, dist, end: route.length - TRAIN_LENGTH };
    };
    const runs = { 1: runFor(1), [-1]: runFor(-1) } as Record<number, ReturnType<typeof runFor>>;

    // timetable: spawn at the route tips; on first frame fill the line as if it had been running
    if (!next.current) {
      next.current = { e: now + 2, w: now + 2 + headway / 2 };
      if (Number.isFinite(headway))
        for (const dir of [1, -1] as const)
          for (let k = 0; k < 6; k++) {
            const t0 = now - (k + (dir === 1 ? 0.3 : 0.8)) * headway;
            const m = runMotion(now - t0, runs[dir].dist, runs[dir].end);
            if (m.phase === "gone") break;
            const done = m.phase === "approach" ? m.stop - 1 : m.stop;
            trains.current.push({ dir, t0, arrived: done, departed: m.phase === "depart" ? m.stop : done - (m.phase === "dwell" ? 1 : 0) });
          }
    }
    for (const dir of [1, -1] as const) {
      const key = dir === 1 ? "e" : "w";
      if (now >= next.current[key]) {
        if (Number.isFinite(headway) && trains.current.length < POOL) trains.current.push({ dir, t0: now, arrived: -1, departed: -1 });
        next.current[key] = now + (Number.isFinite(headway) ? headway * (0.85 + Math.random() * 0.3) : 20);
      }
    }

    const counts: Record<string, number> = {};
    for (const k of Object.keys(PER_CAR)) counts[k] = 0;
    /** Doors open (0..1) per platform "stop:side" this frame. */
    const doorsAt = new Map<string, number>();
    const keep: Train[] = [];
    for (const tr of trains.current) {
      const run = runs[tr.dir];
      const m = runMotion(now - tr.t0, run.dist, run.end);
      if (m.phase === "gone") continue;
      keep.push(tr);
      // left-hand running: southbound (dir +1) on the route's left track, northbound on the other
      const side = tr.dir === 1 ? -1 : 1;
      const stopIdx = run.order[m.stop];
      const stop = route.stops[stopIdx];
      if (m.phase === "dwell" && m.doors > 0.5 && tr.arrived < m.stop) {
        tr.arrived = m.stop;
        if (stop.main) stationPulse.arrivals++;
        for (let k = 0; k < (stop.main ? 14 : 8); k++)
          alighters.current.push({ stop: stopIdx, side, u0: (Math.random() - 0.5) * (TRAIN_LENGTH - 8), lat: Math.random(), t0: now + Math.random() * 1.5, speed: 1.6 + Math.random() * 0.8, look: Math.floor(Math.random() * looks.length) });
      }
      const leaving = m.phase === "depart" || (m.phase === "approach" && m.stop > 0);
      const left = m.phase === "depart" ? m.stop : m.stop - 1;
      if (leaving && tr.departed < left && left >= 0) {
        tr.departed = left;
        if (route.stops[run.order[left]].main) stationPulse.departures++;
        lastDeparture.current.set(`${run.order[left]}:${side}`, now);
      }
      if (m.phase === "dwell") doorsAt.set(`${stopIdx}:${side}`, Math.max(doorsAt.get(`${stopIdx}:${side}`) ?? 0, m.doors));
      const centre = half + m.d; // along the direction of travel
      for (let c = 0; c < TRAIN.cars; c++) {
        const along = centre + (1.5 - c) * (TRAIN.carLen + TRAIN.gap);
        const s = tr.dir === 1 ? along : route.length - along;
        const p = routeAt(route, s, side * TRACK_OFFSET);
        const [x, z] = toScene(p.x, p.z);
        tmp.q.setFromAxisAngle(tmp.up, Math.atan2(p.dx * tr.dir, -p.dz * tr.dir));
        tmp.car.compose(tmp.v.set(x, railLevel(route, s) - DECK_Y, z), tmp.q, tmp.s);
        for (const part of PARTS) {
          const mesh = partRefs.current[part.key];
          if (!mesh) continue;
          for (const off of part.at(c, m.doors)) {
            tmp.part.makeTranslation(off[0], off[1], off[2]);
            mesh.setMatrixAt(counts[part.key]++, tmp.part.premultiply(tmp.car));
          }
        }
      }
    }
    trains.current = keep;
    for (const k of Object.keys(PER_CAR)) {
      const mesh = partRefs.current[k];
      if (!mesh) continue;
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
    }

    // platform people: a queue builds after each train leaves; they board while the doors are open
    let n = 0;
    const service = Number.isFinite(headway);
    route.stops.forEach((stop, si) => {
      for (const side of [-1, 1]) {
        const key = `${si}:${side}`;
        const since = now - (lastDeparture.current.get(key) ?? now - 30);
        const waiting = service ? Math.min(stop.main ? 12 : 7, Math.floor(since / 3)) : 0;
        const boarded = Math.round(waiting * (doorsAt.get(key) ?? 0));
        for (let k = boarded; k < waiting && n < PEOPLE; k++) {
          const lk = looks[(k * 7 + si * 13 + (side > 0 ? 3 : 0)) % looks.length];
          const u = (lk.u - 0.5) * (stop.platformLen - 12);
          const lat = side * (PLATFORM_IN + 1 + lk.lat * (PLATFORM_OUT - PLATFORM_IN - 1.8));
          const p = routeAt(route, stop.s + u, lat);
          const [x, z] = toScene(p.x, p.z);
          // face the track
          people.set(n++, x, PLATFORM_TOP, z, Math.atan2(-side * p.dz, -side * p.dx), 0, false, 1.5, lk.shirt, lk.trousers, lk.skin);
        }
      }
    });
    const still: Alighter[] = [];
    for (const a of alighters.current) {
      const dt = now - a.t0;
      if (dt < 0) {
        still.push(a);
        continue;
      }
      // walk from the door toward the stairs in the middle of the platform, then gone
      const dist = Math.abs(a.u0);
      const walked = dt * a.speed * 2;
      if (walked >= dist || n >= PEOPLE) continue;
      still.push(a);
      const u = a.u0 - Math.sign(a.u0) * walked;
      const lat = a.side * (PLATFORM_IN + 0.8 + a.lat * 2);
      const p = routeAt(route, route.stops[a.stop].s + u, lat);
      const [x, z] = toScene(p.x, p.z);
      const dir = -Math.sign(a.u0);
      const lk = looks[a.look];
      people.set(n++, x, PLATFORM_TOP, z, Math.atan2(p.dx * dir, -p.dz * dir), now * 8 + a.look, true, 1.5, lk.shirt, lk.trousers, lk.skin);
    }
    alighters.current = still;
    people.commit(n);
  });

  if (!route || !stat) return null;
  return (
    <group name="overground">
      <StaticMesh items={stat.deck} geo={res.box} mat={res.mats.deck} />
      <StaticMesh items={stat.ballast} geo={res.box} mat={res.mats.ballast} />
      <StaticMesh items={stat.rails} geo={res.box} mat={res.mats.rail} />
      <StaticMesh items={stat.parapets} geo={res.box} mat={res.mats.parapet} />
      <StaticMesh items={stat.piers} geo={res.box} mat={res.mats.pier} />
      <StaticMesh items={stat.arches} geo={res.box} mat={res.mats.arch} />
      <StaticMesh items={stat.girders} geo={res.box} mat={res.mats.girder} />
      <StaticMesh items={stat.cutting} geo={res.box} mat={res.mats.pier} />
      {route.stops
        .filter((st) => !st.main)
        .map((st) => (
          <MinorStation key={st.name} route={route} stop={st} />
        ))}
      {Object.entries(res.parts).map(([k, p]) => (
        <instancedMesh
          key={k}
          ref={(m) => {
            partRefs.current[k] = m;
          }}
          args={[p.geo, p.mat, POOL * TRAIN.cars * PER_CAR[k]]}
          castShadow={k === "body"}
          frustumCulled={false}
          raycast={noRaycast}
        />
      ))}
      <primitive object={people.group} name="platform-people" />
    </group>
  );
}
