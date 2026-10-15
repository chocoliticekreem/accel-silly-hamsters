// Module: Cyclists (decorative). London on two wheels: commuters in hi-vis, Santander and Lime hire bikes,
// Deliveroo and Uber Eats riders, road cyclists, couriers and the odd cargo bike, riding the real streets with a
// strong stream along Old Street / Great Eastern Street → past the art'otel → up Pitfield Street to Encode Hub →
// on to Hoxton, the Old Street and City Road cycle lanes, and the Shoreditch High Street ↔ Old Street link.
// Ambience, not data: never feeds a KPI.
//
// Routes: Dijkstra over the street graph (map.streets) with real OSM cycle lanes (public/areas/cycle.json) made
// cheaper, so riders take the lanes where they exist. Everyone keeps left, in the painted lane on main roads or a
// little out from the kerb on side streets: never mid-road (Traffic's cars drive at width/4 from the centre line).
// Behaviour: intelligent-driver following of whatever is ahead (other bikes, cars, people crossing), slowing for
// junctions and giving way to moving traffic there, overtaking slower bikes only where the road is wide enough,
// ringing the bell when stuck. Counts follow the sim clock (rush-hour peaks, delivery peaks at lunch and dinner,
// sparse at night with lights on); motion runs on real seconds so it is smooth at 1×, 10× and 100×.
// Docks: the real Santander docking stations (OSM amenity=bicycle_rental) with racks of red bikes; hire riders
// take a bike from one and return it to another. Extras: Critical Mass on Friday evenings (?cyclists=mass forces
// a wave), a weekend club ride, couriers weaving, blinking lights at night, bikes chained along Pitfield Street
// and Rivington Street and at the real Sheffield stands.
// Draw calls: 3 (all standard bikes incl. parked ones, cargo bikes, and one merged mesh of docks/stands/paint).
// Click a rider for a small card (type, from → to).
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CityMap } from "../../api/contract";
import { rng, type Rng } from "../../mock/rng";
import { obstacles, pavementPath, type PavementPath } from "../../sim/crowd";
import { toScene } from "../../sim/geometry";
import { newPoint } from "../../sim/polyline";
import { nightLevel } from "../../sim/sky";
import { dayOf, hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { createBikeMesh, FLAG, type BikeAttrs } from "../cycling/bikeModel";
import { buildNetwork, loadCycleData, storeDoors, type CycleData, type Dock, type Network, type Route } from "../cycling/network";
import { useWorld } from "../context";
import { groundY } from "../ground";
import { trafficVehicles } from "../physics/traffic";

// ---------------------------------------------------------------- riders

type Kind = "commuter" | "roadie" | "santander" | "lime" | "deliveroo" | "ubereats" | "courier" | "cargo" | "mass" | "club";

const LABEL: Record<Kind, string> = {
  commuter: "Commuter",
  roadie: "Road cyclist",
  santander: "Santander Cycles hire",
  lime: "Lime e-bike",
  deliveroo: "Deliveroo rider",
  ubereats: "Uber Eats rider",
  courier: "Bike courier",
  cargo: "Cargo bike",
  mass: "Critical Mass",
  club: "Club ride",
};

/** Desired speed (m/s): [base, random extra]. */
const SPEED: Record<Kind, [number, number]> = {
  commuter: [4.6, 1.6],
  roadie: [6.0, 1.3],
  santander: [3.9, 1.0],
  lime: [4.8, 1.0],
  deliveroo: [5.2, 1.4],
  ubereats: [5.2, 1.4],
  courier: [7.0, 1.0],
  cargo: [3.8, 0.8],
  mass: [3.9, 0.5],
  club: [6.2, 0.4],
};

const MAX_RIDING = 300;
const MAX_CARGO = 24;
const PARKED_CAP = 900;

interface Plan {
  route: Route;
  path: PavementPath;
  cum: Float32Array;
  from: string;
  to: string;
}

interface Rider {
  id: number;
  gen: number;
  active: boolean;
  kind: Kind;
  cargo: boolean;
  slot: number;
  plan: Plan;
  s: number;
  v: number;
  v0: number;
  inset: number;
  baseInset: number;
  insetTarget: number;
  weave: number;
  wheel: number;
  crank: number;
  lean: number;
  h: number;
  x: number;
  z: number;
  fx: number;
  fz: number;
  fade: number;
  leaving: boolean;
  shy: number;
  blocked: number;
  bell: number;
  bellCool: number;
  overtake: number;
  jIdx: number;
  jWait: number;
  dockTo: Dock | null;
  brakeAtEnd: boolean;
  blink: boolean;
  phase: number;
  pack: boolean;
  colors: [Color, Color, Color, Color];
  skin: number;
  flags: number;
}

// colours
const C = (s: string) => new Color(s);
const HIVIS = [C("#d4ee1a"), C("#e6f53a"), C("#ff8a1f")];
const JACKETS = ["#2b2f3a", "#3b4a5c", "#5a4a3c", "#1f3b2c", "#6b6f76", "#8a2f2f", "#2d4f7a", "#c9c3b8", "#111214"].map(C);
const JERSEYS = ["#e8322b", "#1d6fd8", "#f3c613", "#ffffff", "#ff5fa2", "#12a37f", "#141414", "#ff7a00", "#7a3cff"].map(C);
const TROUSERS = ["#24262c", "#2f3a52", "#3c3f45", "#4a3b2f", "#1b1c1f", "#5d6672"].map(C);
const FRAMES = ["#1b1c1f", "#2d4f7a", "#7d8790", "#e9e9e6", "#3d5a3a", "#8a1f2b", "#0f7f8a", "#c4a35a"].map(C);
const ROAD_FRAMES = ["#ffffff", "#d01c1f", "#111111", "#1f5fd0", "#e8e000", "#202a33"].map(C);
const HELMETS = ["#f2f2f2", "#1a1a1a", "#d01c1f", "#1d6fd8", "#ffd400"].map(C);
const SANTANDER = C("#d8261e");
const LIME = C("#2fcf3a");
const DELIVEROO = C("#00ccbc");
const UBER_GREEN = C("#06c167");
const BLACK = C("#151515");
const WOOD = C("#b98a55");
const BOX_COLORS = ["#b98a55", "#2b6e4f", "#e9e4d8", "#1f4f7a"].map(C);

const pickC = (r: Rng, xs: Color[]) => xs[Math.floor(r() * xs.length)];

function dress(r: Rng, k: Kind, out: Rider) {
  const [frame, top, legs, accent] = out.colors;
  let flags = FLAG.rider;
  frame.copy(pickC(r, FRAMES));
  top.copy(pickC(r, JACKETS));
  legs.copy(pickC(r, TROUSERS));
  accent.copy(pickC(r, HELMETS));
  if (r() < 0.6) flags |= FLAG.helmet;
  switch (k) {
    case "commuter":
      if (r() < 0.55) {
        top.copy(pickC(r, HIVIS));
        flags |= FLAG.hivis;
      }
      if (r() < 0.3) flags |= FLAG.helmet;
      break;
    case "roadie":
    case "club":
      frame.copy(pickC(r, ROAD_FRAMES));
      top.copy(pickC(r, JERSEYS));
      legs.copy(BLACK);
      flags |= FLAG.helmet | FLAG.tuck;
      break;
    case "santander":
      frame.copy(SANTANDER);
      flags |= FLAG.basket;
      if (r() < 0.75) flags &= ~FLAG.helmet;
      break;
    case "lime":
      frame.copy(LIME);
      flags |= FLAG.basket;
      if (r() < 0.8) flags &= ~FLAG.helmet;
      break;
    case "deliveroo":
      frame.copy(r() < 0.5 ? BLACK : pickC(r, FRAMES));
      top.copy(DELIVEROO);
      accent.copy(DELIVEROO);
      flags |= FLAG.box | FLAG.helmet;
      break;
    case "ubereats":
      frame.copy(r() < 0.5 ? BLACK : pickC(r, FRAMES));
      top.copy(BLACK);
      accent.copy(UBER_GREEN);
      flags |= FLAG.box | FLAG.helmet;
      break;
    case "courier":
      frame.copy(pickC(r, [BLACK, C("#ff3b30"), C("#00a8ff"), C("#f5f5f5")]));
      top.copy(pickC(r, [BLACK, C("#3d4b2a"), C("#ff6b00")]));
      flags |= FLAG.tuck;
      if (r() < 0.5) flags &= ~FLAG.helmet;
      break;
    case "cargo":
      frame.copy(pickC(r, [BLACK, C("#2b5d3b"), C("#7a8a96")]));
      accent.copy(pickC(r, BOX_COLORS));
      break;
    case "mass":
      frame.copy(pickC(r, [...FRAMES, ...ROAD_FRAMES, SANTANDER, LIME]));
      top.copy(pickC(r, [...JERSEYS, ...HIVIS]));
      if (r() < 0.12) {
        frame.copy(SANTANDER);
        flags |= FLAG.basket;
      }
      break;
  }
  if (k === "cargo") accent.copy(r() < 0.6 ? WOOD : pickC(r, BOX_COLORS));
  out.flags = flags;
  out.skin = r() ** 1.3;
}

// ---------------------------------------------------------------- the clock

const gauss = (h: number, mu: number, sigma: number) => Math.exp(-0.5 * ((h - mu) / sigma) ** 2);

/** Share of the peak commuter flow out at this hour. */
function commuteLevel(h: number, weekend: boolean) {
  if (weekend) return 0.05 + 0.4 * gauss(h, 11.5, 2.2) + 0.25 * gauss(h, 15.5, 2) + (h > 22 || h < 5 ? -0.02 : 0);
  const night = h < 5.5 || h > 23.5 ? 0.04 : 0;
  return Math.max(night, 0.05 + 1.0 * gauss(h, 8.7, 0.55) + 0.9 * gauss(h, 18.2, 0.65) + 0.22 * gauss(h, 13, 2.5) + 0.12 * gauss(h, 21, 1.5));
}

/** Share of the peak delivery riders out: lunch and dinner. */
function deliveryLevel(h: number, weekend: boolean) {
  const late = h < 1 ? 0.25 : h < 10 ? 0.04 : 0.1;
  return late + 0.85 * gauss(h, 12.8, 0.8) + (weekend ? 1.15 : 1.0) * gauss(h, 19.6, 1.2);
}

const PEAK_RIDERS = 170;
const PEAK_DELIVERY = 34;

// ---------------------------------------------------------------- places and flows

type Place = { name: string; x: number; z: number };

function places(map: CityMap): Record<string, Place> {
  const lm = (re: RegExp, fx: number, fz: number) => {
    const l = map.landmarks?.find((m) => re.test(m.name));
    return { x: l?.x ?? fx, z: l?.z ?? fz };
  };
  const p = (name: string, x: number, z: number): Place => ({ name, x, z });
  const enc = lm(/encode/i, -645, 481);
  const art = lm(/art.?otel/i, -601, 339);
  const shs = lm(/^shoreditch high st/i, -41, 1);
  return {
    oldStW: p("Old Street (Clerkenwell)", -1050, 239),
    cityRdN: p("City Road (Angel)", -1050, 496),
    cityRdS: p("City Road (Moorgate)", -870, -187),
    eastRd: p("East Road", -840, 750),
    roundabout: p("Old Street roundabout", -880, 262),
    gesS: p("Great Eastern Street", -240, -30),
    oldStE: p("Old Street / Kingsland Road", -248, 437),
    pitN: p("Pitfield Street (Hoxton)", -595, 750),
    encode: p("Encode Hub, Pitfield Street", enc.x, enc.z),
    artotel: p("art'otel, Old Street", art.x - 30, art.z + 2),
    hoxtonSt: p("Hoxton Street", -396, 750),
    kingsland: p("Kingsland Road (Dalston)", -200, 750),
    shsS: p("Bishopsgate (Liverpool Street)", -282, -197),
    shsStn: p("Shoreditch High Street station", Math.min(shs.x, -150), 40),
    bgrE: p("Bethnal Green Road", 700, 361),
    commS: p("Commercial Street (Aldgate)", 112, -750),
    bishops: p("Bishopsgate (City)", -475, -750),
    hackney: p("Hackney Road", 8, 750),
    hoxSq: p("Hoxton Square", -460, 453),
  };
}

/** [from, to, via, weight]; every flow also runs in reverse. */
const FLOWS: [string, string, string[], number][] = [
  // the corridor: Great Eastern St / Old St → art'otel → Pitfield St → Encode Hub → Hoxton
  ["gesS", "pitN", ["artotel", "encode"], 11],
  ["roundabout", "pitN", ["artotel", "encode"], 7],
  ["oldStW", "encode", ["artotel"], 4],
  ["hoxtonSt", "roundabout", ["hoxSq", "encode", "artotel"], 3],
  // Old Street and City Road cycle lanes
  ["oldStW", "oldStE", [], 8],
  ["cityRdN", "oldStE", [], 5],
  ["cityRdS", "cityRdN", ["roundabout"], 4],
  ["cityRdS", "oldStE", ["roundabout"], 3],
  // Shoreditch High St ↔ Old Street
  ["shsStn", "roundabout", ["gesS", "artotel"], 6],
  ["shsStn", "encode", ["gesS", "artotel"], 3],
  // north-south and the rest
  ["kingsland", "shsS", [], 5],
  ["bishops", "kingsland", [], 3],
  ["eastRd", "oldStE", [], 2],
  ["bgrE", "oldStW", [], 3],
  ["commS", "cityRdN", [], 2],
  ["hackney", "bishops", [], 2],
];

const MASS_VIA = ["oldStW", "roundabout", "artotel", "oldStE", "shsStn", "gesS", "artotel", "encode", "pitN"];
const CLUB_VIA = ["bgrE", "shsStn", "gesS", "artotel", "roundabout", "cityRdN"];

function makePlan(route: Route, from: string, to: string): Plan {
  const n = route.points.length;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(route.points[i][0] - route.points[i - 1][0], route.points[i][1] - route.points[i - 1][1]);
  // pavementPath puts the line `inset` beyond half the given width: give it twice the bike-line offset
  const path = pavementPath(route.points, route.offsets.map((o) => o * 2));
  return { route, path, cum, from, to };
}

/** Width of the street at distance s along a plan. */
function widthAt(p: Plan, s: number) {
  const { cum, route } = p;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return route.widths[Math.min(lo, route.widths.length - 1)] ?? 8;
}

// ---------------------------------------------------------------- the world model

interface ParkedBike {
  x: number;
  z: number;
  h: number;
  color: Color;
  basket: boolean;
  dock: number; // index into docks, or -1
  order: number; // position in the dock row
}

interface DockState extends Dock {
  bikes: number;
  reserved: number;
  /** Kerbside point riders leave from / arrive at (contract). */
  kx: number;
  kz: number;
  slots: number;
}

interface CycleWorld {
  net: Network;
  plans: { plan: Plan; weight: number }[];
  places: Record<string, Place>;
  docks: DockState[];
  parked: ParkedBike[];
  stores: { name: string; x: number; z: number }[];
  staticGeo: BufferGeometry | null;
  planCache: Map<string, Plan | null>;
}

function insideBuilding(map: CityMap, x: number, z: number, pad = 0.3) {
  for (const b of map.buildings) if (Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad) return true;
  return false;
}

/** Static furniture: dock terminals and posts, railings, Sheffield stands, painted cycle lanes. */
class StaticBuilder {
  parts: BufferGeometry[] = [];
  private col = new Color();
  add(g: BufferGeometry, color: string) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute("uv");
    const n = geo.getAttribute("position").count;
    this.col.set(color);
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = this.col.r;
      c[i * 3 + 1] = this.col.g;
      c[i * 3 + 2] = this.col.b;
    }
    geo.setAttribute("color", new BufferAttribute(c, 3));
    this.parts.push(geo);
  }
  /** A box at scene (x, y, z) rotated by heading h. */
  box(w: number, hgt: number, l: number, x: number, y: number, z: number, h: number, color: string) {
    this.add(new BoxGeometry(w, hgt, l).rotateY(h).translate(x, y, z), color);
  }
  build() {
    if (!this.parts.length) return null;
    const g = mergeGeometries(this.parts, false);
    this.parts.forEach((p) => p.dispose());
    return g;
  }
}

