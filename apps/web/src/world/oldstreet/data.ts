// Old Street junction as it is today (post-2024: the gyratory is gone, the north-west arm became a public space
// with the new station entrance pavilion). Geometry from OpenStreetMap, baked once by scripts/fetch-oldstreet.py
// into public/areas/oldstreet.json. Contract coords: x east, z north, metres from the map origin.
import { fetchJsonTracked } from "../../state/loading";
export type XZ = [number, number];

export interface OldStreetData {
  source: string;
  centre: XZ;
  pavilion: XZ[];
  peninsula: XZ[];
  promenade: XZ[];
  whiteCollar: XZ[];
  grind: XZ[];
  liftHouses: XZ[][];
  exit2House: XZ[];
  retaining: XZ[][];
  steps: Record<string, XZ[]>;
  island: XZ[];
  /** The raised public realm inside the junction (hull minus carriageways), and which of its edges face a road. */
  realm: XZ[];
  realmRoadEdge: number[];
  lanes: Record<string, { off: number; pts: XZ[] }>;
  kerbs: XZ[][];
  signals: XZ[];
  crossings: [number, number, string][];
  busStops: { x: number; z: number; ref: string; name: string; bearing: string }[];
  lamps: XZ[];
  benches: XZ[];
  cycleHire: XZ[];
  entrances: { x: number; z: number; name: string; ref: string }[];
}

let pending: Promise<OldStreetData> | null = null;

export function loadOldStreet(): Promise<OldStreetData> {
  if (!pending) {
    pending = fetchJsonTracked<OldStreetData>(`${import.meta.env.BASE_URL}areas/oldstreet.json`, "landmarks", "oldstreet").then((d) => d!);
    pending.catch(() => (pending = null));
  }
  return pending;
}

/** Height of the raised public space (a kerb above the carriageway, whose top is ≤ 0.16). */
export const PLAZA_Y = 0.19;
/** Floor of the sunken St Agnes Well walk (the old subway ramp down to the concourse). */
export const PIT_Y = -3.8;
/** Concourse level at the foot of the pavilion's escalators. */
export const CONCOURSE_Y = -5.6;
