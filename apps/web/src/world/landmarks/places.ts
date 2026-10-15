// Quick-travel destinations (pure, no WebGL). A fixed list of Shoreditch places plus the map's clubs and stations,
// each resolved against the loaded map: a store with that name wins, then a backend landmark, then an OSM building at
// the real position (whose shell the interior replaces), else a free patch of ground near it. Contract coords
// (x east, z north, metres from Shoreditch High St station). Places outside the map bounds are clamped and flagged.
import type { Building, CityMap } from "../../api/contract";
import { closestOnStreet } from "../../sim/geometry";
import { infillPlanFor, planSite } from "../../sim/construction";
import { resolveLandmarks, type LandmarkKey, type ResolvedLandmark } from "../../sim/london";
import { XOYO } from "../clubs";
import { landmarkPlots } from "../models/plots";

/** Landmarks with a multi-floor interior (world/landmarks/floors). */
export type InteriorKey = "xoyo" | "encode" | "artotel" | "boxpark";

export interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface Place {
  key: string;
  name: string;
  /** Short line under the name (street, what it is). */
  sub: string;
  group: "places" | "clubs" | "stations";
  /** Where the camera looks (contract, clamped to the map bounds). */
  x: number;
  z: number;
  /** Height of the look-at point and camera distance for the travel shot. */
  y: number;
  dist: number;
  /** The real position lies outside the map bounds (the shot is clamped to the edge). */
  outside: boolean;
  interior?: InteriorKey;
  /** Sim store behind the place (clicking it / its occupancy), if any. */
  storeId?: string | null;
  /** Map building whose shell the interior replaces (hidden while open). */
  host?: Building | null;
  /** Footprint the interior is built on (the host's, or a free patch). */
  foot?: Footprint;
}

interface Spec {
  key: string;
  name: string;
  sub: string;
  /** Store name that stands for the place (XOYO is a sim club). */
  store?: RegExp;
  /** sim/london landmark key (backend landmark, or its fallback). */
  landmark?: LandmarkKey;
  /** Real position (contract) when neither the map nor the landmarks place it. */
  at: [number, number];
  dist: number;
  y?: number;
  interior?: InteriorKey;
  /** "building": take over the OSM building there; "free": the building, else find open ground of `size`. */
  host?: "building" | "free";
  size?: [number, number, number];
  /** Drawn past the map edge (Surroundings / OldStreet modules), so the shot goes there, not to the clamp. */
  drawnOutside?: boolean;
}

// Encode first: the hackathon venue is the hero of the bar
const SPECS: Spec[] = [
  { key: "encode", name: "Encode Hub", sub: "Hackathon venue · 41 Pitfield St", landmark: "encode", at: [-645, 481], dist: 130, interior: "encode", host: "building", size: [26, 19, 16] },
  { key: "xoyo", name: "XOYO", sub: "Club · 32–37 Cowper St", store: /^xoyo$/i, at: [XOYO.x, XOYO.z], dist: 120, interior: "xoyo", host: "building", size: [XOYO.w, XOYO.d, XOYO.h] },
  { key: "artotel", name: "art'otel", sub: "Hotel tower · Old St", landmark: "artotel", at: [-601, 339], dist: 150, y: 10, interior: "artotel", host: "building", size: [28, 22, 34] },
  { key: "oldstreet", name: "Old Street", sub: "Roundabout · Northern line", landmark: "oldstreet", at: [-880, 255], dist: 240, drawnOutside: true },
  { key: "boxpark", name: "Boxpark", sub: "Container mall · Bethnal Green Rd", landmark: "boxpark", at: [-124, 26], dist: 120, interior: "boxpark", host: "free", size: [40, 16, 6] },
  { key: "station", name: "Shoreditch High St", sub: "Overground station", store: undefined, at: [0, 0], dist: 200 },
  { key: "hoxton", name: "Hoxton", sub: "Overground station", at: [-82, 927], dist: 220, drawnOutside: true },
];

/** Interior keys in menu order (for tests and the stepper). */
export const INTERIOR_KEYS: InteriorKey[] = ["xoyo", "encode", "artotel", "boxpark"];

const HOSTABLE = new Set(["office", "residential"]);

