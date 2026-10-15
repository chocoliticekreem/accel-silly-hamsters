// Builds Hoxton from the real OSM extract (data.ts) and the backend map. Pure geometry, built once.
//  - ground: every free bit of land in the area is a real surface: OSM parks, gardens, playgrounds, pitches and car
//    parks as their own polygons; the rest of the open land a yard, estate green or school tarmac by OSM landuse;
//    York-stone pavement slabs along every street; service roads and footpaths through the blocks
//  - buildings: OSM footprints the backend map has no box for, extruded to their storeys (the gaps between boxes)
//  - streets: granite kerbs, zebra and signal crossings with tactile paving and Belisha beacons, cycle lanes
//  - Hoxton Square: railed garden on a dwarf wall, lawn, paths, mature London planes, benches, a playground
//  - furniture from OSM: street trees, Sheffield stands with parked bikes, Santander docks, benches, bins, K6 boxes,
//    pillar boxes, bus stops, walls and fences; commercial wheelie bins in the yards
//  - shopfronts: a real fascia sign for each named OSM venue (atlas.ts), generic shopfronts along the high streets,
//    street-art murals on Rivington St / Charlotte Rd / Curtain Rd walls
//  - Hoxton Street Market stalls (shown by day), pavement walk runs and bar/lawn spots for people
// Coordinates: contract (x east, z north) throughout; vertices are written in scene coords (x, y, -z).
import { BufferAttribute, BufferGeometry, Color, ExtrudeGeometry, Shape, ShapeUtils, Vector2 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Building, CityMap, Street } from "../../api/contract";
import { rng, seedOf, type Rng } from "../../mock/rng";
import { HOXTON_AREA, inPoly } from "../../sim/areaKeepouts";
import { MARKING_LIFT, ROAD_TOP, roadClass } from "../../sim/roadLayers";
import { Kit, type SlotGeos } from "../models/kit";
import { drawBusStop, drawCycleDock, drawK6, drawPlaneTree } from "../models/street";
import { buildAtlas, MURALS, type Atlas, type SignReq, type SignStyle } from "./atlas";
import { bbox, centroid, closestSeg, pip, polyArea, type HoxtonData, type HxArea, type P2 } from "./data";

export const inArea = (x: number, z: number) => inPoly(x, z, HOXTON_AREA);

/** Hoxton Square's garden (inside the road loop of the map's "Hoxton Square" street), contract coords. */
export const SQUARE = { minX: -482.2, maxX: -450.6, minZ: 461.5, maxZ: 529.8 };

// ---------------------------------------------------------------------------------------------------------------
// spatial lookups

