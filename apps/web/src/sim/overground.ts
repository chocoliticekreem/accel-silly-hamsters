// London Overground through Shoreditch High Street: where the viaduct runs, how a train moves, how often they come.
// Pure and deterministic; the 3D module (world/modules/Overground.tsx) draws it, Infill/Surroundings keep clear of it.
//
// Route: the station is the map's long `kind: "station"` building. The viaduct runs through it along its long axis,
// straight on for a little beyond each end, then (if going straight would plough through a building taller than
// the deck) bends by the smallest angle that clears, and runs on out past the map edge into the surroundings.
//
// Time: trains follow the sim clock's *timetable* (service hours, peak/off-peak frequency, Night Overground on
// Friday and Saturday nights) but move in real seconds, like the traffic and the crowd: at 10×/100× a train that
// moved in sim time would cross the map in a fraction of a frame.
// Contract coords throughout (x east, z north).
import type { Building, CityMap } from "../api/contract";
import { dayAt, weekdayIndex } from "./storeState";
import { hourOf } from "./time";

/** Rail level (top of the deck) above the street, metres. Real ELL viaduct here: ~8–9 m. */
export const DECK_Y = 8.5;
/** Deck width; the two tracks sit TRACK_OFFSET either side of the centreline. */
export const VIADUCT_W = 11;
export const TRACK_OFFSET = 2.1;
/** Straight run beyond each station end before the line may bend. */
const STRAIGHT = 40;
/** The route runs on this far beyond the map bounds (into the surroundings, then the fog). */
export const ROUTE_REACH = 650;
const ANGLES = [0, 8, -8, 16, -16, 24, -24, 32, -32];

export interface OvergroundRoute {
  /** Polyline, west/south tip → east/north tip. */
  points: [number, number][];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
  /** Distance along the route of the station's centre (where trains stop). */
  stationS: number;
  /** Platform length (the station's long side). */
  platformLen: number;
  station: Building;
}

export function stationBuilding(map: CityMap): Building | null {
  let best: Building | null = null;
  for (const b of map.buildings) if (b.kind === "station" && (!best || b.w * b.d > best.w * best.d)) best = b;
  return best;
}

const rot = (x: number, z: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];
};

/** One side of the line beyond the station end: straight, a gentle bend by `deg`, then straight to `far`. */
function sidePoints(end: [number, number], dir: [number, number], deg: number, far: number): [number, number][] {
  const pts: [number, number][] = [end];
  let [x, z] = [end[0] + dir[0] * STRAIGHT, end[1] + dir[1] * STRAIGHT];
  pts.push([x, z]);
  let d: [number, number] = dir;
  const steps = 5;
  for (let k = 1; k <= steps; k++) {
    d = rot(dir[0], dir[1], (deg * k) / steps);
    x += d[0] * 14;
    z += d[1] * 14;
    pts.push([x, z]);
  }
  pts.push([x + d[0] * far, z + d[1] * far]);
  return pts;
}

/** Buildings (ids) taller than the underside of the deck that a stretch of viaduct would run through. */
function clashes(pts: [number, number][], map: CityMap, station: Building): Set<string> {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const tall = map.buildings.filter((b) => b.id !== station.id && b.h > DECK_Y - 1.5);
  const hit = new Set<string>();
  const half = VIADUCT_W / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 3);
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n;
      const z = az + ((bz - az) * k) / n;
      if (x < minX - 5 || x > maxX + 5 || z < minZ - 5 || z > maxZ + 5) break;
      for (const b of tall) if (Math.abs(x - b.x) < b.w / 2 + half && Math.abs(z - b.z) < b.d / 2 + half) hit.add(b.id);
    }
  }
  return hit;
}

export function overgroundRoute(map: CityMap, reach = ROUTE_REACH): OvergroundRoute | null {
  const station = stationBuilding(map);
  if (!station) return null;
  const alongX = station.w >= station.d;
  const L = alongX ? station.w : station.d;
  const axis: [number, number] = alongX ? [1, 0] : [0, 1];
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const far = Math.max(maxX - minX, maxZ - minZ) + reach;

  const side = (sign: number) => {
    const dir: [number, number] = [axis[0] * sign, axis[1] * sign];
    const end: [number, number] = [station.x + (dir[0] * L) / 2, station.z + (dir[1] * L) / 2];
    let best: { pts: [number, number][]; score: number } | null = null;
    for (const deg of ANGLES) {
      const pts = sidePoints(end, dir, deg, far);
      const score = clashes(pts, map, station).size * 1000 + Math.abs(deg);
      if (!best || score < best.score) best = { pts, score };
    }
    return best!.pts;
  };
  const west = side(-1).reverse();
  const east = side(1);
  const points = [...west, ...east];
  // trim to the reach beyond the bounds (the long tails are generous)
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const limit = Math.max(maxX - minX, maxZ - minZ) / 2 + reach;
  const clip = (pts: [number, number][]) => {
    const out: [number, number][] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = out[out.length - 1];
      const [bx, bz] = pts[i];
      const inside = (x: number, z: number) => Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= limit;
      if (inside(bx, bz)) {
        out.push([bx, bz]);
        continue;
      }
      // binary-search the exit point on this segment
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 30; k++) {
        const m = (lo + hi) / 2;
        if (inside(ax + (bx - ax) * m, az + (bz - az) * m)) lo = m;
        else hi = m;
      }
      out.push([ax + (bx - ax) * lo, az + (bz - az) * lo]);
      break;
    }
    return out;
  };
  const mid = west.length; // index of the east side's first point (station east end)
  const westPart = clip(points.slice(0, mid).reverse()).reverse();
  const eastPart = clip(points.slice(mid - 1)).slice(1);
  const pts = [...westPart, ...eastPart];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const westEnd = westPart.length - 1; // station west end
  return { points: pts, cum, length: cum[cum.length - 1], stationS: cum[westEnd] + L / 2, platformLen: L, station };
}

