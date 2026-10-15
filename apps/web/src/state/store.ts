// UI + playback state (low-frequency things, plus the clock `t`). Per-frame 3D data lives in modules, not here.
// Deep links: ?run=3&store=s1&t=7320 open straight onto a moment (used by the report's "replay" evidence link).
import { create } from "zustand";
import { RUN_MINUTES } from "../api/contract";

export type Speed = 1 | 10 | 100;
export type Panel = null | "history" | "area" | "agents";
/** "satellite" / "map" = free keyless aerial / OSM basemap draped as the ground (world/modules/MapGround.tsx);
 *  "photoreal" = Google Photorealistic 3D Tiles (world/modules/Photoreal.tsx), needs VITE_GOOGLE_MAPS_API_KEY. */
export type GraphicsMode = "stylised" | "satellite" | "map" | "photoreal";
const GFX_MODES: readonly GraphicsMode[] = ["stylised", "satellite", "map", "photoreal"];
const GFX_KEY = "scs.graphicsMode.v2"; // v2: default back to stylised

/** Sim minutes per real second. 100× plays 14 days in one minute (spec). */
export const RATE: Record<Speed, number> = { 100: RUN_MINUTES / 60, 10: RUN_MINUTES / 600, 1: RUN_MINUTES / 6000 };

interface SimState {
  run: number;
  t: number;
  playing: boolean;
  speed: Speed;
  selectedStoreId: string | null;
  hoveredStoreId: string | null;
  panel: Panel;
  compare: boolean;
  toast: { id: number; text: string } | null;
  /** Guided demo step (index into DEMO_STEPS), or null when the demo is off. */
  demo: number | null;
  graphicsMode: GraphicsMode;

  setRun: (run: number) => void;
  setT: (t: number) => void;
  setPlaying: (p: boolean) => void;
  togglePlay: () => void;
  setSpeed: (s: Speed) => void;
  selectStore: (id: string | null) => void;
  hoverStore: (id: string | null) => void;
  openPanel: (p: Panel) => void;
  setCompare: (c: boolean) => void;
  showToast: (text: string) => void;
  setDemo: (step: number | null) => void;
  setGraphicsMode: (m: GraphicsMode) => void;
  /** Jump to a run (and optionally a moment) and start playing: "click a point → replay that run". */
  replay: (run: number, t?: number) => void;
}

function fromUrl() {
  const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
  return { run: num("run"), t: num("t"), store: q.get("store") ?? null };
}

const initial = fromUrl();
/** True when the URL picked the run (?run=), so the app must not snap to another one. */
export const RUN_FROM_URL = initial.run !== undefined;
let toastSeq = 0;

function readGraphicsMode(): GraphicsMode {
  try {
    const v = typeof window !== "undefined" ? localStorage.getItem(GFX_KEY) : null;
    return GFX_MODES.find((m) => m === v) ?? "stylised";
  } catch {
    return "stylised";
  }
}

export const useSim = create<SimState>((set, get) => ({
  run: initial.run ?? 1,
  // start on the first evening, so the opening shot shows lights
  t: initial.t ?? 4 * 1440 + 21 * 60,
  playing: false,
  speed: 10,
  selectedStoreId: initial.store,
  hoveredStoreId: null,
  panel: null,
  compare: false,
  toast: null,
  demo: null,
  graphicsMode: readGraphicsMode(),

  setRun: (run) => set({ run }),
  setT: (t) => set({ t: Math.max(0, Math.min(RUN_MINUTES, t)) }),
  setPlaying: (playing) => set({ playing }),
  togglePlay: () => {
    const { playing, t } = get();
    // pressing play at the very end starts over
    set({ playing: !playing, t: !playing && t >= RUN_MINUTES ? 0 : t });
  },
  setSpeed: (speed) => set({ speed }),
  selectStore: (selectedStoreId) => set({ selectedStoreId }),
  hoverStore: (hoveredStoreId) => set({ hoveredStoreId }),
  openPanel: (panel) => set({ panel }),
  setCompare: (compare) => set({ compare }),
  showToast: (text) => set({ toast: { id: ++toastSeq, text } }),
  setDemo: (demo) => set({ demo }),
  setGraphicsMode: (graphicsMode) => {
    try { localStorage.setItem(GFX_KEY, graphicsMode); } catch { /* private mode: not remembered */ }
    set({ graphicsMode });
  },
  replay: (run, t) => set({ run, t: t ?? 0, playing: true, panel: null }),
}));