function buildWorld(map: CityMap, data: CycleData): CycleWorld {
  const net = buildNetwork(map, data);
  const P = places(map);
  const plans: CycleWorld["plans"] = [];
  for (const [a, b, via, w] of FLOWS) {
    const pts = [a, ...via, b].map((k) => [P[k].x, P[k].z] as [number, number]);
    const fwd = net.route(pts);
    if (fwd && fwd.length > 60) plans.push({ plan: makePlan(fwd, P[a].name, P[b].name), weight: w });
    const back = net.route([...pts].reverse());
    if (back && back.length > 60) plans.push({ plan: makePlan(back, P[b].name, P[a].name), weight: w });
  }
  const r = rng(1919);
  const { bounds } = map;
  const inMap = (x: number, z: number, m = 0) => x > bounds.minX - m && x < bounds.maxX + m && z > bounds.minZ - m && z < bounds.maxZ + m;
  const sb = new StaticBuilder();
  const parked: ParkedBike[] = [];
  const docks: DockState[] = [];

  // Santander docking stations: a terminal and a row of posts along the kerb, bikes nose-in on the pavement
  for (const d of data.docks) {
    if (!inMap(d.x, d.z, -5)) continue;
    const k = net.kerb(d.x, d.z, 0.45);
    if (!k) continue;
    const [kx, kz, dx, dz] = k;
    if (insideBuilding(map, kx, kz, 0.1)) continue;
    const slots = d.kind === "bay" ? Math.min(6, Math.max(3, d.capacity)) : Math.min(22, Math.max(6, d.capacity));
    // the side of the street the dock is on: away from the street centre
    const kerbIn = net.kerb(d.x, d.z, -1.2);
    const ox = kerbIn ? kx - kerbIn[0] : 0;
    const oz = kerbIn ? kz - kerbIn[1] : 1;
    const on = Math.hypot(ox, oz) || 1;
    const nx = ox / on;
    const nz = oz / on;
    const di = docks.length;
    const ds: DockState = { ...d, bikes: Math.round(slots * (0.45 + r() * 0.4)), reserved: 0, kx: kerbIn ? kerbIn[0] : kx, kz: kerbIn ? kerbIn[1] : kz, slots };
    docks.push(ds);
    const [sx, sz] = toScene(kx, kz);
    const rowH = Math.atan2(dx, -dz); // scene heading of the street direction
    const faceH = Math.atan2(-nx, nz); // bikes face the road: scene heading of (-n) in contract → scene (−nx, +nz)
    const spacing = d.kind === "bay" ? 1.0 : 0.85;
    const half = ((slots - 1) * spacing) / 2;
    if (d.kind === "santander") {
      // terminal at one end of the row
      const tx = kx - dx * (half + 1.2);
      const tz = kz - dz * (half + 1.2);
      const [tsx, tsz] = toScene(tx, tz);
      sb.box(0.5, 1.7, 0.35, tsx, 0.85, tsz, rowH, "#2c2f33");
      sb.box(0.52, 0.32, 0.37, tsx, 1.55, tsz, rowH, "#d8261e");
      sb.box(0.3, 0.22, 0.05, tsx + Math.sin(faceH) * 0.18, 1.15, tsz + Math.cos(faceH) * 0.18, faceH, "#9fd0ff");
      // base rail
      sb.box(0.22, 0.06, slots * spacing + 0.4, sx, 0.03, sz, rowH, "#3a3d42");
    }
    for (let i = 0; i < slots; i++) {
      const along = -half + i * spacing;
      const px = kx + dx * along;
      const pz = kz + dz * along;
      const [psx, psz] = toScene(px, pz);
      if (d.kind === "santander") sb.box(0.12, 0.75, 0.16, psx, 0.375, psz, rowH, "#5d6268");
      // the bike stands nose-in to its post, body on the pavement side
      const bx = px + nx * 0.95;
      const bz = pz + nz * 0.95;
      const [bsx, bsz] = toScene(bx, bz);
      parked.push({ x: bsx, z: bsz, h: faceH, color: d.kind === "bay" ? LIME : SANTANDER, basket: true, dock: di, order: i });
    }
  }

  // railings with bikes chained to them along Pitfield Street and Rivington Street
  for (const s of map.streets) {
    if (!/^(Pitfield Street|Rivington Street)$/.test(s.name) || s.width < 5) continue;
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx2, bz2] = s.points[i + 1];
      const len = Math.hypot(bx2 - ax, bz2 - az);
      const dx = (bx2 - ax) / (len || 1);
      const dz = (bz2 - az) / (len || 1);
      for (let at = 8; at < len - 8; at += 22 + r() * 14) {
        const side = r() < 0.5 ? 1 : -1;
        const off = s.width / 2 + 0.55;
        const cx = ax + dx * at + dz * off * side;
        const cz = az + dz * at - dx * off * side;
        if (insideBuilding(map, cx, cz, 0.6)) continue;
        const [csx, csz] = toScene(cx, cz);
        const h = Math.atan2(dx, -dz);
        const L = 5 + r() * 3;
        sb.box(0.05, 0.05, L, csx, 1.0, csz, h, "#1f2a24");
        sb.box(0.04, 0.04, L, csx, 0.45, csz, h, "#1f2a24");
        for (let k = 0; k <= Math.floor(L / 1.0); k++) {
          const a = -L / 2 + k * (L / Math.floor(L / 1.0));
          const [qx, qz] = toScene(cx + dx * a, cz + dz * a);
          sb.box(0.04, 1.05, 0.04, qx, 0.525, qz, h, "#1f2a24");
        }
        const nBikes = 1 + Math.floor(r() * 3);
        for (let k = 0; k < nBikes; k++) {
          const a = -L / 2 + 1.1 + k * 1.9 + r() * 0.3;
          if (a > L / 2 - 0.8) break;
          // parked on the pavement side of the railing, facing along the street
          const px = cx + dx * a + dz * 0.33 * side;
          const pz = cz + dz * a - dx * 0.33 * side;
          const [psx, psz] = toScene(px, pz);
          parked.push({ x: psx, z: psz, h: h + (r() < 0.5 ? Math.PI : 0), color: pickC(r, [...FRAMES, ...ROAD_FRAMES]), basket: r() < 0.15, dock: -1, order: 0 });
        }
      }
    }
  }

  // Sheffield stands at the real OSM bicycle_parking nodes in the map (a sample), with a bike or two
  let stands = 0;
  for (const pk of data.parking) {
    if (stands >= 140 || !inMap(pk.x, pk.z, -5) || insideBuilding(map, pk.x, pk.z, 0.4)) continue;
    const k = net.kerb(pk.x, pk.z, 0);
    if (!k) continue;
    const [, , dx, dz, w] = k;
    // a stand inside the carriageway (a misplaced OSM point) would be in everyone's way: skip it
    const centre = net.kerb(pk.x, pk.z, -w / 2);
    if (!centre || Math.hypot(centre[0] - pk.x, centre[1] - pk.z) < w / 2 + 0.4) continue;
    stands++;
    const [sx, sz] = toScene(pk.x, pk.z);
    const h = Math.atan2(dx, -dz);
    sb.box(0.05, 0.85, 0.05, sx + Math.sin(h) * 0.35, 0.42, sz + Math.cos(h) * 0.35, h, "#8b9096");
    sb.box(0.05, 0.85, 0.05, sx - Math.sin(h) * 0.35, 0.42, sz - Math.cos(h) * 0.35, h, "#8b9096");
    sb.box(0.05, 0.05, 0.75, sx, 0.85, sz, h, "#8b9096");
    const n = r() < 0.35 ? 0 : r() < 0.6 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const side = i === 0 ? 1 : -1;
      parked.push({
        x: sx + Math.cos(h) * 0.32 * side,
        z: sz - Math.sin(h) * 0.32 * side,
        h: h + (r() < 0.5 ? Math.PI : 0),
        color: pickC(r, [...FRAMES, ...ROAD_FRAMES]),
        basket: r() < 0.1,
        dock: -1,
        order: 0,
      });
    }
  }

  // painted cycle lanes (OSM cycleway=lane) where they run along one of the map's streets
  for (const l of data.lanes) {
    if (l.kind !== "lane") continue;
    for (let i = 0; i < l.points.length - 1; i++) {
      const [ax, az] = l.points[i];
      const [bx2, bz2] = l.points[i + 1];
      const mx = (ax + bx2) / 2;
      const mz = (az + bz2) / 2;
      if (!inMap(mx, mz)) continue;
      const k = net.kerb(mx, mz, 0);
      if (!k || Math.hypot(k[0] - mx, k[1] - mz) > k[4] / 2 + 3) continue;
      const w = k[4];
      if (w < 7) continue;
      const len = Math.hypot(bx2 - ax, bz2 - az);
      if (len < 2) continue;
      const dx = (bx2 - ax) / len;
      const dz = (bz2 - az) / len;
      const h = Math.atan2(dx, -dz);
      const sides = l.side === "both" || l.side === "own" ? [1, -1] : l.side === "left" ? [-1] : [1];
      for (const sd of sides) {
        const off = (w / 2 - 1.15) * sd;
        const [px, pz] = toScene(mx + dz * off, mz - dx * off);
        sb.box(1.5, 0.02, len, px, 0.035, pz, h, "#3f8a62");
        // the white line on its outer edge
        const off2 = (w / 2 - 1.95) * sd;
        const [qx, qz] = toScene(mx + dz * off2, mz - dx * off2);
        sb.box(0.12, 0.021, len, qx, 0.037, qz, h, "#e8e8e2");
      }
    }
  }

  return {
    net,
    plans,
    places: P,
    docks,
    parked: parked.slice(0, PARKED_CAP),
    stores: storeDoors(map),
    staticGeo: sb.build(),
    planCache: new Map(),
  };
}

