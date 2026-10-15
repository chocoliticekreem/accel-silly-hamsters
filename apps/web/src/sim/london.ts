// Real London around the sim map, as data. Offsets are metres from Shoreditch High Street station (the map's
// origin): x east, z north, measured from OpenStreetMap / lat-long (1° lon ≈ 69.4 km, 1° lat ≈ 111.2 km here).
// Used by the decorative Surroundings and Landmarks modules and by the crowd/traffic layers that run out of the map.
import type { CityMap, Landmark } from "../api/contract";

/** Old Street station (Northern line, Bank branch) under the Old Street roundabout. */
export const OLD_STREET = { x: -850, z: 270, name: "Old Street" };
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
  // Old Street: from the Shoreditch High St / Kingsland Rd junction west past art'otel to the roundabout and on to Clerkenwell
  { name: "Old Street", width: 14, points: [[-205, 366], [-530, 330], [-850, 270], [-1700, 170], [-2900, 60]] },
  // Great Eastern Street: north-west from the map edge to Old Street at art'otel
  { name: "Great Eastern Street", width: 12, points: [[-250, -32.9], [-330, 60], [-530, 322]] },
  // City Road: north-west to Angel from the roundabout, and south toward Finsbury Square / Moorgate
  { name: "City Road", width: 14, points: [[-850, 270], [-1350, 760], [-2300, 1350]] },
  { name: "City Road", width: 14, points: [[-850, 270], [-880, -300], [-930, -900], [-1000, -1500]] },
  // Pitfield Street north from Old Street (Encode Hub)
  { name: "Pitfield Street", width: 9, points: [[-640, 312], [-575, 630], [-560, 1100], [-555, 2200]] },
  // Kingsland Road north (the A10, Shoreditch High Street's continuation)
  { name: "Kingsland Road", width: 14, points: [[-214.6, 250], [-205, 366], [-250, 1300], [-300, 2900]] },
  // Hackney Road north-east
  { name: "Hackney Road", width: 12, points: [[-205, 366], [300, 640], [1100, 1150], [2300, 1700]] },
  // Bishopsgate south into the City
  { name: "Bishopsgate", width: 14, points: [[-250, -119.8], [-300, -480], [-440, -700], [-445, -1050], [-560, -1500], [-640, -2900]] },
  // Commercial Street south to Aldgate, then the A11 east (Whitechapel Road)
  { name: "Commercial Street", width: 14, points: [[-48.7, -250], [-70, -700], [-150, -1150], [-260, -1500]] },
  { name: "Whitechapel Road", width: 14, points: [[-150, -1150], [600, -900], [1500, -700], [2900, -500]] },
  // Bethnal Green Road east
  { name: "Bethnal Green Road", width: 14, points: [[250, 222.5], [900, 380], [1700, 560], [2900, 820]] },
  // Brick Lane south to Whitechapel
  { name: "Brick Lane", width: 9, points: [[182.7, -250], [170, -900]] },
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
  { id: "artotel-hoxton", name: "art'otel London Hoxton", kind: "hotel", x: -530, z: 345, h: 92, note: "Hotel tower at Old Street & Great Eastern Street" },
  { id: "encode-hub", name: "Encode Hub", kind: "venue", x: -540, z: 630, h: 16, note: "41 Pitfield Street: the hackathon venue" },
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
