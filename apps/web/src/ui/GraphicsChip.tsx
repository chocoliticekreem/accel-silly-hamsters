// Ground / graphics switch for the 3D city: Stylised · Satellite · Map (free, keyless tiles), plus Photoreal only when
// a Google Maps key is configured. The choice is remembered in localStorage by the store.
// MapAttribution: the credit line the tile providers require, shown while their tiles are on screen.
import type { CSSProperties } from "react";
import { useSim, type GraphicsMode } from "../state/store";
import { ATTRIBUTION } from "../world/freemap/mosaic";
import { useFreeMap } from "../world/graphics";
import { photorealAvailable } from "../world/modules/Photoreal";

const MODES: { mode: GraphicsMode; label: string; title: string }[] = [
  { mode: "stylised", label: "Stylised", title: "The illustrated city" },
  { mode: "satellite", label: "Satellite", title: "Real aerial imagery as the ground (Esri World Imagery)" },
  { mode: "map", label: "Map", title: "OpenStreetMap street map as the ground (CARTO), dark at night" },
  { mode: "photoreal", label: "Photoreal", title: "Google Photorealistic 3D Tiles" },
];

const seg: CSSProperties = { padding: "2px 8px", borderRadius: 999, font: "inherit", color: "inherit", background: "transparent", border: "none", cursor: "pointer" };
const segOn: CSSProperties = { ...seg, background: "rgba(255, 200, 110, 0.18)", color: "var(--lamp)" };

export function GraphicsChip() {
  const current = useSim((s) => s.graphicsMode);
  const setMode = useSim((s) => s.setGraphicsMode);
  const modes = MODES.filter((m) => m.mode !== "photoreal" || photorealAvailable());
  return (
    <div className="chip" role="group" aria-label="Ground" style={{ padding: "3px 4px", gap: 2 }}>
      {modes.map((m) => (
        <button key={m.mode} style={current === m.mode ? segOn : seg} aria-pressed={current === m.mode} title={m.title} onClick={() => setMode(m.mode)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function MapAttribution() {
  const mode = useSim((s) => s.graphicsMode);
  const ready = useFreeMap((s) => s.ready);
  if (!ready || (mode !== "satellite" && mode !== "map")) return null;
  const href = mode === "map" ? "https://www.openstreetmap.org/copyright" : "https://www.esri.com/";
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ position: "absolute", top: 6, left: "50%", transform: "translateX(-50%)", fontSize: 10.5, color: "rgba(255,255,255,0.85)", textShadow: "0 1px 2px rgba(0,0,0,0.9)", pointerEvents: "auto", whiteSpace: "nowrap", textDecoration: "none" }}
    >
      {ATTRIBUTION[mode === "map" ? "light" : "satellite"]}
    </a>
  );
}
