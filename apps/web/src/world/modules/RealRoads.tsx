// Module: RealRoads. The real street surface from OpenStreetMap (world/realcity, baked by scripts/bake-city.mjs):
// carriageways at their tagged / lane-derived widths, area:highway polygons, raised pavements with kerbs either side
// where the road has sidewalks, footways, pedestrian streets and cycle tracks, then markings: dashed centre and lane
// lines, London's double yellow lines along the kerbs, zebra crossings and signal-crossing studs at the real crossing
// nodes. Markings and kerbs stop at junction mouths (realcity/flat.ts SegGrid), so nothing paints across a side street.
// Layered by draw order, not height (realcity/flat.ts): no z-fighting at any distance. A handful of draw calls.
// Visual only: people and traffic keep following map.json's street graph, which the real carriageways sit under.
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, Color, MeshStandardMaterial } from "three";
import { useRealCityData, LAND, RF, ROAD, type P, type RealCity } from "../realcity/data";
import { dashes, FlatBuilder, LAYER, layerMaterial, offsetLine, pieces, SegGrid } from "../realcity/flat";

const noRaycast = () => null;

const C = {
  asphalt: new Color("#46494e"),
  asphaltMinor: new Color("#4d5054"),
  paving: new Color("#aaa69d"),
  pavingDark: new Color("#9a968d"),
  pedestrian: new Color("#b9b2a5"),
  setts: new Color("#8c8378"),
  cycle: new Color("#4a4b4f"),
  island: new Color("#a39f96"),
  white: new Color("#e9e6dc"),
  yellow: new Color("#e2b93b"),
  kerb: new Color("#b7b4ac"),
};
/** Kerb height: pavements sit this far above the carriageway. */
const KERB = 0.08;
const ROAD_Y = 0.02;
const MARK_Y = 0.03;

function pavementWidth(cls: number) {
  return cls <= 3 ? 3.4 : cls <= 5 ? 2.8 : 2.2;
}