class Hash<T> {
  private m = new Map<number, T[]>();
  constructor(private cell = 24) {}
  private k(i: number, j: number) {
    return (i + 5000) * 10007 + (j + 5000);
  }
  add(minX: number, maxX: number, minZ: number, maxZ: number, item: T) {
    const c = this.cell;
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++)
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const key = this.k(i, j);
        let l = this.m.get(key);
        if (!l) this.m.set(key, (l = []));
        l.push(item);
      }
  }
  at(x: number, z: number): T[] {
    return this.m.get(this.k(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? [];
  }
}

interface GapBuilding {
  r: P2[];
  h: number;
  bb: ReturnType<typeof bbox>;
}

type Solid = { kind: "box"; b: Building } | { kind: "poly"; g: GapBuilding };

interface Facade {
  /** Point on the wall. */
  x: number;
  z: number;
  /** Outward normal (toward the street) and tangent (= right-hand of the normal... see ryFacing). */
  ox: number;
  oz: number;
  /** Half the usable wall length either side of the point. */
  half: number;
  /** Wall height. */
  h: number;
}

/** Rotation about y so a Kit model's local +z faces contract direction (ox, oz); local +x is then (-oz, ox). */
const ryFacing = (ox: number, oz: number) => Math.atan2(ox, -oz);
const ryAlong = (tx: number, tz: number) => ryFacing(tz, -tx);

// ---------------------------------------------------------------------------------------------------------------
// flat ground surfaces (vertex coloured triangles)

class Flat {
  pos: number[] = [];
  col: number[] = [];
  private c = new Color();
  tri(a: P2, b: P2, cc: P2, y: number, hex: string | Color, jitter = 0, r?: Rng) {
    if (typeof hex === "string") this.c.set(hex);
    else this.c.copy(hex);
    if (jitter && r) this.c.offsetHSL(0, 0, (r() - 0.5) * jitter);
    // scene coords (x, y, -z); keep the face pointing up
    const ax = a[0], az = -a[1], bx = b[0], bz = -b[1], cx = cc[0], cz = -cc[1];
    const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (up >= 0) this.pos.push(ax, y, az, bx, y, bz, cx, y, cz);
    else this.pos.push(ax, y, az, cx, y, cz, bx, y, bz);
    for (let i = 0; i < 3; i++) this.col.push(this.c.r, this.c.g, this.c.b);
  }
  quad(a: P2, b: P2, c: P2, d: P2, y: number, hex: string | Color, jitter = 0, r?: Rng) {
    this.tri(a, b, c, y, hex, jitter, r);
    // same colour for both halves
    const n = this.col.length;
    const [cr, cg, cb] = [this.col[n - 3], this.col[n - 2], this.col[n - 1]];
    this.tri(a, c, d, y, "#000000");
    for (let i = 0; i < 3; i++) this.col.splice(this.col.length - 9 + i * 3, 3, cr, cg, cb);
  }
  poly(r: P2[], y: number, hex: string) {
    if (r.length < 3) return;
    const contour = r.map(([x, z]) => new Vector2(x, z));
    const tris = ShapeUtils.triangulateShape(contour, []);
    for (const [i, j, k] of tris) this.tri(r[i], r[j], r[k], y, hex);
  }
  /** A strip of width w along a -> b. */
  strip(a: P2, b: P2, w: number, y: number, hex: string) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * (w / 2);
    const nz = (dx / l) * (w / 2);
    this.quad([a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz], y, hex);
  }
  geometry(): BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.col), 3));
    const n = new Float32Array(this.pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute("normal", new BufferAttribute(n, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------------------------

export interface WalkRun {
  /** Points 1 m apart along a pavement, contract [x, z] pairs. */
  pts: Float32Array;
  len: number;
}

export interface Spot {
  x: number;
  z: number;
  /** Facing direction for the group (contract). */
  ox: number;
  oz: number;
  kind: "bar" | "lawn" | "market";
}

export interface HoxtonBuilt {
  kit: SlotGeos;
  market: SlotGeos;
  ground: BufferGeometry | null;
  buildings: BufferGeometry | null;
  signs: BufferGeometry | null;
  murals: BufferGeometry | null;
  atlas: Atlas | null;
  runs: WalkRun[];
  spots: Spot[];
  stats: Record<string, number>;
}

const BRICK_WAREHOUSE = ["#7a4536", "#8e5240", "#6e3e31", "#b49a72", "#a5664b", "#5e4a42", "#e2ddd2", "#3c3b3d", "#9a8f80"];
const BRICK_ESTATE = ["#7d5a48", "#9c7a5c", "#b49a72", "#a8a39a", "#8b6a55", "#c2b8a6"];
const FRAME_COLORS = ["#1d1f22", "#24343a", "#3b2a22", "#2f3d2f", "#5a1f24", "#1f2a3d", "#e9e4d6", "#4a4a4a"];
const FASCIA_PLAIN = ["#1d1f22", "#2f3d2f", "#5a1f24", "#1f2a3d", "#e9e4d6", "#8a6a3a", "#2a2a2a", "#6b2b2b"];
const AWNINGS = ["#2f4a3a", "#7a1f2b", "#1f3a5c", "#333333", "#c9b48a", "#3e5e3a"];
const BIKE_PAINT = ["#1d1f22", "#c8ced6", "#2f6db5", "#c4322b", "#2e5e3a", "#e8e2cf", "#e0a92e", "#555b62"];
const SHIRTS_STALL = ["#2a5d8f", "#c4322b", "#2e7d4f", "#e0a92e", "#6a3d8f"];

/** Streets whose frontage gets generic shopfronts (Hoxton's high streets and the warehouse lanes). */
const HIGH_STREETS = new Set(["Pitfield Street", "Hoxton Street", "Rivington Street", "Curtain Road", "Charlotte Road", "Hoxton Square", "Old Street", "Coronet Street", "Great Eastern Street", "Hoxton Market", "Boot Street", "Rufus Street", "Bowling Green Walk", "New North Road", "Kingsland Road"]);
/** Streets whose walls carry murals. */
const ART_STREETS = new Set(["Rivington Street", "Charlotte Road", "Curtain Road", "Great Eastern Street", "Hoxton Street", "Rufus Street", "Coronet Street", "Bowling Green Walk", "Boot Street", "Hoxton Market", "Rivington Place", "Mundy Street", "Drysdale Street"]);
/** The Old Street agent dresses Old Street itself; we keep our kerbs, furniture and lanes off it. */
const NOT_OURS = new Set(["Old Street"]);

export function buildHoxton(map: CityMap, data: HoxtonData): HoxtonBuilt {
  const t0 = performance.now();
  const stats: Record<string, number> = {};
  const ab = bbox(HOXTON_AREA);
  const near = (x: number, z: number, m = 40) => x > ab.minX - m && x < ab.maxX + m && z > ab.minZ - m && z < ab.maxZ + m;

  // ---- lookups ------------------------------------------------------------------------------------------------
  const streets = map.streets.filter((s) => s.points.some(([x, z]) => near(x, z, 60)));
  const boxes = map.buildings.filter((b) => near(b.x, b.z, 60));
  const solids = new Hash<Solid>(24);
  for (const b of boxes) solids.add(b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2, { kind: "box", b });
  const roadHash = new Hash<Street>(30);
  for (const s of streets)
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const p = s.width / 2 + 6;
      roadHash.add(Math.min(ax, bx) - p, Math.max(ax, bx) + p, Math.min(az, bz) - p, Math.max(az, bz) + p, s);
    }
  const streetDist = (s: Street, x: number, z: number): [number, number, number, number] => {
    let best: [number, number, number, number] = [x, z, Infinity, 0];
    for (let i = 0; i < s.points.length - 1; i++) {
      const c = closestSeg(x, z, s.points[i][0], s.points[i][1], s.points[i + 1][0], s.points[i + 1][1]);
      if (c[2] < best[2]) best = [c[0], c[1], c[2], i];
    }
    return best;
  };
  /** The street whose carriageway (+pad) covers (x, z). */
  const roadAt = (x: number, z: number, pad = 0, except?: Street): Street | null => {
    for (const s of roadHash.at(x, z)) {
      if (s === except) continue;
      if (streetDist(s, x, z)[2] < s.width / 2 + pad) return s;
    }
    return null;
  };
  /** Nearest street (any distance up to `max`) with its closest point and segment. */
  const nearestStreet = (x: number, z: number, max = 40, filter?: (s: Street) => boolean) => {
    let best: { s: Street; c: [number, number, number, number] } | null = null;
    for (const s of streets) {
      if (filter && !filter(s)) continue;
      const c = streetDist(s, x, z);
      if (c[2] - s.width / 2 < max && (!best || c[2] - s.width / 2 < best.c[2] - best.s.width / 2)) best = { s, c };
    }
    return best;
  };
  const segDir = (s: Street, i: number): [number, number] => {
    const [ax, az] = s.points[i];
    const [bx, bz] = s.points[i + 1];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    return [(bx - ax) / l, (bz - az) / l];
  };
  const solidAt = (x: number, z: number, pad = 0): Solid | null => {
    for (const s of solids.at(x, z)) {
      if (s.kind === "box") {
        if (Math.abs(x - s.b.x) < s.b.w / 2 + pad && Math.abs(z - s.b.z) < s.b.d / 2 + pad) return s;
      } else {
        const bb = s.g.bb;
        if (x < bb.minX - pad || x > bb.maxX + pad || z < bb.minZ - pad || z > bb.maxZ + pad) continue;
        if (pip(x, z, s.g.r)) return s;
        if (pad > 0) {
          const r = s.g.r;
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (closestSeg(x, z, r[j][0], r[j][1], r[i][0], r[i][1])[2] < pad) return s;
        }
      }
    }
    return null;
  };

  // ---- gap buildings: OSM footprints the map has no box for --------------------------------------------------
  const gaps: GapBuilding[] = [];
  const bColors: { r: P2[]; h: number; color: string }[] = [];
  for (const ob of data.buildings) {
    if (ob.r.length < 3) continue;
    const [cx, cz] = centroid(ob.r);
    if (!inArea(cx, cz)) continue;
    if (Number(ob["building:min_level"] ?? 0) > 0 || Number(ob.min_height ?? 0) > 0) continue;
    if (ob.building === "roof" || ob.building === "construction") continue;
    const bb = bbox(ob.r);
    let n = 0;
    let covered = 0;
    let onRoad = 0;
    for (let x = bb.minX + 0.75; x < bb.maxX; x += 1.5)
      for (let z = bb.minZ + 0.75; z < bb.maxZ; z += 1.5) {
        if (!pip(x, z, ob.r)) continue;
        n++;
        if (solidAt(x, z, 0.3)) covered++;
        else if (roadAt(x, z, 0.5)) onRoad++;
      }
    if (!n || covered / n > 0.35 || onRoad / n > 0.2) continue;
    const r = rng(ob.id % 2147483647);
    const residential = ["apartments", "residential", "flats", "dormitory", "house", "terrace"].includes(ob.building ?? "");
    const levels = ob.l ?? (residential ? 4 + Math.floor(r() * 4) : ob.building === "garage" || ob.building === "shed" ? 1 : 2 + Math.floor(r() * 4));
    const h = ob.h ?? Math.max(3, levels * 3.4 + 0.8);
    const color = ob["building:colour"]?.startsWith("#") ? ob["building:colour"] : ob.building === "church" ? "#c9c0ad" : ob.building === "school" ? "#a5664b" : residential ? BRICK_ESTATE[Math.floor(r() * BRICK_ESTATE.length)] : BRICK_WAREHOUSE[Math.floor(r() * BRICK_WAREHOUSE.length)];
    const g: GapBuilding = { r: ob.r, h, bb };
    gaps.push(g);
    bColors.push({ r: ob.r, h, color });
    solids.add(bb.minX, bb.maxX, bb.minZ, bb.maxZ, { kind: "poly", g });
  }
  stats.gapBuildings = gaps.length;

  const buildingGeos: BufferGeometry[] = [];
  const bc = new Color();
  for (const { r, h, color } of bColors) {
    const shape = new Shape(r.map(([x, z]) => new Vector2(x, z)));
    const g = new ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute("uv");
    const pos = g.getAttribute("position");
    const col = new Float32Array(pos.count * 3);
    bc.set(color);
    for (let i = 0; i < pos.count; i++) {
      // a touch darker at the foot (grime + contact shadow)
      const k = 0.82 + 0.18 * Math.min(1, pos.getY(i) / 6);
      col[i * 3] = bc.r * k;
      col[i * 3 + 1] = bc.g * k;
      col[i * 3 + 2] = bc.b * k;
    }
    g.setAttribute("color", new BufferAttribute(col, 3));
    buildingGeos.push(g.index ? g.toNonIndexed() : g);
  }
  const buildings = buildingGeos.length ? mergeGeometries(buildingGeos, false) : null;
  buildingGeos.forEach((g) => g.dispose());

  /** The wall met walking from (x, z) along (nx, nz), oriented to the face that was hit. */
  const facadeFrom = (x: number, z: number, nx: number, nz: number, from = 0, to = 16): Facade | null => {
    let px = x + nx * from;
    let pz = z + nz * from;
    for (let t = from; t <= to; t += 0.5) {
      const qx = x + nx * t;
      const qz = z + nz * t;
      const s = solidAt(qx, qz);
      if (s) {
        if (s.kind === "box") {
          const b = s.b;
          const faces = [
            { d: b.x - b.w / 2 - px, ox: -1, oz: 0 },
            { d: px - (b.x + b.w / 2), ox: 1, oz: 0 },
            { d: b.z - b.d / 2 - pz, ox: 0, oz: -1 },
            { d: pz - (b.z + b.d / 2), ox: 0, oz: 1 },
          ];
          const f = faces.reduce((a, c) => (c.d > a.d ? c : a));
          if (f.ox !== 0) {
            const fx = b.x + (f.ox * b.w) / 2;
            const fz = Math.max(b.z - b.d / 2 + 0.5, Math.min(b.z + b.d / 2 - 0.5, qz));
            return { x: fx, z: fz, ox: f.ox, oz: 0, half: Math.min(fz - (b.z - b.d / 2), b.z + b.d / 2 - fz), h: b.h };
          }
          const fz = b.z + (f.oz * b.d) / 2;
          const fx = Math.max(b.x - b.w / 2 + 0.5, Math.min(b.x + b.w / 2 - 0.5, qx));
          return { x: fx, z: fz, ox: 0, oz: f.oz, half: Math.min(fx - (b.x - b.w / 2), b.x + b.w / 2 - fx), h: b.h };
        }
        const r = s.g.r;
        let best: { c: [number, number, number, number]; i: number; j: number } | null = null;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const c = closestSeg(qx, qz, r[j][0], r[j][1], r[i][0], r[i][1]);
          if (!best || c[2] < best.c[2]) best = { c, i, j };
        }
        if (!best) return null;
        const [ax, az] = r[best.j];
        const [bx, bz] = r[best.i];
        const l = Math.hypot(bx - ax, bz - az) || 1;
        let ox = -(bz - az) / l;
        let oz = (bx - ax) / l;
        if (ox * (px - best.c[0]) + oz * (pz - best.c[1]) < 0) {
          ox = -ox;
          oz = -oz;
        }
        return { x: best.c[0], z: best.c[1], ox, oz, half: Math.min(best.c[3], 1 - best.c[3]) * l, h: s.g.h };
      }
      px = qx;
      pz = qz;
    }
    return null;
  };

  // ---- facade registry so shopfronts, signs and murals never overlap ---------------------------------------------
  const placed: { x: number; z: number; ox: number; oz: number; half: number }[] = [];
  const facadeFree = (x: number, z: number, ox: number, oz: number, half: number) =>
    !placed.some((p) => {
      if (p.ox * ox + p.oz * oz < 0.9) return false;
      const dx = x - p.x;
      const dz = z - p.z;
      const across = Math.abs(dx * ox + dz * oz);
      const along = Math.abs(-dx * oz + dz * ox);
      return across < 1.5 && along < half + p.half + 0.4;
    });

  const kit = new Kit();
  const flat = new Flat();
  const at = (x: number, z: number, ry: number, fn: () => void, y = 0) => kit.at(x, y, -z, ry, fn);
  const R = rng(4242);

  // ---- ground: areas from OSM ---------------------------------------------------------------------------------
  const greens: HxArea[] = [];
  const drawnAreas: P2[][] = [];
  for (const a of data.areas) {
    const [cx, cz] = centroid(a.r);
    if (!inArea(cx, cz)) continue;
    const kind = a.leisure ?? a.landuse ?? a.amenity;
    if (kind === "park" || kind === "garden" || kind === "grass" || kind === "village_green") {
      flat.poly(a.r, 0.035, kind === "grass" ? "#7e9c62" : "#6f9a52");
      greens.push(a);
      drawnAreas.push(a.r);
    } else if (kind === "playground") {
      flat.poly(a.r, 0.04, "#a5523f");
      drawnAreas.push(a.r);
      playground(kit, a.r, rng(a.id % 1e9));
    } else if (kind === "pitch") {
      flat.poly(a.r, 0.04, "#4f8a4f");
      drawnAreas.push(a.r);
      pitchDress(kit, flat, a.r);
    } else if (kind === "parking") {
      flat.poly(a.r, 0.04, "#4d535c");
      drawnAreas.push(a.r);
      carPark(kit, flat, a.r, rng(a.id % 1e9));
    }
  }
  // Hoxton Square garden (not mapped as an OSM area: drawn from the road loop)
  const sq = SQUARE;
  const sqPoly: P2[] = [
    [sq.minX, sq.minZ],
    [sq.maxX, sq.minZ],
    [sq.maxX, sq.maxZ],
    [sq.minX, sq.maxZ],
  ];
  drawnAreas.push(sqPoly);
  hoxtonSquare(kit, flat, sq);
  stats.greens = greens.length;

  // railings round the named parks and gardens
  for (const a of greens) if (a.name || a.leisure === "park") railings(kit, a.r, 1.2, true);

  // ---- ground: everything else that is open land: yard / estate green / school tarmac -----------------------------
  const landuse = data.areas.filter((a) => (a.landuse || a.amenity === "school" || a.amenity === "college") && inArea(...centroid(a.r)));
  const CELL = 4;
  const cellNoise = (x: number, z: number) => {
    const h = seedOf(Math.floor(x / 14), Math.floor(z / 14));
    return (h % 1000) / 1000;
  };
  let cells = 0;
  const yardEdge: P2[] = [];
  for (let x = ab.minX + CELL / 2; x < ab.maxX; x += CELL)
    for (let z = ab.minZ + CELL / 2; z < ab.maxZ; z += CELL) {
      if (!inArea(x, z)) continue;
      if (solidAt(x, z, -0.5)) continue;
      if (roadAt(x, z, 3.2)) continue;
      if (drawnAreas.some((r) => pip(x, z, r))) continue;
      const lu = landuse.find((a) => pip(x, z, a.r));
      const kind = lu?.amenity ?? lu?.landuse;
      let color = "#a9a59c";
      if (kind === "residential") color = cellNoise(x, z) < 0.55 ? "#7f9a66" : "#a5a198";
      else if (kind === "school" || kind === "college") color = "#8a8580";
      else if (kind === "railway") color = "#7d766c";
      else if (kind === "construction") color = "#8c7a5e";
      const h = CELL / 2 + 0.02;
      flat.quad([x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h], 0.02, color, 0.03, R);
      cells++;
      if (roadAt(x, z, 7.5) && color !== "#7f9a66" && R() < 0.12) yardEdge.push([x, z]);
    }
  stats.groundCells = cells;

  // service roads and footpaths through the blocks (OSM), off the main carriageways
  for (const w of data.ways) {
    const service = w.highway === "service";
    const foot = w.highway === "footway" || w.highway === "pedestrian" || w.highway === "path" || w.highway === "cycleway";
    if (!service && !foot) continue;
    if (w.footway === "sidewalk" || w.footway === "crossing") continue;
    for (let i = 0; i < w.p.length - 1; i++) {
      const a = w.p[i];
      const b = w.p[i + 1];
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      if (!inArea(mx, mz) || roadAt(mx, mz, 2.5) || solidAt(mx, mz)) continue;
      flat.strip(a, b, service ? 3.6 : 2.0, service ? 0.05 : 0.055, service ? "#5d636c" : w.highway === "cycleway" ? "#6a5f58" : "#c2bcae");
    }
  }

  // commercial wheelie bins in the yards by the street
  for (const [x, z] of yardEdge.slice(0, 90)) {
    const ns = nearestStreet(x, z, 12);
    if (!ns) continue;
    const ox = ns.c[0] - x;
    const oz = ns.c[1] - z;
    const l = Math.hypot(ox, oz) || 1;
    const n = 1 + Math.floor(R() * 3);
    at(x, z, ryFacing(ox / l, oz / l), () => {
      for (let i = 0; i < n; i++) eurobin(kit, (i - (n - 1) / 2) * 1.35, R);
    });
  }

  // ---- pavements: York-stone slabs along every street side, kerbs at the carriageway edge -----------------------
  const pave = ["#bdb8ae", "#b6b1a6", "#c4bfb4", "#b9b3a7"];
  let kerbM = 0;
  for (const s of streets) {
    const ours = !NOT_OURS.has(s.name);
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.5) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      const nx = -uz;
      const nz = ux;
      for (const side of [-1, 1]) {
        // kerb runs
        const off = s.width / 2 + 0.15;
        let runStart = -1;
        const flush = (d0: number, d1: number) => {
          if (!ours || d1 - d0 < 1.2) return;
          const mid = (d0 + d1) / 2;
          const kx = ax + ux * mid + nx * off * side;
          const kz = az + uz * mid + nz * off * side;
          at(kx, kz, ryAlong(ux, uz), () => kit.box("solid", 0.3, 0.18, d1 - d0, 0, 0.09, 0, "#c9c5bb"));
          kerbM += d1 - d0;
        };
        for (let d = 0; d <= len; d += 1) {
          const kx = ax + ux * d + nx * off * side;
          const kz = az + uz * d + nz * off * side;
          const ok = inArea(kx, kz) && !roadAt(kx, kz, 0.2, s) && !solidAt(kx, kz);
          if (ok && runStart < 0) runStart = d;
          if (!ok && runStart >= 0) {
            flush(runStart, d - 0.5);
            runStart = -1;
          }
        }
        if (runStart >= 0) flush(runStart, len);
        // paving slabs: 1.8 m along, two rows across a 3 m pavement
        for (let d = 0; d < len - 0.2; d += 1.8) {
          const d1 = Math.min(len, d + 1.8);
          for (const [o0, o1] of [
            [0.3, 1.8],
            [1.8, 3.3],
          ]) {
            const mx = ax + ux * (d + d1) * 0.5 + nx * (s.width / 2 + (o0 + o1) / 2) * side;
            const mz = az + uz * (d + d1) * 0.5 + nz * (s.width / 2 + (o0 + o1) / 2) * side;
            if (!inArea(mx, mz) || solidAt(mx, mz) || roadAt(mx, mz, 0, s)) continue;
            const p = (dd: number, o: number): P2 => [ax + ux * dd + nx * (s.width / 2 + o) * side, az + uz * dd + nz * (s.width / 2 + o) * side];
            flat.quad(p(d + 0.03, o0 + 0.03), p(d1 - 0.03, o0 + 0.03), p(d1 - 0.03, o1 - 0.03), p(d + 0.03, o1 - 0.03), 0.03, pave[Math.floor(R() * pave.length)], 0.025, R);
          }
        }
      }
    }
  }
  stats.kerbMetres = Math.round(kerbM);

  // ---- crossings and signals ------------------------------------------------------------------------------------
  let crossings = 0;
  for (const poi of data.pois) {
    const [x, z] = poi.p;
    if (!inArea(x, z)) continue;
    if (poi.highway !== "crossing" && poi.highway !== "traffic_signals") continue;
    const ns = nearestStreet(x, z, 3);
    if (!ns || NOT_OURS.has(ns.s.name) || ns.c[2] > ns.s.width / 2 + 2) continue;
    const s = ns.s;
    const [ux, uz] = segDir(s, ns.c[3]);
    const W = s.width;
    const y = ROAD_TOP[roadClass(W)] + MARKING_LIFT;
    const cx = ns.c[0];
    const cz = ns.c[1];
    if (poi.highway === "traffic_signals") {
      // signal heads on poles at both kerbs
      at(cx, cz, ryAlong(ux, uz), () => {
        for (const side of [-1, 1]) signalPole(kit, side * (W / 2 + 0.7), side);
      });
      continue;
    }
    const kind = poi.crossing_ref === "zebra" || poi.crossing === "zebra" || poi.crossing === "uncontrolled" || poi.crossing === "marked" ? "zebra" : poi.crossing === "traffic_signals" ? "signals" : null;
    if (!kind) continue;
    crossings++;
    at(cx, cz, ryAlong(ux, uz), () => {
      // local frame: z along the road, x across it
      if (kind === "zebra") {
        for (let u = -W / 2 + 0.5; u <= W / 2 - 0.45; u += 1.0) kit.box("solid", 0.5, 0.02, 3.0, u + 0.25, y, 0, "#eeeae0");
        for (const side of [-1, 1]) {
          belisha(kit, side * (W / 2 + 0.75), 1.7 * side);
          kit.box("solid", 1.4, 0.03, 2.4, side * (W / 2 + 1.0), 0.04, 0, "#c9b48a"); // buff tactile paving
        }
        // zig-zags: short white dashes along both kerbs either side of the crossing
        for (const zs of [-1, 1])
          for (let k = 0; k < 6; k++)
            for (const side of [-1, 1]) kit.box("solid", 0.12, 0.02, 1.0, side * (W / 2 - 0.45) + (k % 2 ? 0.18 : -0.18), y, zs * (2.6 + k * 0.9), "#eeeae0", [0, k % 2 ? 0.35 : -0.35, 0]);
      } else {
        for (const zs of [-1.6, 1.6]) for (let u = -W / 2 + 0.3; u <= W / 2 - 0.3; u += 0.6) kit.box("solid", 0.25, 0.02, 0.25, u, y, zs, "#eeeae0");
        for (const side of [-1, 1]) {
          kit.box("solid", 1.4, 0.03, 2.8, side * (W / 2 + 1.0), 0.04, 0, "#b8664a"); // red tactile paving
          signalPole(kit, side * (W / 2 + 0.6), side, 2.2 * side);
        }
        kit.box("solid", 0.3, 0.02, W, 0, y, 3.4, "#eeeae0", [0, Math.PI / 2, 0]); // stop line
      }
    });
  }
  stats.crossings = crossings;

  // ---- cycle lanes (OSM cycleway=lane on our streets) -------------------------------------------------------------
  let laneM = 0;
  for (const w of data.ways) {
    if (!w.name || NOT_OURS.has(w.name) || !["residential", "unclassified", "tertiary", "secondary", "primary"].includes(w.highway)) continue;
    const sides: number[] = [];
    if (w["cycleway:both"] === "lane" || w.cycleway === "lane") sides.push(-1, 1);
    if (w["cycleway:right"] === "lane") sides.push(-1);
    if (w["cycleway:left"] === "lane") sides.push(1);
    if (!sides.length) continue;
    let run = 0;
    for (let i = 0; i < w.p.length - 1; i++) {
      const [ax, az] = w.p[i];
      const [bx, bz] = w.p[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      const ns = nearestStreet((ax + bx) / 2, (az + bz) / 2, 4, (s) => s.name === w.name);
      if (!ns) continue;
      const W = ns.s.width;
      const y = ROAD_TOP[roadClass(W)] + MARKING_LIFT;
      for (const side of sides) {
        // left of travel = (−uz, ux)
        const off = (W / 2 - 1.5) * side;
        const mx = (ax + bx) / 2 + -uz * off;
        const mz = (az + bz) / 2 + ux * off;
        if (!inArea(mx, mz)) continue;
        at(mx, mz, ryAlong(ux, uz), () => {
          kit.box("solid", 0.15, 0.02, len, 0, y, 0, "#eeeae0");
          if (run < 12) kit.box("solid", 1.3, 0.015, Math.min(len, 10), side * 0.75, y - 0.004, 0, "#3f8f4f"); // green lead-in
          for (let d = -len / 2 + 6; d < len / 2 - 2; d += 30) bikeSymbol(kit, side * 0.78, y + 0.004, d);
        });
        laneM += len;
      }
      run += len;
    }
  }
  stats.cycleLaneMetres = Math.round(laneM);

  // ---- trees (OSM natural=tree) ---------------------------------------------------------------------------------
  let trees = 0;
  for (const [x, z] of data.trees) {
    if (!inArea(x, z) || roadAt(x, z, 0.3) || solidAt(x, z, 0.5)) continue;
    if (x > sq.minX - 6 && x < sq.maxX + 6 && z > sq.minZ - 6 && z < sq.maxZ + 6) continue; // the square plants its own
    const seed = seedOf(Math.round(x), Math.round(z));
    at(x, z, (seed % 628) / 100, () => drawPlaneTree(kit, seed % 997, 9 + (seed % 50) / 10));
    trees++;
  }
  stats.trees = trees;

  // ---- furniture from OSM POIs ---------------------------------------------------------------------------------
  /** Put a prop on the pavement near (x, z), facing the nearest road. */
  const onPavement = (x: number, z: number, minOff = 1.0): { x: number; z: number; ox: number; oz: number; tx: number; tz: number } | null => {
    const ns = nearestStreet(x, z, 25);
    if (!ns) return null;
    if (NOT_OURS.has(ns.s.name) && ns.c[2] < ns.s.width / 2 + 8) return null;
    let ox = ns.c[0] - x;
    let oz = ns.c[1] - z;
    const l = Math.hypot(ox, oz);
    const [tx, tz] = segDir(ns.s, ns.c[3]);
    if (l < 0.01) {
      ox = -tz;
      oz = tx;
    } else {
      ox /= l;
      oz /= l;
    }
    let px = x;
    let pz = z;
    // in the carriageway or on the kerb: step back onto the pavement
    if (l < ns.s.width / 2 + minOff) {
      px = ns.c[0] - ox * (ns.s.width / 2 + minOff);
      pz = ns.c[1] - oz * (ns.s.width / 2 + minOff);
    }
    if (roadAt(px, pz, 0.3) || solidAt(px, pz, 0.3)) return null;
    return { x: px, z: pz, ox, oz, tx, tz };
  };
  let bikes = 0;
  let stands = 0;
  for (const poi of data.pois) {
    const [x, z] = poi.p;
    if (!inArea(x, z)) continue;
    const a = poi.amenity;
    if (a === "bicycle_parking") {
      const pv = onPavement(x, z, 1.3);
      if (!pv) continue;
      const cap = Number(poi.capacity ?? 4) || 4;
      const n = Math.max(1, Math.min(6, Math.round(cap / 2)));
      const r = rng(seedOf(x, z));
      at(pv.x, pv.z, ryFacing(pv.ox, pv.oz), () => {
        for (let i = 0; i < n; i++) {
          const lx = (i - (n - 1) / 2) * 1.0;
          sheffield(kit, lx);
          stands++;
          for (const side of [-1, 1])
            if (r() < 0.55) {
              parkedBike(kit, lx + side * 0.32, BIKE_PAINT[Math.floor(r() * BIKE_PAINT.length)], r);
              bikes++;
            }
        }
      });
    } else if (a === "bicycle_rental") {
      const pv = onPavement(x, z, 1.6);
      if (!pv) continue;
      // dock row along the kerb: local x along the street
      at(pv.x, pv.z, ryAlong(pv.tx, pv.tz), () => kit.at(-4, 0, 0, 0, () => drawCycleDock(kit, 9)));
    } else if (a === "bench") {
      const pv = onPavement(x, z, 1.2);
      if (pv) at(pv.x, pv.z, ryFacing(pv.ox, pv.oz), () => bench(kit));
    } else if (a === "waste_basket") {
      const pv = onPavement(x, z, 0.8);
      if (pv) at(pv.x, pv.z, 0, () => litterBin(kit));
    } else if (a === "telephone") {
      const pv = onPavement(x, z, 1.0);
      if (pv) at(pv.x, pv.z, ryFacing(pv.ox, pv.oz), () => drawK6(kit));
    } else if (a === "post_box") {
      const pv = onPavement(x, z, 0.8);
      if (pv) at(pv.x, pv.z, ryFacing(pv.ox, pv.oz), () => pillarBox(kit));
    } else if (a === "recycling") {
      const pv = onPavement(x, z, 1.5);
      if (pv) at(pv.x, pv.z, ryFacing(pv.ox, pv.oz), () => [-1.4, 0, 1.4].forEach((lx, i) => kit.at(lx, 0, 0, 0, () => eurobin(kit, 0, R, ["#2f6b3a", "#1f3f6b", "#6b6f75"][i]))));
    } else if (poi.highway === "bus_stop") {
      const pv = onPavement(x, z, 1.6);
      if (pv) at(pv.x, pv.z, ryFacing(pv.ox, pv.oz), () => drawBusStop(kit, poi.name ?? "Hoxton"));
    }
  }
  stats.bikes = bikes;
  stats.stands = stands;
  // a few more litter bins and street trees along our pavements where OSM is silent (every ~60 m)
  for (const s of streets) {
    if (NOT_OURS.has(s.name)) continue;
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      for (let d = 20; d < len - 8; d += 55) {
        const side = (Math.floor(d / 55) + i) % 2 ? 1 : -1;
        const off = s.width / 2 + 0.7;
        const x = ax + ux * d - uz * off * side;
        const z = az + uz * d + ux * off * side;
        if (!inArea(x, z) || roadAt(x, z, 0.3, s) || solidAt(x, z, 0.4)) continue;
        at(x, z, 0, () => litterBin(kit));
      }
    }
  }

  // ---- walls and fences (OSM barriers) ------------------------------------------------------------------------------
  for (const b of data.barriers) {
    const wall = b.barrier === "wall" || b.barrier === "retaining_wall";
    const fence = b.barrier === "fence" || b.barrier === "railing";
    if (!wall && !fence) continue;
    const h = Math.min(3, Number(b.height ?? (b.barrier === "retaining_wall" ? 1 : wall ? 1.8 : 1.6)) || 1.6);
    for (let i = 0; i < b.p.length - 1; i++) {
      const [ax, az] = b.p[i];
      const [bx, bz] = b.p[i + 1];
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      if (!inArea(mx, mz) || roadAt(mx, mz, 0.2)) continue;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.3) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      at(mx, mz, ryAlong(ux, uz), () => {
        if (wall) {
          kit.box("brick", 0.3, h, len, 0, h / 2, 0, "#8a5a44");
          kit.box("solid", 0.38, 0.08, len, 0, h + 0.04, 0, "#9a948a"); // coping
        } else {
          for (let d = -len / 2; d <= len / 2; d += 2.4) kit.box("metal", 0.07, h, 0.07, 0, h / 2, d, "#2a2c2e");
          for (const y of [0.15, h * 0.55, h - 0.05]) kit.box("metal", 0.04, 0.05, len, 0, y, 0, "#2a2c2e");
          for (let d = -len / 2; d <= len / 2; d += 0.14) kit.box("metal", 0.02, h - 0.1, 0.02, 0, h / 2, d, "#2a2c2e");
        }
      });
    }
  }

  // ---- shopfronts, signs, murals ----------------------------------------------------------------------------------
  const signReqs: SignReq[] = [];
  const signQuads: { x: number; z: number; y: number; ox: number; oz: number; w: number; h: number }[] = [];
  const muralQuads: { x: number; z: number; y: number; ox: number; oz: number; w: number; h: number; m: number }[] = [];
  const spots: Spot[] = [];

  const STYLE: Record<string, SignStyle> = { bar: "bar", pub: "pub", nightclub: "club", cafe: "cafe", restaurant: "food", fast_food: "food", ice_cream: "cafe", events_venue: "venue", theatre: "venue", cinema: "venue", arts_centre: "venue", gallery: "venue" };
  const venues = data.pois.filter((p) => p.name && inArea(p.p[0], p.p[1]) && (p.shop || (p.amenity && STYLE[p.amenity]) || p.tourism === "gallery" || p.tourism === "hotel"));
  // bars first so they win any contested wall
  venues.sort((a, b) => Number(!!b.amenity && ["bar", "pub", "nightclub"].includes(b.amenity)) - Number(!!a.amenity && ["bar", "pub", "nightclub"].includes(a.amenity)));
  for (const v of venues) {
    if (signReqs.length >= 125) break;
    const [x, z] = v.p;
    const ns = nearestStreet(x, z, 30);
    if (!ns) continue;
    let nx = x - ns.c[0];
    let nz = z - ns.c[1];
    const l = Math.hypot(nx, nz);
    if (l < 0.5) continue;
    nx /= l;
    nz /= l;
    const f = facadeFrom(ns.c[0], ns.c[1], nx, nz, ns.s.width / 2 + 0.6, ns.s.width / 2 + 18);
    if (!f || f.half < 1.6) continue;
    // slide along the wall toward the venue's own point
    const tx = -f.oz;
    const tz = f.ox;
    const along = Math.max(-f.half + 1.6, Math.min(f.half - 1.6, (x - f.x) * tx + (z - f.z) * tz));
    const fx = f.x + tx * along;
    const fz = f.z + tz * along;
    const room = f.half - Math.abs(along);
    const style: SignStyle = v.amenity && STYLE[v.amenity] ? STYLE[v.amenity] : v.tourism === "gallery" ? "venue" : "shop";
    const w = Math.max(3, Math.min(7.5, 1.8 + v.name!.length * 0.3, room * 2 - 0.6));
    if (!facadeFree(fx, fz, f.ox, f.oz, w / 2 + 0.3)) continue;
    placed.push({ x: fx, z: fz, ox: f.ox, oz: f.oz, half: w / 2 + 0.3 });
    const r = rng(seedOf(v.name!, x));
    const night = style === "bar" || style === "pub" || style === "club" || style === "food";
    at(fx, fz, ryFacing(f.ox, f.oz), () =>
      shopfront(kit, w, {
        frame: FRAME_COLORS[Math.floor(r() * FRAME_COLORS.length)],
        fascia: style === "bar" || style === "pub" ? "#15171a" : "#2a2a2a",
        glass: night ? "#6a5034" : r() < 0.5 ? "#5a4a36" : "#2a3540",
        awning: style === "cafe" || style === "food" ? (r() < 0.6 ? AWNINGS[Math.floor(r() * AWNINGS.length)] : undefined) : undefined,
      }),
    );
    const sh = Math.min(0.78, w / 4.5);
    signReqs.push({ text: v.name!, style, aspect: (w * 0.92) / sh, seed: seedOf(v.name!) });
    signQuads.push({ x: fx + f.ox * 0.2, z: fz + f.oz * 0.2, y: 3.62, ox: f.ox, oz: f.oz, w: w * 0.92, h: sh });
    if (style === "bar" || style === "pub" || style === "club") spots.push({ x: fx + f.ox * 2.6, z: fz + f.oz * 2.6, ox: f.ox, oz: f.oz, kind: "bar" });
  }
  stats.signs = signReqs.length;

  // murals and generic shopfronts along the streets
  let murals = 0;
  let fronts = 0;
  for (const s of streets) {
    const art = ART_STREETS.has(s.name);
    const high = HIGH_STREETS.has(s.name);
    if (!art && !high) continue;
    const r = rng(seedOf(s.id));
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 4) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      for (const side of [-1, 1]) {
        const nx = -uz * side;
        const nz = ux * side;
        for (let d = 3 + r() * 5; d < len - 3; d += art ? 8 + r() * 6 : 6.5 + r() * 2.5) {
          const cx = ax + ux * d;
          const cz = az + uz * d;
          if (!inArea(cx, cz)) continue;
          const f = facadeFrom(cx, cz, nx, nz, s.width / 2 + 0.6, s.width / 2 + 9);
          if (!f || f.half < 1.8) continue;
          if (art && r() < 0.32 && f.h > 6) {
            const w = Math.min(f.half * 2 - 0.4, 6 + r() * 8);
            const h = Math.min(f.h - 1, 4.5 + r() * 5);
            if (w < 3.5 || !facadeFree(f.x, f.z, f.ox, f.oz, w / 2)) continue;
            placed.push({ x: f.x, z: f.z, ox: f.ox, oz: f.oz, half: w / 2 });
            muralQuads.push({ x: f.x + f.ox * 0.06, z: f.z + f.oz * 0.06, y: 0.5 + h / 2, ox: f.ox, oz: f.oz, w, h, m: Math.floor(r() * MURALS) });
            murals++;
            continue;
          }
          if (!high || r() < 0.1) continue;
          const w = Math.min(f.half * 2 - 0.6, 3.6 + r() * 2.4);
          if (w < 2.6 || !facadeFree(f.x, f.z, f.ox, f.oz, w / 2 + 0.3)) continue;
          placed.push({ x: f.x, z: f.z, ox: f.ox, oz: f.oz, half: w / 2 + 0.3 });
          const lit = r();
          at(f.x, f.z, ryFacing(f.ox, f.oz), () =>
            shopfront(kit, w, {
              frame: FRAME_COLORS[Math.floor(r() * FRAME_COLORS.length)],
              fascia: FASCIA_PLAIN[Math.floor(r() * FASCIA_PLAIN.length)],
              glass: lit < 0.45 ? "#5f4a33" : lit < 0.7 ? "#4a5560" : "#262e36",
              awning: r() < 0.15 ? AWNINGS[Math.floor(r() * AWNINGS.length)] : undefined,
            }),
          );
          fronts++;
        }
      }
    }
  }
  stats.murals = murals;
  stats.shopfronts = fronts;

  const atlas = signReqs.length || muralQuads.length ? buildAtlas(signReqs) : null;
  const quadGeo = (qs: { x: number; z: number; y: number; ox: number; oz: number; w: number; h: number }[], uvOf: (i: number) => [number, number, number, number]) => {
    if (!qs.length) return null;
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    qs.forEach((q, i) => {
      const tx = -q.oz; // contract tangent: local +x seen from the street
      const tz = q.ox;
      const [u0, v0, u1, v1] = uvOf(i);
      const c = (s: number, t: number): [number, number, number] => [q.x + tx * s * (q.w / 2), q.y + t * (q.h / 2), -(q.z + tz * s * (q.w / 2))];
      // seen from the street (along -o), c(-1, *) is on the viewer's left: text runs from c(-1) to c(1)
      const a = c(-1, -1);
      const b = c(1, -1);
      const cc = c(1, 1);
      const d = c(-1, 1);
      pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
      for (let k = 0; k < 6; k++) nor.push(q.ox, 0, -q.oz);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1); // a b c, a c d
    });
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
    g.computeBoundingSphere();
    return g;
  };
  const signs = atlas ? quadGeo(signQuads, (i) => atlas.signUV[i]) : null;
  const muralsGeo = atlas ? quadGeo(muralQuads, (i) => atlas.muralUV[muralQuads[i].m]) : null;

  // ---- Hoxton Street Market (stalls in the parking lanes, by day) ------------------------------------------------------
  const mk = new Kit();
  const hox = streets.find((s) => s.name === "Hoxton Street" && s.points.some(([, z]) => z > 650));
  if (hox) {
    const r = rng(77);
    for (let i = 0; i < hox.points.length - 1; i++) {
      const [ax, az] = hox.points[i];
      const [bx, bz] = hox.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 3) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      for (let d = 2; d < len - 2; d += 3.6) {
        const cx = ax + ux * d;
        const cz = az + uz * d;
        if (cz < 655 || cz > 752 || !inArea(cx, cz)) continue;
        for (const side of [-1, 1]) {
          if (r() < 0.2) continue;
          const off = hox.width / 2 + 0.2;
          const x = cx - uz * off * side;
          const z = cz + ux * off * side;
          if (solidAt(x, z, 1.2) || roadAt(x, z, 0.5, hox)) continue;
          // stall faces the street centre: local +z toward the carriageway
          mk.at(x, 0, -z, ryFacing(uz * side, -ux * side), () => stall(mk, r));
          spots.push({ x: x + uz * side * 1.8, z: z - ux * side * 1.8, ox: -uz * side, oz: ux * side, kind: "market" });
        }
      }
    }
  }
  const market = mk.bake({ ao: 2 });

  // ---- people: pavement walk runs + lawn spots ----------------------------------------------------------------------
  const runs: WalkRun[] = [];
  for (const s of streets) {
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 12) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      for (const side of [-1, 1]) {
        const off = s.width / 2 + 1.8;
        let cur: number[] = [];
        const done = () => {
          if (cur.length >= 24) runs.push({ pts: new Float32Array(cur), len: cur.length / 2 - 1 });
          cur = [];
        };
        for (let d = 0; d <= len; d += 1) {
          const x = ax + ux * d - uz * off * side;
          const z = az + uz * d + ux * off * side;
          const ok = inArea(x, z) && !roadAt(x, z, 0.6) && !solidAt(x, z, 0.5);
          if (ok) cur.push(x, z);
          else done();
        }
        done();
      }
    }
  }
  const rl = rng(5);
  for (let i = 0; i < 40; i++) {
    const x = sq.minX + 6 + rl() * (sq.maxX - sq.minX - 12);
    const z = sq.minZ + 8 + rl() * (sq.maxZ - sq.minZ - 16);
    if (Math.abs(x - (sq.minX + sq.maxX) / 2) < 2.5 || Math.abs(z - (sq.minZ + sq.maxZ) / 2) < 2.5) continue; // not on the paths
    const a = rl() * Math.PI * 2;
    spots.push({ x, z, ox: Math.cos(a), oz: Math.sin(a), kind: "lawn" });
  }
  stats.walkRuns = runs.length;

  const kitGeos = kit.bake({ ao: 2.5 });
  stats.ms = Math.round(performance.now() - t0);
  if (import.meta.env.DEV) (globalThis as unknown as { __hoxton: unknown }).__hoxton = { murals: muralQuads.map((q) => [Math.round(q.x), Math.round(q.z), q.ox, q.oz]), signs: signQuads.map((q) => [Math.round(q.x), Math.round(q.z), q.ox, q.oz]) };
  return { kit: kitGeos, market, ground: flat.geometry(), buildings, signs, murals: muralsGeo, atlas, runs, spots, stats };
}

