// Where the Shoreditch High Street station box sits and how it is laid out (shared by world/Station.tsx, which draws
// it, and the ShoreditchStation module, which walks people in and out of its ticket hall). Cached per map.
import { CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SRGBColorSpace, type BufferGeometry, type Material } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Building, CityMap, Street } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { overgroundRoute, routeAt } from "../../sim/overground";
import { heroMaterials, signMaterial } from "../models/materials";
import type { HeroModel, SignSpec, Slot } from "../models/kit";
import { buildStation, type StationParts } from "./stationModel";

/** The real box (OSM way 170081284) runs x −138 … +55 m from the origin: 193 m, centred on the map's station. */
const REAL_BOX_LEN = 193;
const HALL_LEN = 18;

/** Stretches of the station's long axis (local s, metres from its centre) where a street passes underneath. */
export function streetGaps(b: Building, streets: readonly Street[]): [number, number][] {
  const alongX = b.w >= b.d;
  const L = alongX ? b.w : b.d;
  const out: [number, number][] = [];
  for (const st of streets)
    for (let i = 0; i < st.points.length - 1; i++) {
      const [ax, az] = st.points[i];
      const [bx, bz] = st.points[i + 1];
      const [pa, pb, qa, qb, c] = alongX ? [az, bz, ax, bx, b.z] : [ax, bx, az, bz, b.x];
      if ((pa - c) * (pb - c) > 0 || pa === pb) continue;
      const k = (c - pa) / (pb - pa);
      const q = qa + (qb - qa) * k - (alongX ? b.x : b.z);
      if (Math.abs(q) > L / 2 + st.width) continue;
      const slant = Math.abs(pb - pa) / (Math.hypot(pb - pa, qb - qa) || 1);
      const half = st.width / 2 / Math.max(0.35, slant) + 1.5;
      out.push([q - half, q + half]);
    }
  return out;
}

export interface StationSite {
  building: Building;
  /** Scene position of the local origin and the group's Y rotation. */
  pos: [number, number, number];
  rotY: number;
  parts: StationParts;
  /** Local (x, z) → contract (x, z). */
  toContract: (lx: number, lz: number) => [number, number];
  L: number;
  /** Street gaps under the box, the ticket hall and which way its glazed front looks (local x). */
  gaps: [number, number][];
  hall: [number, number] | null;
  hallFace: -1 | 1;
}

const cache = new WeakMap<CityMap, StationSite | null>();

export function stationSite(map: CityMap, b?: Building): StationSite | null {
  if (cache.has(map)) return cache.get(map)!;
  const station = b ?? map.buildings.find((x) => x.kind === "station");
  if (!station) {
    cache.set(map, null);
    return null;
  }
  const alongX = station.w >= station.d;
  const route = overgroundRoute(map);
  const mapLen = alongX ? station.w : station.d;
  const real = !!route?.real && route.station.id === station.id;
  const L = real ? Math.max(mapLen, REAL_BOX_LEN) : mapLen;
  // centre the box on the tracks, not on the OSM box (the line runs a metre or two off its middle)
  let cx = station.x;
  let cz = station.z;
  if (route && route.station.id === station.id) {
    const p = routeAt(route, route.stationS);
    if (alongX) cz = p.z;
    else cx = p.x;
  }
  const gaps = streetGaps(alongX ? { ...station, x: cx, z: cz, w: L } : { ...station, x: cx, z: cz, d: L }, map.streets).filter(([a, c]) => c > -L / 2 && a < L / 2);
  // ticket hall: beside the street that passes under the box nearest its middle (Braithwaite Street on the real map),
  // on the side toward the middle, its glazed front looking onto that street
  let hall: [number, number] | null = null;
  let hallFace: -1 | 1 = -1;
  const free = (a: number, c: number) => a > -L / 2 + 2 && c < L / 2 - 2 && gaps.every(([g0, g1]) => c <= g0 || a >= g1);
  const byCentre = [...gaps].sort((p, q) => Math.abs((p[0] + p[1]) / 2) - Math.abs((q[0] + q[1]) / 2));
  for (const [g0, g1] of byCentre) {
    const east: [number, number] = [g1 + 0.4, g1 + 0.4 + HALL_LEN];
    const west: [number, number] = [g0 - 0.4 - HALL_LEN, g0 - 0.4];
    const prefEast = (g0 + g1) / 2 <= 0;
    for (const [cand, face] of (prefEast ? [[east, -1], [west, 1]] : [[west, 1], [east, -1]]) as [[number, number], -1 | 1][])
      if (!hall && free(cand[0], cand[1])) {
        hall = cand;
        hallFace = face;
      }
    if (hall) break;
  }
  if (!hall && free(-HALL_LEN / 2, HALL_LEN / 2)) hall = [-HALL_LEN / 2, HALL_LEN / 2];
  const platformLen = Math.min(mapLen, L - 4);
  const parts = buildStation({ L, platformLen, gaps, hall, hallFace });
  const [sx, sz] = toScene(cx, cz);
  const rotY = alongX ? 0 : Math.PI / 2;
  const toContract = (lx: number, lz: number): [number, number] => {
    // local (x, z) in scene axes, rotated by rotY about Y, then scene → contract (z flips)
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const wx = sx + lx * c + lz * s;
    const wz = sz - lx * s + lz * c;
    return [wx, -wz];
  };
  const site: StationSite = { building: station, pos: [sx, 0, sz], rotY, parts, toContract, L, gaps, hall, hallFace };
  cache.set(map, site);
  return site;
}

