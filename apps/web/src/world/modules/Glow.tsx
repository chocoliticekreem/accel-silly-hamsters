// Module: Glow. The post stack, scaled by the Graphics quality level:
// N8AO ambient occlusion → aerial perspective (takram atmosphere: real haze/inscatter by distance) → god rays from
// the sun disc → HDR mipmap bloom (windows, lamps, neon, headlights, the sun) → optional tilt-shift (miniature look)
// → AgX tone mapping (+ a touch of saturation back) → light vignette → a whisper of film grain → SMAA on Low
// (no MSAA there). Everything renders into half-float buffers, so emissive > 1 stays HDR until the tone mapper.
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, GodRays, HueSaturation, N8AO, Noise, SMAA, TiltShift2, ToneMapping, Vignette } from "@react-three/postprocessing";
import { AerialPerspective } from "@takram/three-atmosphere/r3f";
import { BlendFunction, KernelSize, ToneMappingMode, type BloomEffect, type Effect, type GodRaysEffect } from "postprocessing";
import { useEffect, useRef, useState } from "react";
import type { Mesh, Vector3 } from "three";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { gainAerial } from "../atmosphere";
import { PRESETS, useQuality } from "../quality";

/** Debug: ?nofx=ao,aerial,rays,bloom,tilt,grade switches single effects off (profiling). */
const NOFX = new Set((typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("nofx") ?? "").split(","));

export default function Glow() {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const level = useQuality((s) => s.level);
  const tilt = useQuality((s) => s.tiltShift);
  const p = PRESETS[level];
  const bloom = useRef<BloomEffect>(null);
  const rays = useRef<GodRaysEffect>(null);
  const [sun, setSun] = useState<Mesh | null>(null);

  // Sky publishes its sun disc on the scene; pick it up once it exists
  useFrame(() => {
    const s = (scene.userData.sunDisc as Mesh | undefined) ?? null;
    if (s !== sun) setSun(s);
  });

  useEffect(() => {
    gl.toneMappingExposure = 1.15;
  }, [gl]);

  useFrame(() => {
    const night = nightLevel(hourOf(useSim.getState().t));
    const b = bloom.current;
    if (b) {
      b.intensity = 0.5 + 0.8 * night;
      b.luminanceMaterial.threshold = 0.95 - 0.35 * night;
    }
    const r = rays.current;
    const dir = scene.userData.sunDir as Vector3 | undefined;
    if (r && dir) {
      const low = 1 - Math.min(1, Math.max(0, dir.y) / 0.5);
      r.godRaysMaterial.weight = 0.25 + 0.55 * low;
      r.godRaysMaterial.exposure = 0.35 + 0.4 * low;
    }
  });

  const on = <T,>(cond: boolean, el: T) => (cond ? el : <></>);
  return (
    <EffectComposer multisampling={p.multisampling} key={level}>
      {on(p.ao !== "off" && !NOFX.has("ao"), <N8AO halfRes quality={p.ao === "full" ? "medium" : "performance"} aoRadius={5} distanceFalloff={1.2} intensity={2.2} color="#1b1a26" />)}
      {on(p.aerial && !NOFX.has("aerial"), <AerialPerspective ref={(e: Effect | null) => { if (e) gainAerial(e); }} />)}
      {on(p.godRays && !!sun && !NOFX.has("rays"), <GodRays ref={rays} sun={sun!} samples={level === "high" ? 40 : 28} density={0.94} decay={0.92} weight={0.45} exposure={0.45} clampMax={1} blur kernelSize={KernelSize.SMALL} />)}
      <Bloom ref={bloom} mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.25} intensity={0.6} radius={0.75} levels={level === "high" ? 7 : 5} />
      {on(tilt && level !== "low" && !NOFX.has("tilt"), <TiltShift2 blur={0.09} taper={0.55} start={[0, 0.48]} end={[1, 0.48]} samples={level === "high" ? 8 : 6} />)}
      <ToneMapping mode={ToneMappingMode.AGX} />
      <HueSaturation saturation={0.18} />
      <Vignette eskil={false} offset={0.3} darkness={0.45} />
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.18} />
      {on(p.multisampling === 0, <SMAA />)}
    </EffectComposer>
  );
}
