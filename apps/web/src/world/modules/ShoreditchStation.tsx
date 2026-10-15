// Module: ShoreditchStation (decorative). The streets and yards round Shoreditch High Street station (the box itself
// is world/Station.tsx, the trains world/modules/Overground): people coming down the stairs after each train, through
// the gate line and out onto Braithwaite Street to Bethnal Green Road, and others going in; traffic signals at their
// real OSM nodes cycling on the junctions (Bethnal Green Road / Shoreditch High Street, Great Eastern Street /
// Commercial Street), signal crossings, TfL bus stops with people waiting, the Goodsyard behind its hoarding with
// the listed Braithwaite Viaduct across it, and a graffiti wall under the station.
// Data: public/areas/shoreditch-station.json (OSM via Overpass, scripts/fetch-shoreditch-area.mjs). On the mock
// map (no real Overground alignment) only the station's walkers run.
// Draw calls: ~6 (static Kit slots) + ~7 (signs) + hoarding + murals + signal lamps + 3 (people) ≈ 19.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleGeometry, Color, DoubleSide, InstancedMesh, MeshBasicMaterial, MeshStandardMaterial, Object3D } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { overgroundRoute, trainsPerHour } from "../../sim/overground";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { buildArea, type AreaData, type GraffitiWall } from "../shoreditch/area";
import { hoardingTexture, muralTexture } from "../shoreditch/paint";
import { modelObject, stationSite, type StationSite } from "../shoreditch/site";
import { stationPulse } from "../stationPulse";
import { fetchJsonTracked } from "../../state/loading";

const noRaycast = () => null;
const POOL = 110;
const SPEED = 1.35;
const SIGNAL_CYCLE = 64; // s (real time): each phase group gets ~26 s of green

type P3 = [number, number, number]; // contract x, height, contract z

interface Walker {
  path: P3[];
  cum: number[];
  t0: number;
  speed: number;
  look: number;
}

function withCum(path: P3[]): { path: P3[]; cum: number[] } {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
  return { path, cum };
}

/** Station walking routes in contract coords: from the stairs to a point out on Bethnal Green Road (and back). */
function routes(site: StationSite, map: CityMap) {
  const hp = site.parts.hallPoints;
  if (!hp) return null;
  const c = (lx: number, lz: number, y = 0): P3 => {
    const [x, z] = site.toContract(lx, lz);
    return [x, y, z];
  };
  const out = c(hp.outside[0], hp.outside[1]);
  // walk away from the station (the way the outside point lies from the hall) until close to a main road
  const door = c(hp.door[0], hp.door[1]);
  let dx = out[0] - door[0];
  let dz = out[2] - door[2];
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl;
  dz /= dl;
  const mains = map.streets.filter((s) => s.width >= 12);
  let corner: P3 = out;
  let main: (typeof mains)[number] | null = null;
  for (let d = 0; d < 80; d += 1) {
    const x = out[0] + dx * d;
    const z = out[2] + dz * d;
    const hit = mains.find((s) => closestOnStreet(s, x, z)[2] < s.width / 2 + 2.6);
    if (hit) {
      main = hit;
      break;
    }
    corner = [x, 0, z];
  }
  const ends: P3[] = [];
  if (main) {
    const [cx, cz, d] = closestOnStreet(main, corner[0], corner[2]);
    const nx = (corner[0] - cx) / (d || 1);
    const nz = (corner[2] - cz) / (d || 1);
    const off = main.width / 2 + 2.2;
    // along the main road both ways: follow its polyline from the nearest point
    for (const sgn of [-1, 1]) {
      const pts = main.points;
      let best = 0;
      let bd = Infinity;
      pts.forEach(([x, z], i) => {
        const dd = Math.hypot(x - cx, z - cz);
        if (dd < bd) [bd, best] = [dd, i];
      });
      const j = Math.max(0, Math.min(pts.length - 1, best + sgn * 2));
      const [tx, tz] = pts[j];
      const [ex, ez] = closestOnStreet(main, tx, tz);
      ends.push([ex + nx * off, 0, ez + nz * off]);
    }
  } else ends.push([out[0] + dx * 40, 0, out[2] + dz * 40]);
  const gateZ = (i: number) => -6.2 + 1.15 * (i + 0.5);
  const exits: P3[][] = [];
  hp.stairTop.forEach((top, si) => {
    for (let g = 0; g < 6; g++)
      for (const end of ends) {
        const foot = hp.stairFoot[si];
        exits.push([c(top[0], top[1], top[2]), c(foot[0], foot[1]), c(hp.gate[0] - site.hallFace * 1.2, gateZ(g)), c(hp.gate[0] + site.hallFace * 1.2, gateZ(g)), c(hp.door[0], hp.door[1] + (g - 2.5) * 0.6), out, corner, end]);
      }
  });
  return exits;
}