// ===============================================================================================================
// props (Kit local frame: +z faces the street / viewer, y up, metres)

function shopfront(k: Kit, w: number, o: { frame: string; fascia: string; glass: string; awning?: string }) {
  for (const s of [-1, 1]) k.box("paint", 0.3, 4.3, 0.24, s * (w / 2 + 0.15), 2.15, 0.12, o.frame); // pilasters
  k.box("paint", w + 0.6, 0.95, 0.18, 0, 3.62, 0.1, o.fascia); // fascia board
  k.box("paint", w + 0.75, 0.12, 0.32, 0, 4.15, 0.16, o.frame); // cornice
  k.box("paint", w, 0.45, 0.14, 0, 0.225, 0.07, o.frame); // stall riser
  k.box("glass", w, 2.6, 0.05, 0, 1.75, 0.05, o.glass);
  k.box("paint", w, 0.08, 0.1, 0, 2.55, 0.08, o.frame); // transom
  const n = Math.max(1, Math.round(w / 1.7));
  for (let i = 1; i < n; i++) k.box("paint", 0.07, 2.6, 0.1, -w / 2 + (i * w) / n, 1.75, 0.08, o.frame);
  k.box("paint", 0.95, 2.5, 0.08, w / 2 - 0.65, 1.25, 0.07, o.frame); // door
  if (o.awning) k.box("paint", w + 0.1, 0.05, 1.5, 0, 2.98, 0.7, o.awning, [0.32, 0, 0]);
}

