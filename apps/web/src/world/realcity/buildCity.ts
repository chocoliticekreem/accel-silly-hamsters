// The real buildings' merged geometry as plain typed arrays (no three.js objects), so it can be built in a Web Worker
// (realcity/city.worker.ts) and transferred to the page without copying. Pure: no React, no DOM, no scene.
// RealBuildings turns the arrays into BufferGeometries; the same function runs on the main thread when no worker
// is available.
import type { Building, CityMap } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { SKYLINE_SPOTS } from "../../sim/london";
import { GOODSYARD_AREA, HOXTON_AREA, inPoly } from "../../sim/areaKeepouts";
import { OLD_STREET_AREA, OLD_STREET_OSM_WAYS, WHITE_COLLAR_AREA } from "../../sim/oldStreetArea";
import { keptOut } from "../keepOut";
import { landmarkKeepouts } from "../models/plots";
import { addBuilding, CHUNK, lookOf, MeshBuilder } from "./buildingGeometry";
import { inPolygon, type RealBuilding, type RealCity } from "./data";

export interface ChunkArrays {
  outer: boolean;
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  win: Float32Array;
  idx: Uint32Array;
  /** Bounding box minX, minY, minZ, maxX, maxY, maxZ. */
  box: number[];
}

export interface BuiltArrays {
  chunks: ChunkArrays[];
  /** Flat (building index, chunk, first vertex, vertex count) per drawn building. */
  ranges: Int32Array;
  /** store id → building index of its real polygon. */
  storeMatch: [string, number][];
  drawnCount: number;
  ms: number;
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

function boxOf(pos: Float32Array): number[] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

export function buildCityArrays(city: RealCity, map: CityMap): BuiltArrays {
  const t0 = performance.now();
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
  const ranges: number[] = [];
  const drawn = new Set<number>();
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
    ranges.push(i, c.index, start, c.mb.nv - start);
    drawn.add(i);
  });
  const chunks = order.map((k): ChunkArrays => {
    const c = builders.get(k)!;
    const a = c.mb.arrays();
    return { outer: c.outer, ...a, box: boxOf(a.pos) };
  });

  const storeMatch: [string, number][] = [];
  for (const s of map.stores) {
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (!b) continue;
    const i = matchBuilding(city, b, s.osmId, byId);
    if (i != null && drawn.has(i)) storeMatch.push([s.id, i]);
  }
  return { chunks, ranges: Int32Array.from(ranges), storeMatch, drawnCount: drawn.size, ms: Math.round(performance.now() - t0) };
}

/** Buffers to transfer (not copy) when posting a build out of the worker. */
export const transferables = (b: BuiltArrays): ArrayBuffer[] => [
  b.ranges.buffer as ArrayBuffer,
  ...b.chunks.flatMap((c) => [c.pos, c.nor, c.col, c.win, c.idx].map((a) => a.buffer as ArrayBuffer)),
];
