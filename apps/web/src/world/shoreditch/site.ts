// Where the Shoreditch High Street station box sits and how it is laid out (shared by world/Station.tsx, which draws
// it, and the ShoreditchStation module, which walks people in and out of its ticket hall). Cached per map.
import { Group, Mesh, type BufferGeometry, type Material } from "three";
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
  const site: StationSite = { building: station, pos: [sx, 0, sz], rotY, parts, toContract, L };
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
  const byKey = new Map<string, SignSpec[]>();
  for (const s of model.signs) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
  for (const [key, list] of byKey) {
    const geo = list.length === 1 ? list[0].geo : mergeGeometries(list.map((s) => s.geo), false);
    if (!geo) continue;
    const mesh = new Mesh(geo, signMaterial(list[0]) as Material);
    mesh.name = `sign:${key}`;
    if (opts.noRaycast) mesh.raycast = noRay;
    root.add(mesh);
  }
  return root;
}
