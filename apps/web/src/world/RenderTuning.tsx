// Renderer-level tuning that every module benefits from (WebGL path):
// - Shadow maps render once per frame at most. With autoUpdate on, three re-renders the sun's shadow map on every
//   gl.render() of a lit scene, and the post stack renders the scene more than once a frame. On Medium / Low the map
//   also refreshes every 2nd / 3rd frame while the camera is still (moving cars and people stay smooth at 20–30 Hz);
//   any camera move refreshes it immediately, so the follow-the-camera shadow box never lags.
// - Shader precompile: compileAsync (KHR_parallel_shader_compile) over the whole scene as each loading stage seals,
//   tracked as a loading-screen task, so programs (including ones outside the first view) are built behind the loader.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Quaternion, Vector3, type WebGLRenderer } from "three";
import { useQuality } from "./quality";
import { task, useLoading, type StageId } from "../state/loading";

/** Loading stages whose sealing triggers a precompile (each adds a batch of new materials). */
const PRECOMPILE: StageId[] = ["city", "landmarks", "people"];

const EVERY = { high: 1, medium: 2, low: 3 } as const;

export function RenderTuning() {
  const gl = useThree((s) => s.gl) as WebGLRenderer;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const level = useQuality((s) => s.level);
  const webgl = (gl as { isWebGLRenderer?: boolean }).isWebGLRenderer === true;

  useEffect(() => {
    if (!webgl) return;
    const sm = gl.shadowMap;
    sm.autoUpdate = false;
    sm.needsUpdate = true;
    return () => {
      sm.autoUpdate = true;
    };
  }, [gl, webgl]);

  const st = useMemo(() => ({ frame: 0, pos: new Vector3(Infinity, 0, 0), quat: new Quaternion() }), []);
  useFrame(() => {
    if (!webgl) return;
    st.frame++;
    const moved = !camera.position.equals(st.pos) || !camera.quaternion.equals(st.quat);
    if (moved) {
      st.pos.copy(camera.position);
      st.quat.copy(camera.quaternion);
    }
    if (moved || st.frame % EVERY[level] === 0) gl.shadowMap.needsUpdate = true;
  }, -60);

  // Shader precompile behind the loading screen: as each loading stage seals (its modules have all mounted), a
  // "shaders" task joins that stage and compileAsync builds every program the scene now needs, in parallel
  // (KHR_parallel_shader_compile), so the loader only lifts once they're ready and the first frames don't hitch.
  // Capped at 8 s per stage: the loader never waits forever on a slow driver.
  useEffect(() => {
    if (!webgl || typeof gl.compileAsync !== "function") return;
    let alive = true;
    const started = new Set<StageId>();
    const compile = (stage: StageId) => {
      const t = task(stage, "shaders", 1);
      // a painted frame first, so the modules that just mounted have added their meshes
      requestAnimationFrame(() => {
        if (!alive) return t.done();
        const timeout = new Promise<void>((res) => window.setTimeout(res, 8000));
        Promise.race([gl.compileAsync(scene, camera).catch(() => undefined), timeout]).finally(() => t.done());
      });
    };
    const check = (sealed: Record<StageId, boolean>) => {
      if (useLoading.getState().dismissed) return;
      for (const s of PRECOMPILE) if (sealed[s] && !started.has(s)) {
        started.add(s);
        compile(s);
      }
    };
    check(useLoading.getState().sealed);
    // zustand listeners run inside setState: the task joins the stage before any frame can see it complete
    const unsub = useLoading.subscribe((st, prev) => {
      if (st.sealed !== prev.sealed) check(st.sealed);
    });
    // and once more in the background after start-up, for anything mounted later
    const late = window.setTimeout(() => gl.compileAsync(scene, camera).catch(() => undefined), 15000);
    return () => {
      alive = false;
      unsub();
      window.clearTimeout(late);
    };
  }, [gl, scene, camera, webgl]);

  return null;
}