function belisha(k: Kit, x: number, z: number) {
  for (let i = 0; i < 6; i++) k.cyl("paint", 0.06, 0.06, 0.4, 8, [x, 0.2 + i * 0.4, z], i % 2 ? "#f2f2f2" : "#151515");
  k.sphere("glow", 0.2, 12, 8, [x, 2.6, z], "#ffae1a");
}

function signalPole(k: Kit, x: number, side: number, z = 0) {
  k.cyl("metal", 0.06, 0.07, 3.2, 8, [x, 1.6, z], "#4a4f55");
  // head facing traffic coming along the road on this side
  k.rbox("paint", 0.3, 0.9, 0.25, x, 2.75, z + 0.18 * side, "#151515", 0.04);
  k.sphere("glow", 0.08, 8, 6, [x, 3.0, z + 0.31 * side], "#ff2a1a");
  k.sphere("solid", 0.08, 8, 6, [x, 2.75, z + 0.31 * side], "#5a4a1a");
  k.sphere("solid", 0.08, 8, 6, [x, 2.5, z + 0.31 * side], "#1a3a24");
  // push-button box for pedestrians
  k.box("paint", 0.15, 0.25, 0.12, x, 1.1, z, "#e8c547");
}

function bikeSymbol(k: Kit, x: number, y: number, z: number) {
  for (const dz of [-0.45, 0.45]) k.torus("solid", 0.28, 0.035, 3, 14, [x, y, z + dz], "#eeeae0", [Math.PI / 2, 0, 0]);
  k.box("solid", 0.06, 0.01, 0.9, x, y, z, "#eeeae0");
}

