// "Photoreal / Stylised" switch for the 3D city (choice remembered in localStorage by the store).
// Hidden when no Google Maps key is configured; in dev it shows a disabled chip whose tooltip says how to enable it.
import { useSim } from "../state/store";
import { photorealAvailable } from "../world/modules/Photoreal";

const HOW_TO =
  "Photoreal needs a Google Maps Platform key: put VITE_GOOGLE_MAPS_API_KEY=… in apps/web/.env.local " +
  "(never commit it), enable the Map Tiles API for that key in Google Cloud, then restart the dev server.";

export function GraphicsChip() {
  const mode = useSim((s) => s.graphicsMode);
  const setMode = useSim((s) => s.setGraphicsMode);
  if (!photorealAvailable()) {
    if (!import.meta.env.DEV) return null;
    return (
      <span className="chip chip-mock" title={HOW_TO} aria-disabled>
        Photoreal off
      </span>
    );
  }
  const photoreal = mode === "photoreal";
  return (
    <button
      className={`chip ${photoreal ? "on" : ""}`}
      aria-pressed={photoreal}
      onClick={() => setMode(photoreal ? "stylised" : "photoreal")}
      title={photoreal ? "Showing Google Photorealistic 3D Tiles: switch to the stylised city" : "Show the real Shoreditch (Google Photorealistic 3D Tiles)"}
    >
      {photoreal ? "Photoreal" : "Stylised"}
    </button>
  );
}
