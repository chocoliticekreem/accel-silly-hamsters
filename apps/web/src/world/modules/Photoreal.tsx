// Module: Photoreal. In "Photoreal" graphics mode (and only when VITE_GOOGLE_MAPS_API_KEY is set) the real Shoreditch
// is streamed in as Google Photorealistic 3D Tiles, reoriented so contract coords line up with the real place, and
// the stylised modules that would clash with it (buildings, infill, roads, ground slab, skyline, trees) switch off.
// The sim keeps drawing on top: people, traffic, store glows/beacons/labels, street events, overlays.
// The heavy renderer (3d-tiles-renderer + plugins) lives in ../photoreal/Tiles.tsx and is only downloaded in this mode.
// Without a key: nothing renders, the mode chip is hidden, and the stylised city is unchanged.
import { lazy, Suspense } from "react";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { GOOGLE_TILES_KEY } from "../photoreal/frame";

const Tiles = lazy(() => import("../photoreal/Tiles"));

/** Modules the real city replaces. Names of modules that may not exist yet are harmless. */
const HIDDEN_IN_PHOTOREAL: ReadonlySet<string> = new Set([
  "Ground",
  "Skyline",
  "Streets",
  "Buildings",
  "Infill",
  "StreetLights",
  "StreetDressing",
  "Surroundings",
  "Cranes",
  "Construction",
]);
const NONE: ReadonlySet<string> = new Set();

export const photorealAvailable = (): boolean => !!GOOGLE_TILES_KEY;

/** True when the photoreal city is on (mode chosen and a key configured). */
export function usePhotoreal(): boolean {
  return useSim((s) => s.graphicsMode === "photoreal") && photorealAvailable();
}

/** Module names World must not mount right now. */
export function usePhotorealHides(): ReadonlySet<string> {
  return usePhotoreal() ? HIDDEN_IN_PHOTOREAL : NONE;
}

export default function Photoreal() {
  const on = usePhotoreal();
  const { map } = useWorld();
  if (!on) return null;
  return (
    <Suspense fallback={null}>
      <Tiles apiKey={GOOGLE_TILES_KEY!} map={map} />
    </Suspense>
  );
}
