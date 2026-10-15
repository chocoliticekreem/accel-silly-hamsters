// <PhysicsLayer> wraps the city's modules in World.tsx. It renders them untouched and runs the physics runtime
// (Rapier WASM, lazy-loaded into its own chunk) alongside them, behind its own error boundary and Suspense, so a
// slow or failed WASM load never blocks or breaks the city. Modules talk to physics through plain-data APIs
// (crash.ts, craneLoad.ts, traffic.ts), never through Rapier hooks, so they work the same with ?physics=off.
import { lazy, Suspense, type ReactNode } from "react";
import { ModuleBoundary } from "../ModuleBoundary";
import { PHYSICS_ON } from "./engine";

const Runtime = lazy(() => import("./Runtime"));

export function PhysicsLayer({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  return (
    <>
      {children}
      {PHYSICS_ON && enabled && (
        <ModuleBoundary name="Physics">
          <Suspense fallback={null}>
            <Runtime />
          </Suspense>
        </ModuleBoundary>
      )}
    </>
  );
}
