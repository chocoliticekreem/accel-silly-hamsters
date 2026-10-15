// Go-to bar: one click teleports the camera to a landmark: Encode Hub first, then XOYO, art'otel,
// Old Street, Boxpark and the station. Positions come from the map (store buildings, landmarks) with fallbacks.
import { Building2, Hotel, MapPin, Music, ShoppingBag, TrainFront } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { CityMap } from "../api/contract";
import { resolveLandmarks } from "../sim/london";
import { useMap } from "../state/data";
import { flyTo } from "../world/flyTo";

interface Place {
  key: string;
  label: string;
  Icon: typeof MapPin;
  x: number;
  z: number;
  dist: number;
}

function places(map: CityMap | null): Place[] {
  const lm = map ? resolveLandmarks(map) : [];
  const at = (key: string, x: number, z: number) => {
    const l = lm.find((k) => k.key === key);
    return l ? { x: l.x, z: l.z } : { x, z };
  };
  const club = (name: RegExp, x: number, z: number) => {
    const s = map?.stores.find((k) => name.test(k.name));
    const b = s && map?.buildings.find((k) => k.id === s.buildingId);
    return b ? { x: b.x, z: b.z } : { x, z };
  };
  return [
    { key: "encode", label: "Encode Hub", Icon: Building2, dist: 150, ...at("encode", -645, 481) },
    { key: "xoyo", label: "XOYO", Icon: Music, dist: 150, ...club(/^xoyo$/i, -786, 248) },
    { key: "artotel", label: "art'otel", Icon: Hotel, dist: 260, ...at("artotel", -601, 339) },
    { key: "oldstreet", label: "Old Street", Icon: MapPin, dist: 240, ...at("oldstreet", -880, 255) },
    { key: "boxpark", label: "Boxpark", Icon: ShoppingBag, dist: 160, ...at("boxpark", -124, 26) },
    { key: "station", label: "Shoreditch High St", Icon: TrainFront, dist: 220, x: 0, z: 0 },
    { key: "hoxton", label: "Hoxton", Icon: TrainFront, dist: 220, x: -82, z: 927 },
  ];
}

export function GoToBar() {
  const map = useMap().data ?? null;
  const list = useMemo(() => places(map), [map]);

  // #goto=encode deep links (number keys are taken by playback speed)
  useEffect(() => {
    const fromHash = () => {
      const m = /goto=([a-z]+)/i.exec(window.location.hash);
      const p = m && list.find((k) => k.key === m[1].toLowerCase());
      if (p) flyTo(p.x, p.z, p.dist);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [list]);

  return (
    <nav className="goto-bar" aria-label="Go to">
      <span className="goto-label">Go to</span>
      {list.map((p) => (
        <button key={p.key} className={`goto-btn ${p.key === "encode" ? "goto-hero" : ""}`} title={`Teleport to ${p.label}`} onClick={() => flyTo(p.x, p.z, p.dist)}>
          <p.Icon size={15} /> {p.label}
        </button>
      ))}
    </nav>
  );
}
