// Module: RealLand. The ground of real Shoreditch from OpenStreetMap (world/realcity): the base ground out to the
// horizon, then parks, gardens, grass, pitches, playgrounds, churchyards, plazas, surface car parks, rail land,
// construction sites and water at their real outlines, tinted with the median colour of the aerial imagery under
// them. Trees stand at their real OSM positions (natural=tree and tree rows), and parks / woods without mapped trees
// are planted with a deterministic scatter. Painter-layered ground (realcity/flat.ts), instanced trees: ~6 draw calls.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Color, IcosahedronGeometry, CylinderGeometry, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, type InstancedMesh } from "three";
import { rng } from "../../mock/rng";
import { inPolygon, LAND, useRealCityData, type RealCity } from "../realcity/data";
import { FlatBuilder, LAYER, layerMaterial } from "../realcity/flat";

const noRaycast = () => null;

const KIND_COLOUR: Record<number, string> = {
  [LAND.park]: "#6f8b52",
  [LAND.grass]: "#7b9759",
  [LAND.pitch]: "#5f8f4a",
  [LAND.playground]: "#a98466",
  [LAND.water]: "#48697b",
  [LAND.wood]: "#56713f",
  [LAND.cemetery]: "#6f8558",
  [LAND.plaza]: "#b9b2a4",
  [LAND.parking]: "#5d6064",
  [LAND.railway]: "#7a7064",
  [LAND.construction]: "#9d8c74",
  [LAND.court]: "#5d7d8c",
};
const TINTED = new Set<number>([LAND.park, LAND.grass, LAND.pitch, LAND.playground, LAND.wood, LAND.cemetery, LAND.plaza, LAND.court]);
const GROUND = "#9a9890";

function landColour(kind: number, tint: string): Color {
  const c = new Color(KIND_COLOUR[kind] ?? GROUND);
  if (tint && TINTED.has(kind)) {
    const t = new Color(`#${tint}`);
    const hsl = { h: 0, s: 0, l: 0 };
    t.getHSL(hsl);
    // imagery is dark and hazy: keep its hue shift, lift its lightness
    t.setHSL(hsl.h, Math.min(0.45, hsl.s * 1.2), Math.min(0.6, 0.12 + hsl.l));
    c.lerp(t, 0.45);
  }
  return c;
}

interface Tree {
  x: number;
  z: number;
  h: number;
}

function build(city: RealCity) {
  const land = new FlatBuilder();
  for (const a of city.areas) {
    if (a.kind >= LAND.footArea && a.kind <= LAND.island) continue; // roads draw these
    land.polygon(a.rings, 0.01, landColour(a.kind, a.tint));
  }
  // trees: mapped ones, plus a scatter in parks / woods / churchyards that have few mapped trees
  const trees: Tree[] = city.trees.map((t) => ({ x: t.x, z: t.z, h: t.h > 2 ? Math.min(t.h, 24) : 0 }));
  const cell = 6;
  const taken = new Set(trees.map((t) => `${Math.floor(t.x / cell)},${Math.floor(t.z / cell)}`));
  const r = rng(77);
  const inner = city.inner;
  for (const a of city.areas) {
    if (a.kind !== LAND.park && a.kind !== LAND.wood && a.kind !== LAND.cemetery) continue;
    const ring = a.rings[0];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) (minX = Math.min(minX, x)), (maxX = Math.max(maxX, x)), (minZ = Math.min(minZ, z)), (maxZ = Math.max(maxZ, z));
    const far = maxX < inner.minX || minX > inner.maxX || maxZ < inner.minZ || minZ > inner.maxZ;
    const step = a.kind === LAND.wood ? 7 : far ? 16 : 13;
    for (let x = minX + step / 2; x < maxX; x += step)
      for (let z = minZ + step / 2; z < maxZ; z += step) {
        const px = x + (r() - 0.5) * step * 0.8;
        const pz = z + (r() - 0.5) * step * 0.8;
        if (r() < 0.35) continue; // clearings and lawns
        const k = `${Math.floor(px / cell)},${Math.floor(pz / cell)}`;
        if (taken.has(k) || !inPolygon(px, pz, a.rings)) continue;
        taken.add(k);
        trees.push({ x: px, z: pz, h: 0 });
      }
  }
  return { land: land.geometry(), trees };
}

