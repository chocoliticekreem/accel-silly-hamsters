// Real London around the sim map, as data. Offsets are metres from the Shoreditch High Street railway=station node
// (the map's origin, 51.5232534 N 0.0744674 W): x east, z north, with the backend's equirectangular projection.
// Rail alignment, stations and Old Street's entrances are from OpenStreetMap (© OpenStreetMap contributors, ODbL).
// Used by the decorative Surroundings and Landmarks modules and by the crowd/traffic layers that run out of the map.
import type { CityMap, Landmark } from "../api/contract";

/** Old Street station (Northern line, Bank branch) under the Old Street roundabout (OSM station node). */
export const OLD_STREET = { x: -909, z: 264, name: "Old Street" };
/** The Old Street roundabout (Silicon Roundabout): ring road centre and radius. */
export const ROUNDABOUT = { x: -902, z: 270, r: 26, width: 12 };
/** Old Street's street-level entrances (OSM subway_entrance nodes, plus the roundabout's south-east stair). */
export const OLD_STREET_ENTRANCES: { name: string; x: number; z: number }[] = [
  { name: "Exit 4", x: -931.4, z: 305.6 },
  { name: "Exit 2", x: -859.8, z: 232.5 },
  { name: "Old Street Station", x: -918.6, z: 278.9 },
  { name: "Exit 6", x: -876, z: 314 },
];

/** The East London line (London Overground, OSM, simplified to 1.5 m): Haggerston → Hoxton → Shoreditch High
 * Street → east toward Whitechapel, where it goes underground at ELL_TUNNEL_PORTAL. */
export const ELL_ALIGNMENT: [number, number][] = [
  [-65.4, 1950.3], [-80.9, 1673.7], [-90.1, 1441.8], [-88.5, 1164.0], [-83.7, 920.1], [-85.9, 858.6], [-96.8, 802.5],
  [-118.6, 746.3], [-143.9, 702.9], [-142.3, 698.7], [-221.0, 595.8], [-241.3, 564.9], [-266.0, 505.6], [-279.1, 464.6],
  [-289.6, 410.9], [-293.1, 345.7], [-292.2, 177.5], [-283.5, 132.4], [-266.3, 93.3], [-250.0, 70.3], [-232.9, 52.2],
  [-212.8, 36.6], [-191.0, 24.0], [-167.1, 12.7], [-148.7, 7.7], [-111.0, 3.9], [113.4, -0.2], [159.0, -5.7],
  [162.5, -10.1], [226.3, -21.5], [511.1, -86.8], [677.2, -114.6], [737.4, -137.8], [791.6, -169.0], [824.9, -198.6],
];
export const ELL_TUNNEL_PORTAL = { x: 650, z: -109 };
/** Other Overground stations on the alignment (OSM station nodes). */
export const ELL_STATIONS = [
  { name: "Hoxton", x: -82.1, z: 927.2, platformLen: 110 },
  { name: "Haggerston", x: -77.2, z: 1712.8, platformLen: 110 },
];
/** Middle of the City of London's tower cluster (around 22 Bishopsgate / the Gherkin). */
export const CITY_CENTRE = { x: -520, z: -1000 };

export interface NamedRoad {
  name: string;
  width: number;
  points: [number, number][];
}

/**
 * Main roads beyond the map. Each starts on the map edge where the OSM street leaves it (the first point is
 * snapped to the matching exit at runtime when one is within 40 m) and runs out toward its real destination.
 */
export const ARTERIALS: NamedRoad[] = [
  // Old Street west from the map edge to the roundabout, then on to Clerkenwell
  // (every road meeting the roundabout stops at its ring: ROUNDABOUT)
  { name: "Old Street", width: 14, points: [[-800, 310], [-877.8, 279.5]] },
  { name: "Old Street", width: 14, points: [[-927.9, 267.4], [-1700, 190], [-2900, 70]] },
  // City Road: north-west to Angel, and south toward Finsbury Square / Moorgate
  { name: "City Road", width: 14, points: [[-919.5, 289.2], [-1350, 760], [-2300, 1350]] },
  { name: "City Road", width: 14, points: [[-903.3, 244.0], [-930, -300], [-960, -900], [-1000, -1500]] },
  // East Road, north from the roundabout
  { name: "East Road", width: 12, points: [[-900.7, 296.0], [-880, 700], [-860, 1500], [-850, 2900]] },
  // Kingsland Road north (the A10) past Hoxton station
  { name: "Kingsland Road", width: 14, points: [[-200, 750], [-166, 920], [-140, 1300], [-120, 2900]] },
  // Hackney Road north-east
  { name: "Hackney Road", width: 14, points: [[8, 750], [150, 1000], [600, 1500], [1300, 2100]] },
  // New North Road and Pitfield Street north
  { name: "New North Road", width: 10, points: [[-637, 750], [-700, 1300], [-760, 2900]] },
  { name: "Pitfield Street", width: 9, points: [[-595, 750], [-585, 1200], [-580, 2000]] },
  // Bishopsgate south into the City and on to London Bridge
  { name: "Bishopsgate", width: 14, points: [[-475, -750], [-500, -1000], [-520, -1500], [-860, -1700], [-880, -2900]] },
  // Commercial Street south to Aldgate
  { name: "Commercial Street", width: 14, points: [[112, -750], [60, -1050], [-100, -1300]] },
  // London Wall west
  { name: "London Wall", width: 14, points: [[-800, -709], [-1300, -760], [-2900, -800]] },
  // Bethnal Green Road and Whitechapel Road east
  { name: "Bethnal Green Road", width: 14, points: [[700, 361], [1100, 450], [1700, 600], [2900, 850]] },
  { name: "Whitechapel Road", width: 14, points: [[700, -580], [1300, -700], [2900, -900]] },
];

