// Graphics quality: one small store (persisted in localStorage) that every 3D module reads to scale its cost.
// "auto" lets drei's PerformanceMonitor step the level down (and back up) with the frame rate; picking a level by
// hand turns auto off. ?gfx=high|medium|low forces a level for screenshots / benchmarks.
import { create } from "zustand";

export type Quality = "high" | "medium" | "low";
export const QUALITIES: Quality[] = ["high", "medium", "low"];

export interface QualityPreset {
  /** Max device-pixel-ratio. */
  dpr: number;
  shadowMap: number;
  /** PCF (Vogel disk) blur radius in shadow-map texels. */
  shadowRadius: number;
  ao: "full" | "half" | "off";
  godRays: boolean;
  multisampling: number;
  /** Environment map (PMREM from the sky) cube size. */
  envSize: number;
  /** Distance (m) under which people use the detailed model. */
  peopleLod: number;
  /** Rooftop clutter, lamp reflections and other small extras. */
  extras: boolean;
}

export const PRESETS: Record<Quality, QualityPreset> = {
  high: { dpr: 2, shadowMap: 4096, shadowRadius: 3, ao: "full", godRays: true, multisampling: 4, envSize: 128, peopleLod: 220, extras: true },
  medium: { dpr: 1.25, shadowMap: 2048, shadowRadius: 2.5, ao: "half", godRays: true, multisampling: 2, envSize: 64, peopleLod: 130, extras: true },
  low: { dpr: 1, shadowMap: 1024, shadowRadius: 1.5, ao: "off", godRays: false, multisampling: 0, envSize: 32, peopleLod: 60, extras: false },
};

const KEY = "smartcity.gfx";

interface Saved {
  level: Quality;
  auto: boolean;
  tiltShift: boolean;
}

function load(): Saved {
  const def: Saved = { level: "high", auto: true, tiltShift: true };
  if (typeof window === "undefined") return def;
  try {
    const forced = new URLSearchParams(window.location.search).get("gfx");
    const saved = { ...def, ...(JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<Saved>) };
    if (forced && (QUALITIES as string[]).includes(forced)) return { ...saved, level: forced as Quality, auto: false };
    if (!QUALITIES.includes(saved.level)) saved.level = "high";
    return saved;
  } catch {
    return def;
  }
}

function save(s: Saved) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode / blocked storage: the setting just won't persist
  }
}

interface QualityState extends Saved {
  /** Manual pick: sets the level and turns auto off. */
  setLevel: (q: Quality) => void;
  setAuto: (auto: boolean) => void;
  setTiltShift: (on: boolean) => void;
  /** PerformanceMonitor: one step down / up (only while auto). */
  step: (dir: -1 | 1) => void;
}

const snapshot = (s: Saved): Saved => ({ level: s.level, auto: s.auto, tiltShift: s.tiltShift });

export const useQuality = create<QualityState>((set, get) => ({
  ...load(),
  setLevel: (level) => {
    set({ level, auto: false });
    save(snapshot(get()));
  },
  setAuto: (auto) => {
    set({ auto });
    save(snapshot(get()));
  },
  setTiltShift: (tiltShift) => {
    set({ tiltShift });
    save(snapshot(get()));
  },
  step: (dir) => {
    const { auto, level } = get();
    if (!auto) return;
    const i = Math.min(QUALITIES.length - 1, Math.max(0, QUALITIES.indexOf(level) - dir));
    // auto steps are not saved: next visit starts from the saved level again
    if (QUALITIES[i] !== level) set({ level: QUALITIES[i] });
  },
}));

export const usePreset = () => PRESETS[useQuality((s) => s.level)];
