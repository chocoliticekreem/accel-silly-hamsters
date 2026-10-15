// Module: RealBuildings. Every building of real Shoreditch from its OpenStreetMap footprint (world/realcity, baked by
// scripts/bake-city.mjs): extruded polygons with holes, real heights (height / building:levels × floor height),
// building:part drawn instead of an outline that has parts (never both), flat roofs with parapets, gabled / hipped /
// pyramidal / skillion roofs where tagged, roof colours sampled from aerial imagery, wall colours from the tagged
// colour / material or a London brick / office palette, windows drawn by the facade shader and lit at night.
// Merged into a few dozen chunk meshes (realcity/buildingGeometry.ts).
//
// Data buildings (map.json stores, clubs, the station) keep working:
//  - each store's box is matched to its real polygon (OSM id first, then containment); the Stores module's box body is
//    made invisible but stays clickable, and its shopfront (window, awning, sign) is slid onto the real facade;
//  - the station keeps its own model (world/Station.tsx), the real station polygons under it are not drawn;
//  - a hero landmark model (any scene object named `landmark-*`) hides the real polygons it stands on;
//  - an open interior (state/safety insideId) hides its store's real building.
// Until the data is drawn the old Buildings module stays on (world/graphics.ts), so a missing bake never blanks the city.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Box3, type BufferAttribute, type BufferGeometry, type Mesh, type Object3D } from "three";
import type { Building, CityMap } from "../../api/contract";
import { frontage, toScene } from "../../sim/geometry";
import { kerbDistance, MIN_PAVEMENT } from "../../sim/footprints";
import { useFacades } from "../facades";
import { SKYLINE_SPOTS } from "../../sim/london";
import { GOODSYARD_AREA, HOXTON_AREA, inPoly } from "../../sim/areaKeepouts";
import { OLD_STREET_AREA, OLD_STREET_OSM_WAYS, WHITE_COLLAR_AREA } from "../../sim/oldStreetArea";
import { keptOut } from "../keepOut";
import { landmarkKeepouts } from "../models/plots";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSafety } from "../../state/safety";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { addBuilding, CHUNK, lookOf, MeshBuilder } from "../realcity/buildingGeometry";
import { inPolygon, useRealCity, useRealCityData, type RealBuilding, type RealCity } from "../realcity/data";
import { facadeMaterial } from "../realcity/facadeMaterial";
import { Station } from "../Station";

const noRaycast = () => null;

interface Range {
  chunk: number;
  start: number;
  count: number;
}

interface Built {
  chunks: { geo: BufferGeometry; outer: boolean; original: Float32Array }[];
  /** building index → its vertex range (only drawn buildings). */
  ranges: Map<number, Range>;
  /** store id → building index of its real polygon. */
  storeMatch: Map<string, number>;
  drawnCount: number;
}

/** The station box in scene coords, padded: real polygons centred inside are replaced by the Station model. */
function stationRect(map: CityMap) {
  const st = map.buildings.filter((b) => b.kind === "station").sort((a, b) => b.w * b.d - a.w * a.d)[0];
  if (!st) return null;
  const [x, z] = toScene(st.x, st.z);
  return { st, minX: x - st.w / 2 - 2, maxX: x + st.w / 2 + 2, minZ: z - st.d / 2 - 2, maxZ: z + st.d / 2 + 2 };
}

/** Real polygon for a map building: the OSM way first, else the smallest drawn polygon containing its centre. */
function matchBuilding(city: RealCity, b: Building, osmId: string | null | undefined, byId: Map<string, number>): number | null {
  const m = osmId?.match(/^(way|relation)\/(\d+)$/);
  if (m) {
    const i = byId.get(`${m[1][0]}${m[2]}`);
    if (i != null && !city.buildings[i].hasParts) return i;
  }
  const [x, z] = toScene(b.x, b.z);
  let best: number | null = null;
  let bestD = Infinity;
  city.buildings.forEach((rb, i) => {
    if (rb.hasParts || rb.outer) return;
    if (Math.abs(rb.cx - x) > 120 || Math.abs(rb.cz - z) > 120) return;
    if (inPolygon(x, z, rb.rings)) {
      // smallest containing polygon (a shop's own building, not the block around it); low parts preferred
      const score = rb.area + rb.minH * 1000;
      if (score < bestD) (bestD = score), (best = i);
    }
  });
  if (best != null) return best;
  // nearest within 6 m (box centres can sit just outside a thin polygon)
  bestD = 36;
  city.buildings.forEach((rb, i) => {
    if (rb.hasParts || rb.outer || rb.minH > 0) return;
    const d = (rb.cx - x) ** 2 + (rb.cz - z) ** 2;
    if (d < bestD && d < Math.max(36, rb.area / 3)) (bestD = d), (best = i);
  });
  return best;
}

