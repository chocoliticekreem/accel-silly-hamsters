// Where each hero landmark stands, and the ground it owns (pure, no DOM). One source of truth for HeroLandmarks
// (which model to build, its size and rotation) and for every base-building module (Buildings, Stores, Infill),
// which must not draw generic boxes inside a landmark: `landmarkKeepouts(map)` gives each landmark's footprint
// plus a 1 m margin. A host building (the OSM box the landmark replaces) is skipped outright, and any neighbour box
// that only partly overlaps is cut back with sim/footprints `clearKeepouts`.
//
// A landmark with a host building is built to that plot: frontage width along the street, depth into the block,
// street face toward the street the host fronts (sim/geometry frontage). art'otel uses its real OSM footprint and
// orientation (oval tower + podium wing). Contract coords: x east, z north. Scene rotation: model +z faces the street.
import type { Building, CityMap } from "../../api/contract";
import { frontage } from "../../sim/geometry";
import { resolveLandmarks } from "../../sim/london";
import { ARTOTEL_CENTRE, ARTOTEL_FOOTPRINT } from "./landmarkData";

export interface KeepoutRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export type HeroLandmarkKey = "xoyo" | "encode" | "artotel" | "boxpark";

export interface LandmarkPlot {
  /** Stable scene-graph name: landmark-xoyo / landmark-encode / landmark-artotel / landmark-boxpark. */
  name: string;
  key: HeroLandmarkKey;
  /** The map building the landmark replaces (its generic box is not drawn). */
  hostId?: string;
  /** Contract centre of the model. */
  x: number;
  z: number;
  /** Scene rotation about y. */
  rot: number;
  /** Model width (local x, along the street face) and depth (local z), metres. */
  w: number;
  d: number;
  keepouts: KeepoutRect[];
}

const MARGIN = 1;

interface Spec {
  key: HeroLandmarkKey;
  at: [number, number];
  /** Default size (width along the street, depth) when there is no host building. */
  size: [number, number];
  min: [number, number];
}

const SPECS: Spec[] = [
  { key: "xoyo", at: [-786, 248], size: [24, 18], min: [12, 8] },
  { key: "encode", at: [-645.5, 481.4], size: [6.1, 13.5], min: [5, 6] }, // OSM way 191324423: 6 m frontage on Pitfield St
  { key: "artotel", at: [ARTOTEL_CENTRE.x, ARTOTEL_CENTRE.z], size: [28, 37], min: [0, 0] },
  { key: "boxpark", at: [-124, 26], size: [60, 7.3], min: [12, 4.9] },
];

const rectOf = (x: number, z: number, w: number, d: number, m = MARGIN): KeepoutRect => ({ x0: x - w / 2 - m, x1: x + w / 2 + m, z0: z - d / 2 - m, z1: z + d / 2 + m });

let cacheMap: CityMap | null = null;
let cachePlots: LandmarkPlot[] = [];

export function landmarkPlots(map: CityMap): LandmarkPlot[] {
  if (map === cacheMap) return cachePlots;
  const lms = resolveLandmarks(map);
  const byId = new Map(map.buildings.map((b) => [b.id, b]));
  const out: LandmarkPlot[] = [];
  for (const s of SPECS) {
    const name = `landmark-${s.key}`;
    const lm = lms.find((l) => l.key === s.key);
    let hostId: string | undefined = lm?.buildingId ?? undefined;
    if (s.key === "xoyo") hostId = map.stores.find((st) => /^xoyo$/i.test(st.name))?.buildingId ?? (byId.has("b72") ? "b72" : undefined);
    const host = hostId ? byId.get(hostId) : undefined;
    if (s.key === "artotel") {
      // real OSM footprint, true orientation: model local x = east, local z = south
      const [cx, cz] = [ARTOTEL_CENTRE.x, ARTOTEL_CENTRE.z];
      const keepouts = ARTOTEL_FOOTPRINT.map((r) => ({ x0: cx + r.x0 - MARGIN, x1: cx + r.x1 + MARGIN, z0: cz + r.z0 - MARGIN, z1: cz + r.z1 + MARGIN }));
      out.push({ name, key: s.key, hostId: host?.id, x: cx, z: cz, rot: 0, w: s.size[0], d: s.size[1], keepouts });
      continue;
    }
    // the plot: the host's box, else a box of the default size at the landmark's position
    const fake: Building = host ?? { id: `_${s.key}`, kind: "office", x: lm?.x ?? s.at[0], z: lm?.z ?? s.at[1], w: s.size[0], d: s.size[1], h: 10 };
    const f = frontage(fake, map.streets);
    const alongZ = f.nx !== 0; // street face is on an x side: the frontage runs along z
    let w = host ? (alongZ ? host.d : host.w) : s.size[0];
    let d = host ? (alongZ ? host.w : host.d) : s.size[1];
    w = Math.max(w, s.min[0]);
    d = Math.max(d, s.min[1]);
    const rot = Math.atan2(f.nx, -f.nz);
    const [ew, ed] = alongZ ? [d, w] : [w, d];
    out.push({ name, key: s.key, hostId: host?.id, x: fake.x, z: fake.z, rot, w, d, keepouts: [rectOf(fake.x, fake.z, ew, ed)] });
  }
  cacheMap = map;
  cachePlots = out;
  return out;
}

/** Every landmark footprint (+1 m), contract coords. */
export function landmarkKeepouts(map: CityMap): KeepoutRect[] {
  return landmarkPlots(map).flatMap((p) => p.keepouts);
}

/** Building ids whose generic box a landmark model replaces. */
export function landmarkHostIds(map: CityMap): Set<string> {
  return new Set(landmarkPlots(map).flatMap((p) => (p.hostId ? [p.hostId] : [])));
}
