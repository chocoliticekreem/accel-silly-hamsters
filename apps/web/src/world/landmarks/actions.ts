// Travel actions shared by the Go-to bar, the beacons and the hash deep link.
import { useSim } from "../../state/store";
import { useTravel } from "../../state/travel";
import { flyTo } from "../flyTo";
import { DEFAULT_FLOOR, LEVELS } from "./floors";
import type { Place } from "./places";

/** Fly the camera to a place (about a second, eased; CameraRig). */
export function goPlace(p: Place) {
  useTravel.getState().go(p.key);
  flyTo(p.x, p.z, p.dist, p.y);
}

/** Open a landmark's multi-floor interior (the Landmarks module frames the floor), or a club's cutaway. */
export function enterPlace(p: Place, floor?: number) {
  if (p.interior) {
    const key = p.interior;
    useTravel.getState().enter(p.key, { floors: LEVELS[key].length, floor: floor ?? DEFAULT_FLOOR[key], storeId: p.storeId });
    if (p.storeId && useSim.getState().selectedStoreId !== p.storeId) useSim.getState().selectStore(p.storeId);
  } else if (p.storeId) {
    // clubs: selecting one opens Interiors' cutaway and flies in
    useTravel.getState().go(p.key);
    useSim.getState().selectStore(p.storeId);
  } else goPlace(p);
}

/** Can you go inside? (landmark interiors and clubs) */
export const enterable = (p: Place) => !!p.interior || p.group === "clubs";