/** Point and unit direction `s` metres along the route, shifted `lateral` metres to the right of travel. */
export function routeAt(r: Pick<OvergroundRoute, "points" | "cum">, s: number, lateral = 0): { x: number; z: number; dx: number; dz: number } {
  const { points, cum } = r;
  const d = Math.max(0, Math.min(cum[cum.length - 1], s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const [ax, az] = points[i - 1];
  const [bx, bz] = points[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const k = (d - cum[i - 1]) / seg;
  const dx = (bx - ax) / seg;
  const dz = (bz - az) / seg;
  return { x: ax + (bx - ax) * k + dz * lateral, z: az + (bz - az) * k - dx * lateral, dx, dz };
}

/** Distance from (x, z) to the route centreline. */
export function routeDistance(r: Pick<OvergroundRoute, "points">, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < r.points.length - 1; i++) {
    const [ax, az] = r.points[i];
    const [bx, bz] = r.points[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * k, z - az - dz * k));
  }
  return best;
}

// ---------- trains ----------

/** A Class 378 "Capitalstar": four 20 m cars. Speeds in real m/s (the world's motion runs in real time). */
export const TRAIN = { cars: 4, carLen: 20, gap: 0.7, speed: 17, accel: 1.1, dwell: 14 } as const;
export const TRAIN_LENGTH = TRAIN.cars * TRAIN.carLen + (TRAIN.cars - 1) * TRAIN.gap;

export interface TrainMotion {
  /** Metres travelled since appearing. */
  d: number;
  /** 0 shut … 1 open. */
  doors: number;
  phase: "approach" | "dwell" | "depart" | "gone";
}

/**
 * Where a train is `elapsed` real seconds after appearing: it cruises, brakes to a stand `toStop` metres on,
 * dwells with doors opening and closing, accelerates away and is gone `afterStop` metres past the stop.
 */
export function trainMotion(elapsed: number, toStop: number, afterStop: number, cfg: { speed: number; accel: number; dwell: number } = TRAIN): TrainMotion {
  const { speed: v, accel: a, dwell } = cfg;
  const brake = Math.min(toStop, (v * v) / (2 * a));
  const vIn = Math.sqrt(2 * a * brake); // = v unless the stop is closer than a full braking distance
  const tCruise = (toStop - brake) / v;
  const tBrake = vIn / a;
  const tArrive = tCruise + tBrake;
  if (elapsed < tCruise) return { d: elapsed * v, doors: 0, phase: "approach" };
  if (elapsed < tArrive) {
    const u = elapsed - tCruise;
    return { d: toStop - brake + vIn * u - 0.5 * a * u * u, doors: 0, phase: "approach" };
  }
  const tDepart = tArrive + dwell;
  if (elapsed < tDepart) {
    const u = elapsed - tArrive;
    // doors: open 1 s after stopping (over 1.2 s), close 3 s before leaving (over 1.2 s)
    const open = Math.min(1, Math.max(0, (u - 1) / 1.2));
    const close = Math.min(1, Math.max(0, (dwell - 3 - u) / 1.2 + 1));
    return { d: toStop, doors: Math.min(open, close), phase: "dwell" };
  }
  const u = elapsed - tDepart;
  const accelDist = Math.min(afterStop, (v * v) / (2 * a));
  const tAccel = Math.sqrt((2 * accelDist) / a);
  if (u < tAccel) return { d: toStop + 0.5 * a * u * u, doors: 0, phase: "depart" };
  const d = toStop + accelDist + (u - tAccel) * Math.sqrt(2 * a * accelDist);
  return d >= toStop + afterStop ? { d: toStop + afterStop, doors: 0, phase: "gone" } : { d, doors: 0, phase: "depart" };
}

/**
 * Trains per hour each way at sim minute `t` (East London line through Shoreditch): 16 in the weekday peaks,
 * 12 through the day, 8 in the evening, none 00:30–05:45 except the Night Overground (4/h) on Friday and Saturday nights.
 */
export function trainsPerHour(t: number): number {
  const h = hourOf(t);
  const wd = weekdayIndex(dayAt(t)); // 0 = Monday
  const weekday = wd < 5;
  if (h < 0.5) return 8;
  if (h < 5.75) {
    // early hours of Saturday (wd 5) and Sunday (wd 6) are Friday and Saturday nights
    return wd === 5 || wd === 6 ? 4 : 0;
  }
  if (weekday && ((h >= 7 && h < 10) || (h >= 16 && h < 19))) return 16;
  if (h < 20) return 12;
  return 8;
}

/** Real seconds between trains each way for a timetable of `tph`; Infinity when no service. */
export function headwaySeconds(tph: number): number {
  return tph > 0 ? 600 / tph : Infinity;
}
