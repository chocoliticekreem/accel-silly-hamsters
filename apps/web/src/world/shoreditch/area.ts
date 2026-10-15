// The streets and yards round Shoreditch High Street station, built from the OSM extract in
// public/areas/shoreditch-station.json (scripts/fetch-shoreditch-area.mjs): traffic signals at their real nodes
// (poles either side of the carriageway, lamp positions returned for the module to light), signal-controlled
// crossings painted as stud lines, TfL bus stops at their real stops, the Bishopsgate Goodsyard behind its printed
// hoarding with the Grade II listed Braithwaite Viaduct running across it (brick arches, some bricked up and
// painted, buddleia on top), site cabins, spoil heaps and plant, and a graffiti wall under the station on
// Braithwaite Street. Everything static goes into one Kit (one draw call per material slot); the printed hoarding
// and the murals are UV-mapped planes with their own canvas textures.
// All inputs in contract coords (x east, z north); geometry in scene coords (toScene).
import { BufferAttribute, BufferGeometry, PlaneGeometry, Shape, ShapeGeometry, Vector2 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CityMap, Street } from "../../api/contract";
import { rng } from "../../mock/rng";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { MARKING_LIFT, ROAD_TOP, roadClass } from "../../sim/roadLayers";
import { Kit, type HeroModel } from "../models/kit";
import { drawBusStop } from "../models/street";
import { teaBuilding } from "./tea";

export interface AreaData {
  signals: { x: number; z: number; crossing: boolean }[];
  crossings: { x: number; z: number; kind: string }[];
  busStops: { x: number; z: number; name: string; ref: string }[];
  braithwaiteViaduct: [number, number][] | null;
  goodsyard: [number, number][] | null;
}

/** One lamp of a signal head: scene position, facing (scene yaw), colour index 0 red 1 amber 2 green, phase group. */
export interface Lamp {
  p: [number, number, number];
  yaw: number;
  color: 0 | 1 | 2;
  group: 0 | 1;
}

/** A spot where someone waits for a bus (scene coords) and which way they face. */
export interface Waiting {
  x: number;
  z: number;
  yaw: number;
}

export interface AreaBuild {
  model: HeroModel;
  lamps: Lamp[];
  /** Printed hoarding faces (uv.x runs along in 16 m repeats). */
  hoarding: BufferGeometry;
  /** Murals: uv.y picks one of 4 rows of the mural atlas. */
  murals: BufferGeometry;
  waiting: Waiting[];
}

const BRICK = "#8a5440";
const BRICK_INFILL = ["#6a4335", "#5d3c31", "#74503f"];
const AREA_R = 270;
const ORIGIN = { x: -41, z: 1 };

function nearestStreet(streets: readonly Street[], x: number, z: number, minWidth = 0) {
  let best: { st: Street; cx: number; cz: number; d: number; dx: number; dz: number } | null = null;
  for (const st of streets) {
    if (st.width < minWidth) continue;
    for (let i = 0; i < st.points.length - 1; i++) {
      const [ax, az] = st.points[i];
      const [bx, bz] = st.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const L2 = dx * dx + dz * dz || 1;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const cx = ax + dx * k;
      const cz = az + dz * k;
      const d = Math.hypot(x - cx, z - cz);
      if (!best || d < best.d) {
        const l = Math.sqrt(L2);
        best = { st, cx, cz, d, dx: dx / l, dz: dz / l };
      }
    }
  }
  return best;
}

/** Scene yaw whose local +z points along contract direction (dx, dz). */
const yawOf = (dx: number, dz: number) => Math.atan2(dx, -dz);

function quad(a: [number, number, number], b: [number, number, number], h: number, u0: number, u1: number, v0 = 0, v1 = 1): BufferGeometry {
  // vertical quad from a to b (bottom edge), height h; front face to the left of a→b seen from above in scene coords
  const g = new BufferGeometry();
  const pos = new Float32Array([a[0], a[1], a[2], b[0], b[1], b[2], b[0], b[1] + h, b[2], a[0], a[1], a[2], b[0], b[1] + h, b[2], a[0], a[1] + h, a[2]]);
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("uv", new BufferAttribute(new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]), 2));
  g.computeVertexNormals();
  return g;
}

