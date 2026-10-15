// Which world modules each graphics mode switches off (read by World). The chosen mode lives in state/store.ts.
//  stylised  - everything procedural
//  satellite - Esri aerial imagery draped as the ground (MapGround): real streets/rooftops from the air, our buildings,
//              people, cars and glows on top. Our flat road strips and the made-up infill blocks give way to the photo.
//  map       - same with the OSM (CARTO) street map, light by day / dark by night
//  photoreal - Google 3D Tiles (Photoreal), only with a key
// Satellite/map only hide anything once the mosaic has loaded, so a slow or failed fetch never leaves a blank city.
import { create } from "zustand";
import { useSim } from "../state/store";
import { usePhotorealHides } from "./modules/Photoreal";
import { useRealCity } from "./realcity/data";

const FREE_MAP_HIDES: ReadonlySet<string> = new Set(["Ground", "Streets", "Infill"]);
const NONE: ReadonlySet<string> = new Set();
/** The real OSM city (Real* modules) replaces the procedural base city once it is drawn. */
const REAL_CITY = ["RealLand", "RealRoads", "RealRail", "RealBuildings"];
const REAL_HIDES: ReadonlySet<string> = new Set(["Buildings", "Streets", "Ground", "Infill", "Surroundings"]);
const FREE_MAP_REAL_HIDES: ReadonlySet<string> = new Set([...FREE_MAP_HIDES, ...REAL_HIDES, "RealLand", "RealRoads"]);
const withReal = (s: ReadonlySet<string>) => new Set([...s, ...REAL_CITY]);

/** Set by MapGround: the draped mosaic is on screen. */
export const useFreeMap = create<{ ready: boolean }>(() => ({ ready: false }));

export function useModuleHides(): ReadonlySet<string> {
  const photoreal = usePhotorealHides();
  const mode = useSim((s) => s.graphicsMode);
  const ready = useFreeMap((s) => s.ready);
  const real = useRealCity((s) => s.drawn);
  if (photoreal.size) return withReal(photoreal);
  if ((mode === "satellite" || mode === "map") && ready) return real ? FREE_MAP_REAL_HIDES : FREE_MAP_HIDES;
  return real ? REAL_HIDES : NONE;
}