function sheffield(k: Kit, x: number) {
  // inverted U across the pavement (local z), galvanised steel
  for (const z of [-0.35, 0.35]) k.cyl("metal", 0.03, 0.03, 0.8, 6, [x, 0.4, z], "#8d939a");
  k.cylZ("metal", 0.03, 0.7, 6, [x, 0.8, 0], "#8d939a");
}

function parkedBike(k: Kit, x: number, paint: string, r: Rng) {
  k.at(x, 0, 0, (r() - 0.5) * 0.08, () => {
    for (const z of [-0.52, 0.52]) {
      k.torus("solid", 0.33, 0.025, 4, 14, [0, 0.34, z], "#151517", [0, Math.PI / 2, 0]);
      k.cylX("metal", 0.035, 0.06, 6, [0, 0.34, z], "#9aa0a6");
    }
    k.bar("paint", [0, 0.34, -0.52], [0, 0.78, -0.1], 0.035, paint); // seat stay
    k.bar("paint", [0, 0.34, -0.52], [0, 0.36, 0.0], 0.035, paint); // chain stay
    k.bar("paint", [0, 0.36, 0.0], [0, 0.78, -0.1], 0.04, paint); // seat tube
    k.bar("paint", [0, 0.78, -0.1], [0, 0.8, 0.38], 0.04, paint); // top tube
    k.bar("paint", [0, 0.36, 0.0], [0, 0.8, 0.38], 0.042, paint); // down tube
    k.bar("metal", [0, 0.8, 0.38], [0, 0.34, 0.52], 0.03, "#2a2c30"); // fork
    k.box("solid", 0.12, 0.05, 0.24, 0, 0.88, -0.14, "#151515"); // saddle
    k.box("metal", 0.5, 0.03, 0.03, 0, 0.98, 0.36, "#2a2c30"); // bars
  });
}

