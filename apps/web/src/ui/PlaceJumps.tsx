// "Go to" chips for the places people look for: the camera flies there (world/flyTo). Positions from sim/london.ts
// (OSM), or the backend's map.landmarks / station entry points when it serves them.
import { MapPin } from "lucide-react";
import { useMemo } from "react";
import { ELL_STATIONS, OLD_STREET, resolveLandmarks } from "../sim/london";
import { useMap } from "../state/data";
import { flyTo } from "../world/flyTo";

interface Place {
  label: string;
  x: number;
  z: number;
  dist: number;
  y?: number;
}

export function PlaceJumps() {
  const map = useMap().data;
  const places = useMemo<Place[]>(() => {
    if (!map) return [];
    const lm = resolveLandmarks(map);
    const at = (key: string) => lm.find((l) => l.key === key);
    const shs = map.entryPoints.find((e) => e.kind === "station" && /shoreditch/i.test(e.name ?? "")) ?? map.entryPoints.find((e) => e.kind === "station");
    const hoxton = ELL_STATIONS.find((s) => s.name === "Hoxton")!;
    const os = at("oldstreet") ?? OLD_STREET;
    const out: Place[] = [{ label: "Old Street", x: os.x, z: os.z, dist: 170 }];
    if (shs) out.push({ label: "Shoreditch High St", x: shs.x, z: shs.z, dist: 170, y: 6 });
    out.push({ label: "Hoxton", x: hoxton.x, z: hoxton.z, dist: 170, y: 6 });
    const art = at("artotel");
    if (art) out.push({ label: "art'otel", x: art.x, z: art.z, dist: 230, y: 20 });
    const encode = at("encode");
    if (encode) out.push({ label: "Encode Hub", x: encode.x, z: encode.z, dist: 170 });
    return out;
  }, [map]);
  if (!places.length) return null;
  return (
    <div className="tool-row place-jumps" role="group" aria-label="Go to a place">
      {places.map((p) => (
        <button key={p.label} className="chip" onClick={() => flyTo(p.x, p.z, p.dist, p.y ?? 0)} title={`Fly to ${p.label}`}>
          <MapPin size={13} aria-hidden /> {p.label}
        </button>
      ))}
    </div>
  );
}
