// Module: Glow. The post stack, scaled by the Graphics quality level:
// N8AO ambient occlusion → god rays from the sun disc → HDR bloom (windows, lamps, neon, headlights, the sun) →
// optional tilt-shift (miniature look) → ACES filmic tone mapping → vignette → a whisper of film grain.
// Everything renders into half-float buffers, so emissive > 1 stays HDR until the tone mapper.
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, GodRays, N8AO, Noise, TiltShift2, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, KernelSize, ToneMappingMode, type BloomEffect, type GodRaysEffect } from "postprocessing";
import { useEffect, useRef, useState } from "react";
import type { Mesh } from "three";
import { sunDirection, nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { PRESETS, useQuality } from "../quality";

export default function Glow() {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const level = useQuality((s) => s.level);
  const tilt = useQuality((s) => s.tiltShift);
  const p = PRESETS[level];
  const bloom = useRef<BloomEffect>(null);
  const rays = useRef<GodRaysEffect>(null);
  const [sun, setSun] = useState<Mesh | null>(null);
  const dir = useRef<[number, number, number]>([0, 1, 0]);

  // Sky publishes its sun disc on the scene; pick it up once it exists
  useFrame(() => {
    const s = (scene.userData.sunDisc as Mesh | undefined) ?? null;
    if (s !== sun) setSun(s);
  });

  useEffect(() => {
    gl.toneMappingExposure = 1.05;
  }, [gl]);

  useFrame(() => {
    const hour = hourOf(useSim.getState().t);
    const night = nightLevel(hour);
    const b = bloom.current;
    if (b) {
      b.intensity = 0.45 + 0.75 * night;
      b.luminanceMaterial.threshold = 0.95 - 0.35 * night;
    }
    const r = rays.current;
    if (r) {
      sunDirection(hour, dir.current);
      const low = 1 - Math.min(1, Math.max(0, dir.current[1]) / 0.5);
      r.godRaysMaterial.weight = 0.25 + 0.55 * low;
      r.godRaysMaterial.exposure = 0.35 + 0.35 * low;
    }
  });

  return (
    <EffectComposer multisampling={p.multisampling} key={level}>
      {p.ao !== "off" ? (
        <N8AO halfRes={p.ao === "half"} quality={p.ao === "full" ? "medium" : "performance"} aoRadius={5} distanceFalloff={1.2} intensity={2.2} color="#1b1a26" />
      ) : (
        <></>
      )}
      {p.godRays && sun ? (
        <GodRays ref={rays} sun={sun} samples={p.ao === "full" ? 48 : 32} density={0.94} decay={0.92} weight={0.45} exposure={0.45} clampMax={1} blur kernelSize={KernelSize.SMALL} />
      ) : (
        <></>
      )}
      <Bloom ref={bloom} mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.25} intensity={0.6} radius={0.75} levels={level === "low" ? 5 : 7} />
      {tilt && level !== "low" ? <TiltShift2 blur={0.09} taper={0.55} start={[0, 0.48]} end={[1, 0.48]} samples={level === "high" ? 8 : 6} /> : <></>}
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette eskil={false} offset={0.3} darkness={0.5} />
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.18} />
    </EffectComposer>
  );
}
