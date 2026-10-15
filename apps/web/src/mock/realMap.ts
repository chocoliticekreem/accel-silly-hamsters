// The mock's city: the real processed map (data/processed/map.json, what the backend serves as GET /api/map), bundled
// at build time so the no-backend deploy (Vercel) puts its stores, clubs and walkers on the same OpenStreetMap streets
// and buildings the 3D city draws. The schematic grid (mock/map.ts) is only the fallback if that file is unusable.
import type { CityMap } from "../api/contract";
import realMapData from "../../../../data/processed/map.json";
import { generateMap } from "./map";

/** True when the bundled file has what the mock needs. */
export function usableMap(m: unknown): m is CityMap {
  const x = m as Partial<CityMap> | null;
  if (!x || !Array.isArray(x.streets) || !Array.isArray(x.buildings) || !Array.isArray(x.stores) || !Array.isArray(x.entryPoints) || !x.bounds) return false;
  const ids = new Set(x.buildings.map((b) => b.id));
  return x.streets.length > 0 && x.stores.length > 0 && x.stores.every((s) => ids.has(s.buildingId)) && x.entryPoints.some((e) => e.kind === "station");
}

/** A fresh copy of the real map (callers mutate it), or the schematic one if the real file can't be used. */
export function mockMap(seed: number): CityMap {
  try {
    if (usableMap(realMapData)) return structuredClone(realMapData as unknown as CityMap);
    console.warn("[mock] data/processed/map.json is unusable: falling back to the schematic map");
  } catch (e) {
    console.warn("[mock] could not read the real map, falling back to the schematic map", e);
  }
  return generateMap(seed);
}