function build(city: RealCity, map: CityMap): Built {
  const station = stationRect(map);
  const skyline = SKYLINE_SPOTS.map((s) => {
    const [x, z] = toScene(s.x, s.z);
    return { x, z, r: s.r + 8 };
  });
  const byId = new Map(city.buildings.map((b, i) => [b.id, i]));
  // footprints other modules draw themselves (contract coords): hero landmark plots, keep-out heroes, area patches
  const heroPlots = landmarkKeepouts(map);
  const boxCover = (b: RealBuilding) => {
    // share of the footprint covered by map.json boxes / landmark plots (Hoxton draws the uncovered ones itself)
    let n = 0;
    let covered = 0;
    const r = b.rings[0];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of r) (minX = Math.min(minX, x)), (maxX = Math.max(maxX, x)), (minZ = Math.min(minZ, z)), (maxZ = Math.max(maxZ, z));
    // map boxes near this footprint (contract z = -scene z)
    const near = map.buildings.filter((m) => m.x + m.w / 2 > minX - 1 && m.x - m.w / 2 < maxX + 1 && m.z + m.d / 2 > -maxZ - 1 && m.z - m.d / 2 < -minZ + 1);
    for (let x = minX + 0.75; x < maxX; x += 1.5)
      for (let z = minZ + 0.75; z < maxZ; z += 1.5) {
        if (!inPolygon(x, z, b.rings)) continue;
        n++;
        const cx = x;
        const cz = -z;
        if (near.some((m) => Math.abs(cx - m.x) < m.w / 2 + 0.3 && Math.abs(cz - m.z) < m.d / 2 + 0.3) || heroPlots.some((k) => cx > k.x0 && cx < k.x1 && cz > k.z0 && cz < k.z1)) covered++;
      }
    return n ? covered / n : 1;
  };
  const ownedElsewhere = (b: RealBuilding) => {
    const x = b.cx;
    const z = -b.cz;
    if (OLD_STREET_OSM_WAYS.has(Number(b.id.slice(1))) && b.id[0] === "w") return true;
    if (keptOut(x, z)) return true;
    if (heroPlots.some((k) => x > k.x0 && x < k.x1 && z > k.z0 && z < k.z1)) return true;
    if (inPoly(x, z, GOODSYARD_AREA) || inPoly(x, z, OLD_STREET_AREA) || inPoly(x, z, WHITE_COLLAR_AREA)) return true;
    // Hoxton extrudes the OSM footprints the backend map has no box for: leave those to it
    if (inPoly(x, z, HOXTON_AREA) && b.minH === 0 && !b.part && boxCover(b) <= 0.35) return true;
    return false;
  };
  const skip = (b: RealBuilding) =>
    b.hasParts ||
    (!b.outer && ownedElsewhere(b)) ||
    (station && b.cx > station.minX && b.cx < station.maxX && b.cz > station.minZ && b.cz < station.maxZ) ||
    (b.outer && skyline.some((s) => Math.hypot(b.cx - s.x, b.cz - s.z) < s.r));

  const builders = new Map<string, { mb: MeshBuilder; outer: boolean; index: number }>();
  const ranges = new Map<number, Range>();
  let drawnCount = 0;
  const order: string[] = [];
  city.buildings.forEach((b, i) => {
    if (skip(b)) return;
    const key = `${Math.floor(b.cx / CHUNK)},${Math.floor(b.cz / CHUNK)},${b.outer ? 1 : 0}`;
    let c = builders.get(key);
    if (!c) {
      c = { mb: new MeshBuilder(), outer: b.outer, index: order.length };
      builders.set(key, c);
      order.push(key);
    }
    const start = c.mb.nv;
    addBuilding(c.mb, b, lookOf(b, city.enums.materials), { parapet: !b.outer });
    ranges.set(i, { chunk: c.index, start, count: c.mb.nv - start });
    drawnCount++;
  });
  const chunks = order.map((k) => {
    const c = builders.get(k)!;
    const geo = c.mb.geometry();
    return { geo, outer: c.outer, original: (geo.attributes.position.array as Float32Array).slice() };
  });

  const storeMatch = new Map<string, number>();
  for (const s of map.stores) {
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (!b) continue;
    const i = matchBuilding(city, b, s.osmId, byId);
    if (i != null && ranges.has(i)) storeMatch.set(s.id, i);
  }
  return { chunks, ranges, storeMatch, drawnCount };
}

