// The 3D city. Each module is independent and wrapped so one failure can't break the scene.
// Add a module: create world/modules/<Name>.tsx (default export, reads useWorld() + useSim), then list it in MODULES.
// Debug: ?only=Sky,Ground,Streets or ?skip=Glow,Agents switch modules off.
import { Canvas } from "@react-three/fiber";
import { AdaptiveDpr, PerformanceMonitor } from "@react-three/drei";
import { Suspense, useMemo, useState, type ComponentType } from "react";
import type { CityMap, RunStores } from "../api/contract";
import { ModuleBoundary } from "./ModuleBoundary";
import { newLive, WorldContext, type WorldCtx } from "./context";
import Agents from "./modules/Agents";
import Buildings from "./modules/Buildings";
import CameraRig from "./modules/CameraRig";
import Glow from "./modules/Glow";
import Ground from "./modules/Ground";
import Heatmap from "./modules/Heatmap";
import Infill from "./modules/Infill";
import Sky from "./modules/Sky";
import Stores from "./modules/Stores";
import StreetLights from "./modules/StreetLights";
import Footfall from "./modules/Footfall";
import Skyline from "./modules/Skyline";
import StreetDressing from "./modules/StreetDressing";
import StreetEvents from "./modules/StreetEvents";
import Streets from "./modules/Streets";
import Traffic from "./modules/Traffic";

export const MODULES: Record<string, ComponentType> = {
  Sky,
  Ground,
  Heatmap,
  Skyline,
  Streets,
  Buildings,
  Infill,
  Stores,
  StreetLights,
  StreetDressing,
  StreetEvents,
  Traffic,
  Footfall,
  Agents,
  CameraRig,
  Glow,
};

function enabledModules() {
  const q = new URLSearchParams(window.location.search);
  const list = (k: string) => (q.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const only = list("only");
  const skip = new Set(list("skip"));
  return Object.keys(MODULES).filter((m) => (only.length ? only.includes(m) : true) && !skip.has(m));
}

export interface WorldProps {
  map: CityMap;
  run: number;
  stores: RunStores | undefined;
  cameraGroup?: string;
  interactive?: boolean;
  /** Called with the live bag so overlays (e.g. "people on street") can read it. */
  onLive?: (live: WorldCtx["live"]) => void;
}

export default function World({ map, run, stores, cameraGroup = "main", interactive = true, onLive }: WorldProps) {
  const [dpr, setDpr] = useState(1.5);
  const [enabled] = useState(enabledModules);
  const live = useMemo(() => {
    const l = newLive();
    onLive?.(l);
    return l;
    // one bag per mounted world
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ctx = useMemo<WorldCtx>(() => ({ map, run, stores, cameraGroup, live, interactive }), [map, run, stores, cameraGroup, live, interactive]);

  return (
    <Canvas
      shadows
      dpr={dpr}
      camera={{ position: [190, 105, -230], fov: 42, near: 1, far: 4000 }}
      gl={{ antialias: true, powerPreference: "high-performance", stencil: false }}
    >
      <PerformanceMonitor onIncline={() => setDpr(Math.min(2, window.devicePixelRatio))} onDecline={() => setDpr(1)} />
      <AdaptiveDpr pixelated />
      <WorldContext.Provider value={ctx}>
        {Object.entries(MODULES)
          .filter(([name]) => enabled.includes(name))
          .map(([name, M]) => (
            <ModuleBoundary key={name} name={name}>
              <Suspense fallback={null}>
                <M />
              </Suspense>
            </ModuleBoundary>
          ))}
      </WorldContext.Provider>
    </Canvas>
  );
}
