// Module: RealBuildings. Every building of real Shoreditch from its OpenStreetMap footprint (world/realcity, baked by
// scripts/bake-city.mjs): extruded polygons with holes, real heights (height / building:levels × floor height),
// building:part drawn instead of an outline that has parts (never both), flat roofs with parapets, gabled / hipped /
// pyramidal / skillion roofs where tagged, roof colours sampled from aerial imagery, wall colours from the tagged
// colour / material or a London brick / office palette, windows drawn by the facade shader and lit at night.
// Merged into a few dozen chunk meshes (realcity/buildingGeometry.ts), built off the main thread in a Web Worker
// (realcity/city.worker.ts) and revealed a few chunks per frame so their GPU upload never stalls a frame.
//
// Data buildings (map.json stores, clubs, the station) keep working:
//  - each store's box is matched to its real polygon (OSM id first, then containment); the Stores module's box body is
//    made invisible but stays clickable, and its shopfront (window, awning, sign) is slid onto the real facade;
//  - the station keeps its own model (world/Station.tsx), the real station polygons under it are not drawn;
//  - a hero landmark model (any scene object named `landmark-*`) hides the real polygons it stands on;
//  - an open interior (state/safety insideId) hides its store's real building.
// Until the data is drawn the old Buildings module stays on (world/graphics.ts), so a missing bake never blanks the city.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3, type Mesh, type Object3D } from "three";
import { frontage, toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { task } from "../../state/loading";
import { hourOf } from "../../sim/time";
import { useSafety } from "../../state/safety";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import type { BuiltArrays } from "../realcity/buildCity";
import { buildRealBuildings, useRealCity, useRealCityData, type RealBuilding } from "../realcity/data";
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

/** Worker arrays → geometries (bounds come precomputed, so nothing here walks the vertices). */
function toBuilt(a: BuiltArrays): Built {
  const chunks = a.chunks.map((c) => {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(c.pos, 3));
    geo.setAttribute("normal", new BufferAttribute(c.nor, 3));
    geo.setAttribute("color", new BufferAttribute(c.col, 3));
    geo.setAttribute("aWin", new BufferAttribute(c.win, 4));
    geo.setIndex(new BufferAttribute(c.idx, 1));
    const [x0, y0, z0, x1, y1, z1] = c.box;
    geo.boundingBox = new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new Sphere());
    return { geo, outer: c.outer, original: c.pos.slice() };
  });
  const ranges = new Map<number, Range>();
  for (let k = 0; k < a.ranges.length; k += 4) ranges.set(a.ranges[k], { chunk: a.ranges[k + 1], start: a.ranges[k + 2], count: a.ranges[k + 3] });
  return { chunks, ranges, storeMatch: new Map(a.storeMatch), drawnCount: a.drawnCount };
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
  const status = useRealCity((s) => s.status);
  const { map } = useWorld();
  const [built, setBuilt] = useState<Built | null>(null);
  /** Chunks on screen so far (a few more each frame). */
  const [shown, setShown] = useState(0);
  const progress = useRef<ReturnType<typeof task> | null>(null);
  useEffect(() => {
    progress.current = task("city", "buildings", 3);
  }, []);
  useEffect(() => {
    if (status === "missing") progress.current?.done();
  }, [status]);
  useEffect(() => {
    if (!city) return;
    let alive = true;
    buildRealBuildings(city, map).then(
      (a) => {
        if (!alive) return;
        console.info(`[RealBuildings] built in ${a.ms} ms`);
        setShown(0);
        setBuilt(toBuilt(a));
      },
      (e: unknown) => {
        console.error("[RealBuildings] build failed", e);
        progress.current?.fail("Buildings could not be built");
      },
    );
    return () => {
      alive = false;
    };
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

  // drawn (the old box city gives way) once every chunk is on screen
  const allShown = !!built && shown >= built.chunks.length;
  useEffect(() => {
    if (!built) return;
    return () => built.chunks.forEach((c) => c.geo.dispose());
  }, [built]);
  useEffect(() => {
    if (!built || !allShown) return;
    progress.current?.done();
    useRealCity.setState({ drawn: true });
    console.info(`[RealBuildings] ${built.drawnCount} buildings in ${built.chunks.length} meshes; ${built.storeMatch.size}/${map.stores.length} stores matched to real footprints`);
    return () => useRealCity.setState({ drawn: false });
  }, [built, allShown, map]);

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
    const apply = () => {
      for (const [storeId, bi] of built.storeMatch) {
        const g = scene.getObjectByName(`store-${storeId}`);
        const body = g?.getObjectByName("store-body");
        if (!g || !body || body.userData.realCity) continue;
        const s = map.stores.find((x) => x.id === storeId);
        const b = s && map.buildings.find((x) => x.id === s.buildingId);
        if (!b) continue;
        const shells = body.children.slice(0, 2).filter((o): o is Mesh => (o as Mesh).isMesh);
        for (const m of shells) (m.material as { visible: boolean }).visible = false;
        const f = frontage(b, map.streets);
        const [x, z] = toScene(b.x, b.z);
        const [dx, dz] = toScene(f.nx, f.nz);
        const depth = f.nx !== 0 ? b.w : b.d;
        const t = exitDistance(x, z, dx, dz, city.buildings[bi]);
        const prevZ = body.position.z;
        if (t != null) body.position.z = Math.max(-depth / 2, Math.min(10, t - depth / 2 + 0.04));
        body.userData.realCity = true;
        touched.push({ o: body, mats: shells, z: prevZ });
      }
    };
    apply();
    // stores may mount after us
    timer = window.setInterval(apply, 1500);
    return () => {
      window.clearInterval(timer);
      for (const t of touched) {
        for (const m of t.mats) (m.material as { visible: boolean }).visible = true;
        t.o.position.z = t.z;
        delete t.o.userData.realCity;
      }
    };
  }, [built, city, map, scene]);

  useFrame((_, dt) => {
    // reveal: a few chunks a frame, so their first upload to the GPU is spread out
    if (built && shown < built.chunks.length) {
      setShown((n) => Math.min(built.chunks.length, n + 4));
      progress.current?.progress(shown / built.chunks.length);
    }
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
      {built.chunks.slice(0, shown).map((c, i) => (
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