function litterBin(k: Kit) {
  k.cyl("paint", 0.3, 0.27, 0.95, 12, [0, 0.48, 0], "#1e2022");
  k.cyl("paint", 0.33, 0.33, 0.1, 12, [0, 0.98, 0], "#c9a227");
  k.cyl("paint", 0.31, 0.31, 0.05, 12, [0, 0.7, 0], "#c9a227");
}

function bench(k: Kit) {
  for (const x of [-0.75, 0.75]) {
    k.box("metal", 0.07, 0.45, 0.5, x, 0.23, 0, "#1d1f22");
    k.box("metal", 0.07, 0.5, 0.07, x, 0.7, -0.24, "#1d1f22");
  }
  for (const z of [-0.15, 0, 0.15]) k.box("solid", 1.7, 0.04, 0.12, 0, 0.46, z, "#8a5a32");
  for (const y of [0.62, 0.78]) k.box("solid", 1.7, 0.1, 0.03, 0, y, -0.25, "#8a5a32");
}

function pillarBox(k: Kit) {
  k.cyl("paint", 0.3, 0.32, 0.12, 12, [0, 0.06, 0], "#151515");
  k.cyl("paint", 0.27, 0.27, 1.22, 14, [0, 0.73, 0], "#c8201e");
  k.cyl("paint", 0.3, 0.3, 0.08, 14, [0, 1.36, 0], "#b01a19");
  k.dome("paint", 0.28, 14, 6, [0, 1.4, 0], "#c8201e", [1, 0.5, 1]);
  k.box("solid", 0.22, 0.04, 0.05, 0, 1.18, 0.27, "#111111");
  k.box("solid", 0.16, 0.12, 0.02, 0, 0.98, 0.275, "#f2efe2");
}

