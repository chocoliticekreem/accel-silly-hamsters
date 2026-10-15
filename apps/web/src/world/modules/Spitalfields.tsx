// Module: Spitalfields (decorative). South and east of Shoreditch High Street station: Brick Lane and Banglatown,
// the Old Truman Brewery, Old Spitalfields Market, Christ Church Spitalfields, Commercial Street, Petticoat Lane,
// and the City edge at Bishopsgate / Liverpool Street. Geometry comes from OpenStreetMap (public/areas/
// spitalfields.json, made by apps/web/scripts/spitalfields-osm.py); the hero models are in world/spitalfields.
//  - heroes: Christ Church (floodlit at night), the market hall roof, Liverpool Street's trainshed and clock tower,
//    Truman's chimney and Brick Lane bridge, the Banglatown arch, the Jamme Masjid minaret (world/keepOut.ts hides
//    the base map's boxes under the church, the market hall and the trainshed);
//  - street level: OSM parks, churchyards, squares and car parks; granite kerbs along every carriageway; Brick Lane's
//    narrow pavements; zebras at OSM crossings; curry-house fascias with neon and lit shop windows; street art;
//    market stalls; Banglatown lamps; OSM trees, benches, bins, cycle stands and Santander docks;
//  - people: market crowds and the curry crowd on the sim clock (see world/spitalfields/crowds.ts).
// Never clickable. About 20 draw calls: merged vertex-coloured geometry per material, instancing for repeats.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  type Material,
} from "three";
import type { CityMap, Street } from "../../api/contract";
import { rng } from "../../mock/rng";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { newPoint, polyline } from "../../sim/polyline";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople } from "../people";
import { benchGeometry, binGeometry, merge, treeGeometry } from "../propModels";
import { CURRY_HOUSES, muralAtlas, SIGN_STYLES, signAtlas, type SignStyle, type UvRect } from "../spitalfields/atlas";
import { makeWalker, pace, turnout, weekdayOf, type Walker, type Zone } from "../spitalfields/crowds";
import { banglaArch, christChurch, inRing, liverpoolStreet, marketHall, minaret, trumanBrewery, type HeroKits, type Ring } from "../spitalfields/heroes";
import { flatPolygon, Kit, Quads } from "../spitalfields/kit";
import { banglaLampGeometry, banglaLanternGeometry, bikeGeometry, stallAwningGeometry, stallFrameGeometry, standGeometry } from "../spitalfields/props";
import { buildingsNear, castToFacade, crossings, inArea, kerbRuns, onOtherRoad } from "../spitalfields/street";

interface AreaData {
  heroes: { church?: Ring; market?: Ring; station?: Ring; masjid?: Ring; boiler?: Ring };
  truman: Ring[];
  areas: { k: string; n?: string; r: Ring }[];
  points: { k: string; p: [number, number]; n?: string }[];
}

const noRaycast = () => {};

const AREA_STYLE: Record<string, { hex: string; y: number }> = {
  pedestrian: { hex: "#cdc6b8", y: 0.03 },
  marketplace: { hex: "#cdc6b8", y: 0.03 },
  food_court: { hex: "#c4b8a4", y: 0.032 },
  parking: { hex: "#555a61", y: 0.036 },
  park: { hex: "#6e8f58", y: 0.045 },
  garden: { hex: "#73945c", y: 0.047 },
  grass: { hex: "#7a9a60", y: 0.049 },
  recreation_ground: { hex: "#6e8f58", y: 0.045 },
  pitch: { hex: "#4c8a4e", y: 0.055 },
  playground: { hex: "#b5654a", y: 0.056 },
};

const AWNINGS = ["#2f6b4f", "#b7322c", "#24395c", "#efe6cf", "#d9a521", "#2a8c8c", "#6d2e5b", "#e9e4d8"].map((c) => new Color(c));
const BIKE_COLORS = ["#1b1b1b", "#2b4c7e", "#7a7f85", "#2a8c8c", "#b7322c", "#e9e4d8"].map((c) => new Color(c));
const SANTANDER = new Color("#d4202c");
const NORTH_SHOPS = ["Rough Trade East", "Beyond Retro", "Atika Vintage", "Brick Lane Bookshop", "Café 1001", "Dark Sugars", "Blitz", "Upmarket", "Brick Lane Beigel Bake", "Vintage Market", "Coffee Box", "Brick Lane Gallery"];
const NORTH_STYLES: SignStyle[] = [
  { bg: "#111111", fg: "#ffffff" },
  { bg: "#f2efe6", fg: "#151515" },
  { bg: "#e8b400", fg: "#151515" },
  { bg: "#1f3b2d", fg: "#f1e6c8" },
  { bg: "#8a1c2b", fg: "#ffffff" },
];

interface Inst {
  m: Matrix4;
  c?: Color;
}

interface StallInst extends Inst {
  group: "always" | "sunday" | "petticoat";
}

