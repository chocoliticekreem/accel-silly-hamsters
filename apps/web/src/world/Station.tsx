// Shoreditch High Street station: the grey concrete box on the viaduct that encloses both platforms, its
// lightweight roof and long strip windows (the trains of world/modules/Overground show through them), the legs it
// stands on, and the glazed street-level ticket hall beside Braithwaite Street. Geometry: world/shoreditch.
// Drawn by the Buildings module for the map's `kind: "station"` building; local +x = long axis.
// Night: window glass picks up the warm interior light, the light lines and signs glow (hero materials).
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import { DoubleSide, MeshStandardMaterial } from "three";
import type { Building, CityMap } from "../api/contract";
import { nightLevel } from "../sim/sky";
import { hourOf } from "../sim/time";
import { useSim } from "../state/store";
import { setHeroNight } from "./models/materials";
import { modelObject, stationSite } from "./shoreditch/site";

export { PLATFORM_IN, PLATFORM_OUT, PLATFORM_TOP } from "./shoreditch/stationModel";
export { streetGaps } from "./shoreditch/site";

const OVERGROUND_ORANGE = "#ee7c0e";

export function Roundel({ y = 0, scale = 1, ring = OVERGROUND_ORANGE }: { y?: number; scale?: number; ring?: string }) {
  return (
    <group position-y={y} scale={scale}>
      <mesh>
        <torusGeometry args={[2.2, 0.55, 10, 28]} />
        <meshStandardMaterial color={ring} emissive={ring} emissiveIntensity={0.4} />
      </mesh>
      <mesh rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[1.7, 1.7, 0.2, 24]} />
        <meshStandardMaterial color="#f4f4f4" emissive="#ffffff" emissiveIntensity={0.15} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} position-z={0}>
        <boxGeometry args={[6, 0.42, 1.1]} />
        <meshStandardMaterial color="#0019a8" emissive="#3048ff" emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

export function Station({ b, map }: { b: Building; map: CityMap }) {
  const site = useMemo(() => stationSite(map, b), [map, b]);
  const object = useMemo(() => (site ? modelObject(site.parts.model) : null), [site]);
  const glass = useMemo(
    () =>
      new MeshStandardMaterial({
        color: "#a9c0cd",
        roughness: 0.06,
        metalness: 0.35,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: DoubleSide,
        emissive: "#ffdca8",
        emissiveIntensity: 0,
      }),
    [],
  );

  useFrame(() => {
    const n = nightLevel(hourOf(useSim.getState().t));
    setHeroNight(n);
    // lit interior: the glazing takes a warm glow after dark (and a little more opacity so it reads as lit glass)
    glass.emissiveIntensity = 0.32 * n;
    glass.opacity = 0.3 + 0.12 * n;
  });

  if (!site || !object) return null;
  return (
    <group name="station" position={site.pos} rotation-y={site.rotY}>
      <primitive object={object} />
      <mesh geometry={site.parts.windows} material={glass} renderOrder={2} />
    </group>
  );
}
