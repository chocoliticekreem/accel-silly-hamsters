// Module: StreetDressing (decorative). The bits that make it read as London: plane trees along the pavements,
// red K6 phone boxes and pillar boxes near junctions. Placed from the real street polylines, skipping roadway
// and building footprints. Three to five instanced meshes for the whole city.
import { useMemo } from "react";
import { CylinderGeometry, IcosahedronGeometry, Object3D, BoxGeometry, type InstancedMesh, type Matrix4 } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { newPoint, polyline } from "../../sim/polyline";
import { useWorld } from "../context";

const TREE_SPACING = 26;

function free(map: CityMap, x: number, z: number, self: CityMap["streets"][number] | null, pad = 1) {
  if (map.streets.some((o) => o !== self && closestOnStreet(o, x, z)[2] < o.width / 2 + pad)) return false;
  return !map.buildings.some((b) => Math.abs(x - b.x) < b.w / 2 + 0.5 && Math.abs(z - b.z) < b.d / 2 + 0.5);
}

function place(map: CityMap) {
  const r = rng(23);
  const o = new Object3D();
  const trees: { m: Matrix4; s: number }[] = [];
  const kiosks: Matrix4[] = [];
  const pillars: Matrix4[] = [];
  const pt = newPoint();
  for (const s of map.streets) {
    if (s.width < 7) continue;
    const path = polyline(s.points);
    // trees on alternate sides, offset from the lamps (which sit at SPACING/2)
    for (let d = 6; d < path.length - 6; d += TREE_SPACING) {
      const side = r() < 0.5 ? -1 : 1;
      path.at(d, side * (s.width / 2 + 2.2), pt);
      if (!free(map, pt.x, pt.z, s)) continue;
      const sc = 0.8 + r() * 0.5;
      const [x, z] = toScene(pt.x, pt.z);
      o.position.set(x, 0, z);
      o.rotation.set(0, r() * Math.PI, 0);
      o.scale.setScalar(sc);
      o.updateMatrix();
      trees.push({ m: o.matrix.clone(), s: sc });
    }
    // a phone box or pillar box near each end of the bigger streets
    if (s.width >= 10)
      for (const at of [8, path.length - 8]) {
        path.at(at, s.width / 2 + 1.6, pt);
        if (!free(map, pt.x, pt.z, s, 0.5)) continue;
        const [x, z] = toScene(pt.x, pt.z);
        o.position.set(x, 0, z);
        o.rotation.set(0, Math.atan2(pt.dx, -pt.dz), 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        (r() < 0.5 ? kiosks : pillars).push(o.matrix.clone());
      }
  }
  return { trees, kiosks, pillars };
}

function fill(m: InstancedMesh | null, mats: Matrix4[]) {
  if (!m) return;
  mats.forEach((x, i) => m.setMatrixAt(i, x));
  m.count = mats.length;
  m.instanceMatrix.needsUpdate = true;
}

export default function StreetDressing() {
  const { map } = useWorld();
  const { trees, kiosks, pillars } = useMemo(() => place(map), [map]);
  const geo = useMemo(
    () => ({
      trunk: new CylinderGeometry(0.25, 0.35, 4, 6).translate(0, 2, 0),
      // London plane: a lumpy round crown, not a pine
      crown: new IcosahedronGeometry(3.2, 1).scale(1, 0.85, 1).translate(0, 6.2, 0),
      kiosk: new BoxGeometry(1.1, 2.6, 1.1).translate(0, 1.3, 0),
      kioskRoof: new BoxGeometry(1.25, 0.25, 1.25).translate(0, 2.7, 0),
      pillar: new CylinderGeometry(0.3, 0.3, 1.5, 10).translate(0, 0.75, 0),
    }),
    [],
  );
  const treeMats = trees.map((t) => t.m);
  const n = (a: unknown[]) => Math.max(1, a.length);

  return (
    <group name="street-dressing">
      <instancedMesh args={[geo.trunk, undefined, n(trees)]} castShadow ref={(m) => fill(m, treeMats)}>
        <meshStandardMaterial color="#6b5b4b" roughness={1} />
      </instancedMesh>
      <instancedMesh args={[geo.crown, undefined, n(trees)]} castShadow receiveShadow ref={(m) => fill(m, treeMats)}>
        <meshStandardMaterial color="#6f9a5e" roughness={0.95} flatShading />
      </instancedMesh>
      <instancedMesh args={[geo.kiosk, undefined, n(kiosks)]} castShadow ref={(m) => fill(m, kiosks)}>
        <meshStandardMaterial color="#c8201e" roughness={0.5} emissive="#ffe8b0" emissiveIntensity={0.05} />
      </instancedMesh>
      <instancedMesh args={[geo.kioskRoof, undefined, n(kiosks)]} ref={(m) => fill(m, kiosks)}>
        <meshStandardMaterial color="#a8191a" roughness={0.6} />
      </instancedMesh>
      <instancedMesh args={[geo.pillar, undefined, n(pillars)]} castShadow ref={(m) => fill(m, pillars)}>
        <meshStandardMaterial color="#c8201e" roughness={0.5} />
      </instancedMesh>
    </group>
  );
}
