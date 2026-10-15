// The real city, baked from OpenStreetMap + Esri imagery colours by apps/web/scripts/bake-city.mjs into
// public/city/{buildings,roads,land}.json. Loaded once per page; the Real* modules build three.js geometry from it.
// While it loads (or if it is missing) `ready` stays false and the old procedural modules keep drawing the city.
// Coordinates here are already in the *scene* frame (x east, z = -north): see toScene in sim/geometry.ts.
import { create } from "zustand";
import type { CityMap } from "../../api/contract";
import { task } from "../../state/loading";
import type { BuiltArrays } from "./buildCity";

export type P = [number, number];

export interface RealBuilding {
  id: string;
  /** Outer ring CCW-in-scene first, then holes; scene coords. */
  rings: P[][];
  h: number;
  minH: number;
  roof: number; // index into ROOFS
  roofH: number;
  levels: number;
  part: boolean;
  /** Outline whose building:parts are drawn instead (kept for matching, never drawn). */
  hasParts: boolean;
  outer: boolean;
  wall: string;
  roofColour: string;
  material: number;
  type: number;
  name: string;
  /** Centroid (scene) and footprint area. */
  cx: number;
  cz: number;
  area: number;
}

export interface RealRoad {
  cls: number;
  width: number;
  flags: number;
  layer: number;
  lanes: number;
  pts: P[];
  name: string;
}

export interface RealCrossing {
  x: number;
  z: number;
  /** Road direction in scene (radians, atan2(dz, dx)). */
  angle: number;
  width: number;
  type: number;
}

export interface RealRail {
  flags: number;
  layer: number;
  pts: P[];
  name: string;
}

export interface RealArea {
  kind: number;
  rings: P[][];
  tint: string;
}

export interface RealCity {
  buildings: RealBuilding[];
  roads: RealRoad[];
  crossings: RealCrossing[];
  rail: RealRail[];
  areas: RealArea[];
  trees: { x: number; z: number; h: number }[];
  enums: { materials: string[]; roofs: string[]; types: string[] };
  /** Scene-frame rectangles: detailed area and the outer ring. */
  inner: { minX: number; maxX: number; minZ: number; maxZ: number };
  outer: { minX: number; maxX: number; minZ: number; maxZ: number };
  attribution: string;
}

export const ROAD = { car: 8, pedestrian: 9, footway: 10, path: 11, cycleway: 12, steps: 13, track: 14 } as const;
export const RF = { oneway: 1, swLeft: 2, swRight: 4, bridge: 8, sidewalk: 16, crossing: 32, paved: 64, setts: 128, cycleLane: 256 } as const;
export const RAILF = { bridge: 1, embankment: 2, cutting: 4, service: 8, overground: 16, disused: 32 } as const;
export const LAND = {
  park: 1, grass: 2, pitch: 3, playground: 4, water: 5, wood: 6, cemetery: 7, plaza: 8, parking: 9, railway: 10, construction: 11,
  footArea: 12, cycleArea: 13, roadArea: 14, island: 15, court: 16,
} as const;

/** Delta-decoded decimetre ring → scene points. */
function ring(enc: number[]): P[] {
  const out: P[] = [];
  let x = 0;
  let z = 0;
  for (let i = 0; i + 1 < enc.length; i += 2) {
    x = i ? x + enc[i] : enc[i];
    z = i ? z + enc[i + 1] : enc[i + 1];
    out.push([x / 10, -z / 10]);
  }
  return out;
}