/** Distance from (x, z) along unit (dx, dz) to where the ray leaves polygon rings (scene coords). */
function exitDistance(x: number, z: number, dx: number, dz: number, b: RealBuilding): number | null {
  let best: number | null = null;
  for (const r of b.rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, az] = r[j];
      const [bx, bz] = r[i];
      const ex = bx - ax;
      const ez = bz - az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - x) * ez - (az - z) * ex) / den;
      const u = ((ax - x) * dz - (az - z) * dx) / den;
      if (t > 0 && u >= 0 && u <= 1 && (best == null || t < best)) best = t;
    }
  return best;
}

export default function RealBuildings() {
  const city = useRealCityData();
  const { map } = useWorld();
  const built = useMemo(() => {
    if (!city) return null;
    const t0 = performance.now();
    const b = build(city, map);
    console.info(`[RealBuildings] built in ${Math.round(performance.now() - t0)} ms`);
    return b;
  }, [city, map]);
  const gl = useThree((s) => s.gl);
  // debugging aid: `await __frameStats()` in the console = draw calls and triangles of one whole frame (all passes)
  useEffect(() => {
    (window as unknown as { __frameStats?: () => Promise<unknown> }).__frameStats = async () => {
      gl.info.autoReset = false;
      gl.info.reset();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = { ...gl.info.render, ...gl.info.memory, programs: gl.info.programs?.length };
      gl.info.autoReset = true;
      return out;
    };
  }, [gl]);
  const meshes = useRef<(Mesh | null)[]>([]);
  const scene = useThree((s) => s.scene);
  const hidden = useRef(new Set<number>());
  const heroHidden = useRef(new Set<number>());
  const heroKey = useRef("");
  const tick = useRef(0);
  const insideId = useSafety((s) => s.insideId);
  const mat = facadeMaterial();

  useEffect(() => {
    if (!built) return;
    useRealCity.setState({ drawn: true });
    console.info(`[RealBuildings] ${built.drawnCount} buildings in ${built.chunks.length} meshes; ${built.storeMatch.size}/${map.stores.length} stores matched to real footprints`);
    return () => {
      useRealCity.setState({ drawn: false });
      built.chunks.forEach((c) => c.geo.dispose());
    };
  }, [built, map]);

  /** Collapse (hide) or restore one building's vertices. */
  const setHidden = (i: number, hide: boolean) => {
    if (!built) return;
    const r = built.ranges.get(i);
    if (!r) return;
    const c = built.chunks[r.chunk];
    const attr = c.geo.attributes.position as BufferAttribute;
    const arr = attr.array as Float32Array;
    const s = r.start * 3;
    const e = (r.start + r.count) * 3;
    if (hide) for (let k = s; k < e; k += 3) (arr[k] = c.original[s]), (arr[k + 1] = -50), (arr[k + 2] = c.original[s + 2]);
    else arr.set(c.original.subarray(s, e), s);
    attr.addUpdateRange(s, e - s);
    attr.needsUpdate = true;
  };

  const sync = () => {
    if (!built) return;
    const want = new Set<number>(heroHidden.current);
    const inside = insideId != null ? built.storeMatch.get(insideId) : undefined;
    if (inside != null) want.add(inside);
    for (const i of hidden.current) if (!want.has(i)) setHidden(i, false);
    for (const i of want) if (!hidden.current.has(i)) setHidden(i, true);
    hidden.current = want;
  };

  // an open interior hides its building
  useEffect(sync, [insideId, built]); // eslint-disable-line react-hooks/exhaustive-deps

  // store boxes: invisible (still clickable), shopfront slid onto the real facade
  useEffect(() => {
    if (!built || !city) return;
    const touched: { o: Object3D; mats: Mesh[]; z: number }[] = [];
    let timer = 0;
    // every matched store's real facade (clubs too, which ClubLife dresses), never closer to the road than the kerb
    // minus a strip of pavement
    const fronts: Record<string, number> = {};
    for (const [storeId, bi] of built.storeMatch) {
      const s = map.stores.find((x) => x.id === storeId);
      const b = s && map.buildings.find((x) => x.id === s.buildingId);
      if (!b) continue;
      const f = frontage(b, map.streets);
      const [x, z] = toScene(b.x, b.z);
      const [dx, dz] = toScene(f.nx, f.nz);
      const depth = f.nx !== 0 ? b.w : b.d;
      const t = exitDistance(x, z, dx, dz, city.buildings[bi]);
      const kerb = kerbDistance(b, f.nx, f.nz, map.streets) - MIN_PAVEMENT;
      fronts[storeId] = Math.max(0.5, Math.min(t ?? depth / 2, depth / 2 + 10, kerb));
    }
    useFacades.setState({ front: fronts });
    const apply = () => {
      for (const storeId of built.storeMatch.keys()) {
        const g = scene.getObjectByName(`store-${storeId}`);
        const body = g?.getObjectByName("store-body");
        if (!g || !body || body.userData.realCity) continue;
        const s = map.stores.find((x) => x.id === storeId);
        const b = s && map.buildings.find((x) => x.id === s.buildingId);
        if (!b) continue;
        const shells = body.children.slice(0, 2).filter((o): o is Mesh => (o as Mesh).isMesh);
        for (const m of shells) (m.material as { visible: boolean }).visible = false;
        const f = frontage(b, map.streets);
        const depth = f.nx !== 0 ? b.w : b.d;
        const prevZ = body.position.z;
        body.position.z = Math.max(-depth / 2, Math.min(10, (fronts[storeId] ?? depth / 2) - depth / 2 + 0.04));
        body.userData.realCity = true;
        touched.push({ o: body, mats: shells, z: prevZ });
      }
    };
    apply();
    // stores may mount after us
    timer = window.setInterval(apply, 1500);
    return () => {
      window.clearInterval(timer);
      useFacades.setState({ front: {} });
      for (const t of touched) {
        for (const m of t.mats) (m.material as { visible: boolean }).visible = true;
        t.o.position.z = t.z;
        delete t.o.userData.realCity;
      }
    };
  }, [built, city, map, scene]);

  useFrame((_, dt) => {
    const hour = hourOf(useSim.getState().t);
    const n = Math.round(nightLevel(hour) * 40) / 40;
    if (mat.uniforms.night.value !== n) mat.uniforms.night.value = n;
    // hero landmark models (named landmark-*) replace the real polygons they stand on
    tick.current -= dt;
    if (!built || !city || tick.current > 0) return;
    tick.current = 1.5;
    const boxes: Box3[] = [];
    scene.traverse((o) => {
      // hidden ones too: an open landmark interior hides its hero shell, and the real polygon must stay hidden
      if (o.name.startsWith("landmark-")) boxes.push(new Box3().setFromObject(o));
    });
    const key = boxes.map((b) => `${b.min.x.toFixed(0)},${b.min.z.toFixed(0)},${b.max.x.toFixed(0)},${b.max.z.toFixed(0)}`).join("|");
    if (key === heroKey.current) return;
    heroKey.current = key;
    const next = new Set<number>();
    for (const box of boxes) {
      if (box.isEmpty()) continue;
      const area = (box.max.x - box.min.x) * (box.max.z - box.min.z);
      city.buildings.forEach((b, i) => {
        if (!built.ranges.has(i) || b.area > area * 3) return;
        if (b.cx > box.min.x - 1 && b.cx < box.max.x + 1 && b.cz > box.min.z - 1 && b.cz < box.max.z + 1) next.add(i);
      });
    }
    heroHidden.current = next;
    sync();
  });

  if (!built) return null;
  const station = map.buildings.filter((b) => b.kind === "station").sort((a, b) => b.w * b.d - a.w * a.d)[0];
  return (
    <group name="real-buildings">
      {built.chunks.map((c, i) => (
        <mesh
          key={i}
          ref={(m) => void (meshes.current[i] = m)}
          geometry={c.geo}
          material={mat}
          castShadow={!c.outer}
          receiveShadow
          raycast={noRaycast}
        />
      ))}
      {station && <Station b={station} map={map} />}
    </group>
  );
}