export default function ShoreditchStation() {
  const { map } = useWorld();
  const real = useMemo(() => !!overgroundRoute(map)?.real, [map]);
  const site = useMemo(() => stationSite(map), [map]);
  const [data, setData] = useState<AreaData | null>(null);
  useEffect(() => {
    if (!real) return;
    let live = true;
    fetchJsonTracked(`${import.meta.env.BASE_URL}areas/shoreditch-station.json`, "landmarks", "shoreditch-station", { optional: true })
      .then((d) => live && d && setData(d as AreaData))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [real]);

  // the graffiti wall: along the far kerb of the street the ticket hall looks onto, under the box
  const walls = useMemo<GraffitiWall[]>(() => {
    if (!site?.hall || site.rotY !== 0) return [];
    const face = site.hallFace;
    const gap = site.gaps.find(([a, b]) => (face < 0 ? Math.abs(b + 0.4 - site.hall![0]) < 0.01 : Math.abs(a - 0.4 - site.hall![1]) < 0.01));
    if (!gap) return [];
    const lx = face < 0 ? gap[0] + 0.9 : gap[1] - 0.9;
    const [x, z0] = site.toContract(lx, 7.2);
    const [, z1] = site.toContract(lx, -7.2);
    return [{ x, z0, z1, h: 5.9, face: (face < 0 ? 1 : -1) as 1 | -1 }];
  }, [site]);

  const area = useMemo(() => (data ? buildArea(map, data, { graffitiWalls: walls, tea: real }) : null), [map, data, walls]);
  const areaObject = useMemo(() => (area ? modelObject(area.model, { noRaycast: true }) : null), [area]);
  const mats = useMemo(() => {
    const hoarding = new MeshStandardMaterial({ map: hoardingTexture(), roughness: 0.8, side: DoubleSide, emissive: "#ffffff", emissiveIntensity: 0 });
    hoarding.emissiveMap = hoarding.map;
    const mural = new MeshStandardMaterial({ map: muralTexture(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, emissive: "#ffffff", emissiveIntensity: 0 });
    mural.emissiveMap = mural.map;
    return { hoarding, mural };
  }, []);
  useEffect(
    () => () => {
      mats.hoarding.map?.dispose();
      mats.mural.map?.dispose();
      mats.hoarding.dispose();
      mats.mural.dispose();
    },
    [mats],
  );

  // ---- signal lamps ----
  const lampRef = useRef<InstancedMesh>(null);
  const lampRes = useMemo(() => ({ geo: new CircleGeometry(0.105, 14), mat: new MeshBasicMaterial({ toneMapped: false }) }), []);
  useEffect(() => {
    const m = lampRef.current;
    if (!m || !area) return;
    const o = new Object3D();
    area.lamps.forEach((l, i) => {
      o.position.set(l.p[0], l.p[1], l.p[2]);
      o.rotation.set(0, l.yaw, 0);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, new Color("#222"));
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [area]);
  const lampState = useRef<string>("");
  const LIT = useMemo(() => [new Color("#ff2a1a").multiplyScalar(2.2), new Color("#ffb21a").multiplyScalar(2.2), new Color("#3dff7a").multiplyScalar(2)], []);
  const DIM = useMemo(() => [new Color("#3a0d0a"), new Color("#3a2a08"), new Color("#0b3016")], []);

  // ---- people ----
  const exits = useMemo(() => (site ? routes(site, map) : null), [site, map]);
  const people = useMemo(() => createPeople(POOL, { emissive: 0.08 }), []);
  useEffect(() => () => people.dispose(), [people]);
  const looks = useMemo(() => {
    const r = rng(5150);
    return Array.from({ length: 48 }, () => ({ shirt: new Color().setHSL(r(), 0.45 + r() * 0.3, 0.3 + r() * 0.35), trousers: TROUSERS[Math.floor(r() * TROUSERS.length)], skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)] }));
  }, []);
  const walkers = useRef<Walker[]>([]);
  const lastArrivals = useRef(stationPulse.arrivals);
  const nextEntry = useRef(0);

  useFrame(({ clock }) => {
    const now = clock.elapsedTime;
    const t = useSim.getState().t;
    const h = hourOf(t);
    const night = nightLevel(h);
    mats.hoarding.emissiveIntensity = 0.12 * night;
    mats.mural.emissiveIntensity = 0.1 * night;

    // signals: two phase groups (along x-ish / along z-ish roads)
    const m = lampRef.current;
    if (m && area) {
      const ph = now % SIGNAL_CYCLE;
      const g0: 0 | 1 | 2 = ph < 26 ? 2 : ph < 29 ? 1 : 0;
      const g1: 0 | 1 | 2 = ph >= 32 && ph < 58 ? 2 : ph >= 58 && ph < 61 ? 1 : 0;
      const key = `${g0}${g1}`;
      if (key !== lampState.current) {
        lampState.current = key;
        area.lamps.forEach((l, i) => m.setColorAt(i, (l.group === 0 ? g0 : g1) === l.color ? LIT[l.color] : DIM[l.color]));
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }

    // station walkers: a burst down the stairs after each train, a steady stream in
    const service = trainsPerHour(t) > 0;
    const rush = (h >= 7 && h < 10) || (h >= 16.5 && h < 19.5);
    if (exits && exits.length) {
      if (stationPulse.arrivals !== lastArrivals.current) {
        lastArrivals.current = stationPulse.arrivals;
        const n = rush ? 14 : h >= 22 || h < 6 ? 6 : 9;
        for (let i = 0; i < n && walkers.current.length < POOL - 12; i++) {
          const p = exits[Math.floor(Math.random() * exits.length)];
          walkers.current.push({ ...withCum(p), t0: now + 5 + Math.random() * 12, speed: SPEED * (0.85 + Math.random() * 0.35), look: Math.floor(Math.random() * looks.length) });
        }
      }
      // with no Overground running (the mock without the module, or an idle pulse), keep a light trickle out
      const rate = !service ? 0 : rush ? 0.45 : h >= 22 || h < 6 ? 0.1 : 0.22;
      if (rate > 0 && now >= nextEntry.current) {
        nextEntry.current = now + (-Math.log(1 - Math.random()) / rate);
        if (walkers.current.length < POOL - 12) {
          const p = [...exits[Math.floor(Math.random() * exits.length)]].reverse();
          walkers.current.push({ ...withCum(p), t0: now, speed: SPEED * (0.85 + Math.random() * 0.35), look: Math.floor(Math.random() * looks.length) });
        }
        if (!stationPulse.active && Math.random() < 0.6 && walkers.current.length < POOL - 12) {
          const p = exits[Math.floor(Math.random() * exits.length)];
          walkers.current.push({ ...withCum(p), t0: now, speed: SPEED, look: Math.floor(Math.random() * looks.length) });
        }
      }
    }
    let n = 0;
    const keep: Walker[] = [];
    for (const w of walkers.current) {
      const d = (now - w.t0) * w.speed;
      const total = w.cum[w.cum.length - 1];
      if (d >= total) continue;
      keep.push(w);
      if (d < 0 || n >= POOL) continue;
      let i = 1;
      while (i < w.cum.length - 1 && w.cum[i] < d) i++;
      const a = w.path[i - 1];
      const b = w.path[i];
      const seg = w.cum[i] - w.cum[i - 1] || 1;
      const k = (d - w.cum[i - 1]) / seg;
      const x = a[0] + (b[0] - a[0]) * k;
      const y = a[1] + (b[1] - a[1]) * k;
      const z = a[2] + (b[2] - a[2]) * k;
      const [sx, sz] = toScene(x, z);
      const lk = looks[w.look];
      people.set(n++, sx, y, sz, Math.atan2(b[0] - a[0], -(b[2] - a[2])), now * 7 + w.look, true, 1.7, lk.shirt, lk.trousers, lk.skin);
    }
    walkers.current = keep;
    // people waiting at the bus stops
    if (area) {
      const share = h < 5.5 ? 0.15 : rush ? 0.85 : h >= 22 ? 0.35 : 0.5;
      area.waiting.forEach((s, i) => {
        if (n >= POOL || ((i * 7919) % 100) / 100 > share) return;
        const lk = looks[(i * 5) % looks.length];
        people.set(n++, s.x, 0.15, s.z, s.yaw, i * 1.7 + now * 0.3, false, 1.7, lk.shirt, lk.trousers, lk.skin);
      });
    }
    people.commit(n);
  });

  return (
    <group name="shoreditch-station-area">
      {areaObject && <primitive object={areaObject} />}
      {area && <mesh geometry={area.hoarding} material={mats.hoarding} receiveShadow raycast={noRaycast} />}
      {area && <mesh geometry={area.murals} material={mats.mural} receiveShadow raycast={noRaycast} />}
      {area && area.lamps.length > 0 && <instancedMesh ref={lampRef} args={[lampRes.geo, lampRes.mat, area.lamps.length]} raycast={noRaycast} />}
      <primitive object={people.group} name="station-street-people" />
    </group>
  );
}