export function signedArea(r: P[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

/** Outer ring with positive signed area (scene x, z), holes negative: wall normals are then (dz, -dx) everywhere. */
function orient(rings: P[][]): P[][] {
  return rings.map((r, i) => ((i === 0) === signedArea(r) > 0 ? r : [...r].reverse()));
}

export function centroidOf(r: P[]): P {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f;
    cx += (r[j][0] + r[i][0]) * f;
    cz += (r[j][1] + r[i][1]) * f;
  }
  return Math.abs(a) < 1e-9 ? r[0] : [cx / (3 * a), cz / (3 * a)];
}

export function inRing(x: number, z: number, r: P[]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
export const inPolygon = (x: number, z: number, rings: P[][]) => inRing(x, z, rings[0]) && !rings.slice(1).some((h) => inRing(x, z, h));

const rect = (a: number[]) => ({ minX: a[0], maxX: a[2], minZ: -a[3], maxZ: -a[1] });

/* eslint-disable @typescript-eslint/no-explicit-any */
export function decode(b: any, r: any, l: any): RealCity {
  const buildings: RealBuilding[] = b.b.map((e: any[]) => {
    const rings = orient((e[1] as number[][]).map(ring));
    const [cx, cz] = centroidOf(rings[0]);
    return {
      id: e[0],
      rings,
      h: e[2] / 10,
      minH: e[3] / 10,
      roof: e[4],
      roofH: e[5] / 10,
      levels: e[6],
      part: !!(e[7] & 1),
      hasParts: !!(e[7] & 2),
      outer: !!(e[7] & 4),
      wall: e[8],
      roofColour: e[9],
      material: e[10],
      type: e[11],
      name: e[12] ?? "",
      cx,
      cz,
      area: Math.abs(signedArea(rings[0])),
    };
  });
  return {
    buildings,
    roads: r.r.map((e: any[]) => ({ cls: e[0], width: e[1] / 10, flags: e[2], layer: e[3], lanes: e[4], pts: ring(e[5]), name: e[6] ?? "" })),
    crossings: r.x.map((e: number[]) => ({ x: e[0] / 10, z: -e[1] / 10, angle: -e[2] / 1000, width: e[3] / 10, type: e[4] })),
    rail: r.rail.map((e: any[]) => ({ flags: e[0], layer: e[1], pts: ring(e[2]), name: e[3] ?? "" })),
    areas: l.a.map((e: any[]) => ({ kind: e[0], rings: orient((e[1] as number[][]).map(ring)), tint: e[2] ?? "" })),
    trees: l.t.map((e: number[]) => ({ x: e[0] / 10, z: -e[1] / 10, h: e[2] / 10 })),
    enums: b.enums,
    inner: rect(b.inner),
    outer: rect(b.outer),
    attribution: b.attribution,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface RealCityState {
  status: "idle" | "loading" | "ready" | "missing";
  city: RealCity | null;
  /** Set by RealBuildings once its geometry is on screen: the old box modules give way then. */
  drawn: boolean;
}

export const useRealCity = create<RealCityState>(() => ({ status: "idle", city: null, drawn: false }));

/** ?real=0 keeps the old procedural city (debugging / comparisons). */
const disabled = () => new URLSearchParams(window.location.search).get("real") === "0";

// The heavy lifting (download, JSON parse, decode, building geometry) runs in a Web Worker (realcity/city.worker.ts)
// so the page keeps drawing frames; if workers are unavailable or the worker fails, the same code runs here instead.
let worker: Worker | null = null;
/** The worker holds its own decoded copy of the city (needed for builds). */
let workerHasCity = false;
let nextBuild = 1;
const builds = new Map<number, { resolve: (b: BuiltArrays) => void; reject: (e: Error) => void }>();

function startWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./city.worker.ts", import.meta.url), { type: "module" });
  } catch (e) {
    console.warn("[city] no worker, building on the main thread:", e);
    return null;
  }
  return worker;
}

function mainThreadLoad(onProgress: (p: number) => void): Promise<RealCity> {
  const base = `${import.meta.env.BASE_URL}city/`;
  let n = 0;
  const get = (f: string) =>
    fetch(base + f).then((res) => {
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) throw new Error(`${f}: ${res.status}`);
      return res.json().then((j) => (onProgress(++n / 3), j));
    });
  return Promise.all([get("buildings.json"), get("roads.json"), get("land.json")]).then(([b, r, l]) => decode(b, r, l));
}

export function loadRealCity() {
  if (useRealCity.getState().status !== "idle") return;
  if (disabled()) {
    useRealCity.setState({ status: "missing" });
    return;
  }
  useRealCity.setState({ status: "loading" });
  const t = task("city", "data", 3);
  const ok = (city: RealCity) => {
    useRealCity.setState({ status: "ready", city });
    t.done();
  };
  const missing = (e: unknown) => {
    console.warn("real city data unavailable, keeping the procedural city:", e);
    useRealCity.setState({ status: "missing" });
    // the procedural city stands in: not an error worth showing
    t.done();
  };
  const fallback = () => mainThreadLoad((p) => t.progress(p)).then(ok, missing);
  const w = startWorker();
  if (!w) return void fallback();
  let settled = false;
  w.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "progress") t.progress(m.p);
    else if (m.type === "city") {
      settled = true;
      workerHasCity = true;
      ok(m.city as RealCity);
    } else if (m.type === "built") {
      builds.get(m.id)?.resolve(m.built as BuiltArrays);
      builds.delete(m.id);
    } else if (m.type === "error") {
      if (m.id != null) {
        builds.get(m.id)?.reject(new Error(m.message));
        builds.delete(m.id);
      } else if (!settled) {
        settled = true;
        // a missing bake fails the same way on the main thread: no need to try twice
        missing(m.message);
      }
    }
  };
  w.onerror = (e) => {
    console.warn("[city] worker failed, falling back to the main thread:", e.message);
    e.preventDefault?.();
    worker = null;
    workerHasCity = false;
    for (const b of builds.values()) b.reject(new Error("worker failed"));
    builds.clear();
    if (!settled) {
      settled = true;
      fallback();
    }
  };
  w.postMessage({ type: "load", base: new URL(`${import.meta.env.BASE_URL}city/`, location.href).href });
}

/** The real buildings' merged geometry arrays: built in the worker when it has the city, else here. */
export async function buildRealBuildings(city: RealCity, map: CityMap): Promise<BuiltArrays> {
  if (worker && workerHasCity) {
    try {
      const id = nextBuild++;
      const w = worker;
      return await new Promise<BuiltArrays>((resolve, reject) => {
        builds.set(id, { resolve, reject });
        // the map is plain JSON data: structured-cloned (a DataCloneError rejects and falls back below)
        w.postMessage({ type: "build", id, map });
      });
    } catch (e) {
      console.warn("[city] worker build failed, building on the main thread:", e);
    }
  }
  const { buildCityArrays } = await import("./buildCity");
  return buildCityArrays(city, map);
}

/** The baked city once loaded (null meanwhile / when missing). Starts the load on first use. */
export function useRealCityData(): RealCity | null {
  const city = useRealCity((s) => s.city);
  if (useRealCity.getState().status === "idle") queueMicrotask(loadRealCity);
  return city;
}
