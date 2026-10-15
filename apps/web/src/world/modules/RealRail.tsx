// Module: RealRail. The railways of real Shoreditch from OpenStreetMap (world/realcity): every track at its real
// alignment. Lines tagged as bridges / viaducts / embankments stand on London-brick viaducts (arched, the arches
// drawn by the facade shader, a few lit as workshops and bars at night) with parapets, and open up into steel
// girder bridges wherever a real street passes underneath; the rest (the Liverpool Street throat, sidings) lies on
// ballast at ground level. Where a viaduct meets a ground-level track the line ramps down at a railway gradient.
// The Overground module draws its own viaduct, station and trains along its route through Shoreditch High Street;
// real tracks inside that corridor are left to it, so nothing is doubled.
import { useEffect, useMemo } from "react";
import { type BufferGeometry, Color, MeshStandardMaterial } from "three";
import type { CityMap } from "../../api/contract";
import { DECK_Y, overgroundRoute, routeDistance, VIADUCT_W } from "../../sim/overground";
import { useWorld } from "../context";
import { addQuad, MeshBuilder, STYLE } from "../realcity/buildingGeometry";
import { RAILF, ROAD, useRealCityData, type P, type RealCity } from "../realcity/data";
import { facadeMaterial } from "../realcity/facadeMaterial";
import { FlatBuilder, LAYER, layerMaterial, pieces, SegGrid } from "../realcity/flat";

const noRaycast = () => null;
const BRICK = new Color("#7a4a3a");
const STEEL = new Color("#5b6168");
const BALLAST = new Color("#6c645b");
const RAIL = new Color("#9a9a98");
const DECK = new Color("#5e5852");
const HALF = 2.7; // deck half width per track
const GRADE = 0.025;

/** Per-vertex rail height: viaducts at deck level, ground tracks at 0, ramps where they meet. */
function heights(city: RealCity): number[][] {
  const elevated = (f: number, layer: number) => !!(f & (RAILF.bridge | RAILF.embankment)) || layer >= 1;
  const hs: number[][] = city.rail.map((r) => r.pts.map((): number => (elevated(r.flags, r.layer) ? DECK_Y : 0)));
  const key = (p: P) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const highEnds = new Set<string>();
  city.rail.forEach((r, i) => {
    if (hs[i][0] > 0) highEnds.add(key(r.pts[0]));
    if (hs[i][r.pts.length - 1] > 0) highEnds.add(key(r.pts[r.pts.length - 1]));
  });
  // ground ways that touch a viaduct end ramp down from it
  city.rail.forEach((r, i) => {
    if (hs[i][0] > 0) return;
    const from = (start: boolean) => {
      const idx = start ? r.pts.map((_, k) => k) : r.pts.map((_, k) => r.pts.length - 1 - k);
      let d = 0;
      for (let k = 0; k < idx.length; k++) {
        if (k) d += Math.hypot(r.pts[idx[k]][0] - r.pts[idx[k - 1]][0], r.pts[idx[k]][1] - r.pts[idx[k - 1]][1]);
        hs[i][idx[k]] = Math.max(hs[i][idx[k]], DECK_Y - d * GRADE);
      }
    };
    if (highEnds.has(key(r.pts[0]))) from(true);
    if (highEnds.has(key(r.pts[r.pts.length - 1]))) from(false);
  });
  return hs;
}

