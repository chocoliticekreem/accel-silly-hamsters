// <PhysicsLayer> wraps the city's modules in World.tsx. It renders them untouched and runs the physics runtime
// (Rapier WASM, lazy-loaded into its own chunk) alongside them, behind its own error boundary and Suspense, so a
// slow or failed WASM load never blocks or breaks the city. Modules talk to physics through plain-data APIs
// (crash.ts, craneLoad.ts, traffic.ts), never through Rapier hooks, so they work the same with ?physics=off.
import { lazy, Suspense, type ReactNode } from "react";
import { ModuleBoundary } from "../ModuleBoundary";
import { PHYSICS_ON } from "./engine";
import { track } from "../../state/loading";

// the loading screen counts the Rapier chunk under "People and traffic" (a failed load just leaves physics off)
const Runtime = lazy(() => track("people", "physics", import("./Runtime"), { weight: 2, optional: true }));

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
