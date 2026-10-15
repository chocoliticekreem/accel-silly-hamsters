import { Component, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Group, Material, Mesh } from "three";
import { noteSkipped } from "../state/loading";

// One broken module must never take down the whole city: it just disappears (renders nothing) and logs.
export class ModuleBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[city] module ${this.props.name} crashed`, error);
    noteSkipped(this.props.name);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * A module's own group: on unmount (layer switched off, world closed) the GPU buffers of the geometries and
 * materials it drew are released. Done in an idle moment, after the frame that removed them. Anything shared with
 * a module still on screen is simply uploaded again on its next draw, so this is always safe.
 */
export function ModuleScope({ name, children }: { name: string; children: ReactNode }) {
  const ref = useRef<Group>(null);
  useLayoutEffect(() => {
    const g = ref.current;
    return () => {
      // layout cleanups run before the group leaves the scene: collect now, dispose later
      if (!g) return;
      const geos = new Set<{ dispose(): void }>();
      const mats = new Set<Material>();
      g.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) geos.add(m.geometry);
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x));
      });
      const run = () => {
        geos.forEach((x) => x.dispose());
        mats.forEach((x) => x.dispose());
      };
      if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 2000 });
      else setTimeout(run, 200);
    };
  }, []);
  return (
    <group ref={ref} name={`module-${name}`}>
      {children}
    </group>
  );
}