function streetsNamed(map: CityMap, name: string) {
  return map.streets.filter((s) => s.name === name && s.points.some(([x, z]) => inArea(x, z, 20)));
}

/** Runs of consecutive points inside the area (so walkers and stalls stay in this module's patch). */
function clipped(s: Street, test: (x: number, z: number) => boolean): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const p of s.points) {
    if (test(p[0], p[1])) cur.push(p);
    else {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Unit direction of the nearest street (contract), for orienting benches and bike racks. */
function nearestStreetDir(map: CityMap, x: number, z: number): [number, number, number] {
  let best: [number, number, number] = [1, 0, Infinity];
  for (const s of map.streets)
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t) - s.width / 2;
      if (d < best[2]) {
        const l = Math.sqrt(l2);
        best = [dx / l, dz / l, d];
      }
    }
  return best;
}

const o3 = new Object3D();
/** Instance matrix at contract (x, z), turned so local +z faces contract direction (fx, fz), uniform scale. */
function mat(x: number, z: number, fx: number, fz: number, y = 0, s = 1, sx = s, sy = s, sz = s): Matrix4 {
  const [px, pz] = toScene(x, z);
  o3.position.set(px, y, pz);
  // local +z → scene (sin θ, cos θ) = (fx, -fz)
  o3.rotation.set(0, Math.atan2(fx, -fz), 0);
  o3.scale.set(sx, sy, sz);
  o3.updateMatrix();
  return o3.matrix.clone();
}

