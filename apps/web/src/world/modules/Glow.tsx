// Module: Glow. Post-processing: bloom that swells at night (lit windows, lamps, neon) plus a soft vignette.
import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useRef } from "react";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";

type BloomFx = { intensity: number };

export default function Glow() {
  const bloom = useRef<BloomFx>(null);
  useFrame(() => {
    if (bloom.current) bloom.current.intensity = 0.25 + 1.1 * nightLevel(hourOf(useSim.getState().t));
  });
  return (
    <EffectComposer multisampling={4}>
      <Bloom ref={bloom as never} mipmapBlur luminanceThreshold={0.75} luminanceSmoothing={0.2} intensity={0.6} />
      <Vignette eskil={false} offset={0.25} darkness={0.55} />
    </EffectComposer>
  );
}
