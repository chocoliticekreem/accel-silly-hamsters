// Provides @takram/three-atmosphere's context to every module. The scattering look-up tables are generated on the
// GPU once per renderer and kept for its lifetime (StrictMode's mount → unmount → mount would otherwise dispose
// the render targets mid-generation and leave a black sky).
import { useThree } from "@react-three/fiber";
import { PrecomputedTexturesGenerator } from "@takram/three-atmosphere";
import { Atmosphere } from "@takram/three-atmosphere/r3f";
import { useMemo, type ReactNode } from "react";
import type { WebGLRenderer } from "three";
import { seal, track } from "../state/loading";
import { PerfProbe } from "./PerfProbe";
import { RenderTuning } from "./RenderTuning";

const Q = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const STATS = Q.has("stats");
/** ?notune: renderer tuning off (A/B benchmarks). */
const TUNE = !Q.has("notune");

const generators = new WeakMap<WebGLRenderer, PrecomputedTexturesGenerator>();

export function AtmosphereRoot({ children }: { children: ReactNode }) {
  const gl = useThree((s) => s.gl);
  const generator = useMemo(() => {
    let g = generators.get(gl);
    if (!g) {
      g = new PrecomputedTexturesGenerator(gl);
      generators.set(gl, g);
      // The generator steps through its ~hundreds of GPU passes on requestIdleCallback, which a busy page (the
      // city renders every frame) grants rarely: tens of seconds of black sky. Run them all now, synchronously
      // (a one-off ~100 ms hitch at startup), then put requestIdleCallback back.
      const idle = window.requestIdleCallback;
      window.requestIdleCallback = ((cb: IdleRequestCallback) => {
        cb({ didTimeout: true, timeRemaining: () => 0 });
        return 0;
      }) as typeof window.requestIdleCallback;
      try {
        track("lighting", "atmosphere", g.update(), { optional: true }).catch((e: unknown) => console.error("atmosphere LUTs", e));
      } finally {
        window.requestIdleCallback = idle;
      }
    }
    seal("lighting");
    return g;
  }, [gl]);
  return (
    <Atmosphere textures={generator.textures} correctAltitude>
      {TUNE && <RenderTuning />}
      {STATS && <PerfProbe />}
      {children}
    </Atmosphere>
  );
}