export function build(map: CityMap, data: AreaData) {
  const r = rng(1729);
    const inBuilding = (x: number, z: number, pad = 0.3) => buildingsNear(map, x, z).some((b) => Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad);
  const kits: HeroKits = { solid: new Kit(), stone: new Kit(), glass: new Kit(), glow: new Kit(), signs: new Quads() };

  // --- sign list first (the atlas needs every name before it's drawn) --------------------------------------
  const brick = streetsNamed(map, "Brick Lane");
  const named = data.points.filter((p) => p.n && ["restaurant", "cafe", "fast_food", "bar", "pub"].includes(p.k));
  interface SignSpot {
    x: number;
    z: number;
    nx: number;
    nz: number;
    w: number;
    name: string;
    style: SignStyle;
  }
  const signSpots: SignSpot[] = [];
  let curry = 0;
  let north = 0;
  const pt = newPoint();
  for (const s of brick) {
    const path = polyline(s.points);
    for (const side of [-1, 1]) {
      let lastB = "";
      let lastD = -99;
      for (let d = 4; d < path.length; d += 6.5) {
        path.at(d, 0, pt);
        if (!inArea(pt.x, pt.z) || pt.z > -60 || pt.z < -660) continue;
        // right-hand normal (dz, -dx) times side
        const nx = pt.dz * side;
        const nz = -pt.dx * side;
        if (onOtherRoad(map, pt.x + nx * (s.width / 2 + 2), pt.z + nz * (s.width / 2 + 2), s, 0.5)) continue;
        const f = castToFacade(map, pt.x, pt.z, nx, nz, 16);
        if (!f || f.room < 1.6 || f.b.h < 5) continue;
        if (f.b.id === lastB && d - lastD < 13) continue;
        const banglatown = pt.z < -300;
        const w = Math.min(banglatown ? 6.2 : 5.5, 2 * f.room - 0.5);
        const near = named.find((p) => Math.hypot(p.p[0] - f.x, p.p[1] - f.z) < 9);
        const name = near?.n?.replace(/\s*\(.*\)$/, "") ?? (banglatown ? CURRY_HOUSES[curry++ % CURRY_HOUSES.length] : NORTH_SHOPS[north++ % NORTH_SHOPS.length]);
        // one look per name, so a chain of the same name never needs a second atlas slot
        const hn = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
        const style = banglatown ? SIGN_STYLES[hn % SIGN_STYLES.length] : NORTH_STYLES[hn % NORTH_STYLES.length];
        signSpots.push({ x: f.x, z: f.z, nx: f.nx, nz: f.nz, w, name, style });
        lastB = f.b.id;
        lastD = d;
      }
    }
  }
  const atlas = signAtlas(signSpots.map((s) => ({ name: s.name, style: s.style })));
  const murals = muralAtlas();

  // --- heroes ------------------------------------------------------------------------------------------------
  if (data.heroes.church) christChurch(kits, data.heroes.church);
  const market = data.heroes.market ? marketHall(kits, data.heroes.market, atlas) : null;
  if (data.heroes.station) liverpoolStreet(kits, data.heroes.station, atlas);
  // Truman's chimney (OSM man_made=chimney, 49 m) and the bridge across Brick Lane by the Boiler House
  let bridge = { x: 186, z: -205, dx: 1, dz: 0, span: 13 };
  for (const s of brick) {
    const c = closestOnStreet(s, 186, -205);
    if (c[2] < 10) {
      // bridge crosses the lane: along the street's normal
      const i = s.points.findIndex((p, k) => k < s.points.length - 1 && Math.min(p[1], s.points[k + 1][1]) <= c[1] && Math.max(p[1], s.points[k + 1][1]) >= c[1]);
      const a = s.points[Math.max(0, i)];
      const b = s.points[Math.max(1, i + 1)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      bridge = { x: c[0], z: c[1], dx: (b[1] - a[1]) / l, dz: -(b[0] - a[0]) / l, span: s.width + 3 };
    }
  }
  trumanBrewery(kits, atlas, [207, -161], bridge);
  // the Banglatown arch over Brick Lane's south end, by Osborn Street
  for (const s of brick) {
    const path = polyline(s.points);
    for (let d = 0; d < path.length; d += 2) {
      path.at(d, 0, pt);
      if (Math.hypot(pt.x - 262, pt.z + 646) < 3) {
        banglaArch(kits, atlas, { x: pt.x, z: pt.z, dx: pt.dx, dz: pt.dz, span: s.width + 1.6 });
        d = Infinity;
      }
    }
  }
  minaret(kits, [182.4, -436.6]);

  // --- curry-house fascias, lit shop windows, neon ----------------------------------------------------------
  for (const sp of signSpots) {
    const [x, z] = toScene(sp.x, sp.z);
    const nx = sp.nx;
    const nz = -sp.nz; // scene normal
    const rot = Math.atan2(nx, nz); // kit local +z out of the facade, +x along it
    const k = kits.solid.frame(x + nx * 0.16, z + nz * 0.16, rot);
    k.block(sp.w + 0.3, 1.25, 0.26, 0, 3.0, 0, sp.style.bg);
    k.block(sp.w, 2.35, 0.06, 0, 0.35, 0.02, "#26323b"); // shop window glass
    k.block(sp.w + 0.3, 0.35, 0.3, 0, 0, 0, "#3a3a3a"); // stall riser
    const g = kits.glow.frame(x + nx * 0.16, z + nz * 0.16, rot);
    g.block(sp.w - 0.2, 2.2, 0.04, 0, 0.42, 0.07, "#ffd9a0"); // lit window
    const neon = new Color(sp.style.fg);
    const hex = `#${neon.getHexString()}`;
    for (const [w, h, px, py] of [
      [sp.w + 0.2, 0.07, 0, 4.3],
      [sp.w + 0.2, 0.07, 0, 2.95],
      [0.07, 1.4, -(sp.w / 2 + 0.1), 3.62],
      [0.07, 1.4, sp.w / 2 + 0.1, 3.62],
    ] as const)
      g.block(w, h, 0.07, px, py, 0.17, hex);
    kits.signs.add(x + nx * 0.3, 3.62, z + nz * 0.3, nx, nz, sp.w, sp.w / (512 / 112) > 1.15 ? 1.15 : sp.w / (512 / 112), atlas.sign(sp.name, sp.style));
  }
  kits.solid.frame(0, 0, 0);
  kits.glow.frame(0, 0, 0);

  // --- street art on the side streets (Hanbury, Princelet, Fashion, Brick Lane's upper walls) ---------------
  const muralQuads = new Quads();
  const artStreets: { s: Street; y0: number; every: number }[] = [
    ...streetsNamed(map, "Hanbury Street").map((s) => ({ s, y0: 0.6, every: 13 })),
    ...streetsNamed(map, "Princelet Street").map((s) => ({ s, y0: 0.6, every: 16 })),
    ...streetsNamed(map, "Fashion Street").map((s) => ({ s, y0: 0.6, every: 15 })),
    ...streetsNamed(map, "Buxton Street").map((s) => ({ s, y0: 0.6, every: 17 })),
    ...streetsNamed(map, "Quaker Street").map((s) => ({ s, y0: 0.6, every: 15 })),
    ...brick.map((s) => ({ s, y0: 4.6, every: 19 })),
  ];
  for (const { s, y0, every } of artStreets) {
    const path = polyline(s.points);
    for (const side of [-1, 1])
      for (let d = 5 + r() * 6; d < path.length; d += every * (0.8 + r() * 0.6)) {
        path.at(d, 0, pt);
        if (!inArea(pt.x, pt.z) || (s.name === "Brick Lane" && (pt.z < -330 || pt.z > -60))) continue;
        if (s.name === "Hanbury Street" && pt.x > 460) continue;
        if (r() < 0.25) continue;
        const nx = pt.dz * side;
        const nz = -pt.dx * side;
        const f = castToFacade(map, pt.x, pt.z, nx, nz, 14);
        if (!f || f.room < 1.8 || f.b.h < y0 + 3) continue;
        const w = Math.min(9, 2 * f.room - 0.6);
        const h = Math.min(f.b.h - y0 - 1, w * (0.6 + r() * 0.5), 8);
        if (h < 2) continue;
        const [x, z] = toScene(f.x, f.z);
        const tile: UvRect = murals.tiles[Math.floor(r() * murals.tiles.length)];
        muralQuads.add(x + f.nx * 0.13, y0 + h / 2, z - f.nz * 0.13, f.nx, -f.nz, w, h, tile);
      }
  }

  // --- ground: OSM parks, churchyards, squares, car parks ------------------------------------------------------
  const groundParts: BufferGeometry[] = [];
  for (const a of data.areas) {
    const st = AREA_STYLE[a.k];
    if (!st) continue;
    const ring = a.r.map(([x, z]) => toScene(x, z));
    const shade = new Color(st.hex).offsetHSL(0, 0, (r() - 0.5) * 0.04);
    const g = flatPolygon(ring, st.y, `#${shade.getHexString()}`);
    if (g) groundParts.push(g);
    // car parks get their bay lines
    if (a.k === "parking") {
      const xs = a.r.map((p) => p[0]);
      const zs = a.r.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const z0 = Math.min(...zs);
      const z1 = Math.max(...zs);
      for (let x = x0 + 2; x < x1 - 1; x += 2.5)
        for (const zc of [z0 + 3, z1 - 3])
          if (inRing(x, zc, a.r) && !inBuilding(x, zc, 0)) {
            const [sx, sz] = toScene(x, zc);
            groundParts.push(new Kit().frame(sx, sz, 0).box(0.1, 0.01, 4.8, 0, st.y + 0.006, 0, "#e8e2cf").build()!);
          }
    }
  }
  const ground = groundParts.length ? merge(groundParts) : null;

  // --- kerbs, Brick Lane's pavements, zebras: one instanced unit box, coloured per instance -------------------
  const strips: Inst[] = [];
  const KERB = new Color("#a9a7a1");
  const PAVE = new Color("#b4b6b9");
  const STRIPE = new Color("#ece8dc");
  const areaStreets = map.streets.filter((s) => s.width >= 6 && s.points.some(([x, z]) => inArea(x, z)));
  const narrow = (s: Street) => s.name === "Brick Lane";
  const PAVE_W = 1.9;
  const strip = (x: number, z: number, dx: number, dz: number, len: number, w: number, h: number, y: number, c: Color) => {
    const [px, pz] = toScene(x, z);
    o3.position.set(px, y, pz);
    o3.rotation.set(0, Math.atan2(dx, -dz), 0);
    o3.scale.set(w, h, len);
    o3.updateMatrix();
    strips.push({ m: o3.matrix.clone(), c });
  };
  const brickNarrow = (x: number, z: number) => inArea(x, z) && z < -60 && z > -665;
  for (const k of kerbRuns(map, areaStreets.filter((s) => !narrow(s)), () => -0.15)) strip(k.x, k.z, k.dx, k.dz, k.len, 0.3, 0.2, 0.1, KERB);
  for (const s of brick) {
    for (const k of kerbRuns(map, [s], () => PAVE_W / 2)) if (brickNarrow(k.x, k.z)) strip(k.x, k.z, k.dx, k.dz, k.len, PAVE_W, 0.19, 0.095, PAVE);
    for (const k of kerbRuns(map, [s], () => PAVE_W + 0.15)) if (brickNarrow(k.x, k.z)) strip(k.x, k.z, k.dx, k.dz, k.len, 0.3, 0.22, 0.11, KERB);
    for (const k of kerbRuns(map, [s], () => -0.15)) if (!brickNarrow(k.x, k.z)) strip(k.x, k.z, k.dx, k.dz, k.len, 0.3, 0.2, 0.1, KERB);
  }
  const crossingPts = data.points.filter((p) => p.k === "crossing").map((p) => p.p);
  for (const c of crossings(map, crossingPts)) {
    const isBrick = brick.some((s) => closestOnStreet(s, c.x, c.z)[2] < 1);
    const half = c.width / 2 - (isBrick ? PAVE_W : 0) - 0.3;
    const nx = c.dz;
    const nz = -c.dx;
    for (let a = -half + 0.3; a <= half - 0.3; a += 1.1) strip(c.x + nx * a, c.z + nz * a, c.dx, c.dz, 3, 0.55, 0.02, c.top + 0.012, STRIPE);
  }

  // --- trees, benches, bins, cycle stands, Santander docks --------------------------------------------------
  const trees: Inst[] = [];
  const benches: Inst[] = [];
  const bins: Inst[] = [];
  const stands: Inst[] = [];
  const bikes: Inst[] = [];
  const free = (x: number, z: number, pad = 0.3) => inArea(x, z) && !inBuilding(x, z, pad) && !onOtherRoad(map, x, z, null, pad);
  for (const p of data.points) {
    const [x, z] = p.p;
    if (p.k === "tree") {
      if (!free(x, z, 0.6)) continue;
      const s = 0.85 + r() * 0.45;
      const m = mat(x, z, Math.cos(r() * 6.28), Math.sin(r() * 6.28), 0, s);
      trees.push({ m, c: new Color().setHSL(0.22 + r() * 0.08, 0.25, 0.75 + r() * 0.25) });
    } else if (p.k === "bench" || p.k === "waste_basket") {
      if (!free(x, z, 0.4)) continue;
      const [dx, dz] = nearestStreetDir(map, x, z);
      (p.k === "bench" ? benches : bins).push({ m: mat(x, z, dz, -dx) });
    } else if (p.k === "bicycle_parking" || p.k === "bicycle_rental") {
      if (!free(x, z, 0.5)) continue;
      const [dx, dz] = nearestStreetDir(map, x, z);
      const dock = p.k === "bicycle_rental";
      const n = dock ? 9 : 2;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * (dock ? 0.85 : 1.0);
        const sx = x + dx * off;
        const sz = z + dz * off;
        if (!free(sx, sz, 0.2)) continue;
        // stands across the kerb line (local x along the stand); bikes parked along them
        stands.push({ m: mat(sx, sz, dx, dz, 0, 1, dock ? 0.5 : 1, dock ? 1.25 : 1, 1) });
        if (r() < (dock ? 0.75 : 0.6)) bikes.push({ m: mat(sx + dx * 0.25, sz + dz * 0.25, dx, dz), c: dock ? SANTANDER : BIKE_COLORS[Math.floor(r() * BIKE_COLORS.length)] });
      }
    }
  }

  // --- Banglatown lamps along Brick Lane's south half ------------------------------------------------------
  const lamps: Inst[] = [];
  for (const s of brick) {
    const path = polyline(s.points);
    let k = 0;
    for (let d = 6; d < path.length; d += 22) {
      path.at(d, 0, pt);
      if (pt.z > -300 || pt.z < -660 || !inArea(pt.x, pt.z)) continue;
      const side = k++ % 2 ? 1 : -1;
      const off = s.width / 2 - PAVE_W + 0.45;
      const x = pt.x + pt.dz * side * off;
      const z = pt.z - pt.dx * side * off;
      if (onOtherRoad(map, x, z, s, 0.5)) continue;
      lamps.push({ m: mat(x, z, -pt.dz * side, pt.dx * side) });
    }
  }

  // --- market stalls -------------------------------------------------------------------------------------------
  const stalls: StallInst[] = [];
  const awning = () => AWNINGS[Math.floor(r() * AWNINGS.length)];
  const walkers: Walker[] = [];
  const toContract = (sx: number, sz: number): [number, number] => [sx, -sz];
  if (market) {
    const { cx, cz, len, width, spans } = market;
    const sw = width / spans;
    // hall frame: local x → scene (0, -1) (north), local z → scene (1, 0)
    const L = (x: number, z: number): [number, number] => toContract(cx + z, cz - x);
    const hallGreen = new Color("#2f6b4f");
    for (let i = 0; i < spans; i++) {
      const zc = -width / 2 + (i + 0.5) * sw;
      let n = 0;
      for (let x = -len / 2 + 3; x < len / 2 - 2; x += 2.9) {
        if (++n % 7 === 0) continue; // cross aisle
        for (const e of [-1, 1]) {
          const [px, pz] = L(x, zc + e * (sw / 2 - 1.7));
          // face the span's centre aisle: local -e*z → contract direction
          const [fx, fz] = [-e, 0];
          stalls.push({ m: mat(px, pz, fx, fz), c: r() < 0.6 ? hallGreen : awning(), group: "always" });
        }
      }
      // shoppers pace the centre aisle
      for (let k = 0; k < 34; k++) {
        const w = makeWalker("hall", [L(-len / 2 + 2, zc), L(len / 2 - 2, zc)], r, { lateral: (r() - 0.5) * 3, minLen: 8, maxLen: 35, speed: [0.7, 1.2], pause: [2, 8] });
        if (w) walkers.push(w);
      }
    }
    for (let k = 0; k < 24; k++) {
      const x = -len / 2 + 3 + Math.floor(r() * 10) * 2.9 * 7 + 2.9 * 6;
      const w = makeWalker("hall", [L(Math.min(len / 2 - 3, x), -width / 2 + 1), L(Math.min(len / 2 - 3, x), width / 2 - 1)], r, { lateral: (r() - 0.5) * 1.5, minLen: 10, maxLen: 50, speed: [0.9, 1.3], pause: [1, 4] });
      if (w) walkers.push(w);
    }
  }
  // Ely's Yard and the Truman yard (the Sunday Upmarket's food stalls), stalls round the edge facing in
  for (const a of data.areas.filter((x) => /Ely's Yard/.test(x.n ?? ""))) {
    const cxz = a.r.reduce((acc, p) => [acc[0] + p[0] / a.r.length, acc[1] + p[1] / a.r.length], [0, 0]);
    for (let i = 0; i < a.r.length; i++) {
      const p = a.r[i];
      const q = a.r[(i + 1) % a.r.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      for (let d = 1.6; d < l - 1.4; d += 3.1) {
        let x = p[0] + ((q[0] - p[0]) * d) / l;
        let z = p[1] + ((q[1] - p[1]) * d) / l;
        const fx = cxz[0] - x;
        const fz = cxz[1] - z;
        const fl = Math.hypot(fx, fz) || 1;
        x += (fx / fl) * 1.8;
        z += (fz / fl) * 1.8;
        if (!inRing(x, z, a.r) || inBuilding(x, z, 0.4)) continue;
        stalls.push({ m: mat(x, z, fx / fl, fz / fl), c: awning(), group: "always" });
      }
    }
    for (let k = 0; k < 70; k++) {
      const a0 = a.r[Math.floor(r() * a.r.length)];
      const pts: [number, number][] = [
        [cxz[0] + (a0[0] - cxz[0]) * 0.55, cxz[1] + (a0[1] - cxz[1]) * 0.55],
        [cxz[0] - (a0[0] - cxz[0]) * 0.4, cxz[1] - (a0[1] - cxz[1]) * 0.4],
      ];
      const w = makeWalker("upmarket", pts, r, { lateral: (r() - 0.5) * 3, minLen: 5, maxLen: 30, speed: [0.6, 1.1], pause: [2, 9] });
      if (w) walkers.push(w);
    }
  }
  // Sunday: stalls down both sides of Brick Lane north, and the crowd fills the road
  for (const s of brick) {
    for (const run of clipped(s, (x, z) => inArea(x, z) && z > -330 && z < -70)) {
      const path = polyline(run);
      const lat = s.width / 2 - PAVE_W - 1.0;
      for (let d = 2; d < path.length - 2; d += 3.1) {
        for (const side of [-1, 1]) {
          path.at(d, side * lat, pt);
          if (onOtherRoad(map, pt.x, pt.z, s, 1.2)) continue;
          stalls.push({ m: mat(pt.x, pt.z, -pt.dz * side, pt.dx * side), c: awning(), group: "sunday" });
        }
      }
      for (let k = 0; k < 90; k++) {
        const w = makeWalker("sundayRoad", run, r, { lateral: (r() - 0.5) * 3.4, minLen: 15, maxLen: 80, speed: [0.6, 1.1], pause: [1, 6] });
        if (w) walkers.push(w);
      }
    }
  }
  // Petticoat Lane: Wentworth Street's stalls (Mon-Fri and Sunday mornings)
  for (const s of streetsNamed(map, "Wentworth Street")) {
    for (const run of clipped(s, (x, z) => inArea(x, z) && x < 90)) {
      const path = polyline(run);
      const lat = s.width / 2 - 1.1;
      for (let d = 2; d < path.length - 2; d += 3.0) {
        for (const side of [-1, 1]) {
          path.at(d, side * lat, pt);
          if (onOtherRoad(map, pt.x, pt.z, s, 1.2)) continue;
          stalls.push({ m: mat(pt.x, pt.z, -pt.dz * side, pt.dx * side), c: awning(), group: "petticoat" });
        }
      }
      for (let k = 0; k < 90; k++) {
        const w = makeWalker("petticoat", run, r, { lateral: (r() - 0.5) * 2.4, minLen: 10, maxLen: 60, speed: [0.6, 1.1], pause: [1, 6] });
        if (w) walkers.push(w);
      }
    }
  }

  // --- the rest of the crowd: Brick Lane, Commercial Street, Bishopsgate / Liverpool Street, the church -------
  const pavementWalkers = (zone: Zone, ss: Street[], n: number, test: (x: number, z: number) => boolean, offset: (s: Street) => number, smart = false) => {
    const runs = ss.flatMap((s) => clipped(s, test).map((run) => ({ s, run })));
    if (!runs.length) return;
    for (let k = 0; k < n; k++) {
      const { s, run } = runs[Math.floor(r() * runs.length)];
      const side = r() < 0.5 ? -1 : 1;
      const w = makeWalker(zone, run, r, { lateral: side * (offset(s) + (r() - 0.5) * 1.0), minLen: 30, maxLen: 160, speed: [1.1, 1.6], pause: [0, 2], smart });
      if (w) walkers.push(w);
    }
  };
  pavementWalkers("bricklane", brick, 200, (x, z) => inArea(x, z) && z < -60, (s) => s.width / 2 - PAVE_W / 2);
  pavementWalkers("commercial", streetsNamed(map, "Commercial Street"), 130, (x, z) => inArea(x, z), (s) => s.width / 2 + 2.2);
  pavementWalkers("commute", [...streetsNamed(map, "Bishopsgate"), ...streetsNamed(map, "Liverpool Street"), ...streetsNamed(map, "Primrose Street"), ...streetsNamed(map, "Sun Street")], 200, (x, z) => inArea(x, z), (s) => s.width / 2 + 2.2, true);
  if (data.heroes.church) {
    const c = data.heroes.church;
    const x0 = Math.min(...c.map((p) => p[0]));
    for (let k = 0; k < 26; k++) {
      const still = r() < 0.55;
      const z = -460 + (r() - 0.5) * 12;
      const pts: [number, number][] = still ? [[x0 - 0.5 - r() * 4, z], [x0 - 1 - r() * 4, z + 0.5]] : [[x0 - 8, -449 + r() * 2], [x0 + 70, -480 - r() * 20]];
      const w = makeWalker("church", pts, r, { lateral: 0, minLen: 1, maxLen: 60, still, speed: [0.9, 1.3], pause: [2, 10] });
      if (w) walkers.push(w);
    }
  }

  const finish = (k: Kit) => k.build();
  return {
    solid: finish(kits.solid),
    stone: finish(kits.stone),
    glass: finish(kits.glass),
    glow: finish(kits.glow),
    signs: kits.signs.build(),
    murals: muralQuads.build(),
    signTex: atlas.texture,
    muralTex: murals.texture,
    ground,
    strips,
    trees,
    benches,
    bins,
    stands,
    bikes,
    lamps,
    stalls,
    walkers,
  };
}

type Built = ReturnType<typeof build>;

function fillInst(mesh: InstancedMesh | null, list: Inst[]) {
  if (!mesh) return;
  list.forEach((it, i) => {
    mesh.setMatrixAt(i, it.m);
    if (it.c) mesh.setColorAt(i, it.c);
  });
  mesh.count = list.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.raycast = noRaycast;
}

export default function Spitalfields() {
  const { map } = useWorld();
  const [data, setData] = useState<AreaData | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${import.meta.env.BASE_URL}areas/spitalfields.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => live && d && setData(d as AreaData))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const built = useMemo(() => (data ? build(map, data) : null), [map, data]);
  if (!built) return null;
  return <SpitalfieldsScene built={built} />;
}

function SpitalfieldsScene({ built }: { built: Built }) {
  const mats = useMemo(() => {
    const solid = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
    const stone = new MeshStandardMaterial({ vertexColors: true, roughness: 0.78, emissive: new Color("#ffe3b5"), emissiveIntensity: 0 });
    const glass = new MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.42, depthWrite: false, side: DoubleSide });
    const glow = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const signs = new MeshStandardMaterial({ map: built.signTex, emissiveMap: built.signTex, emissive: new Color("#ffffff"), emissiveIntensity: 0.08, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
    const murals = new MeshStandardMaterial({ map: built.muralTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 });
    const ground = new MeshStandardMaterial({ vertexColors: true, roughness: 0.97, polygonOffset: true, polygonOffsetFactor: -1 });
    const plain = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
    const strips = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.9 });
    const lantern = new MeshStandardMaterial({ color: "#fff4d6", emissive: new Color("#ffc857"), emissiveIntensity: 0, toneMapped: false });
    const awning = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: DoubleSide });
    return { solid, stone, glass, glow, signs, murals, ground, plain, strips, lantern, awning };
  }, [built]);
  const geos = useMemo(
    () => ({
      unit: new BoxGeometry(1, 1, 1),
      tree: treeGeometry(),
      bench: benchGeometry(),
      bin: binGeometry(),
      stand: standGeometry(),
      bike: bikeGeometry(),
      lamp: banglaLampGeometry(),
      lantern: banglaLanternGeometry(),
      stall: stallFrameGeometry(),
      awning: stallAwningGeometry(),
    }),
    [],
  );
  useEffect(
    () => () => {
      Object.values(geos).forEach((g) => g.dispose());
      Object.values(mats).forEach((m: Material) => m.dispose());
      for (const g of [built.solid, built.stone, built.glass, built.glow, built.signs, built.murals, built.ground]) g?.dispose();
      built.signTex.dispose();
      built.muralTex.dispose();
    },
    [geos, mats, built],
  );

  // people
  const people = useMemo(() => createPeople(built.walkers.length, { emissive: 0.08 }), [built]);
  useEffect(() => () => people.dispose(), [people]);
  const glowRef = useRef<Group>(null);
  const stallRefs = useRef<{ frame: InstancedMesh | null; awning: InstancedMesh | null; key: string }>({ frame: null, awning: null, key: "" });
  const pt = useMemo(newPoint, []);

  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const h = hourOf(t);
    const wd = weekdayOf(t);
    const n = nightLevel(h);
    mats.stone.emissiveIntensity = n * 0.32;
    mats.signs.emissiveIntensity = 0.08 + n * 0.95;
    mats.lantern.emissiveIntensity = n * 2.4;
    mats.glow.color.setScalar(Math.min(1, n * 1.25));
    if (glowRef.current) glowRef.current.visible = n > 0.03;

    // stalls up only on their market days
    const sunday = wd === 6 && h >= 8 && h < 18;
    const petticoat = (wd <= 4 || wd === 6) && h >= 7.5 && h < 15;
    const key = `${sunday}|${petticoat}`;
    const sr = stallRefs.current;
    if (sr.frame && sr.awning && sr.key !== key) {
      sr.key = key;
      const list = built.stalls.filter((s) => s.group === "always" || (s.group === "sunday" && sunday) || (s.group === "petticoat" && petticoat));
      fillInst(sr.frame, list.map((s) => ({ m: s.m })));
      fillInst(sr.awning, list);
    }

    // crowd
    const time = clock.elapsedTime;
    const share: Record<Zone, number> = {
      hall: turnout("hall", wd, h),
      upmarket: turnout("upmarket", wd, h),
      sundayRoad: turnout("sundayRoad", wd, h),
      bricklane: turnout("bricklane", wd, h),
      petticoat: turnout("petticoat", wd, h),
      commute: turnout("commute", wd, h),
      commercial: turnout("commercial", wd, h),
      church: turnout("church", wd, h),
    };
    let k = 0;
    for (let i = 0; i < built.walkers.length; i++) {
      const w = built.walkers[i];
      if (w.rank >= share[w.zone]) continue;
      const p = pace(w, time);
      w.path.at(p.s, w.lateral, pt);
      const [x, z] = toScene(pt.x, pt.z);
      const hx = pt.dx * p.dir;
      const hz = pt.dz * p.dir;
      people.set(k++, x, 0, z, Math.atan2(hx, -hz), time * 6.5 * (w.speed / 1.3) + i, p.moving, w.scale, w.shirt, w.trousers, w.skin);
    }
    people.commit(k);
  });

  return (
    <group name="spitalfields">
      {built.ground && <mesh geometry={built.ground} material={mats.ground} receiveShadow raycast={noRaycast} />}
      {built.solid && <mesh geometry={built.solid} material={mats.solid} castShadow receiveShadow raycast={noRaycast} />}
      {built.stone && <mesh geometry={built.stone} material={mats.stone} castShadow receiveShadow raycast={noRaycast} name="christ-church" />}
      {built.glass && <mesh geometry={built.glass} material={mats.glass} raycast={noRaycast} renderOrder={2} />}
      <group ref={glowRef}>{built.glow && <mesh geometry={built.glow} material={mats.glow} raycast={noRaycast} />}</group>
      {built.signs && <mesh geometry={built.signs} material={mats.signs} raycast={noRaycast} />}
      {built.murals && <mesh geometry={built.murals} material={mats.murals} raycast={noRaycast} receiveShadow />}
      <instancedMesh args={[geos.unit, mats.strips, Math.max(1, built.strips.length)]} ref={(m) => fillInst(m, built.strips)} receiveShadow />
      <instancedMesh args={[geos.tree, mats.plain, Math.max(1, built.trees.length)]} ref={(m) => fillInst(m, built.trees)} castShadow />
      <instancedMesh args={[geos.bench, mats.plain, Math.max(1, built.benches.length)]} ref={(m) => fillInst(m, built.benches)} />
      <instancedMesh args={[geos.bin, mats.plain, Math.max(1, built.bins.length)]} ref={(m) => fillInst(m, built.bins)} />
      <instancedMesh args={[geos.stand, mats.plain, Math.max(1, built.stands.length)]} ref={(m) => fillInst(m, built.stands)} />
      <instancedMesh args={[geos.bike, mats.plain, Math.max(1, built.bikes.length)]} ref={(m) => fillInst(m, built.bikes)} />
      <instancedMesh args={[geos.lamp, mats.plain, Math.max(1, built.lamps.length)]} ref={(m) => fillInst(m, built.lamps)} castShadow />
      <instancedMesh args={[geos.lantern, mats.lantern, Math.max(1, built.lamps.length)]} ref={(m) => fillInst(m, built.lamps)} />
      <instancedMesh
        args={[geos.stall, mats.plain, Math.max(1, built.stalls.length)]}
        ref={(m) => {
          stallRefs.current.frame = m;
          stallRefs.current.key = "";
        }}
        castShadow
      />
      <instancedMesh
        args={[geos.awning, mats.awning, Math.max(1, built.stalls.length)]}
        ref={(m) => {
          stallRefs.current.awning = m;
          stallRefs.current.key = "";
          // the colour buffer must exist before the first compile so the material picks up per-instance tints
          if (m && !m.instanceColor) m.setColorAt(0, AWNINGS[0]);
        }}
        castShadow
      />
      <primitive object={people.group} name="spitalfields-people" />
    </group>
  );
}
