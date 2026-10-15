// Module: HeroLandmarks (decorative). Places the procedural Shoreditch hero landmarks (world/models/landmarks.ts):
// XOYO, art'otel, Encode Hub and Boxpark, at the positions sim/london.ts resolveLandmarks gives (map.landmarks,
// else real OSM fallbacks; XOYO sits on its club building). When a landmark stands on one of the map's buildings
// the model is aligned and scaled to cover that footprint. Street faces turn toward Shoreditch High St station.
// (Old Street has its own module; the landmark-oldstreet model stays available in world/models.)
// Group names are stable (`landmark-xoyo`, `landmark-artotel`, `landmark-encode`, `landmark-boxpark`) so other
// modules (interiors, quick travel) can find and hide them.
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import type { CityMap } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { resolveLandmarks, type LandmarkKey } from "../../sim/london";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { heroGroup } from "../hero";
import { heroModel } from "../models";
import { ARTOTEL_CENTRE } from "../models/landmarks";
import { setHeroNight } from "../models/materials";

/** Fallback contract positions (x east, z north) when neither the map nor resolveLandmarks knows the place. */
const SPOTS: { name: string; key: LandmarkKey | "xoyo"; x: number; z: number }[] = [
  { name: "landmark-xoyo", key: "xoyo", x: -786, z: 248 }, // store c4, building b72 (Cowper St)
  { name: "landmark-artotel", key: "artotel", x: -601, z: 339 },
  { name: "landmark-encode", key: "encode", x: -645, z: 481 },
  { name: "landmark-boxpark", key: "boxpark", x: -124, z: 26 },
];

interface Placed {
  name: string;
  x: number;
  z: number;
  rot: number;
  scale: [number, number, number];
}

function place(map: CityMap): Placed[] {
  const lms = resolveLandmarks(map);
  const station = map.entryPoints.find((e) => e.kind === "station" && /shoreditch/i.test(e.name ?? "")) ??
    map.entryPoints.find((e) => e.kind === "station") ?? { x: 0, z: 0 };
  const [sx0, sz0] = toScene(station.x, station.z);
  return SPOTS.map((spot) => {
    const lm = lms.find((l) => l.key === spot.key);
    // the map building this landmark stands on, if any (XOYO's club building, Boxpark's container block)
    const xoyoStore = spot.key === "xoyo" ? map.stores.find((s) => /xoyo/i.test(s.name) || s.id === "c4") : undefined;
    const bid = lm?.buildingId ?? xoyoStore?.buildingId ?? (spot.key === "xoyo" ? "b72" : undefined);
    const b = bid ? map.buildings.find((x) => x.id === bid) : undefined;
    // art'otel is modelled on its OSM footprint in true orientation: tower centre, no turn, no fit
    if (spot.key === "artotel") {
      const [ax, az] = toScene(ARTOTEL_CENTRE.x, ARTOTEL_CENTRE.z);
      return { name: spot.name, x: ax, z: az, rot: 0, scale: [1, 1, 1] as [number, number, number] };
    }
    const cx = b?.x ?? lm?.x ?? spot.x;
    const cz = b?.z ?? lm?.z ?? spot.z;
    const [x, z] = toScene(cx, cz);
    // street face toward the station, snapped to a quarter turn
    let rot = Math.round(Math.atan2(sx0 - x, sz0 - z) / (Math.PI / 2)) * (Math.PI / 2);
    const size = heroModel(spot.name).size;
    let scale: [number, number, number] = [1, 1, 1];
    if (b) {
      // stand on the building: long axes aligned, footprint covering it, at least as tall
      const modelLongX = size[0] >= size[2];
      const bLongX = b.w >= b.d;
      const quarter = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
      if (modelLongX !== quarter !== bLongX) rot += Math.PI / 2;
      const q = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
      const [fw, fd] = q ? [b.d, b.w] : [b.w, b.d];
      const sxz = Math.max(0.6, Math.min(1.6, Math.max((fw + 1) / size[0], (fd + 1) / size[2])));
      scale = [sxz, Math.max(1, (b.h + 0.5) / size[1]), sxz];
    }
    return { name: spot.name, x, z, rot, scale };
  });
}

export default function HeroLandmarks() {
  const { map } = useWorld();
  const items = useMemo(() => place(map).map((p) => ({ ...p, object: heroGroup(p.name) })), [map]);

  useFrame(() => setHeroNight(nightLevel(hourOf(useSim.getState().t))));

  return (
    <group name="hero-landmarks">
      {items.map((it) => (
        <primitive key={it.name} object={it.object} position={[it.x, 0, it.z]} rotation={[0, it.rot, 0]} scale={it.scale} />
      ))}
    </group>
  );
}