/** A vertical quad from a to b (scene, bottom edge) of height h whose front faces scene direction `n` (x, z). */
function facing(a: [number, number, number], b: [number, number, number], h: number, n: [number, number], u0: number, u1: number, v0: number, v1: number) {
  const left = [-(b[2] - a[2]), b[0] - a[0]];
  return left[0] * n[0] + left[1] * n[1] > 0 ? quad(a, b, h, u0, u1, v0, v1) : quad(b, a, h, u1, u0, v0, v1);
}

/**
 * The OSM outline stops ~25 m short of the station; on the ground the site runs right up to the box. Pull the north
 * edge west of x = 56 up to z = −11 (just clear of the station's legs), keeping the rest of the outline as mapped.
 */
function yardRing(ring: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    const [x, z] = ring[i];
    // the notch between the Shoreditch High Street strip and the main yard is part of the site too
    if (x > -162 && x < -158 && z < -45 && z > -52) continue;
    const notch = x < -183.5 && x > -185 && z < -45 && z > -50;
    const north = notch || (z > -40 && x > -160 && x < 56);
    out.push(north ? [x, -11] : [x, z]);
    // after the edge's east end, add the corner where the raised edge meets the mapped one
    if (north && i + 1 < ring.length && ring[i + 1][0] >= 56) out.push([55, -11]);
  }
  return out;
}

export interface GraffitiWall {
  /** Contract x of the painted face, running z0..z1; `face` +1 = the face looks east (scene +x). */
  x: number;
  z0: number;
  z1: number;
  h: number;
  face: 1 | -1;
}

