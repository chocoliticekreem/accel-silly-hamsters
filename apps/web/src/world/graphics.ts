// Which world modules are switched off (read by World): the real OSM city (Real* modules) replaces the procedural
// base city once it has drawn. (The satellite / map / photoreal modes were removed: one look, nothing extra loaded.)
import { useRealCity } from "./realcity/data";

const NONE: ReadonlySet<string> = new Set();
export const REAL_HIDES: ReadonlySet<string> = new Set(["Buildings", "Streets", "Ground", "Infill", "Surroundings"]);

export function useModuleHides(): ReadonlySet<string> {
  const real = useRealCity((s) => s.drawn);
  return real ? REAL_HIDES : NONE;
}