/** The Thames, west → east, and its width: the City and the Shard sit either side of it. */
export const THAMES = {
  width: 240,
  points: [
    [-3200, -1640],
    [-2000, -1660],
    [-1300, -1730],
    [-860, -1800],
    [-300, -1900],
    [0, -1960],
    [700, -1940],
    [1400, -1830],
    [2200, -1900],
    [3200, -2100],
  ] as [number, number][],
};

/** Where the Skyline module's towers stand (keep the surroundings off them). Radius in metres. */
export const SKYLINE_SPOTS: { x: number; z: number; r: number }[] = [
  { x: -354, z: -980, r: 32 },
  { x: -576, z: -990, r: 40 },
  { x: -390, z: -790, r: 30 },
  { x: -480, z: -1060, r: 45 },
  { x: -583, z: -1345, r: 38 },
  { x: -785, z: -2090, r: 40 },
  { x: -470, z: -880, r: 45 },
  { x: -650, z: -1150, r: 40 },
  { x: -300, z: -1180, r: 32 },
  { x: -700, z: -900, r: 42 },
];

export type LandmarkKey = "artotel" | "encode" | "boxpark" | "oldstreet" | "other";

export interface ResolvedLandmark extends Landmark {
  key: LandmarkKey;
}

/** Fallbacks when the backend serves no `map.landmarks`. Boxpark is found on the map (see resolveLandmarks). */
export const LANDMARK_FALLBACKS: Landmark[] = [
  { id: "artotel-hoxton", name: "art'otel London Hoxton", kind: "hotel", x: -601, z: 339, h: 92, note: "Hotel tower at Old Street & Great Eastern Street" },
  { id: "encode-hub", name: "Encode Hub", kind: "venue", x: -645, z: 481, h: 19, note: "41 Pitfield Street: the hackathon venue" },
  { id: "old-street", name: "Old Street", kind: "station", x: OLD_STREET.x, z: OLD_STREET.z, h: 0, note: "Northern line, under the roundabout" },
];

export function landmarkKey(l: Pick<Landmark, "id" | "name">): LandmarkKey {
  const s = `${l.id} ${l.name}`.toLowerCase();
  if (/art.?otel/.test(s)) return "artotel";
  if (/encode/.test(s)) return "encode";
  if (/boxpark/.test(s)) return "boxpark";
  if (/old.?street/.test(s)) return "oldstreet";
  return "other";
}

/**
 * The landmarks to draw: the backend's, plus a fallback for each well-known one it doesn't list.
 * Boxpark Shoreditch (two storeys of shipping containers beside the station) is, on the OSM map, the low
 * container-sized block just past the station's west end; found by shape when not listed.
 */
export function resolveLandmarks(map: CityMap): ResolvedLandmark[] {
  const out: ResolvedLandmark[] = (map.landmarks ?? []).map((l) => ({ ...l, key: landmarkKey(l) }));
  const have = new Set(out.map((l) => l.key));
  for (const f of LANDMARK_FALLBACKS) if (!have.has(landmarkKey(f))) out.push({ ...f, key: landmarkKey(f) });
  if (!have.has("boxpark")) {
    const b = findBoxpark(map);
    if (b) out.push({ id: "boxpark", name: "Boxpark Shoreditch", kind: "market", buildingId: b.id, x: b.x, z: b.z, h: 5.4, key: "boxpark" });
  }
  // Old Street station: the map's own entry point wins once the backend's map reaches it
  const os = out.find((l) => l.key === "oldstreet");
  const ep = map.entryPoints.find((e) => e.kind === "station" && /old.?street/i.test(e.name ?? ""));
  if (os && ep) Object.assign(os, { x: ep.x, z: ep.z });
  return out;
}

function findBoxpark(map: CityMap) {
  const st = map.buildings.filter((b) => b.kind === "station").sort((a, b) => b.w * b.d - a.w * a.d)[0];
  if (!st) return null;
  const alongX = st.w >= st.d;
  const L = alongX ? st.w : st.d;
  // west (or south) end of the station
  const ex = alongX ? st.x - L / 2 : st.x;
  const ez = alongX ? st.z : st.z - L / 2;
  let best = null as (typeof map.buildings)[number] | null;
  for (const b of map.buildings) {
    if (b.kind === "station" || b.kind === "store" || b.kind === "club" || b.h > 7) continue;
    const area = b.w * b.d;
    if (area < 250 || area > 1200 || Math.hypot(b.x - ex, b.z - ez) > 60) continue;
    if (!best || area > best.w * best.d) best = b;
  }
  return best;
}