/** The OSM building at (x, z): one whose footprint contains the point (3 m slack), else the nearest within 25 m. */
export function hostAt(map: CityMap, x: number, z: number): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of map.buildings) {
    if (!HOSTABLE.has(b.kind)) continue;
    const inside = Math.abs(b.x - x) <= b.w / 2 + 3 && Math.abs(b.z - z) <= b.d / 2 + 3;
    const d = Math.hypot(b.x - x, b.z - z) - (inside ? 1000 : 0);
    if (d < bestD && (inside || d < 25)) [best, bestD] = [b, d];
  }
  return best;
}

type Box = { x: number; z: number; w: number; d: number };
const overlaps = (a: Box, b: Box, pad: number) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + pad && Math.abs(a.z - b.z) < (a.d + b.d) / 2 + pad;

/** Open ground of w × d nearest (x, z): clear of buildings, infill, the construction site and street carriageways. */
export function freeSpot(map: CityMap, x: number, z: number, w: number, d: number): { x: number; z: number } {
  const R = 160;
  const near = (b: Box) => Math.abs(b.x - x) < R + b.w && Math.abs(b.z - z) < R + b.d;
  const blocks: Box[] = map.buildings.filter(near);
  try {
    blocks.push(...infillPlanFor(map).plots.filter((p) => p.h > 0 && near(p)));
    const site = planSite(map);
    if (site) blocks.push(site.rect);
  } catch {
    /* infill planning is decor; without it only buildings and streets count */
  }
  const streets = map.streets.filter((s) => s.points.some(([px, pz]) => Math.abs(px - x) < R * 1.5 && Math.abs(pz - z) < R * 1.5));
  const probes = (c: Box) => [
    [c.x, c.z],
    [c.x - c.w / 2, c.z - c.d / 2],
    [c.x + c.w / 2, c.z - c.d / 2],
    [c.x - c.w / 2, c.z + c.d / 2],
    [c.x + c.w / 2, c.z + c.d / 2],
    [c.x, c.z - c.d / 2],
    [c.x, c.z + c.d / 2],
    [c.x - c.w / 2, c.z],
    [c.x + c.w / 2, c.z],
  ];
  const clear = (c: Box) =>
    !blocks.some((b) => overlaps(c, b, 1.5)) &&
    !streets.some((s) => {
      const hw = s.width / 2 + 1.5;
      if (probes(c).some(([px, pz]) => closestOnStreet(s, px, pz)[2] < hw)) return true;
      // a street can cross the middle of a long box between probes: test its points too
      return s.points.some(([px, pz]) => Math.abs(px - c.x) < c.w / 2 + hw && Math.abs(pz - c.z) < c.d / 2 + hw);
    });
  const step = 4;
  for (let r = 0; r <= R; r += step) {
    // ring of candidates at Chebyshev radius r, nearest first
    const ring: [number, number][] = [];
    if (r === 0) ring.push([x, z]);
    else
      for (let k = -r; k <= r; k += step) ring.push([x + k, z - r], [x + k, z + r], [x - r, z + k], [x + r, z + k]);
    ring.sort((a, b) => Math.hypot(a[0] - x, a[1] - z) - Math.hypot(b[0] - x, b[1] - z));
    for (const [cx, cz] of ring) if (clear({ x: cx, z: cz, w, d })) return { x: cx, z: cz };
  }
  return { x, z };
}

function clampTo(map: CityMap, x: number, z: number) {
  const b = map.bounds;
  const cx = Math.max(b.minX + 10, Math.min(b.maxX - 10, x));
  const cz = Math.max(b.minZ + 10, Math.min(b.maxZ - 10, z));
  return { x: cx, z: cz, outside: x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ };
}