/** A Group for a Kit model: one mesh per material slot and one per sign *kind* (same-key planes merged). */
export function modelObject(model: HeroModel, opts: { shadows?: boolean; noRaycast?: boolean } = {}): Group {
  const mats = heroMaterials();
  const root = new Group();
  root.name = model.name;
  const noRay = () => null;
  for (const [slot, geo] of Object.entries(model.parts) as [Slot, BufferGeometry | undefined][]) {
    if (!geo) continue;
    const mesh = new Mesh(geo, mats[slot]);
    mesh.name = `${model.name}:${slot}`;
    mesh.castShadow = (opts.shadows ?? true) && slot !== "glow" && slot !== "glass";
    mesh.receiveShadow = opts.shadows ?? true;
    if (opts.noRaycast) mesh.raycast = noRay;
    root.add(mesh);
  }
  // signs: every distinct sign painted once into an atlas, so all self-lit signs are one draw call and all painted
  // (scene-lit) ones another, however many kinds there are
  for (const glow of [true, false]) {
    const list = model.signs.filter((s) => s.glow === glow);
    if (!list.length) continue;
    const atlas = signAtlas(list);
    if (!atlas) {
      for (const s of list) root.add(new Mesh(s.geo, signMaterial(s) as Material));
      continue;
    }
    const mesh = new Mesh(atlas.geo, atlas.material(glow));
    mesh.name = `${model.name}:signs-${glow ? "lit" : "painted"}`;
    if (opts.noRaycast) mesh.raycast = noRay;
    root.add(mesh);
  }
  return root;
}

const ATLAS_W = 2048;
const PAD = 3;

/** Shelf-pack each distinct sign key's canvas into one texture and remap every sign plane's uvs into it. */
function signAtlas(signs: SignSpec[]) {
  const kinds = new Map<string, SignSpec>();
  for (const s of signs) if (!kinds.has(s.key)) kinds.set(s.key, s);
  const order = [...kinds.values()].sort((a, b) => b.h - a.h);
  const slot = new Map<string, { x: number; y: number; w: number; h: number }>();
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const s of order) {
    const w = Math.min(s.w, ATLAS_W - 2 * PAD);
    if (x + w + 2 * PAD > ATLAS_W) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    slot.set(s.key, { x: x + PAD, y: y + PAD, w, h: s.h });
    x += w + 2 * PAD;
    shelf = Math.max(shelf, s.h + 2 * PAD);
  }
  const H = Math.pow(2, Math.ceil(Math.log2(Math.max(64, y + shelf))));
  if (H > 4096 || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return null;
  for (const s of order) {
    const r = slot.get(s.key)!;
    // paint at the sign's own size on a scratch canvas, then copy (keeps each painter's clearRect/fill local)
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;
    const cg = c.getContext("2d");
    if (!cg) continue;
    s.draw(cg, s.w, s.h);
    g.drawImage(c, r.x, r.y, r.w, r.h);
  }
  const geos = signs.map((s) => {
    const r = slot.get(s.key)!;
    const geo = (s.geo.index ? s.geo.toNonIndexed() : s.geo.clone()) as BufferGeometry;
    const uv = geo.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      uv.setXY(i, (r.x + u * r.w) / ATLAS_W, 1 - (r.y + (1 - v) * r.h) / H);
    }
    return geo;
  });
  const geo = mergeGeometries(geos, false);
  geos.forEach((g2) => g2.dispose());
  if (!geo) return null;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return {
    geo,
    material: (glow: boolean): Material =>
      glow
        ? new MeshBasicMaterial({ map: tex, toneMapped: false, side: DoubleSide, alphaTest: 0.3, polygonOffset: true, polygonOffsetFactor: -2 })
        : new MeshStandardMaterial({ map: tex, roughness: 0.7, alphaTest: 0.3, polygonOffset: true, polygonOffsetFactor: -2 }),
  };
}
