// Module: Overground (decorative). The East London line on its brick viaduct through Shoreditch High Street:
// arches (some let as lit workshops and bars), steel bridges where it crosses a street, ballast and rails, and
// four-car orange-striped Class 378 trains both ways. Trains brake into the platform, open their doors, people get
// off and walk to the stairs (and the background crowd streams out of the station: world/stationPulse), the
// waiting passengers board, the doors close and the train pulls out. Frequency follows the sim clock's timetable
// (sim/overground.ts: peaks, evenings, no trains in the small hours except the Night Overground on Fri/Sat);
// motion runs in real seconds like the rest of the street life. Instanced: a few draw calls for every train.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, Color, Matrix4, MeshStandardMaterial, Object3D, Quaternion, Vector3, type InstancedMesh } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { DECK_Y, headwaySeconds, overgroundRoute, routeAt, TRACK_OFFSET, TRAIN, TRAIN_LENGTH, trainMotion, trainsPerHour, VIADUCT_W, type OvergroundRoute } from "../../sim/overground";
import { exitContinuations } from "../../sim/surroundings";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { PLATFORM_IN, PLATFORM_OUT, PLATFORM_TOP } from "../Station";
import { stationPulse } from "../stationPulse";

const noRaycast = () => null;
const PIER_EVERY = 13;
const POOL = 8; // trains alive at once, both directions
const FLOOR = DECK_Y + 0.55; // bottom of the car body

interface Static {
  m: Matrix4;
  c?: Color;
}

/** Everything that doesn't move, as instance lists. */
function viaduct(route: OvergroundRoute, map: CityMap) {
  const o = new Object3D();
  const mk = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rot: number, c?: string): Static => {
    const [px, pz] = toScene(x, z);
    o.position.set(px, y, pz);
    o.rotation.set(0, rot, 0);
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
  const half = route.platformLen / 2;
  const inStation = (s: number) => Math.abs(s - route.stationS) < half + 0.5;
  const pts = route.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.01) continue;
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    // scene heading: local +z along the segment
    const rot = Math.atan2(bx - ax, -(bz - az));
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    const station = inStation((route.cum[i] + route.cum[i + 1]) / 2);
    deck.push(mk(mx, DECK_Y - 0.8, mz, VIADUCT_W, 1.6, len + 0.6, rot));
    ballast.push(mk(mx, DECK_Y + 0.04, mz, VIADUCT_W - 1.4, 0.1, len + 0.6, rot));
    for (const lat of [-TRACK_OFFSET - 0.72, -TRACK_OFFSET + 0.72, TRACK_OFFSET - 0.72, TRACK_OFFSET + 0.72])
      rails.push(mk(mx + uz * lat, DECK_Y + 0.17, mz - ux * lat, 0.12, 0.14, len + 0.6, rot));
    if (!station) for (const lat of [-1, 1]) parapets.push(mk(mx + uz * lat * (VIADUCT_W / 2 - 0.2), DECK_Y + 0.5, mz - ux * lat * (VIADUCT_W / 2 - 0.2), 0.4, 1, len + 0.4, rot));
  }
  // piers every PIER_EVERY m, except under the station (it has its own) and where a street runs underneath
  const roads = [...map.streets, ...exitContinuations(map, 400)];
  const overRoad = (x: number, z: number) => roads.some((st) => closestOnStreet(st, x, z)[2] < st.width / 2 + 2.2);
  const r = rng(378);
  let prev: { s: number; ok: boolean } | null = null;
  for (let s = PIER_EVERY / 2; s < route.length; s += PIER_EVERY) {
    const p = routeAt(route, s);
    const rot = Math.atan2(p.dx, -p.dz);
    const ok = !inStation(s) && !overRoad(p.x, p.z);
    if (ok) piers.push(mk(p.x, (DECK_Y - 1.6) / 2, p.z, VIADUCT_W - 0.2, DECK_Y - 1.6, 1.8, rot, "#7a4a3a"));
    if (prev) {
      const mid = routeAt(route, (prev.s + s) / 2);
      const mrot = Math.atan2(mid.dx, -mid.dz);
      if (ok && prev.ok) {
        // an arch: the brick spandrel under the deck, and the arch's own front set back inside it
        arches.push(mk(mid.x, DECK_Y - 2.4, mid.z, VIADUCT_W - 0.3, 1.6, PIER_EVERY - 1.6, mrot, "#6e4134"));
        const lit = r() < 0.45;
        const tone = lit ? ["#ffcf8a", "#ffb870", "#ffe2b0"][Math.floor(r() * 3)] : ["#2a2d33", "#3a3f47", "#4b3a2f", "#23362e"][Math.floor(r() * 4)];
        arches.push(mk(mid.x, (DECK_Y - 3.2) / 2, mid.z, VIADUCT_W - 1.4, DECK_Y - 3.2, PIER_EVERY - 2, mrot, tone));
      } else if (!inStation((prev.s + s) / 2) && (overRoad(mid.x, mid.z) || !ok || !prev.ok)) {
        // a bridge over the street: painted steel plate girders along both edges
        for (const lat of [-1, 1]) girders.push(mk(mid.x + mid.dz * lat * (VIADUCT_W / 2 + 0.1), DECK_Y - 0.5, mid.z - mid.dx * lat * (VIADUCT_W / 2 + 0.1), 0.35, 2.6, PIER_EVERY + 0.4, mrot));
      }
    }
    prev = { s, ok };
  }
  return { deck, ballast, rails, parapets, piers, arches, girders };
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
  arrived: boolean;
  departed: boolean;
}