// ---------------------------------------------------------------- spatial hash

class Hash {
  head = new Int32Array(4096);
  next: Int32Array;
  constructor(cap: number) {
    this.next = new Int32Array(cap);
  }
  static key(x: number, z: number) {
    return ((Math.floor(x / 8) * 73856093) ^ (Math.floor(z / 8) * 19349663)) & 4095;
  }
  clear() {
    this.head.fill(-1);
  }
  add(i: number, x: number, z: number) {
    const k = Hash.key(x, z);
    this.next[i] = this.head[k];
    this.head[k] = i;
  }
}

// ---------------------------------------------------------------- the module

const A_MAX = 1.1;
const B_COMF = 1.8;
const S0 = 1.1;
const T_HEAD = 0.8;
const pt = newPoint();
const m4 = new Matrix4();
const pos = new Vector3();
const quat = new Quaternion();
const eul = new Euler(0, 0, 0, "YXZ");
const scl = new Vector3();
const projV = new Vector3();
const UP = new Vector3(0, 1, 0);

interface Picked {
  id: number;
  gen: number;
  kind: Kind;
  from: string;
  to: string;
}

export default function Cyclists() {
  const { map, interactive } = useWorld();
  const [data, setData] = useState<CycleData | null>(null);
  useEffect(() => {
    let alive = true;
    loadCycleData().then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, []);
  if (!data) return null;
  return <CyclistsLayer map={map} data={data} interactive={interactive} />;
}

function CyclistsLayer({ map, data, interactive }: { map: CityMap; data: CycleData; interactive: boolean }) {
  const world = useMemo(() => buildWorld(map, data), [map, data]);
  const { gl, camera } = useThree();
  const [picked, setPicked] = useState<Picked | null>(null);
  const cardRef = useRef<Group>(null);
  const forceMass = useMemo(() => new URLSearchParams(window.location.search).get("cyclists") === "mass", []);

  const gfx = useMemo(() => {
    const std = createBikeMesh("standard", MAX_RIDING + world.parked.length);
    const cargo = createBikeMesh("cargo", MAX_CARGO);
    std.mesh.count = MAX_RIDING + world.parked.length;
    cargo.mesh.count = MAX_CARGO;
    std.mesh.name = "cyclists";
    cargo.mesh.name = "cargo-bikes";
    const zero = new Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < std.mesh.count; i++) std.mesh.setMatrixAt(i, zero);
    for (let i = 0; i < MAX_CARGO; i++) cargo.mesh.setMatrixAt(i, zero);
    const staticMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.15, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const staticMesh = world.staticGeo ? new Mesh(world.staticGeo, staticMat) : null;
    if (staticMesh) {
      staticMesh.receiveShadow = true;
      staticMesh.name = "cycle-furniture";
    }
    // parked bikes: riderless instances after the riding pool
    const setC = (a: BikeAttrs, i: number, key: keyof BikeAttrs, c: Color, w: number) => a[key].setXYZW(i, c.r, c.g, c.b, w);
    world.parked.forEach((p, k) => {
      const i = MAX_RIDING + k;
      setC(std.attrs, i, "frame", p.color, 0);
      setC(std.attrs, i, "top", p.color, p.basket ? FLAG.basket : 0);
      setC(std.attrs, i, "legs", p.color, 0);
      setC(std.attrs, i, "accent", p.color, 0);
      std.attrs.anim.setXYZW(i, 0, Math.PI * 0.3, 0, 0);
    });
    return { std, cargo, staticMesh, staticMat };
  }, [world]);

  useEffect(
    () => () => {
      gfx.std.mesh.geometry.dispose();
      (gfx.std.mesh.material as MeshStandardMaterial).dispose();
      gfx.cargo.mesh.geometry.dispose();
      (gfx.cargo.mesh.material as MeshStandardMaterial).dispose();
      gfx.staticMesh?.geometry.dispose();
      gfx.staticMat.dispose();
    },
    [gfx],
  );

  // the fleet
  const sim = useMemo(() => {
    const riders: Rider[] = [];
    const total = MAX_RIDING + MAX_CARGO;
    let stdSlot = 0;
    let cargoSlot = 0;
    for (let i = 0; i < total; i++) {
      const cargo = i >= MAX_RIDING;
      riders.push({
        id: i,
        gen: 0,
        active: false,
        kind: "commuter",
        cargo,
        slot: cargo ? cargoSlot++ : stdSlot++,
        plan: undefined as unknown as Plan,
        s: 0,
        v: 0,
        v0: 5,
        inset: 0,
        baseInset: 0,
        insetTarget: 0,
        weave: 0,
        wheel: 0,
        crank: 0,
        lean: 0,
        h: 0,
        x: 0,
        z: 0,
        fx: 0,
        fz: 1,
        fade: 0,
        leaving: false,
        shy: 0,
        blocked: 0,
        bell: 0,
        bellCool: 0,
        overtake: 0,
        jIdx: 0,
        jWait: 0,
        dockTo: null,
        brakeAtEnd: false,
        blink: false,
        phase: 0,
        pack: false,
        colors: [new Color(), new Color(), new Color(), new Color()],
        skin: 0,
        flags: 0,
      });
    }
    return {
      riders,
      r: rng(4242),
      hash: new Hash(total),
      carHash: new Hash(1024),
      pedHash: new Hash(4000),
      packQueue: [] as { kind: Kind; plan: Plan; inset: number }[],
      lastMassDay: -1,
      lastClubDay: -1,
      massTimer: 0,
      time: 0,
      parkedDirty: true,
    };
  }, []);

  const routeCached = (key: string, via: [number, number][], from: string, to: string) => {
    if (world.planCache.has(key)) return world.planCache.get(key) ?? null;
    const route = world.net.route(via);
    const plan = route && route.length > 40 ? makePlan(route, from, to) : null;
    world.planCache.set(key, plan);
    return plan;
  };

  const spawn = (kind: Kind, plan: Plan, opts?: { inset?: number; pack?: boolean; dockTo?: DockState | null; brakeAtEnd?: boolean }) => {
    const cargo = kind === "cargo";
    const r = sim.r;
    const rd = sim.riders.find((x) => !x.active && x.cargo === cargo);
    if (!rd) return null;
    // the start must be clear
    plan.path.at(0, -1, 0, pt);
    const [sx, sz] = toScene(pt.x, pt.z);
    for (const o of sim.riders) if (o.active && Math.abs(o.x - sx) < 3.5 && Math.abs(o.z - sz) < 3.5) return null;
    rd.active = true;
    rd.gen++;
    rd.kind = kind;
    rd.plan = plan;
    rd.s = 0;
    const [base, extra] = SPEED[kind];
    rd.v0 = base + r() * extra;
    rd.v = rd.v0 * 0.6;
    rd.baseInset = opts?.inset ?? -0.25 + r() * 0.4;
    rd.inset = rd.baseInset;
    rd.insetTarget = rd.baseInset;
    rd.weave = r() * 10;
    rd.fade = 0;
    rd.leaving = false;
    rd.shy = r();
    rd.blocked = 0;
    rd.bell = 0;
    rd.bellCool = 0;
    rd.overtake = 0;
    rd.jIdx = 0;
    rd.jWait = 0;
    rd.dockTo = opts?.dockTo ?? null;
    rd.brakeAtEnd = opts?.brakeAtEnd ?? false;
    rd.blink = r() < 0.55;
    rd.phase = r() * 6;
    rd.pack = opts?.pack ?? false;
    rd.lean = 0;
    rd.h = Math.atan2(pt.dx, -pt.dz);
    rd.x = sx;
    rd.z = sz;
    dress(r, kind, rd);
    const a = (cargo ? gfx.cargo : gfx.std).attrs;
    const [fc, tc, lc, ac] = rd.colors;
    a.frame.setXYZW(rd.slot, fc.r, fc.g, fc.b, rd.skin);
    a.top.setXYZW(rd.slot, tc.r, tc.g, tc.b, rd.flags);
    a.legs.setXYZW(rd.slot, lc.r, lc.g, lc.b, 0);
    a.accent.setXYZW(rd.slot, ac.r, ac.g, ac.b, 0);
    return rd;
  };

  const docksWithBikes = () => world.docks.filter((d) => d.kind === "santander" && d.bikes > 0);

  const trySpawn = (kind: Kind) => {
    const r = sim.r;
    if (kind === "santander") {
      const from = docksWithBikes();
      if (!from.length) return null;
      const a = from[Math.floor(r() * from.length)];
      const free = world.docks.filter((d) => d !== a && d.kind === "santander" && d.bikes + d.reserved < d.slots && Math.hypot(d.x - a.x, d.z - a.z) > 250);
      if (!free.length) return null;
      const b = free[Math.floor(r() * free.length)];
      const plan = routeCached(`dock:${a.name}:${b.name}`, [[a.kx, a.kz], [b.kx, b.kz]], `Santander dock: ${a.name}`, `Santander dock: ${b.name}`);
      if (!plan) return null;
      const rd = spawn(kind, plan, { dockTo: b, brakeAtEnd: true });
      if (rd) {
        a.bikes--;
        b.reserved++;
        sim.parkedDirty = true;
      }
      return rd;
    }
    if (kind === "deliveroo" || kind === "ubereats") {
      const st = world.stores[Math.floor(r() * world.stores.length)];
      if (!st) return null;
      // to a flat somewhere a few hundred metres away
      const ang = r() * Math.PI * 2;
      const dist = 250 + r() * 450;
      const tx = Math.max(map.bounds.minX + 20, Math.min(map.bounds.maxX - 20, st.x + Math.cos(ang) * dist));
      const tz = Math.max(map.bounds.minZ + 20, Math.min(map.bounds.maxZ - 20, st.z + Math.sin(ang) * dist));
      const node = world.net.nearestNode(tx, tz);
      const [nx, nz] = world.net.graph.nodes[node];
      const plan = routeCached(`del:${st.name}:${node}`, [[st.x, st.z], [nx, nz]], `Pickup: ${st.name}`, `Drop-off: ${world.net.streetName(nx, nz) || "a flat nearby"}`);
      if (!plan) return null;
      return spawn(kind, plan, { brakeAtEnd: true });
    }
    // everyone else: a weighted flow
    const total = world.plans.reduce((s, p) => s + p.weight, 0);
    let x = r() * total;
    for (const p of world.plans) if ((x -= p.weight) <= 0) return spawn(kind, p.plan);
    return null;
  };

  // click a rider → card
  useEffect(() => {
    if (!interactive) return;
    const el = gl.domElement;
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent) => {
      down = [e.clientX, e.clientY];
    };
    const onClick = (e: MouseEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const rect = el.getBoundingClientRect();
      let best: Rider | null = null;
      let bestD = 18;
      for (const rd of sim.riders) {
        if (!rd.active || rd.fade < 0.5) continue;
        projV.set(rd.x, 1.1, rd.z).project(camera);
        if (projV.z > 1) continue;
        const d = Math.hypot(rect.left + ((projV.x + 1) / 2) * rect.width - e.clientX, rect.top + ((1 - projV.y) / 2) * rect.height - e.clientY);
        if (d < bestD) {
          bestD = d;
          best = rd;
        }
      }
      if (!best) return;
      setPicked({ id: best.id, gen: best.gen, kind: best.kind, from: best.plan.from, to: best.plan.to });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicked(null);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [interactive, gl, camera, sim]);

  const pickedRef = useRef<Picked | null>(null);
  pickedRef.current = picked;

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    sim.time += dt;
    const t = useSim.getState().t;
    const hour = hourOf(t);
    const day = dayOf(t);
    const weekday = (day - 1) % 7;
    const weekend = weekday >= 5;
    const night = nightLevel(hour);
    const lightsOn = night > 0.3;
    const r = sim.r;
    const riders = sim.riders;

    // ---- how many should be out
    const commute = commuteLevel(hour, weekend);
    const delivery = deliveryLevel(hour, weekend);
    const want: Partial<Record<Kind, number>> = {
      commuter: PEAK_RIDERS * commute * (weekend ? 0.3 : 0.5),
      roadie: PEAK_RIDERS * commute * (weekend ? 0.3 : 0.11),
      santander: PEAK_RIDERS * commute * (weekend ? 0.22 : 0.16),
      lime: PEAK_RIDERS * commute * 0.12,
      courier: hour > 8 && hour < 19 && !weekend ? 4 : 0,
      cargo: PEAK_RIDERS * commute * 0.04,
      deliveroo: PEAK_DELIVERY * delivery * 0.55,
      ubereats: PEAK_DELIVERY * delivery * 0.45,
    };
    const have: Partial<Record<Kind, number>> = {};
    for (const rd of riders) if (rd.active && !rd.leaving) have[rd.kind] = (have[rd.kind] ?? 0) + 1;
    let budget = 4;
    for (const k of Object.keys(want) as Kind[]) {
      const target = want[k] ?? 0;
      const n = have[k] ?? 0;
      if (n < Math.round(target) && budget > 0) {
        budget--;
        trySpawn(k);
      } else if (n > target * 1.3 + 2) {
        // the clock has moved on: the shyest riders head off
        const ratio = target / n;
        for (const rd of riders) if (rd.active && rd.kind === k && !rd.pack && !rd.leaving && rd.shy > ratio * 1.15) rd.leaving = true;
      }
    }

    // ---- Critical Mass: Friday evenings (or forced), the weekend club ride
    const isFriEve = weekday === 4 && hour >= 18.5 && hour < 21;
    sim.massTimer -= dt;
    if ((isFriEve && sim.lastMassDay !== day) || (forceMass && sim.massTimer <= 0)) {
      sim.lastMassDay = day;
      sim.massTimer = 90;
      const pts = MASS_VIA.map((k) => [world.places[k].x, world.places[k].z] as [number, number]);
      const plan = routeCached("mass", pts, "Old Street", "Hoxton (Critical Mass)");
      if (plan) {
        sim.packQueue.push({ kind: "cargo", plan, inset: 0 });
        for (let i = 0; i < 56; i++) sim.packQueue.push({ kind: "mass", plan, inset: i % 2 ? -0.95 : 0 });
      }
    }
    if (weekend && hour >= 7.5 && hour < 9.5 && sim.lastClubDay !== day) {
      sim.lastClubDay = day;
      const pts = CLUB_VIA.map((k) => [world.places[k].x, world.places[k].z] as [number, number]);
      const plan = routeCached("club", pts, "Bethnal Green Road", "City Road (club run)");
      if (plan) for (let i = 0; i < 16; i++) sim.packQueue.push({ kind: "club", plan, inset: i % 2 ? -0.85 : 0 });
    }
    if (sim.packQueue.length) {
      const q = sim.packQueue[0];
      const w = widthAt(q.plan, 0);
      const rd = spawn(q.kind, q.plan, { pack: true, inset: w >= 12 ? q.inset : 0 });
      if (rd) {
        sim.packQueue.shift();
        if (q.kind === "mass" || q.kind === "cargo") rd.v0 = 4.0 + r() * 0.3;
        if (q.kind === "cargo") {
          rd.colors[3].set("#ff2fa0");
          gfx.cargo.attrs.accent.setXYZ(rd.slot, 1, 0.18, 0.63);
        }
      }
    }

    // ---- spatial hashes: bikes, cars, people
    sim.hash.clear();
    for (const rd of riders) if (rd.active) sim.hash.add(rd.id, rd.x, rd.z);
    sim.carHash.clear();
    const cars = trafficVehicles;
    const nCars = Math.min(cars.length, 1024);
    for (let i = 0; i < nCars; i++) if (cars[i].shown) sim.carHash.add(i, cars[i].x, cars[i].z);
    sim.pedHash.clear();
    const nPed = Math.min(obstacles.n, 4000);
    for (let i = 0; i < nPed; i++) sim.pedHash.add(i, obstacles.xs[i], obstacles.zs[i]);

    // ---- step everyone
    for (const me of riders) {
      if (!me.active) continue;
      const plan = me.plan;
      const L = plan.route.length;
      const fx = me.fx;
      const fz = me.fz;
      let gap = Infinity;
      let leadV = 0;
      let leadBike: Rider | null = null;
      // look ahead around a point 7 m in front
      const qx = me.x + fx * 7;
      const qz = me.z + fz * 7;
      const cx0 = Math.floor(qx / 8);
      const cz0 = Math.floor(qz / 8);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          const k = (((cx0 + i) * 73856093) ^ ((cz0 + j) * 19349663)) & 4095;
          for (let o = sim.hash.head[k]; o >= 0; o = sim.hash.next[o]) {
            if (o === me.id) continue;
            const ot = riders[o];
            const rx = ot.x - me.x;
            const rz = ot.z - me.z;
            const along = rx * fx + rz * fz;
            if (along <= 0 || along > 16) continue;
            const lat = Math.abs(rx * fz - rz * fx);
            if (lat > 0.8) continue;
            const g = along - (ot.cargo || me.cargo ? 2.4 : 1.9);
            if (g < gap) {
              gap = g;
              const cos = ot.fx * fx + ot.fz * fz;
              leadV = Math.max(0, ot.v * cos);
              leadBike = cos > 0.6 ? ot : null;
            }
          }
          for (let o = sim.carHash.head[k]; o >= 0; o = sim.carHash.next[o]) {
            const car = cars[o];
            const rx = car.x - me.x;
            const rz = car.z - me.z;
            const along = rx * fx + rz * fz;
            if (along <= -car.length / 2 || along > 18) continue;
            const lat = Math.abs(rx * fz - rz * fx);
            if (lat > car.width / 2 + 0.55) continue;
            const g = along - car.length / 2 - 1.2;
            if (g < gap) {
              gap = g;
              const chx = Math.sin(car.heading);
              const chz = Math.cos(car.heading);
              leadV = Math.max(0, car.speed * (chx * fx + chz * fz));
              leadBike = null;
            }
          }
          for (let o = sim.pedHash.head[k]; o >= 0; o = sim.pedHash.next[o]) {
            const rx = obstacles.xs[o] - me.x;
            const rz = obstacles.zs[o] - me.z;
            const along = rx * fx + rz * fz;
            if (along <= 0 || along > 12) continue;
            if (Math.abs(rx * fz - rz * fx) > 0.75) continue;
            const g = along - 1.0;
            if (g < gap) {
              gap = g;
              leadV = 0;
              leadBike = null;
            }
          }
        }
      const physGap = gap;

      // junctions: slow for them, give way to moving traffic
      let vCap = me.v0 * (1 + 0.05 * Math.sin(sim.time * 0.4 + me.phase));
      const js = plan.route.junctions;
      while (me.jIdx < js.length && js[me.jIdx].s < me.s - 1) {
        me.jIdx++;
        me.jWait = 0;
      }
      const jn = js[me.jIdx];
      if (jn) {
        const dist = jn.s - me.s;
        const vTurn = 2.6 + (1 - jn.turn) * 3.2;
        vCap = Math.min(vCap, Math.sqrt(vTurn * vTurn + 2 * 1.1 * Math.max(0, dist - 2)));
        if (dist > 2.5 && dist < 11 && me.jWait < 6 && !me.pack) {
          const [jx, jz] = toScene(jn.x, jn.z);
          let busy = false;
          for (let i = -1; i <= 1 && !busy; i++)
            for (let j = -1; j <= 1 && !busy; j++) {
              const k = Hash.key(jx + i * 8, jz + j * 8);
              for (let o = sim.carHash.head[k]; o >= 0 && !busy; o = sim.carHash.next[o]) {
                const car = cars[o];
                if (car.speed < 1.2 || Math.abs(car.x - jx) > 11 || Math.abs(car.z - jz) > 11) continue;
                const cos = Math.sin(car.heading) * fx + Math.cos(car.heading) * fz;
                if (Math.abs(cos) < 0.75) busy = true;
              }
            }
          if (busy) {
            me.jWait += dt;
            gap = Math.min(gap, dist - 3.5);
            leadV = 0;
          }
        }
      }
      // arriving at a dock / a door: brake to a stop
      if (me.brakeAtEnd) {
        const toEnd = L - me.s - 0.5;
        if (toEnd < gap) {
          gap = toEnd;
          leadV = 0;
        }
      }
      // the intelligent driver model
      const s = Math.max(0.05, gap);
      const dv = me.v - leadV;
      const sStar = S0 + Math.max(0, me.v * T_HEAD + (me.v * dv) / (2 * Math.sqrt(A_MAX * B_COMF)));
      const v0 = Math.max(0.5, vCap);
      let acc = A_MAX * (1 - (me.v / v0) ** 4 - (gap === Infinity ? 0 : (sStar / s) ** 2));
      acc = Math.max(-6, acc);
      if (me.leaving) acc = Math.min(acc, 0);
      me.v = Math.max(0, Math.min(me.v + acc * dt, v0 * 1.05));
      let adv = me.v * dt;
      if (physGap !== Infinity) adv = Math.min(adv, Math.max(0, physGap - 0.25));
      me.s += adv;

      // stuck behind a slower bike: overtake where the road is wide, else ring the bell
      me.overtake = Math.max(0, me.overtake - dt);
      me.bellCool = Math.max(0, me.bellCool - dt);
      me.bell = Math.max(0, me.bell - dt * 2.2);
      const w = widthAt(plan, me.s);
      if (leadBike && physGap < 7 && leadBike.v < me.v0 - 0.7 && !me.pack) {
        me.blocked += dt;
        const nearJ = jn ? jn.s - me.s < 18 : false;
        if (w >= 12 && !nearJ && me.overtake <= 0) me.overtake = 3.5;
        else if (me.blocked > 1.4 && me.bellCool <= 0) {
          me.bell = 1;
          me.bellCool = 4 + r() * 3;
        }
      } else me.blocked = Math.max(0, me.blocked - dt);
      if (me.pack && me.bellCool <= 0 && r() < dt * 0.15) {
        me.bell = 1;
        me.bellCool = 3;
      }
      // lateral line: base, couriers weave, overtakers pull out (only on wide roads)
      let target = me.baseInset;
      if (me.kind === "courier" && w >= 12) target += -0.3 + 0.35 * Math.sin(sim.time * 1.3 + me.weave);
      if (me.overtake > 0 && w >= 12) target -= 1.05;
      if (w < 12) target = Math.max(target, -0.3);
      me.insetTarget = target;
      const dl = me.insetTarget - me.inset;
      me.inset += Math.sign(dl) * Math.min(Math.abs(dl), 0.8 * dt);

      // wheels and cranks (freewheel when not pushing)
      me.wheel = (me.wheel + (me.v / 0.34) * dt) % (Math.PI * 2);
      if (me.v > 0.3 && acc > -0.4) me.crank = (me.crank + ((me.v / 0.34) / 2.6) * dt) % (Math.PI * 2);

      // fades and arrival
      if (me.leaving) me.fade -= dt / 1.2;
      else me.fade = Math.min(1, me.fade + dt / 0.7);
      const arrived = me.s >= L - (me.brakeAtEnd ? 0.8 : 2) && (!me.brakeAtEnd || me.v < 0.4 || me.s >= L - 0.6);
      if (arrived && !me.leaving) {
        me.leaving = true;
        if (me.dockTo) {
          const d = me.dockTo as DockState;
          d.reserved = Math.max(0, d.reserved - 1);
          d.bikes = Math.min(d.slots, d.bikes + 1);
          me.dockTo = null;
          sim.parkedDirty = true;
          me.fade = Math.min(me.fade, 0.4);
        }
      }
      if (me.leaving && me.fade <= 0) {
        me.active = false;
        if (me.dockTo) {
          (me.dockTo as DockState).reserved = Math.max(0, (me.dockTo as DockState).reserved - 1);
          me.dockTo = null;
        }
        continue;
      }

      // pose
      plan.path.at(Math.min(me.s, L), -1, me.inset, pt);
      const [x, z] = toScene(pt.x, pt.z);
      const h = Math.atan2(pt.dx, -pt.dz);
      let dh = h - me.h;
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      const omega = dt > 0 ? dh / dt : 0;
      const leanT = Math.max(-0.42, Math.min(0.42, -Math.atan((me.v * omega) / 9.81)));
      me.lean += (leanT - me.lean) * Math.min(1, dt * 6);
      me.h = h;
      me.x = x;
      me.z = z;
      me.fx = Math.sin(h);
      me.fz = Math.cos(h);
    }

    // ---- write instances
    const lampLevel = lightsOn ? 1 : 0.0;
    for (const rd of riders) {
      const g = rd.cargo ? gfx.cargo : gfx.std;
      if (!rd.active) {
        m4.makeScale(0, 0, 0);
        g.mesh.setMatrixAt(rd.slot, m4);
        continue;
      }
      const f = Math.max(0, Math.min(1, rd.fade));
      pos.set(rd.x, groundY(rd.x, rd.z), rd.z);
      eul.set(0, rd.h, rd.lean);
      quat.setFromEuler(eul);
      m4.compose(pos, quat, scl.setScalar(Math.max(0.001, f)));
      g.mesh.setMatrixAt(rd.slot, m4);
      const tail = lightsOn ? (rd.blink ? (Math.sin(sim.time * 12 + rd.phase) > 0 ? 1 : 0.08) : 0.75) : 0;
      g.attrs.anim.setXYZW(rd.slot, rd.wheel, rd.crank, tail, 0);
      g.attrs.legs.setW(rd.slot, lampLevel * (rd.pack && rd.blink ? 0.6 + 0.4 * Math.sin(sim.time * 7 + rd.phase) : 1));
      g.attrs.accent.setW(rd.slot, rd.bell);
    }

    // ---- parked bikes: docks show their current count
    if (sim.parkedDirty) {
      sim.parkedDirty = false;
      world.parked.forEach((p, k) => {
        const i = MAX_RIDING + k;
        const show = p.dock < 0 || p.order < world.docks[p.dock].bikes;
        if (!show) m4.makeScale(0, 0, 0);
        else {
          pos.set(p.x, groundY(p.x, p.z), p.z);
          quat.setFromAxisAngle(UP, p.h);
          m4.compose(pos, quat, scl.setScalar(1));
        }
        gfx.std.mesh.setMatrixAt(i, m4);
      });
    }

    for (const g of [gfx.std, gfx.cargo]) {
      g.mesh.instanceMatrix.needsUpdate = true;
      g.attrs.frame.needsUpdate = true;
      g.attrs.top.needsUpdate = true;
      g.attrs.legs.needsUpdate = true;
      g.attrs.accent.needsUpdate = true;
      g.attrs.anim.needsUpdate = true;
    }

    // ---- the card follows its rider
    const pk = pickedRef.current;
    if (pk && cardRef.current) {
      const rd = riders[pk.id];
      if (!rd.active || rd.gen !== pk.gen) setPicked(null);
      else cardRef.current.position.set(rd.x, 2.4, rd.z);
    }
  });

  return (
    <group name="cyclists">
      <primitive object={gfx.std.mesh} />
      <primitive object={gfx.cargo.mesh} />
      {gfx.staticMesh && <primitive object={gfx.staticMesh} />}
      {picked && (
        <group ref={cardRef}>
          <Html center distanceFactor={60} zIndexRange={[20, 0]} style={{ pointerEvents: "auto" }}>
            <div
              style={{
                background: "rgba(18,22,30,0.92)",
                color: "#f2f4f8",
                font: "12px/1.35 system-ui, sans-serif",
                padding: "8px 10px",
                borderRadius: 8,
                minWidth: 170,
                boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
                transform: "translateY(-46px)",
                whiteSpace: "nowrap",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                <strong style={{ fontSize: 13 }}>{LABEL[picked.kind]}</strong>
                <button
                  onClick={() => setPicked(null)}
                  aria-label="Close"
                  style={{ background: "none", border: 0, color: "#aab", cursor: "pointer", fontSize: 14, padding: 0 }}
                >
                  ×
                </button>
              </div>
              <div style={{ opacity: 0.85 }}>{picked.from}</div>
              <div style={{ opacity: 0.85 }}>→ {picked.to}</div>
              <div style={{ opacity: 0.55, fontSize: 10, marginTop: 3 }}>Ambient rider, not a sim agent</div>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}