function fillTrees(trunks: InstancedMesh | null, crowns: InstancedMesh | null, trees: Tree[]) {
  if (!trunks || !crowns) return;
  const o = new Object3D();
  const r = rng(5);
  const c = new Color();
  const greens = ["#4f6b35", "#5b7a3c", "#46622f", "#647f42", "#56733a", "#6b8446"];
  trees.forEach((t, i) => {
    const h = t.h || 8 + r() * 7;
    const cr = Math.max(2, h * (0.26 + r() * 0.08));
    o.position.set(t.x, (h * 0.55) / 2, t.z);
    o.rotation.set(0, r() * Math.PI * 2, 0);
    o.scale.set(1, h * 0.55, 1);
    o.updateMatrix();
    trunks.setMatrixAt(i, o.matrix);
    o.position.set(t.x, h * 0.62, t.z);
    o.scale.set(cr, cr * (1.05 + r() * 0.25), cr);
    o.updateMatrix();
    crowns.setMatrixAt(i, o.matrix);
    crowns.setColorAt(i, c.set(greens[Math.floor(r() * greens.length)]).multiplyScalar(0.9 + r() * 0.2));
  });
  trunks.count = crowns.count = trees.length;
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  trunks.computeBoundingSphere();
  crowns.computeBoundingSphere();
}

export default function RealLand() {
  const city = useRealCityData(5); // a turn of its own after the city arrives
  const built = useMemo(() => (city ? build(city) : null), [city]);
  const assets = useMemo(() => {
    const crown = new IcosahedronGeometry(1, 1);
    // knobbly crowns: jitter the shared vertices
    const p = crown.attributes.position;
    const r = rng(3);
    const seen = new Map<string, number>();
    for (let i = 0; i < p.count; i++) {
      const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      const s = seen.get(k) ?? 0.85 + r() * 0.3;
      seen.set(k, s);
      p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
    }
    crown.computeVertexNormals();
    return {
      crown,
      trunk: new CylinderGeometry(0.16, 0.24, 1, 6),
      plane: new PlaneGeometry(16000, 16000).rotateX(-Math.PI / 2),
      base: new MeshStandardMaterial({ color: GROUND, roughness: 1, depthWrite: false }),
      land: layerMaterial(0.97),
      depth: new MeshBasicMaterial({ colorWrite: false }),
      crownMat: new MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
      trunkMat: new MeshStandardMaterial({ color: "#4a3b2e", roughness: 1 }),
    };
  }, []);
  const trunks = useRef<InstancedMesh>(null);
  const crowns = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (built) fillTrees(trunks.current, crowns.current, built.trees);
  }, [built]);
  useEffect(() => () => built?.land.dispose(), [built]);
  useEffect(() => () => Object.values(assets).forEach((a) => a.dispose()), [assets]);
  if (!built) return null;
  const n = Math.max(1, built.trees.length);
  return (
    <group name="real-land">
      <mesh geometry={assets.plane} material={assets.base} renderOrder={LAYER.base} receiveShadow raycast={noRaycast} />
      <mesh geometry={built.land} material={assets.land} renderOrder={LAYER.land} receiveShadow raycast={noRaycast} />
      {/* the ground's depth, written once all ground layers are painted */}
      <mesh geometry={assets.plane} material={assets.depth} renderOrder={LAYER.depth} raycast={noRaycast} />
      <instancedMesh key={`t${n}`} ref={trunks} args={[assets.trunk, assets.trunkMat, n]} castShadow raycast={noRaycast} />
      <instancedMesh key={`c${n}`} ref={crowns} args={[assets.crown, assets.crownMat, n]} castShadow receiveShadow raycast={noRaycast} />
    </group>
  );
}