export function buildArea(map: CityMap, data: AreaData, opts: { graffitiWalls?: GraffitiWall[]; tea?: boolean } = {}): AreaBuild {
  const k = new Kit();
  const lamps: Lamp[] = [];
  const hoardings: BufferGeometry[] = [];
  const murals: BufferGeometry[] = [];
  const waiting: Waiting[] = [];
  const r = rng(1863);
  const near = (x: number, z: number, rad = AREA_R) => Math.hypot(x - ORIGIN.x, z - ORIGIN.z) < rad;
  const onRoad = (x: number, z: number, pad = 0) => map.streets.some((st) => closestOnStreet(st, x, z)[2] < st.width / 2 + pad);

  // ---------------- traffic signals ----------------
  for (const s of data.signals) {
    if (!near(s.x, s.z)) continue;
    const ns = nearestStreet(map.streets, s.x, s.z, 8);
    if (!ns || ns.d > 12) continue;
    const group: 0 | 1 = Math.abs(ns.dx) >= Math.abs(ns.dz) ? 0 : 1;
    const nx = -ns.dz;
    const nz = ns.dx;
    for (const side of [-1, 1]) {
      const off = ns.st.width / 2 + 0.75;
      const px = ns.cx + nx * side * off;
      const pz = ns.cz + nz * side * off;
      if (onRoad(px, pz, 0.2)) continue; // a side street joins here: no pole in its mouth
      const [sx, sz] = toScene(px, pz);
      const yaw = yawOf(ns.dx, ns.dz);
      k.at(sx, 0, sz, yaw, () => {
        k.cyl("solid", 0.13, 0.15, 0.2, 10, [0, 0.1, 0], "#26292d");
        k.cyl("metal", 0.065, 0.07, 3.6, 8, [0, 1.8, 0], "#3b4046");
        k.box("solid", 0.16, 0.24, 0.12, 0, 1.15, 0.1 * side, "#d8b000");
        // the head: lenses both ways, black backboard with a white border
        k.rbox("solid", 0.34, 1.0, 0.3, 0, 2.95, 0, "#141517", 0.04);
        k.box("paint", 0.6, 1.26, 0.03, 0, 2.95, 0, "#f2f2ee");
        k.box("paint", 0.54, 1.2, 0.05, 0, 2.95, 0, "#111214");
        for (const f of [-1, 1]) for (let i = 0; i < 3; i++) k.box("solid", 0.26, 0.05, 0.12, 0, 3.32 - i * 0.31 + 0.12, f * 0.2, "#0d0e10");
      });
      for (const f of [-1, 1] as const)
        for (let i = 0; i < 3; i++) {
          // lamp i (0 red top, 1 amber, 2 green bottom) on face f
          const lz = f * 0.16;
          const c = Math.cos(yaw);
          const sn = Math.sin(yaw);
          lamps.push({ p: [sx + lz * sn, 3.32 - i * 0.31, sz + lz * c], yaw: f > 0 ? yaw : yaw + Math.PI, color: i as 0 | 1 | 2, group });
        }
    }
  }

  // ---------------- signal crossings: two lines of studs across the carriageway ----------------
  for (const c of data.crossings) {
    if (c.kind !== "traffic_signals" || !near(c.x, c.z)) continue;
    const ns = nearestStreet(map.streets, c.x, c.z);
    if (!ns || ns.d > 4) continue;
    const y = ROAD_TOP[roadClass(ns.st.width)] + MARKING_LIFT + 0.012;
    const nx = -ns.dz;
    const nz = ns.dx;
    const half = ns.st.width / 2 - 0.3;
    for (const along of [-1.3, 1.3])
      for (let t = -half; t <= half; t += 0.75) {
        const [sx, sz] = toScene(c.x + ns.dx * along + nx * t, c.z + ns.dz * along + nz * t);
        k.box("paint", 0.45, 0.012, 0.18, sx, y, sz, "#f2f2ee", [0, yawOf(nx, nz), 0]);
      }
  }

  // ---------------- bus stops ----------------
  const BGR = ["8", "388", "N8"];
  const A10 = ["26", "35", "47", "78", "135", "149", "242", "243"];
  for (const b of data.busStops) {
    if (!near(b.x, b.z, 250)) continue;
    const ns = nearestStreet(map.streets, b.x, b.z, 8);
    if (!ns || ns.d > 14) continue;
    let nx = b.x - ns.cx;
    let nz = b.z - ns.cz;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const off = ns.st.width / 2 + 2.1;
    const px = ns.cx + nx * off;
    const pz = ns.cz + nz * off;
    const [sx, sz] = toScene(px, pz);
    const yaw = yawOf(-nx, -nz); // open front faces the road
    const name = /elder/i.test(b.name) ? "Elder Street" : /brick/i.test(b.name) ? "Brick Lane" : "Shoreditch High St Stn";
    k.at(sx, 0, sz, yaw, () => drawBusStop(k, name, /bethnal/i.test(ns.st.name) ? BGR : A10));
    // a few spots where people wait, along the kerb by the shelter
    for (let i = 0; i < 4; i++) {
      const t = -1.8 + i * 1.3;
      const [wx, wz] = toScene(px - nx * 1.2 + ns.dx * t, pz - nz * 1.2 + ns.dz * t);
      waiting.push({ x: wx, z: wz, yaw: yawOf(-nx, -nz) });
    }
  }

  // ---------------- the Goodsyard: ground, hoarding round its OSM outline ----------------
  const yard = data.goodsyard ? yardRing(data.goodsyard) : null;
  if (yard && yard.length > 3) {
    const ring = yard.slice(0, yard[0][0] === yard[yard.length - 1][0] && yard[0][1] === yard[yard.length - 1][1] ? -1 : undefined);
    const shape = new Shape(ring.map(([x, z]) => new Vector2(x, z)));
    const ground = new ShapeGeometry(shape);
    ground.rotateX(-Math.PI / 2);
    k.add("solid", ground, "#8f877a", [0, 0.045, 0]);
    // orientation: positive area = counter-clockwise in (x, z-north)
    let area = 0;
    for (let i = 0; i < yard.length - 1; i++) area += yard[i][0] * yard[i + 1][1] - yard[i + 1][0] * yard[i][1];
    const ccw = area > 0;
    let run = 0;
    const H = 3.0;
    for (let i = 0; i < yard.length - 1; i++) {
      const [ax, az] = yard[i];
      const [bx, bz] = yard[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.3) continue;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      // outward normal (contract)
      const ox = ccw ? dz : -dz;
      const oz = ccw ? -dx : dx;
      const steps = Math.max(1, Math.round(len / 4));
      for (let j = 0; j < steps; j++) {
        const t0 = (j / steps) * len;
        const t1 = ((j + 1) / steps) * len;
        const mx = ax + dx * (t0 + t1) / 2;
        const mz = az + dz * (t0 + t1) / 2;
        if (onRoad(mx, mz, 0.5)) continue; // a road crosses the line: leave the gateway open
        const a = toScene(ax + dx * t0 + ox * 0.12, az + dz * t0 + oz * 0.12);
        const b = toScene(ax + dx * t1 + ox * 0.12, az + dz * t1 + oz * 0.12);
        // face the outside: quad's front is to the left of a→b in scene; flip order when needed
        const leftX = -(b[1] - a[1]);
        const leftZ = b[0] - a[0];
        const [osx, osz] = [ox, -oz];
        const front = leftX * osx + leftZ * osz > 0;
        const u0 = (run + t0) / 16;
        const u1 = (run + t1) / 16;
        const pa: [number, number, number] = [a[0], 0, a[1]];
        const pb: [number, number, number] = [b[0], 0, b[1]];
        // the SHS-road strip of hoarding is covered in paste-ups and graffiti instead of the developer's print
        const graffiti = ax < -183 && bx < -183;
        if (graffiti) murals.push(front ? quad(pa, pb, H - 0.15, u0 * 0.25, u1 * 0.25, 0, 0.25) : quad(pb, pa, H - 0.15, u1 * 0.25, u0 * 0.25, 0, 0.25));
        else hoardings.push(front ? quad(pa, pb, H - 0.15, u0, u1) : quad(pb, pa, H - 0.15, u1, u0));
        const [cx, cz] = toScene(mx, mz);
        k.box("solid", t1 - t0 + 0.05, H, 0.16, cx, H / 2, cz, "#1d3a2e", [0, yawOf(dx, dz) + Math.PI / 2, 0]);
      }
      // posts every ~4 m on the inside
      for (let t = 0; t <= len; t += 4) {
        const px = ax + dx * t - ox * 0.25;
        const pz = az + dz * t - oz * 0.25;
        if (onRoad(px, pz, 0.5)) continue;
        const [sx, sz] = toScene(px, pz);
        k.box("solid", 0.12, H + 0.1, 0.12, sx, (H + 0.1) / 2, sz, "#3a3d40");
        if (Math.round(t / 4) % 5 === 0) {
          const [lx, lz] = toScene(px + ox * 0.5, pz + oz * 0.5);
          k.box("glow", 0.3, 0.12, 0.3, lx, H + 0.25, lz, "#fff1c9");
        }
      }
      run += len;
    }
  }

  // ---------------- the Braithwaite Viaduct (1839–40, Grade II): brick arches across the Goodsyard ----------------
  const bv = data.braithwaiteViaduct;
  if (bv && bv.length >= 2) {
    const [a, b] = [bv[0], bv[bv.length - 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    const [sax, saz] = toScene(a[0], a[1]);
    // local +x along the viaduct: scene direction (ux, -uz)
    const ry = Math.atan2(uz, ux);
    const PITCH = 9;
    const PIER = 1.8;
    const SPAN = PITCH - PIER;
    const SPRING = 2.9;
    const DECK = 7.4;
    const D = 8.6;
    // align one arch over the street that passes under it (Braithwaite Street)
    let phase = 0;
    const crossings: number[] = [];
    for (const st of map.streets)
      for (let i = 0; i < st.points.length - 1; i++) {
        const [px, pz] = st.points[i];
        const [qx, qz] = st.points[i + 1];
        const da = (px - a[0]) * -uz + (pz - a[1]) * ux;
        const db = (qx - a[0]) * -uz + (qz - a[1]) * ux;
        if (da * db > 0) continue;
        const kk = da / (da - db);
        const t = (px + (qx - px) * kk - a[0]) * ux + (pz + (qz - pz) * kk - a[1]) * uz;
        if (t > 0 && t < len) {
          crossings.push(t);
          phase = (((t - (PIER + PITCH) / 2) % PITCH) + PITCH) % PITCH;
        }
      }
    const spandrel = new Shape();
    spandrel.moveTo(-SPAN / 2, SPRING);
    spandrel.lineTo(-SPAN / 2, DECK);
    spandrel.lineTo(SPAN / 2, DECK);
    spandrel.lineTo(SPAN / 2, SPRING);
    spandrel.absarc(0, SPRING, SPAN / 2, 0, Math.PI, false);
    const infill = new Shape();
    infill.moveTo(-SPAN / 2, 0);
    infill.lineTo(SPAN / 2, 0);
    infill.lineTo(SPAN / 2, SPRING);
    infill.absarc(0, SPRING, SPAN / 2, 0, Math.PI, false);
    infill.lineTo(-SPAN / 2, 0);
    let muralRow = 0;
    k.at(sax, 0, saz, ry, () => {
      for (let x = phase; x + PITCH <= len + 0.01; x += PITCH) {
        const c = x + PITCH / 2;
        k.slab("brick", x, x + PIER, 0, DECK, -D / 2, D / 2, BRICK);
        // pilaster strips and a plinth on the piers
        for (const s of [-1, 1]) k.slab("brick", x - 0.1, x + PIER + 0.1, 0, 0.9, s > 0 ? D / 2 - 0.05 : -D / 2 - 0.15, s > 0 ? D / 2 + 0.15 : -D / 2 + 0.05, "#6b4334");
        k.extrude("brick", spandrel, D, [c + PIER / 2, 0, -D / 2], BRICK, [0, 0, 0], 10);
        // half the arches bricked up (lock-ups, some painted), the rest open right through
        const fill = r();
        const overStreet = crossings.some((t) => t > x + PIER - 1 && t < x + PITCH + 1);
        if (fill < 0.55 && !overStreet) {
          k.extrude("brick", infill, 0.35, [c + PIER / 2, 0, -D / 2 + 0.9], BRICK_INFILL[Math.floor(r() * 3)], [0, 0, 0], 10);
          k.extrude("brick", infill, 0.35, [c + PIER / 2, 0, D / 2 - 1.25], BRICK_INFILL[Math.floor(r() * 3)], [0, 0, 0], 10);
          // a steel door or roller shutter in the north face
          const shutter = r() < 0.5;
          k.slab("metal", c + PIER / 2 - (shutter ? 2 : 0.6), c + PIER / 2 + (shutter ? 2 : 0.6), 0, shutter ? 2.8 : 2.2, -D / 2 + 0.82, -D / 2 + 0.9, shutter ? "#6f757b" : "#2e4a3f");
          if (r() < 0.6) {
            // paint on the bricked-up face (the north side, toward the station)
            const row = muralRow++ % 4;
            const g = new PlaneGeometry(SPAN - 0.6, 2.6);
            const uv = g.getAttribute("uv");
            const u0 = r() * 0.6;
            for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.4, (3 - row + uv.getY(i)) / 4);
            g.rotateY(Math.PI);
            g.translate(c + PIER / 2, shutter ? 4.2 : 3.4, -D / 2 + 0.86);
            g.rotateY(ry);
            g.translate(sax, 0, saz);
            murals.push(g);
          }
        } else {
          // open arch: a dark soffit glimpse and a puddle-dark floor
          k.slab("solid", x + PIER, x + PITCH, 0.03, 0.06, -D / 2, D / 2, "#3c3a36");
        }
        // parapet with stone coping, buddleia on the top
        for (const s of [-1, 1]) {
          k.slab("brick", x, x + PITCH, DECK, DECK + 1.0, s > 0 ? D / 2 - 0.45 : -D / 2, s > 0 ? D / 2 : -D / 2 + 0.45, BRICK);
          k.slab("solid", x - 0.02, x + PITCH + 0.02, DECK + 1.0, DECK + 1.14, s > 0 ? D / 2 - 0.55 : -D / 2 - 0.08, s > 0 ? D / 2 + 0.08 : -D / 2 + 0.55, "#cbc2b0");
        }
        k.slab("solid", x, x + PITCH, DECK, DECK + 0.25, -D / 2 + 0.45, D / 2 - 0.45, "#5b5a45");
        for (let i = 0; i < 2; i++) if (r() < 0.6) k.blob("solid", 0.8 + r() * 1.1, 1, [x + r() * PITCH, DECK + 0.6, (r() - 0.5) * (D - 2)], r() < 0.3 ? "#7a5a8c" : "#4f6b3a", [1, 0.7, 1]);
      }
    });
  }

  // ---------------- site cabins, spoil heaps and plant in the yard ----------------
  if (yard) {
    const cabin = (x: number, z: number, rot: number, tiers: number) => {
      const [sx, sz] = toScene(x, z);
      k.at(sx, 0, sz, rot, () => {
        for (let t = 0; t < tiers; t++)
          for (let i = 0; i < 3; i++) {
            const y = t * 2.7;
            k.rbox("solid", 2.5, 2.6, 9.6, i * 2.6, y + 1.3, 0, t === 1 ? "#2f6f9e" : "#e9e6dc", 0.05);
            for (let w = -3; w <= 3; w += 3) k.box("glass", 0.04, 0.9, 1.4, i * 2.6 - 1.27, y + 1.6, w, "#ffe6b0");
          }
        if (tiers > 1) {
          k.slab("metal", -1.3, 6.5, 2.65, 2.75, 4.8, 6.0, "#e2b400");
          k.beam("metal", [6.5, 0, 5.4], [3, 2.7, 5.4], 0.06, "#e2b400");
        }
      });
    };
    cabin(-178, -40, Math.PI / 2, 2);
    cabin(-150, -84, 0, 1);
    const heap = (x: number, z: number, s: number, c: string) => {
      const [sx, sz] = toScene(x, z);
      k.blob("solid", s, 1, [sx, 0, sz], c, [1.3, 0.55, 1]);
    };
    heap(-105, -68, 6, "#8c7356");
    heap(-92, -78, 4, "#7e6a52");
    heap(48, -60, 5, "#8c7356");
    heap(130, -52, 4.5, "#857059");
    // excavators (yellow) and a piling rig
    const digger = (x: number, z: number, rot: number) => {
      const [sx, sz] = toScene(x, z);
      k.at(sx, 0, sz, rot, () => {
        k.slab("solid", -1.4, 1.4, 0, 0.8, -2.2, 2.2, "#26272a");
        k.rbox("paint", 2.6, 1.3, 3.0, 0, 1.45, -0.3, "#f2b705", 0.1);
        k.rbox("glass", 1.0, 1.2, 1.1, 0.7, 2.6, 0.5, "#7d97a5", 0.05);
        k.beam("paint", [-0.3, 1.8, 1.0], [-0.3, 4.2, 3.6], 0.22, "#f2b705");
        k.beam("paint", [-0.3, 4.2, 3.6], [-0.3, 1.0, 5.6], 0.18, "#f2b705");
        k.box("metal", 1.0, 0.8, 0.8, -0.3, 0.6, 5.8, "#3d4045");
      });
    };
    digger(-120, -76, 0.6);
    digger(30, -62, -1.1);
    const [px, pz] = toScene(-20, -60);
    k.at(px, 0, pz, 0.3, () => {
      k.slab("solid", -1.6, 1.6, 0, 0.9, -2.5, 2.5, "#26272a");
      k.rbox("paint", 3.0, 2.2, 4.0, 0, 2.0, 0, "#c8102e", 0.1);
      k.slab("metal", -0.35, 0.35, 0.9, 24, 2.2, 2.9, "#c8102e");
      for (let y = 2; y < 24; y += 1.6) k.slab("metal", -0.4, 0.4, y, y + 0.1, 2.15, 2.95, "#8a0b20");
      k.cyl("metal", 0.35, 0.35, 8, 10, [0, 6, 3.5], "#6b6f74");
    });
  }

  // ---------------- graffiti wall under the station on Braithwaite Street ----------------
  // a brick wall along the street's far kerb under the box, painted both sides (`x` contract, running z0..z1)
  for (const w of opts.graffitiWalls ?? []) {
    const a = toScene(w.x, w.z0);
    const b = toScene(w.x, w.z1);
    const len = Math.abs(w.z1 - w.z0);
    k.box("brick", 0.6, w.h, len, a[0] - w.face * 0.32, w.h / 2, (a[1] + b[1]) / 2, "#5e3a2e");
    murals.push(facing([a[0], 0.12, a[1]], [b[0], 0.12, b[1]], w.h - 0.4, [w.face, 0], 0, len / 16, 0.5, 0.75));
    const ba: [number, number, number] = [a[0] - w.face * 0.64, 0.12, a[1]];
    const bb: [number, number, number] = [b[0] - w.face * 0.64, 0.12, b[1]];
    murals.push(facing(ba, bb, w.h - 0.4, [-w.face, 0], 0, len / 16, 0.25, 0.5));
  }

  if (opts.tea) teaBuilding(k);

  const merge = (list: BufferGeometry[]) => {
    const clean = list.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      for (const key of Object.keys(n.attributes)) if (key !== "position" && key !== "normal" && key !== "uv") n.deleteAttribute(key);
      return n;
    });
    return (clean.length ? mergeGeometries(clean, false) : null) ?? new BufferGeometry();
  };
  return { model: k.model("shoreditch-area", { ao: 0 }), lamps, hoarding: merge(hoardings), murals: merge(murals), waiting };
}
