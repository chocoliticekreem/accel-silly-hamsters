// Which world modules are switched off (read by World): the real OSM city (Real* modules) replaces the procedural
// base city once it has drawn. (The satellite / map / photoreal modes were removed: one look, nothing extra loaded.)
import { useRealCity } from "./realcity/data";
import { useWebGPURenderer } from "./renderer";

const NONE: ReadonlySet<string> = new Set();
export const REAL_HIDES: ReadonlySet<string> = new Set(["Buildings", "Streets", "Ground", "Infill", "Surroundings"]);

/** WebGL-only modules (takram atmosphere sky, pmndrs post stack): the WebGPU stage stands in for them. */
const WEBGPU_HIDES = ["Sky", "Glow"];
const REAL_WEBGPU: ReadonlySet<string> = new Set([...REAL_HIDES, ...WEBGPU_HIDES]);
const ONLY_WEBGPU: ReadonlySet<string> = new Set(WEBGPU_HIDES);

export function useModuleHides(): ReadonlySet<string> {
  const real = useRealCity((s) => s.drawn);
  if (useWebGPURenderer) return real ? REAL_WEBGPU : ONLY_WEBGPU;
  return real ? REAL_HIDES : NONE;
}