function build(city: RealCity, map: CityMap) {
  const walls = new MeshBuilder();
  const deck = new FlatBuilder();
  const ground = new FlatBuilder();
  const route = overgroundRoute(map);
  const roads = new SegGrid(30);
  city.roads.forEach((r, i) => {
    if (r.cls > ROAD.pedestrian) return;
    for (let k = 0; k < r.pts.length - 1; k++) roads.add(r.pts[k], r.pts[k + 1], r.width / 2 + 1.5, i);
  });
  const hs = heights(city);
  const seed = 0.37;
  city.rail.forEach((r, ri) => {
    if (r.flags & RAILF.disused) return;
    // contract coords for the Overground corridor test (scene z = -north)
    const inCorridor = (p: P) => !!route && routeDistance(route, p[0], -p[1]) < VIADUCT_W / 2 + 4;
    const h = hs[ri];
    // walk the line in short pieces, carrying the height along
    let along = 0;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const segLen = Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]);
      if (segLen < 1e-3) continue;
      const sub: P[] = [r.pts[i], r.pts[i + 1]];
      let s0 = 0;
      for (const [a, b, dx, dz] of pieces(sub, 2.5)) {
        const pl = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ta = s0 / segLen;
        const tb = (s0 + pl) / segLen;
        s0 += pl;
        const ha = h[i] + (h[i + 1] - h[i]) * ta;
        const hb = h[i] + (h[i + 1] - h[i]) * tb;
        const u0 = along / 13;
        along += pl;
        const u1 = along / 13;
        const mid: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (inCorridor(mid)) continue;
        const nx = dz;
        const nz = -dx;
        const L = (p: P, o: number): P => [p[0] + nx * o, p[1] + nz * o];
        if (Math.max(ha, hb) < 0.4) {
          ground.strip(a, b, 1.6, 0.02, BALLAST);
          ground.strip(L(a, 0.72), L(b, 0.72), 0.05, 0.02, RAIL);
          ground.strip(L(a, -0.72), L(b, -0.72), 0.05, 0.02, RAIL);
          continue;
        }
        // deck with ballast and rails on top
        deck.quad(L(a, HALF), L(b, HALF), L(b, -HALF), L(a, -HALF), 0, DECK);
        const top = deck.nv;
        for (let k = top - 4; k < top; k++) deck.pos[k * 3 + 1] = k === top - 4 || k === top - 1 ? ha : hb;
        for (const [off, w, col, lift] of [
          [0, 1.6, BALLAST, 0.12],
          [0.72, 0.05, RAIL, 0.22],
          [-0.72, 0.05, RAIL, 0.22],
        ] as const) {
          const c0 = L(a, off);
          const c1 = L(b, off);
          deck.quad(L(c0, w), L(c1, w), L(c1, -w), L(c0, -w), 0, col);
          const t2 = deck.nv;
          for (let k = t2 - 4; k < t2; k++) deck.pos[k * 3 + 1] = (k === t2 - 4 || k === t2 - 1 ? ha : hb) + lift;
        }
        // side walls: brick arches, or a steel girder where a street runs underneath
        const overRoad = roads.crossing(mid[0], mid[1], -1, dx, dz, 0);
        for (const side of [1, -1]) {
          const pa = L(a, side * HALF);
          const pb = L(b, side * HALF);
          const wn: [number, number, number] = [nx * side, 0, nz * side];
          const yb = overRoad ? Math.min(ha, hb) - 1.6 : 0;
          const look = overRoad ? STEEL : BRICK;
          const style = (overRoad ? STYLE.office : STYLE.viaduct) + seed;
          addQuad(walls, pa, pb, yb, yb, ha, hb, wn, look, u0, u1, style, overRoad ? 0 : 1);
          // parapet: outer face, inner face, coping
          addQuad(walls, pa, pb, ha, hb, ha + 1.1, hb + 1.1, wn, look, u0, u1, STYLE.office + seed, 0);
          const ia = L(a, side * (HALF - 0.3));
          const ib = L(b, side * (HALF - 0.3));
          addQuad(walls, ia, ib, ha, hb, ha + 1.1, hb + 1.1, [-wn[0], 0, -wn[2]], look, u0, u1, STYLE.office + seed, 0);
        }
      }
    }
  });
  const deckGeo = deck.geometry();
  // the deck isn't a painter layer: real normals (it is a sloped, raised surface)
  deckGeo.computeVertexNormals();
  return { walls: walls.geometry(), deck: deckGeo, ground: ground.geometry() };
}

export default function RealRail() {
  const city = useRealCityData();
  const { map } = useWorld();
  const geo = useMemo(() => (city ? build(city, map) : null), [city, map]);
  const mats = useMemo(
    () => ({
      deck: new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
      ground: layerMaterial(1),
    }),
    [],
  );
  useEffect(() => () => void (geo && Object.values(geo).forEach((g: BufferGeometry) => g.dispose())), [geo]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  if (!geo) return null;
  return (
    <group name="real-rail">
      <mesh geometry={geo.walls} material={facadeMaterial()} castShadow receiveShadow raycast={noRaycast} />
      <mesh geometry={geo.deck} material={mats.deck} castShadow receiveShadow raycast={noRaycast} />
      <mesh geometry={geo.ground} material={mats.ground} renderOrder={LAYER.ballast} receiveShadow raycast={noRaycast} />
    </group>
  );
}
