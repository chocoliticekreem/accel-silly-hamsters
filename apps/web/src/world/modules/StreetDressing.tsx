// Module: StreetDressing (decorative). The bits that make it read as London: plane trees in tree pits along the
// pavements, red K6 phone boxes and Royal Mail pillar boxes near junctions, benches and litter bins, and TfL bus
// shelters on the main roads. Placed from the real street polylines, skipping roadway and building footprints.
// Props are merged vertex-coloured models (world/propModels.ts), one instanced mesh per kind: six draw calls.
import { useEffect, useMemo } from "react";
import { Color, InstancedMesh, MeshStandardMaterial, Object3D, type BufferGeometry, type Matrix4 } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { inAreaKeepout } from "../../sim/areaKeepouts";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { newPoint, polyline } from "../../sim/polyline";
import { useWorld } from "../context";
import { benchGeometry, binGeometry, busShelterGeometry, phoneBoxGeometry, pillarBoxGeometry, treeGeometry } from "../propModels";

const TREE_SPACING = 26;
const FURNITURE_SPACING = 48;
const SHELTER_SPACING = 160;

type Kind = "tree" | "kiosk" | "pillar" | "bench" | "bin" | "shelter";

function free(map: CityMap, x: number, z: number, self: CityMap["streets"][number] | null, pad = 1) {
  if (inAreaKeepout(x, z)) return false; // an area module dresses its own streets
  if (map.streets.some((o) => o !== self && closestOnStreet(o, x, z)[2] < o.width / 2 + pad)) return false;
  return !map.buildings.some((b) => Math.abs(x - b.x) < b.w / 2 + 0.5 && Math.abs(z - b.z) < b.d / 2 + 0.5);
}

interface Placed {
  m: Matrix4;
  c?: Color;
}

function place(map: CityMap) {
  const r = rng(23);
  const o = new Object3D();
  const out: Record<Kind, Placed[]> = { tree: [], kiosk: [], pillar: [], bench: [], bin: [], shelter: [] };
  const pt = newPoint();
  const crown = new Color();
  /** Puts a prop `lateral` metres right of the street's direction (negative = left), facing the road. */
  const put = (kind: Kind, path: ReturnType<typeof polyline>, s: CityMap["streets"][number], d: number, lateral: number, scale = 1, pad = 1, color?: Color) => {
    path.at(d, lateral, pt);
    if (!free(map, pt.x, pt.z, s, pad)) return false;
    const side = Math.sign(lateral) || 1;
    const [x, z] = toScene(pt.x, pt.z);
    o.position.set(x, 0, z);
    o.rotation.set(0, Math.atan2(-side * pt.dz, -side * pt.dx), 0);
    o.scale.setScalar(scale);
    o.updateMatrix();
    out[kind].push({ m: o.matrix.clone(), c: color });
    return true;
  };
  for (const s of map.streets) {
    if (s.width < 7) continue;
    const path = polyline(s.points);
    const kerb = s.width / 2;
    // trees on alternate sides, offset from the lamps (which sit at SPACING/2)
    for (let d = 6; d < path.length - 6; d += TREE_SPACING) {
      const side = r() < 0.5 ? -1 : 1;
      crown.setHSL(0.24 + r() * 0.06, 0.25 + r() * 0.2, 0.75 + r() * 0.25);
      put("tree", path, s, d, side * (kerb + 2.2), 0.8 + r() * 0.5, 1, crown.clone());
    }
    // benches with a bin beside them, between the trees
    for (let d = 18 + r() * 10; d < path.length - 12; d += FURNITURE_SPACING * (0.8 + r() * 0.5)) {
      const side = r() < 0.5 ? -1 : 1;
      if (put("bench", path, s, d, side * (kerb + 3.4), 1, 0.6)) put("bin", path, s, d + 1.6, side * (kerb + 3.4), 1, 0.4);
    }
    // a phone box or pillar box near each end of the bigger streets
    if (s.width >= 10)
      for (const at of [8, path.length - 8]) put(r() < 0.5 ? "kiosk" : "pillar", path, s, at, kerb + 1.6, 1, 0.5);
    // bus shelters on the main roads, on both sides
    if (s.width >= 14)
      for (let d = 40; d < path.length - 30; d += SHELTER_SPACING) put("shelter", path, s, d, (r() < 0.5 ? -1 : 1) * (kerb + 1.5), 1, 0.3);
  }
  return out;
}

const BUILDERS: Record<Kind, () => BufferGeometry> = {
  tree: treeGeometry,
  kiosk: phoneBoxGeometry,
  pillar: pillarBoxGeometry,
  bench: benchGeometry,
  bin: binGeometry,
  shelter: busShelterGeometry,
};

export default function StreetDressing() {
  const { map } = useWorld();
  const built = useMemo(() => {
    const placed = place(map);
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });
    const treeMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    const meshes: InstancedMesh[] = [];
    for (const kind of Object.keys(BUILDERS) as Kind[]) {
      const list = placed[kind];
      if (!list.length) continue;
      const m = new InstancedMesh(BUILDERS[kind](), kind === "tree" ? treeMat : mat, list.length);
      list.forEach((p, i) => {
        m.setMatrixAt(i, p.m);
        if (p.c) m.setColorAt(i, p.c);
      });
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.receiveShadow = kind === "tree" || kind === "shelter";
      m.raycast = () => null; // set dressing: never clickable
      m.computeBoundingSphere();
      m.name = kind;
      meshes.push(m);
    }
    return { meshes, mats: [mat, treeMat] };
  }, [map]);

  useEffect(
    () => () => {
      built.meshes.forEach((m) => {
        m.geometry.dispose();
        m.dispose();
      });
      built.mats.forEach((m) => m.dispose());
    },
    [built],
  );

  return (
    <group name="street-dressing">
      {built.meshes.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
    </group>
  );
}
