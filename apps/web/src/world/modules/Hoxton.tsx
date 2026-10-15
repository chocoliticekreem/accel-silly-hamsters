// Module: Hoxton (decorative). The real streets between Old Street, East Road, Hoxton Street and Kingsland Road,
// built from an OpenStreetMap extract (public/areas/hoxton.json; world/hoxton/build.ts does the geometry):
// pavements, kerbs, crossings, cycle lanes, Hoxton Square's railed garden of plane trees, the gap buildings and
// yards the base map leaves empty, parked bikes and street furniture, shopfront fascias for every named venue,
// murals on Rivington St / Charlotte Rd / Curtain Rd, Hoxton Street Market stalls by day, people on the pavements
// (busier by the sim clock: rush hours, lunch, the evening bar crowd outside the pubs) and Best Mangal next to
// City Best Wine. The generic Infill and StreetDressing modules leave this patch alone (sim/areaKeepouts.ts).
// Draw calls: hero slots ~6 + ground + gap buildings + signs + murals + market + people 3 (+ Best Mangal ~10).
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { Color, DoubleSide, MeshStandardMaterial } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { dayOf, hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { cityMaterial } from "../cityMaterial";
import { useWorld } from "../context";
import BestMangal from "../hoxton/BestMangal";
import { buildHoxton, type HoxtonBuilt } from "../hoxton/build";
import { loadHoxton, type HoxtonData } from "../hoxton/data";
import { heroMaterials, setHeroNight } from "../models/materials";
import type { Slot } from "../models/kit";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";

export default function Hoxton() {
  const { map } = useWorld();
  const [data, setData] = useState<HoxtonData | null>(null);
  // the small mock map doesn't reach Hoxton
  const inMap = map.bounds.minX <= -700 && map.bounds.maxZ >= 500;
  useEffect(() => {
    if (!inMap) return;
    let live = true;
    loadHoxton()
      .then((d) => live && setData(d))
      .catch((e) => console.warn("[hoxton] OSM extract unavailable", e));
    return () => {
      live = false;
    };
  }, [inMap]);
  if (!inMap) return null;
  return (
    <group name="hoxton">
      <BestMangal />
      {data && <Area map={map} data={data} />}
    </group>
  );
}

/** Walkers on the pavements: share of the crowd out at this hour (Hoxton: busy late for the bars). */
function streetShare(h: number) {
  if (h < 1) return 0.5;
  if (h < 3) return 0.32;
  if (h < 6) return 0.08;
  if (h < 7) return 0.3;
  if (h < 10) return 0.85;
  if (h < 12) return 0.6;
  if (h < 14) return 0.85;
  if (h < 17) return 0.62;
  if (h < 19.5) return 0.95;
  if (h < 23) return 0.85;
  return 0.65;
}
function barShare(h: number) {
  if (h >= 12 && h < 14) return 0.2;
  if (h >= 17 && h < 18.5) return 0.35;
  if (h >= 18.5 && h < 20) return 0.7;
  if (h >= 20 || h < 1.5) return 1;
  if (h < 2.5) return 0.35;
  return 0;
}

const WALKERS = 380;

function Area({ map, data }: { map: CityMap; data: HoxtonData }) {
  const built = useMemo<HoxtonBuilt>(() => {
    const b = buildHoxton(map, data);
    console.info("[hoxton] built", JSON.stringify(b.stats));
    return b;
  }, [map, data]);

  const mats = useMemo(() => {
    const sign = built.atlas
      ? new MeshStandardMaterial({ map: built.atlas.texture, emissiveMap: built.atlas.texture, emissive: new Color("#ffffff"), emissiveIntensity: 0.2, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 })
      : null;
    const mural = built.atlas ? new MeshStandardMaterial({ map: built.atlas.texture, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }) : null;
    const ground = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const buildings = cityMaterial({ litShare: 0.3 });
    buildings.vertexColors = true;
    const market = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide });
    return { sign, mural, ground, buildings, market };
  }, [built]);
  const hero = heroMaterials();

  useEffect(
    () => () => {
      for (const g of [...Object.values(built.kit), ...Object.values(built.market), built.ground, built.buildings, built.signs, built.murals]) g?.dispose();
      built.atlas?.texture.dispose();
      Object.values(mats).forEach((m) => m?.dispose());
    },
    [built, mats],
  );

  // ---- people ------------------------------------------------------------------------------------------------
  const crowd = useMemo(() => {
    const r = rng(1717);
    const runs = built.runs;
    const total = runs.reduce((a, x) => a + x.len, 0) || 1;
    const pickRun = () => {
      let k = r() * total;
      for (let i = 0; i < runs.length; i++) {
        k -= runs[i].len;
        if (k <= 0) return i;
      }
      return runs.length - 1;
    };
    const look = () => ({
      shirt: new Color().setHSL(r(), 0.25 + r() * 0.45, 0.22 + r() * 0.45),
      trousers: TROUSERS[Math.floor(r() * TROUSERS.length)],
      skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)],
    });
    const walkers = runs.length
      ? Array.from({ length: WALKERS }, () => ({ run: pickRun(), s0: r() * 1000, speed: 1.05 + r() * 0.55, dir: r() < 0.5 ? 1 : -1, lat: (r() - 0.5) * 1.1, scale: 1.65 + r() * 0.2, ...look() }))
      : [];
    const standers: { x: number; z: number; heading: number; kind: "bar" | "lawn" | "market"; rank: number; scale: number; shirt: Color; trousers: Color; skin: Color }[] = [];
    for (const s of built.spots) {
      const n = s.kind === "bar" ? 3 + Math.floor(r() * 4) : s.kind === "market" ? 1 + (r() < 0.5 ? 1 : 0) : 1 + (r() < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 0.5;
        const rad = s.kind === "bar" ? 0.7 + r() * 0.3 : s.kind === "market" ? 0.6 : 0.5;
        const x = s.x + Math.cos(a) * rad * (n > 1 ? 1 : 0);
        const z = s.z + Math.sin(a) * rad * (n > 1 ? 1 : 0);
        // face the middle of the group (a lone person faces the spot's direction)
        const hx = n > 1 ? s.x - x : s.ox;
        const hz = n > 1 ? s.z - z : s.oz;
        standers.push({ x, z, heading: Math.atan2(hx, -hz), kind: s.kind, rank: r(), scale: 1.62 + r() * 0.22, ...look() });
      }
    }
    return { walkers, standers, people: createPeople(walkers.length + standers.length, { emissive: 0.08 }) };
  }, [built]);
  useEffect(() => () => crowd.people.dispose(), [crowd]);

  const [marketOpen, setMarketOpen] = useState(false);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    const simT = useSim.getState().t;
    const h = hourOf(simT);
    const night = nightLevel(h);
    setHeroNight(night);
    if (mats.sign) mats.sign.emissiveIntensity = 0.12 + 1.15 * night;
    mats.buildings.uniforms.night.value = night;
    const dow = (dayOf(simT) - 1) % 7;
    const open = dow !== 6 && h >= 8 && h < 17.5; // Hoxton Street Market: Mon-Sat, daytime
    if (open !== marketOpen) setMarketOpen(open);

    const { walkers, standers, people } = crowd;
    const runs = built.runs;
    let n = 0;
    const share = streetShare(h);
    const active = Math.floor(walkers.length * share);
    for (let i = 0; i < active; i++) {
      const w = walkers[i];
      const run = runs[w.run];
      const L = run.len;
      const p = w.s0 + w.speed * time;
      const m = p % (2 * L);
      const fwd = m < L;
      const s = fwd ? m : 2 * L - m;
      const k = Math.min(L - 1, Math.floor(s));
      const f = s - k;
      const pts = run.pts;
      const ax = pts[k * 2];
      const az = pts[k * 2 + 1];
      const bx = pts[k * 2 + 2];
      const bz = pts[k * 2 + 3];
      let dx = bx - ax;
      let dz = bz - az;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      const sign = fwd === w.dir > 0 ? 1 : -1;
      // keep left-ish: lateral offset flips with walking direction so two-way flows pass each other
      const lat = w.lat * sign;
      const x = ax + (bx - ax) * f - dz * lat;
      const z = az + (bz - az) * f + dx * lat;
      const [sx, sz] = toScene(x, z);
      const hx = fwd ? dx : -dx;
      const hz = fwd ? dz : -dz;
      people.set(n++, sx, 0, sz, Math.atan2(hx, -hz), time * 6.5 * w.speed + i, true, w.scale, w.shirt, w.trousers, w.skin);
    }
    const bars = barShare(h);
    const lawn = h >= 10.5 && h < 19.5 ? (h >= 12 && h < 17 ? 1 : 0.4) * (night > 0.5 ? 0 : 1) : 0;
    for (let i = 0; i < standers.length; i++) {
      const s = standers[i];
      const want = s.kind === "bar" ? bars : s.kind === "lawn" ? lawn : open ? 1 : 0;
      if (s.rank >= want) continue;
      const [sx, sz] = toScene(s.x, s.z);
      people.set(n++, sx, 0, sz, s.heading, time * 0.8 + i * 1.3, false, s.scale, s.shirt, s.trousers, s.skin);
    }
    people.commit(n);
  });

  return (
    <group name="hoxton-area">
      {built.ground && <mesh geometry={built.ground} material={mats.ground} receiveShadow raycast={() => null} />}
      {built.buildings && <mesh geometry={built.buildings} material={mats.buildings} castShadow receiveShadow raycast={() => null} />}
      {Object.entries(built.kit).map(([slot, geo]) => (
        <mesh key={slot} geometry={geo} material={hero[slot as Slot]} castShadow={slot !== "glow" && slot !== "glass"} receiveShadow raycast={() => null} />
      ))}
      {built.signs && mats.sign && <mesh geometry={built.signs} material={mats.sign} raycast={() => null} />}
      {built.murals && mats.mural && <mesh geometry={built.murals} material={mats.mural} receiveShadow raycast={() => null} />}
      {marketOpen && built.market.solid && <mesh geometry={built.market.solid} material={mats.market} castShadow receiveShadow raycast={() => null} />}
      <primitive object={crowd.people.group} />
    </group>
  );
}