/** 1100 L four-wheeled commercial bin. */
function eurobin(k: Kit, x: number, r: Rng, body?: string) {
  const c = body ?? ["#4a4f55", "#2b2d30", "#5b6066", "#2f5d3a", "#1f3f6b"][Math.floor(r() * 5)];
  const lid = body ? body : r() < 0.5 ? "#2b2d30" : c;
  k.rbox("paint", 1.25, 1.05, 1.0, x, 0.7, 0, c, 0.05);
  k.rbox("paint", 1.3, 0.12, 1.08, x, 1.28, -0.02, lid, 0.03, 2, [-0.08, 0, 0]);
  for (const sx of [-0.5, 0.5]) for (const sz of [-0.38, 0.38]) k.cylX("solid", 0.09, 0.07, 8, [x + sx, 0.09, sz], "#151515");
}

function railings(k: Kit, ring: P2[], h: number, wall: boolean) {
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.3) continue;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    k.at((ax + bx) / 2, 0, -(az + bz) / 2, ryAlong(ux, uz), () => {
      const base = wall ? 0.35 : 0;
      if (wall) k.box("solid", 0.32, 0.35, len, 0, 0.175, 0, "#6f665c");
      for (let d = -len / 2 + 0.12; d < len / 2; d += 0.24) {
        k.box("metal", 0.025, h, 0.025, 0, base + h / 2, d, "#16171a");
        k.cone("metal", 0.03, 0.09, 4, [0, base + h + 0.045, d], "#16171a");
      }
      for (const y of [base + 0.1, base + h - 0.12]) k.box("metal", 0.03, 0.04, len, 0, y, 0, "#16171a");
    });
  }
}

function hoxtonSquare(k: Kit, flat: Flat, s: typeof SQUARE) {
  const cx = (s.minX + s.maxX) / 2;
  const cz = (s.minZ + s.maxZ) / 2;
  const W = s.maxX - s.minX;
  const D = s.maxZ - s.minZ;
  flat.quad([s.minX, s.minZ], [s.maxX, s.minZ], [s.maxX, s.maxZ], [s.minX, s.maxZ], 0.035, "#6c9a4c");
  // mown stripes
  for (let z = s.minZ + 2; z < s.maxZ - 2; z += 4) flat.quad([s.minX + 1, z], [s.maxX - 1, z], [s.maxX - 1, z + 2], [s.minX + 1, z + 2], 0.04, "#74a253");
  // paths: perimeter loop, the cross, a round centre
  const path = "#c9bb98";
  const y = 0.05;
  const inset = 3.2;
  const pw = 2.2;
  flat.strip([s.minX + inset, s.minZ + inset], [s.maxX - inset, s.minZ + inset], pw, y, path);
  flat.strip([s.minX + inset, s.maxZ - inset], [s.maxX - inset, s.maxZ - inset], pw, y, path);
  flat.strip([s.minX + inset, s.minZ + inset - pw / 2], [s.minX + inset, s.maxZ - inset + pw / 2], pw, y, path);
  flat.strip([s.maxX - inset, s.minZ + inset - pw / 2], [s.maxX - inset, s.maxZ - inset + pw / 2], pw, y, path);
  flat.strip([cx, s.minZ], [cx, s.maxZ], 2.6, y + 0.002, path);
  flat.strip([s.minX, cz], [s.maxX, cz], 2.6, y + 0.002, path);
  const ring: P2[] = [];
  for (let i = 0; i < 24; i++) ring.push([cx + Math.cos((i / 24) * Math.PI * 2) * 5, cz + Math.sin((i / 24) * Math.PI * 2) * 5]);
  flat.poly(ring, y + 0.004, path);
  const bed: P2[] = ring.map(([x, z]) => [cx + (x - cx) * 0.55, cz + (z - cz) * 0.55]);
  flat.poly(bed, y + 0.008, "#5a4632");
  // centre bed planting
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    k.blob("solid", 0.55, 1, [cx + Math.cos(a) * 1.6, 0.4, -(cz + Math.sin(a) * 1.6)], i % 3 ? "#4f7d36" : "#b84a6a", [1, 0.7, 1]);
  }
  // dwarf wall + railings, with gates at the four path ends
  const gate = 1.6;
  const sides: [P2, P2][] = [
    [[s.minX, s.minZ], [cx - gate, s.minZ]],
    [[cx + gate, s.minZ], [s.maxX, s.minZ]],
    [[s.maxX, s.minZ], [s.maxX, cz - gate]],
    [[s.maxX, cz + gate], [s.maxX, s.maxZ]],
    [[s.maxX, s.maxZ], [cx + gate, s.maxZ]],
    [[cx - gate, s.maxZ], [s.minX, s.maxZ]],
    [[s.minX, s.maxZ], [s.minX, cz + gate]],
    [[s.minX, cz - gate], [s.minX, s.minZ]],
  ];
  for (const [a, b] of sides) {
    railingsOpen(k, a, b, 1.25);
  }
  // gate piers
  for (const [px, pz] of [
    [cx - gate, s.minZ],
    [cx + gate, s.minZ],
    [cx - gate, s.maxZ],
    [cx + gate, s.maxZ],
    [s.minX, cz - gate],
    [s.minX, cz + gate],
    [s.maxX, cz - gate],
    [s.maxX, cz + gate],
  ] as P2[]) {
    k.box("solid", 0.5, 1.8, 0.5, px, 0.9, -pz, "#5f574e");
    k.box("solid", 0.6, 0.1, 0.6, px, 1.85, -pz, "#8a8378");
  }
  // mature London planes round the edge, between railings and the perimeter path
  let seed = 3;
  const plant = (x: number, z: number) => {
    seed++;
    k.at(x, 0, -z, seed * 1.3, () => drawPlaneTree(k, 500 + seed, 17 + (seed % 5)));
  };
  for (let x = s.minX + 1.6; x <= s.maxX - 1.6; x += (W - 3.2) / 3) {
    plant(x, s.minZ + 1.5);
    plant(x, s.maxZ - 1.5);
  }
  for (let z = s.minZ + 12; z <= s.maxZ - 12; z += (D - 24) / 3) {
    plant(s.minX + 1.5, z);
    plant(s.maxX - 1.5, z);
  }
  // benches facing the lawn along the cross path
  for (const z of [cz - 14, cz - 24, cz + 14, cz + 24]) {
    for (const side of [-1, 1]) k.at(cx + side * 1.9, 0, -z, side > 0 ? -Math.PI / 2 : Math.PI / 2, () => bench(k));
  }
  for (const [x, z] of [
    [cx + 3, cz + 3],
    [cx - 3, cz - 3],
    [s.minX + inset + 1.6, s.minZ + inset + 1.6],
    [s.maxX - inset - 1.6, s.maxZ - inset - 1.6],
  ] as P2[])
    k.at(x, 0, -z, 0, () => litterBin(k));
  // small playground in the north-east corner
  const px = s.maxX - 9;
  const pz = s.maxZ - 10;
  flat.quad([px - 4, pz - 4], [px + 4, pz - 4], [px + 4, pz + 4], [px - 4, pz + 4], 0.06, "#a5523f");
  k.at(px, 0, -pz, 0.4, () => {
    for (const x of [-1.2, 1.2]) k.beam("metal", [x, 0, -0.8], [x, 2.2, 0], 0.05, "#d94f2b");
    for (const x of [-1.2, 1.2]) k.beam("metal", [x, 0, 0.8], [x, 2.2, 0], 0.05, "#d94f2b");
    k.cylX("metal", 0.05, 2.5, 8, [0, 2.2, 0], "#d94f2b");
    for (const x of [-0.5, 0.5]) {
      k.box("metal", 0.02, 1.6, 0.02, x, 1.4, 0, "#2a2c30");
      k.box("solid", 0.45, 0.05, 0.2, x, 0.55, 0, "#1d1f22");
    }
    k.box("paint", 1.2, 1.0, 1.2, 0, 0.5, 2.6, "#2f6db5"); // play tower
    k.box("paint", 0.6, 0.06, 2.0, 0.9, 0.55, 2.6, "#e8c547", [0, 0, 0.45]); // slide
  });
}