function resolveSpec(map: CityMap, s: Spec, lms: ResolvedLandmark[]): Place | null {
  const store = s.store ? map.stores.find((x) => s.store!.test(x.name)) : undefined;
  const storeB = store && map.buildings.find((b) => b.id === store.buildingId);
  const lm = s.landmark ? lms.find((l) => l.key === s.landmark) : undefined;
  const lmB = lm?.buildingId ? map.buildings.find((b) => b.id === lm.buildingId) : undefined;
  let host: Building | null = null;
  let foot: Footprint | undefined;
  let [x, z] = s.at;
  const [w, d, h] = s.size ?? [20, 20, 12];
  if (storeB) {
    [x, z] = [storeB.x, storeB.z];
    foot = storeB;
  } else if (lmB) {
    host = lmB;
    [x, z] = [lmB.x, lmB.z];
    foot = { x, z, w: lmB.w, d: lmB.d, h: Math.max(lmB.h, h) };
  } else {
    if (lm) [x, z] = [lm.x, lm.z];
    if (s.key === "station") {
      const ep = map.entryPoints.find((e) => e.kind === "station" && /shoreditch high/i.test(e.name ?? ""));
      if (ep) [x, z] = [ep.x, ep.z];
    }
    if (s.host) {
      host = hostAt(map, x, z);
      if (host) [x, z] = [host.x, host.z];
      else if (s.host === "free") [x, z] = Object.values(freeSpot(map, x, z, w, d)) as [number, number];
      foot = host ? { x, z, w: host.w, d: host.d, h: Math.max(host.h, h) } : { x, z, w, d, h };
    }
  }
  // the hero model's plot (world/models/plots) is the authority: the interior replaces that model
  const plot = s.interior ? landmarkPlots(map).find((pl) => pl.key === s.interior) : undefined;
  if (plot) {
    const xs = plot.keepouts.flatMap((k) => [k.x0 + 1, k.x1 - 1]);
    const zs = plot.keepouts.flatMap((k) => [k.z0 + 1, k.z1 - 1]);
    [x, z] = [plot.x, plot.z];
    const hb = plot.hostId ? map.buildings.find((b) => b.id === plot.hostId) : undefined;
    if (hb) host = hb;
    foot = { x, z, w: Math.max(...xs) - Math.min(...xs), d: Math.max(...zs) - Math.min(...zs), h: Math.max(foot?.h ?? 0, h) };
  }
  const c = clampTo(map, x, z);
  if (c.outside && s.interior) return null; // an interior off the map can't be drawn on our ground
  const at = c.outside && s.drawnOutside ? { x, z } : c;
  return { key: s.key, name: s.name, sub: s.sub, group: "places", x: at.x, z: at.z, y: s.y ?? 0, dist: s.dist, outside: c.outside, interior: s.interior, storeId: store?.id ?? null, host, foot };
}

/** Every travel destination for this map, in menu order: places, then clubs, then stations. */
export function resolvePlaces(map: CityMap): Place[] {
  const out: Place[] = [];
  const lms = resolveLandmarks(map);
  for (const s of SPECS) {
    const p = resolveSpec(map, s, lms);
    if (p) out.push(p);
  }
  // the Goodsyard construction site with its tower cranes (sim/construction)
  try {
    const site = planSite(map);
    if (site) {
      const crane = Math.max(30, ...site.cranes.map((c) => c.h));
      const c = clampTo(map, site.rect.x, site.rect.z);
      out.push({ key: "goodsyard", name: "Goodsyard site", sub: "Construction · tower cranes", group: "places", x: c.x, z: c.z, y: crane * 0.35, dist: Math.max(170, crane * 3.2), outside: c.outside });
    }
  } catch {
    /* no site on this map */
  }
  const taken = new Set(out.map((p) => p.storeId).filter(Boolean));
  for (const s of map.stores) {
    if (s.type !== "club" || taken.has(s.id)) continue;
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (!b) continue;
    const c = clampTo(map, b.x, b.z);
    out.push({ key: `club-${s.id}`, name: s.name, sub: "Club", group: "clubs", x: c.x, z: c.z, y: 0, dist: 110, outside: c.outside, storeId: s.id });
  }
  const main = out.find((p) => p.key === "station");
  for (const e of map.entryPoints) {
    if (e.kind !== "station") continue;
    if (main && Math.hypot(e.x - main.x, e.z - main.z) < 60) continue;
    if (out.some((p) => p.group === "places" && e.name && p.name.toLowerCase() === e.name.toLowerCase())) continue;
    const c = clampTo(map, e.x, e.z);
    out.push({ key: `station-${e.id}`, name: e.name ?? "Station", sub: "Station", group: "stations", x: c.x, z: c.z, y: 0, dist: 170, outside: c.outside });
  }
  return out;
}


const cache = new WeakMap<CityMap, Place[]>();
/** resolvePlaces, once per map. */
export function placesFor(map: CityMap): Place[] {
  let p = cache.get(map);
  if (!p) cache.set(map, (p = resolvePlaces(map)));
  return p;
}
