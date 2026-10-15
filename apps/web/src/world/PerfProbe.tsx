// ?stats=1: a small readout of renderer.info (draw calls, triangles, programs) and frame time, next to drei's
// <Stats>. Also mirrors the numbers on window.__perf so benchmarks can read them. Reads at the start of each frame,
// when info holds the whole previous frame (autoReset is off while the probe runs; it resets info itself).
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { activeBackend } from "./renderer";

interface Perf {
  backend: string;
  calls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  frameMs: number;
  /** worst frame in the last second */
  worstMs: number;
  /** shadow-map renders per frame */
  shadowPerFrame: number;
}

const shadowPasses = { n: 0, frames: 0 };

export function PerfProbe() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    // for profiling scripts: walk the scene, count meshes by module, etc.
    Object.assign(window as object, { __gl: gl, __scene: scene, __camera: camera });
    // count the whole frame (scene + every post pass), not just the last render call
    const info = gl.info as unknown as { autoReset: boolean };
    const was = info.autoReset;
    info.autoReset = false;
    // shadow-map passes that actually drew this frame
    const sm = (gl as unknown as { shadowMap?: { render?: (...a: unknown[]) => void; needsUpdate: boolean; autoUpdate: boolean } }).shadowMap;
    const orig = sm?.render;
    if (sm && orig) {
      sm.render = function (this: unknown, ...a: unknown[]) {
        if (sm.autoUpdate || sm.needsUpdate) shadowPasses.n++;
        return orig.apply(this, a);
      };
    }
    return () => {
      info.autoReset = was;
      if (sm && orig) sm.render = orig;
    };
  }, [gl, scene, camera]);
  const el = useMemo(() => {
    const d = document.createElement("div");
    Object.assign(d.style, {
      position: "fixed",
      left: "84px",
      top: "0",
      zIndex: "10000",
      font: "11px/1.35 ui-monospace, Menlo, monospace",
      color: "#cfe",
      background: "rgba(0,8,16,0.72)",
      padding: "3px 6px",
      pointerEvents: "none",
      whiteSpace: "pre",
    });
    return d;
  }, []);
  useEffect(() => {
    document.body.appendChild(el);
    return () => el.remove();
  }, [el]);

  const acc = useMemo(() => ({ last: 0, sum: 0, n: 0, worst: 0, at: 0, perf: null as Perf | null }), []);
  useFrame(() => {
    const now = performance.now();
    const dt = acc.last ? now - acc.last : 0;
    acc.last = now;
    shadowPasses.frames++;
    if (dt > 0 && dt < 1000) {
      acc.sum += dt;
      acc.n++;
      acc.worst = Math.max(acc.worst, dt);
    }
    if (now - acc.at < 500) {
      gl.info.reset();
      return;
    }
    const info = gl.info as unknown as {
      render: { calls?: number; drawCalls?: number; triangles: number };
      memory: { geometries: number; textures: number };
      programs?: unknown[] | null;
    };
    const p: Perf = {
      backend: activeBackend,
      calls: info.render.calls ?? info.render.drawCalls ?? 0,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      frameMs: acc.n ? +(acc.sum / acc.n).toFixed(2) : 0,
      worstMs: +acc.worst.toFixed(1),
      shadowPerFrame: +(shadowPasses.n / Math.max(1, shadowPasses.frames)).toFixed(2),
    };
    shadowPasses.n = 0;
    shadowPasses.frames = 0;
    (window as unknown as { __perf: Perf }).__perf = p;
    el.textContent = `${p.backend}  ${p.calls} calls  ${(p.triangles / 1e6).toFixed(2)}M tris  ${p.programs} progs\n${p.frameMs} ms avg  ${p.worstMs} ms worst  ${p.geometries} geo  ${p.textures} tex  ${p.shadowPerFrame} shadow/frame`;
    acc.at = now;
    acc.sum = 0;
    acc.n = 0;
    acc.worst = 0;
    gl.info.reset();
  }, -100);
  return null;
}