function railingsOpen(k: Kit, a: P2, b: P2, h: number) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 0.4) return;
  const ux = (b[0] - a[0]) / len;
  const uz = (b[1] - a[1]) / len;
  k.at((a[0] + b[0]) / 2, 0, -(a[1] + b[1]) / 2, ryAlong(ux, uz), () => {
    const base = 0.4;
    k.box("solid", 0.34, base, len, 0, base / 2, 0, "#6f665c");
    k.box("solid", 0.4, 0.06, len, 0, base + 0.03, 0, "#8a8378");
    for (let d = -len / 2 + 0.11; d < len / 2; d += 0.22) {
      k.box("metal", 0.025, h, 0.025, 0, base + h / 2, d, "#141518");
      k.cone("metal", 0.03, 0.1, 4, [0, base + h + 0.05, d], "#141518");
    }
    for (const y of [base + 0.12, base + h - 0.15]) k.box("metal", 0.035, 0.045, len, 0, y, 0, "#141518");
  });
}

function playground(k: Kit, r: P2[], rand: Rng) {
  const [cx, cz] = centroid(r);
  if (polyArea(r) < 30) return;
  k.at(cx, 0, -cz, rand() * Math.PI, () => {
    k.box("paint", 1.4, 1.2, 1.4, -1.5, 0.6, 0, "#2f6db5");
    k.box("paint", 1.6, 0.1, 1.6, -1.5, 2.4, 0, "#e8c547");
    for (const [x, z] of [
      [-2.2, -0.7],
      [-0.8, -0.7],
      [-2.2, 0.7],
      [-0.8, 0.7],
    ])
      k.cyl("metal", 0.05, 0.05, 2.4, 6, [x, 1.2, z], "#d94f2b");
    k.box("paint", 0.6, 0.06, 2.4, 0.2, 0.7, 0, "#3fae6a", [0, 0, -0.5]);
    for (const x of [1.8, 3.0]) k.beam("metal", [x, 0, -0.7], [x, 2, 0], 0.05, "#d94f2b");
    for (const x of [1.8, 3.0]) k.beam("metal", [x, 0, 0.7], [x, 2, 0], 0.05, "#d94f2b");
    k.cylX("metal", 0.05, 1.4, 8, [2.4, 2, 0], "#d94f2b");
  });
}

function pitchDress(k: Kit, flat: Flat, r: P2[]) {
  // white lines on the outline, inset a metre; tall ball-court fence on the outline
  const [cx, cz] = centroid(r);
  const inner: P2[] = r.map(([x, z]) => {
    const dx = x - cx;
    const dz = z - cz;
    const l = Math.hypot(dx, dz) || 1;
    return [x - (dx / l) * 1.2, z - (dz / l) * 1.2];
  });
  for (let i = 0; i < inner.length; i++) flat.strip(inner[i], inner[(i + 1) % inner.length], 0.1, 0.045, "#eeeae0");
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    k.at((a[0] + b[0]) / 2, 0, -(a[1] + b[1]) / 2, ryAlong(ux, uz), () => {
      for (let d = -len / 2; d <= len / 2 + 0.01; d += 3) k.box("metal", 0.08, 3.2, 0.08, 0, 1.6, d, "#2c4a32");
      for (const y of [0.1, 1.2, 3.15]) k.box("metal", 0.04, 0.05, len, 0, y, 0, "#2c4a32");
      for (let d = -len / 2; d <= len / 2; d += 0.2) k.box("metal", 0.012, 3.1, 0.012, 0, 1.6, d, "#3b5a40");
    });
  }
}

function carPark(k: Kit, flat: Flat, r: P2[], rand: Rng) {
  // bays along the longest edge's direction, with parked cars in most of them
  let best = 0;
  let ux = 1;
  let uz = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) {
      best = l;
      ux = (b[0] - a[0]) / l;
      uz = (b[1] - a[1]) / l;
    }
  }
  const vx = -uz;
  const vz = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of r) {
    const u = x * ux + z * uz;
    const v = x * vx + z * vz;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const P = (u: number, v: number): P2 => [u * ux + v * vx, u * uz + v * vz];
  const rows = v1 - v0 > 16 ? [v0 + 2.6, v1 - 2.6] : v1 - v0 > 6 ? [v0 + 2.6] : [];
  const CARS = ["#d9d9d9", "#2b2b2b", "#8a1f1f", "#2d4f8a", "#9aa3ad", "#e8e2cf", "#3e5e3a", "#5a5f66", "#f2f2f2", "#1f2a44"];
  for (const rv of rows) {
    for (let u = u0 + 1.5; u < u1 - 1.5; u += 2.5) {
      const [mx, mz] = P(u + 1.25, rv);
      if (!pip(mx, mz, r) || !pip(...P(u + 1.25, rv - 2.3), r) || !pip(...P(u + 1.25, rv + 2.3), r)) continue;
      flat.strip(P(u, rv - 2.4), P(u, rv + 2.4), 0.1, 0.045, "#e8e2cf");
      if (rand() < 0.75) {
        const c = CARS[Math.floor(rand() * CARS.length)];
        k.at(mx, 0, -mz, ryAlong(vx, vz) + (rand() < 0.5 ? Math.PI : 0), () => parkedCar(k, c));
      }
    }
  }
}

function parkedCar(k: Kit, paint: string) {
  // local +z = nose
  k.rbox("paint", 1.78, 0.7, 4.2, 0, 0.62, 0, paint, 0.18);
  k.rbox("glass", 1.56, 0.55, 2.2, 0, 1.2, -0.25, "#1d2733", 0.16);
  k.rbox("paint", 1.6, 0.06, 1.9, 0, 1.49, -0.3, paint, 0.03);
  for (const sx of [-0.78, 0.78]) for (const sz of [-1.35, 1.3]) k.cylX("solid", 0.33, 0.24, 12, [sx, 0.33, sz], "#151517");
  for (const sx of [-0.6, 0.6]) {
    k.box("glow", 0.32, 0.1, 0.04, sx, 0.75, 2.1, "#fff5d8");
    k.box("solid", 0.32, 0.1, 0.04, sx, 0.8, -2.1, "#7a1010");
  }
}

function stall(k: Kit, r: Rng) {
  // 3 x 2.4 m gazebo stall: tubular frame, striped canopy, trestle with goods, crates underneath
  const canopy = SHIRTS_STALL[Math.floor(r() * SHIRTS_STALL.length)];
  for (const x of [-1.45, 1.45]) for (const z of [-1.15, 1.15]) k.cyl("solid", 0.035, 0.035, 2.4, 6, [x, 1.2, z], "#c9ccd1");
  for (let i = 0; i < 6; i++) k.box("solid", 0.5, 0.06, 2.6, -1.25 + i * 0.5, 2.5 + (i % 2) * 0.004, 0, i % 2 ? "#f2efe6" : canopy);
  k.box("solid", 3.0, 0.3, 0.04, 0, 2.35, 1.3, canopy); // valance
  k.box("solid", 2.8, 0.06, 0.9, 0, 0.85, 0.6, "#8a6a4a"); // trestle top
  k.box("solid", 2.8, 0.8, 0.02, 0, 0.45, 1.06, "#2f4a3a"); // skirt
  const goods = ["#e0a92e", "#c4322b", "#3e8e41", "#f2efe6", "#6a3d8f", "#2a5d8f", "#e86f2c"];
  for (let i = 0; i < 6; i++) k.box("solid", 0.38, 0.18 + r() * 0.15, 0.32, -1.15 + i * 0.46, 0.98, 0.6 + (r() - 0.5) * 0.2, goods[Math.floor(r() * goods.length)]);
  // rail of clothes on some stalls
  if (r() < 0.4) {
    k.cylX("solid", 0.02, 2.6, 6, [0, 1.9, -0.6], "#c9ccd1");
    for (let i = 0; i < 9; i++) k.box("solid", 0.06, 0.8, 0.45, -1.1 + i * 0.28, 1.45, -0.6, goods[Math.floor(r() * goods.length)]);
  }
  for (let i = 0; i < 3; i++) k.box("solid", 0.5, 0.3, 0.4, -0.9 + i * 0.9, 0.15, -0.3, "#2b4a8f");
}
