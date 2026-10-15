// Module: HeroLandmarks (decorative). Places the procedural Shoreditch hero landmarks (world/models/landmarks.ts):
// XOYO, art'otel, Encode Hub, Boxpark and the Old Street roundabout. A landmark goes where `map.landmarks` says
// (optional, additive: { id, x, z, rotation? } in contract coords) or else at its real-world offset from
// Shoreditch High St station. If that spot is covered by a map building it nudges outwards to the nearest
// free spot, and it turns its street face toward the station so the default camera sees the front.
// Group names are stable (`landmark-xoyo`, `landmark-artotel`, `landmark-encode`, `landmark-boxpark`,
// `landmark-oldstreet`) so other modules (interiors, quick travel) can find and hide them.
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import type { CityMap } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { heroGroup } from "../hero";
import { heroModel } from "../models";
import { setHeroNight } from "../models/materials";

interface MapLandmark {
  id: string;
  x: number;
  z: number;
  /** Scene rotation about y (radians); the model's street face is +z before rotation. */
  rotation?: number;
}

/** Contract-coord offsets (x east, z north) from Shoreditch High St station. */
const FALLBACK: { name: string; match: RegExp; dx: number; dz: number; nudge: boolean }[] = [
  { name: "landmark-xoyo", match: /xoyo/i, dx: -640, dz: 220, nudge: true },
  { name: "landmark-artotel", match: /art.?otel/i, dx: -530, dz: 320, nudge: true },
  { name: "landmark-encode", match: /encode/i, dx: -540, dz: 630, nudge: true },
  { name: "landmark-oldstreet", match: /old.?street/i, dx: -850, dz: 270, nudge: false },
  { name: "landmark-boxpark", match: /boxpark/i, dx: -20, dz: -40, nudge: true },
];

function footprintFree(map: CityMap, x: number, z: number, hw: number, hd: number) {
  return !map.buildings.some((b) => Math.abs(x - b.x) < hw + b.w / 2 - 1 && Math.abs(z - b.z) < hd + b.d / 2 - 1);
}

/** Nearest spot (spiral search, up to ~150 m) where the footprint doesn't overlap a map building. */
function nudge(map: CityMap, x: number, z: number, hw: number, hd: number): [number, number] {
  if (footprintFree(map, x, z, hw, hd)) return [x, z];
  for (let r = 10; r <= 150; r += 10)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (footprintFree(map, px, pz, hw, hd)) return [px, pz];
    }
  return [x, z];
}

function place(map: CityMap) {
  const listed = (map as CityMap & { landmarks?: MapLandmark[] }).landmarks ?? [];
  const station = map.entryPoints.find((e) => e.kind === "station" && /shoreditch/i.test(e.name ?? "")) ??
    map.entryPoints.find((e) => e.kind === "station") ?? { x: 0, z: 0 };
  return FALLBACK.map((f) => {
    const hit = listed.find((l) => f.match.test(l.id));
    const size = heroModel(f.name).size;
    let x = hit?.x ?? station.x + f.dx;
    let z = hit?.z ?? station.z + f.dz;
    // contract → scene, then face the station (scene rotation y = atan2(dx, dz) points +z at it)
    const [sx0, sz0] = toScene(station.x, station.z);
    let [sx, sz] = toScene(x, z);
    let rot = hit?.rotation ?? Math.atan2(sx0 - sx, sz0 - sz);
    // snap to the nearest quarter turn so footprints stay axis-aligned with the nudge test
    if (hit?.rotation === undefined) rot = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
    if (!hit && f.nudge) {
      const quarter = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
      const [hw, hd] = quarter ? [size[2] / 2, size[0] / 2] : [size[0] / 2, size[2] / 2];
      [x, z] = nudge(map, x, z, hw, hd);
      [sx, sz] = toScene(x, z);
    }
    return { name: f.name, x: sx, z: sz, rot };
  });
}

export default function HeroLandmarks() {
  const { map } = useWorld();
  const items = useMemo(() => place(map).map((p) => ({ ...p, object: heroGroup(p.name) })), [map]);

  useFrame(() => setHeroNight(nightLevel(hourOf(useSim.getState().t))));

  return (
    <group name="hero-landmarks">
      {items.map((it) => (
        <primitive key={it.name} object={it.object} position={[it.x, 0, it.z]} rotation={[0, it.rot, 0]} />
      ))}
    </group>
  );
}