/** People on the platforms: waiting (standing) and just off a train (walking to the stairs). */
interface Alighter {
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
  const lastDeparture = useRef<{ [side: number]: number }>({ [-1]: 0, [1]: 0 });
  const alighters = useRef<Alighter[]>([]);
  const people = useMemo(() => createPeople(160, { emissive: 0.08 }), []);
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
    const toStopE = route.stationS - TRAIN_LENGTH / 2;
    const afterE = route.length - TRAIN_LENGTH / 2 - route.stationS;
    const plan = (dir: 1 | -1) => (dir === 1 ? [toStopE, afterE] : [afterE, toStopE]);

    // timetable: spawn at the route tips; on first frame fill the line as if it had been running
    if (!next.current) {
      next.current = { e: now + 3, w: now + 3 + headway / 2 };
      if (Number.isFinite(headway))
        for (const dir of [1, -1] as const) for (let k = 0; k < 3; k++) trains.current.push({ dir, t0: now - (k + (dir === 1 ? 0.3 : 0.8)) * headway, arrived: true, departed: true });
    }
    for (const dir of [1, -1] as const) {
      const key = dir === 1 ? "e" : "w";
      if (now >= next.current[key]) {
        if (Number.isFinite(headway) && trains.current.length < POOL) trains.current.push({ dir, t0: now, arrived: false, departed: false });
        next.current[key] = now + (Number.isFinite(headway) ? headway * (0.85 + Math.random() * 0.3) : 20);
      }
    }

    const counts: Record<string, number> = {};
    for (const k of Object.keys(PER_CAR)) counts[k] = 0;
    const doorsBySide: Record<number, number> = { [-1]: 0, [1]: 0 };
    const keep: Train[] = [];
    for (const tr of trains.current) {
      const [toStop, after] = plan(tr.dir);
      const m = trainMotion(now - tr.t0, toStop, after);
      if (m.phase === "gone") continue;
      keep.push(tr);
      // eastbound runs on the left-hand (north) track, westbound on the other: UK left-hand running
      const side = tr.dir === 1 ? -1 : 1;
      if (m.phase === "dwell" && m.doors > 0.5 && !tr.arrived) {
        tr.arrived = true;
        stationPulse.arrivals++;
        for (let k = 0; k < 14; k++)
          alighters.current.push({ side, u0: (Math.random() - 0.5) * (TRAIN_LENGTH - 8), lat: Math.random(), t0: now + Math.random() * 1.5, speed: 1.6 + Math.random() * 0.8, look: Math.floor(Math.random() * looks.length) });
      }
      if (m.phase === "depart" && tr.arrived && !tr.departed) {
        tr.departed = true;
        stationPulse.departures++;
        lastDeparture.current[side] = now;
      }
      if (m.phase === "dwell") doorsBySide[side] = Math.max(doorsBySide[side], m.doors);
      const centre = TRAIN_LENGTH / 2 + m.d; // along the direction of travel
      for (let c = 0; c < TRAIN.cars; c++) {
        const along = centre + (1.5 - c) * (TRAIN.carLen + TRAIN.gap);
        const s = tr.dir === 1 ? along : route.length - along;
        const p = routeAt(route, s, side * TRACK_OFFSET);
        const [x, z] = toScene(p.x, p.z);
        tmp.q.setFromAxisAngle(tmp.up, Math.atan2(p.dx * tr.dir, -p.dz * tr.dir));
        tmp.car.compose(tmp.v.set(x, 0, z), tmp.q, tmp.s);
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

    // platform people
    let n = 0;
    const service = Number.isFinite(headway);
    for (const side of [-1, 1]) {
      const since = now - lastDeparture.current[side];
      const waiting = service ? Math.min(12, Math.floor(since / 2.5)) : 0;
      const boarded = Math.round(waiting * doorsBySide[side]);
      for (let k = boarded; k < waiting && n < 160; k++) {
        const lk = looks[(k * 7 + (side > 0 ? 3 : 0)) % looks.length];
        const u = (lk.u - 0.5) * (route.platformLen - 12);
        const lat = side * (PLATFORM_IN + 1 + lk.lat * (PLATFORM_OUT - PLATFORM_IN - 1.8));
        const p = routeAt(route, route.stationS + u, lat);
        const [x, z] = toScene(p.x, p.z);
        // face the track
        people.set(n++, x, PLATFORM_TOP, z, Math.atan2(-side * p.dz, -side * p.dx), 0, false, 1.5, lk.shirt, lk.trousers, lk.skin);
      }
    }
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
      if (walked >= dist || n >= 160) continue;
      still.push(a);
      const u = a.u0 - Math.sign(a.u0) * walked;
      const lat = a.side * (PLATFORM_IN + 0.8 + a.lat * 2);
      const p = routeAt(route, route.stationS + u, lat);
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