function build(city: RealCity) {
  const paving = new FlatBuilder();
  const asphalt = new FlatBuilder();
  const islands = new FlatBuilder();
  const marks = new FlatBuilder();
  // kerb faces stand up (normal pipeline, depth tested): their own small mesh
  const kerbPos: number[] = [];
  const kerbNor: number[] = [];
  const inner = city.inner;
  const isInner = (p: P) => p[0] > inner.minX && p[0] < inner.maxX && p[1] > inner.minZ && p[1] < inner.maxZ;

  const grid = new SegGrid(30);
  city.roads.forEach((r, i) => {
    if (r.cls > ROAD.car) return;
    for (let k = 0; k < r.pts.length - 1; k++) grid.add(r.pts[k], r.pts[k + 1], r.width / 2, i);
  });

  const kerbFace = (a: P, b: P, side: 1 | -1) => {
    // vertical face from the road surface up to the pavement, facing the carriageway
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    // left of travel is (dz, -dx): the face on the left side looks right (towards the road), and vice versa
    const nx = (-side * dz) / l;
    const nz = (side * dx) / l;
    const ux = b[0] - a[0];
    const uz = b[1] - a[1];
    // triangle (a0, b0, b1) faces (-uz, ux): keep that winding when it matches the wanted normal
    if (-uz * nx + ux * nz > 0) kerbPos.push(a[0], 0, a[1], b[0], 0, b[1], b[0], KERB, b[1], a[0], 0, a[1], b[0], KERB, b[1], a[0], KERB, a[1]);
    else kerbPos.push(a[0], 0, a[1], b[0], KERB, b[1], b[0], 0, b[1], a[0], 0, a[1], a[0], KERB, a[1], b[0], KERB, b[1]);
    for (let k = 0; k < 6; k++) kerbNor.push(nx, 0, nz);
  };

  city.roads.forEach((r, i) => {
    const hw = r.width / 2;
    if (r.cls <= ROAD.car) {
      const minor = r.cls >= 6;
      asphalt.ribbon(r.pts, hw, ROAD_Y, minor ? C.asphaltMinor : C.asphalt);
      if (!isInner(r.pts[0]) && !isInner(r.pts[r.pts.length - 1])) return;
      // pavements + kerbs on the sides that have them
      for (const side of [1, -1] as const) {
        const has = side === 1 ? r.flags & RF.swLeft : r.flags & RF.swRight;
        if (!has) continue;
        const sw = pavementWidth(r.cls);
        const mid = offsetLine(r.pts, side * (hw + sw / 2));
        paving.ribbon(mid, sw / 2 + 0.02, KERB, C.paving, false);
        const edge = offsetLine(r.pts, side * hw);
        for (const [a, b, dx, dz] of pieces(edge, 2)) {
          const mx = (a[0] + b[0]) / 2;
          const mz = (a[1] + b[1]) / 2;
          if (grid.crossing(mx, mz, i, dx, dz, -0.3)) continue;
          kerbFace(a, b, side);
        }
      }
      // markings (inner area only)
      if (!r.pts.some(isInner)) return;
      const oneway = !!(r.flags & RF.oneway);
      const lanes = r.lanes || (oneway ? (r.width >= 6.5 ? 2 : 1) : r.width >= 12 ? 4 : r.width >= 5.5 ? 2 : 1);
      const lineOffsets: number[] = [];
      for (let k = 1; k < lanes; k++) lineOffsets.push(-hw + (r.width * k) / lanes);
      if (r.cls <= 7)
        for (const off of lineOffsets) {
          const centre = !oneway && Math.abs(off) < 0.3;
          const line = offsetLine(r.pts, off);
          for (const [a, b, dx, dz] of dashes(line, centre ? 4 : 3, centre ? 5 : 6)) {
            if (grid.crossing((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, i, dx, dz)) continue;
            marks.strip(a, b, 0.07, MARK_Y, C.white);
          }
        }
      // double yellow lines along both kerbs on through roads
      if (r.cls >= 2 && r.cls <= 7 && r.width >= 5)
        for (const side of [1, -1] as const)
          for (const off of [hw - 0.32, hw - 0.52]) {
            const line = offsetLine(r.pts, side * off);
            for (const [a, b, dx, dz] of pieces(line, 3)) {
              if (grid.crossing((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, i, dx, dz, -0.6)) continue;
              marks.strip(a, b, 0.055, MARK_Y, C.yellow);
            }
          }
      return;
    }
    // non-car ways
    if (r.cls === ROAD.cycleway) return asphalt.ribbon(r.pts, Math.max(0.9, hw), ROAD_Y, C.cycle);
    if (r.cls === ROAD.pedestrian) return paving.ribbon(r.pts, Math.max(2, hw), KERB * 0.5, r.flags & RF.setts ? C.setts : C.pedestrian);
    if (r.flags & RF.crossing) return; // painted from the crossing nodes
    paving.ribbon(r.pts, Math.max(0.9, hw), KERB, r.cls === ROAD.path || r.cls === ROAD.track ? C.pavingDark : C.paving);
  });

  // area:highway polygons
  for (const a of city.areas) {
    if (a.kind === LAND.roadArea) asphalt.polygon(a.rings, ROAD_Y, C.asphalt);
    else if (a.kind === LAND.cycleArea) asphalt.polygon(a.rings, ROAD_Y, C.cycle);
    else if (a.kind === LAND.footArea) paving.polygon(a.rings, KERB, C.paving);
    else if (a.kind === LAND.island) islands.polygon(a.rings, KERB, C.island);
  }

  // crossings
  for (const x of city.crossings) {
    const ux = Math.cos(x.angle);
    const uz = Math.sin(x.angle);
    const vx = -uz;
    const vz = ux;
    const w = x.width;
    if (x.type === 1) {
      // zebra: stripes running along the road, laid across its whole width
      const n = Math.max(2, Math.floor(w / 1.0));
      for (let k = 0; k < n; k++) {
        const o = -w / 2 + 0.5 + ((w - 1) * (k + 0.5)) / n;
        const cx = x.x + vx * o;
        const cz = x.z + vz * o;
        marks.strip([cx - ux * 1.4, cz - uz * 1.4], [cx + ux * 1.4, cz + uz * 1.4], 0.25, MARK_Y, C.white);
      }
    } else {
      // signal crossing: two dotted lines of studs across the road
      for (const s of [-1.3, 1.3]) {
        const cx = x.x + ux * s;
        const cz = x.z + uz * s;
        const n = Math.max(2, Math.floor(w / 0.7));
        for (let k = 0; k < n; k++) {
          const o = -w / 2 + (w * (k + 0.5)) / n;
          const px = cx + vx * o;
          const pz = cz + vz * o;
          marks.strip([px - ux * 0.15, pz - uz * 0.15], [px + ux * 0.15, pz + uz * 0.15], 0.15, MARK_Y, C.white);
        }
      }
    }
  }

  const kerbs = new BufferGeometry();
  kerbs.setAttribute("position", new BufferAttribute(new Float32Array(kerbPos), 3));
  kerbs.setAttribute("normal", new BufferAttribute(new Float32Array(kerbNor), 3));
  kerbs.computeBoundingSphere();
  return {
    paving: paving.geometry(),
    asphalt: asphalt.geometry(),
    islands: islands.geometry(),
    marks: marks.geometry(),
    kerbs,
  };
}

export default function RealRoads() {
  const city = useRealCityData();
  const geo = useMemo(() => (city ? build(city) : null), [city]);
  const mats = useMemo(
    () => ({
      paving: layerMaterial(0.95),
      asphalt: layerMaterial(0.88),
      islands: layerMaterial(0.95),
      marks: layerMaterial(0.7),
      kerb: new MeshStandardMaterial({ color: C.kerb, roughness: 0.9 }),
    }),
    [],
  );
  useEffect(() => () => void (geo && Object.values(geo).forEach((g) => g.dispose())), [geo]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  if (!geo) return null;
  return (
    <group name="real-roads">
      <mesh geometry={geo.paving} material={mats.paving} renderOrder={LAYER.paving} receiveShadow raycast={noRaycast} />
      <mesh geometry={geo.asphalt} material={mats.asphalt} renderOrder={LAYER.asphalt} receiveShadow raycast={noRaycast} />
      <mesh geometry={geo.islands} material={mats.islands} renderOrder={LAYER.islands} receiveShadow raycast={noRaycast} />
      <mesh geometry={geo.marks} material={mats.marks} renderOrder={LAYER.markings} receiveShadow raycast={noRaycast} />
      <mesh geometry={geo.kerbs} material={mats.kerb} receiveShadow raycast={noRaycast} />
    </group>
  );
}
