// Module: Sky. Day/night from sim time: background, fog, hemisphere + sun/moon light (with shadows), stars.
// Palette maths is pure in sim/sky.ts; this module only applies it each frame (no allocations).
import { Stars } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, DirectionalLight, Fog, HemisphereLight, type Points } from "three";
import { createSkySample, sampleSky, sunPosition } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";

export default function Sky() {
  const scene = useThree((s) => s.scene);
  const sample = useMemo(createSkySample, []);
  const hemi = useRef<HemisphereLight>(null);
  const sun = useRef<DirectionalLight>(null);
  const stars = useRef<Points>(null);

  useMemo(() => {
    scene.background = new Color("#121a2e");
    // far enough that the City skyline (1–2 km south-west) sits in soft haze, not in a void
    scene.fog = new Fog("#121a2e", 700, 3200);
  }, [scene]);

  useFrame(() => {
    const hour = hourOf(useSim.getState().t);
    sampleSky(hour, sample);
    (scene.background as Color).copy(sample.sky);
    (scene.fog as Fog).color.copy(sample.sky);
    if (hemi.current) {
      hemi.current.color.copy(sample.hemiSky);
      hemi.current.groundColor.copy(sample.hemiGround);
      hemi.current.intensity = sample.hemi;
    }
    if (sun.current) {
      const [x, y, z] = sunPosition(hour);
      sun.current.position.set(x, y, z);
      sun.current.color.copy(sample.sun);
      sun.current.intensity = sample.sunI;
    }
    if (stars.current) {
      const m = stars.current.material as { opacity: number; transparent: boolean };
      m.transparent = true;
      m.opacity = Math.max(0, sample.night - 0.4) / 0.6;
      stars.current.visible = m.opacity > 0.02;
    }
  });

  return (
    <group name="sky">
      <hemisphereLight ref={hemi} args={["#ffffff", "#444444", 1]} />
      <directionalLight
        ref={sun}
        castShadow
        position={[200, 300, -200]}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-300}
        shadow-camera-right={300}
        shadow-camera-top={300}
        shadow-camera-bottom={-300}
        shadow-camera-far={1200}
        shadow-bias={-0.0005}
      />
      <Stars ref={stars} radius={700} depth={120} count={2500} factor={6} saturation={0} fade speed={0.4} />
    </group>
  );
}
