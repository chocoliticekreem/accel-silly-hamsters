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

const FREE_MAP_HIDES: ReadonlySet<string> = new Set(["Ground", "Streets", "Infill"]);
const NONE: ReadonlySet<string> = new Set();

/** Set by MapGround: the draped mosaic is on screen. */
export const useFreeMap = create<{ ready: boolean }>(() => ({ ready: false }));

export function useModuleHides(): ReadonlySet<string> {
  const photoreal = usePhotorealHides();
  const mode = useSim((s) => s.graphicsMode);
  const ready = useFreeMap((s) => s.ready);
  if (photoreal.size) return photoreal;
  return (mode === "satellite" || mode === "map") && ready ? FREE_MAP_HIDES : NONE;
}
