// Renderer-level tuning that every module benefits from (WebGL path):
// - Shadow maps render once per frame at most. With autoUpdate on, three re-renders the sun's shadow map on every
//   gl.render() of a lit scene, and the post stack renders the scene more than once a frame. On Medium / Low the map
//   also refreshes every 2nd / 3rd frame while the camera is still (moving cars and people stay smooth at 20–30 Hz);
//   any camera move refreshes it immediately, so the follow-the-camera shadow box never lags.
// - Shader warm-up: compileAsync (KHR_parallel_shader_compile) over the whole scene a few times while modules
//   stream in, so materials outside the first view are already compiled when the camera turns to them.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Quaternion, Vector3, type WebGLRenderer } from "three";
import { useQuality } from "./quality";

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

  // warm the shader cache in the background as modules mount (each pass only compiles what's new)
  useEffect(() => {
    if (!webgl || typeof gl.compileAsync !== "function") return;
    let busy = false;
    const warm = () => {
      if (busy) return;
      busy = true;
      gl.compileAsync(scene, camera)
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    const timers = [400, 2000, 5000, 10000, 20000].map((ms) => window.setTimeout(warm, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [gl, scene, camera, webgl]);

  return null;
}
