// The WebGPU stage (?gpu=webgpu): stands in for the WebGL-only Sky (takram atmosphere + GLSL env bake) and Glow
// (pmndrs postprocessing) modules. Same sim palette and real sun/moon positions: sky-coloured background and haze,
// hemisphere fill, a shadow-casting key light whose box follows the camera, AgX tone mapping in the renderer.
// ?gpupost=1 adds a TSL post pipeline (GTAO → mipmap bloom), still experimental (takes over rendering, priority 1).
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AgXToneMapping, Color, Fog, Vector3, type DirectionalLight, type HemisphereLight } from "three";
import { RenderPipeline, type WebGPURenderer } from "three/webgpu";
import { mrt, normalView, output, pass, vec4 } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { createSkySample, nightLevel, sampleSky } from "../sim/sky";
import { hourOf } from "../sim/time";
import { useSim } from "../state/store";
import { createCelestial, updateCelestial } from "./atmosphere";
import { PRESETS, useQuality } from "./quality";

const DAY_ZENITH = new Color("#2f63b3");
const NIGHT_ZENITH = new Color("#04070f");
const GOLD = new Color("#ff9a4a");

function WebGPUSky() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const preset = PRESETS[useQuality((s) => s.level)];
  const sample = useMemo(createSkySample, []);
  const celestial = useMemo(createCelestial, []);
  const hemi = useRef<HemisphereLight>(null);
  const sun = useRef<DirectionalLight>(null);
  const v = useMemo(() => ({ fwd: new Vector3(), focus: new Vector3(), key: new Vector3(), horizon: new Color(), zenith: new Color() }), []);

  useMemo(() => {
    scene.background = new Color("#121a2e");
    scene.fog = new Fog("#121a2e", 520, 3000);
  }, [scene]);
  useEffect(() => {
    scene.userData.sunDir = celestial.sun;
  }, [scene, celestial]);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = AgXToneMapping;
    gl.toneMappingExposure = 1.15;
  }, [gl]);

  useEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.shadow.mapSize.set(preset.shadowMap, preset.shadowMap);
    l.shadow.map?.dispose();
    l.shadow.map = null;
  }, [preset.shadowMap]);

  useFrame(() => {
    const t = useSim.getState().t;
    sampleSky(hourOf(t), sample);
    updateCelestial(t, celestial);
    const s = celestial.sun;
    const m = celestial.moon;
    const sunUp = Math.max(0, Math.min(1, (s.y + 0.03) / 0.06));
    const low = 1 - Math.min(1, Math.max(0, s.y) / 0.45);
    v.horizon.copy(sample.sky).lerp(GOLD, 0.22 * low * sunUp);
    v.zenith.copy(sample.sky).lerp(DAY_ZENITH, 0.5).lerp(NIGHT_ZENITH, sample.night * 0.85);
    (scene.background as Color).copy(v.horizon).lerp(v.zenith, 0.35);
    (scene.fog as Fog).color.copy(v.horizon).lerp(v.zenith, 0.15);
    if (hemi.current) {
      hemi.current.color.copy(sample.hemiSky);
      hemi.current.groundColor.copy(sample.hemiGround);
      hemi.current.intensity = sample.hemi * 0.85; // no env map on this path: the fill carries the sky light
    }
    const l = sun.current;
    if (!l) return;
    const day = s.y > -0.02;
    const d = day ? s : m.y > 0 ? m : v.key.set(-s.x, 0.6, -s.z).normalize();
    const y = Math.max(0.21, d.y);
    const flat = Math.hypot(d.x, d.z) || 1;
    const r = Math.sqrt(1 - y * y) / flat;
    v.key.set(d.x * r, y, d.z * r);
    camera.getWorldDirection(v.fwd);
    const dist = v.fwd.y < -0.05 ? Math.min(900, camera.position.y / -v.fwd.y) : 300;
    v.focus.copy(camera.position).addScaledVector(v.fwd, dist);
    v.focus.y = 0;
    const half = Math.min(520, Math.max(140, dist * 0.85));
    const snap = (half * 2) / preset.shadowMap;
    v.focus.x = Math.round(v.focus.x / snap) * snap;
    v.focus.z = Math.round(v.focus.z / snap) * snap;
    const cam = l.shadow.camera;
    if (cam.right !== half) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
    }
    l.target.position.copy(v.focus);
    l.target.updateMatrixWorld();
    l.position.copy(v.focus).addScaledVector(v.key, 700);
    l.color.copy(sample.sun).lerp(GOLD, day ? 0.5 * low : 0);
    l.intensity = day ? sample.sunI * (1.7 + 0.6 * low) * Math.max(0.25, sunUp) : sample.sunI * 0.9;
  });

  return (
    <group name="sky-webgpu">
      <hemisphereLight ref={hemi} args={["#ffffff", "#444444", 1]} />
      <directionalLight
        ref={sun}
        castShadow
        position={[200, 300, -200]}
        shadow-mapSize={[preset.shadowMap, preset.shadowMap]}
        shadow-camera-near={10}
        shadow-camera-far={1500}
        shadow-bias={-0.0004}
        shadow-normalBias={0.6}
      />
    </group>
  );
}

function WebGPUPost() {
  const gl = useThree((s) => s.gl) as unknown as WebGPURenderer;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const level = useQuality((s) => s.level);
  const useAO = PRESETS[level].ao !== "off";

  const post = useMemo(() => {
    const pipeline = new RenderPipeline(gl);
    const scenePass = pass(scene, camera);
    let color = scenePass.getTextureNode("output");
    let aoNode: ReturnType<typeof ao> | null = null;
    if (useAO) {
      scenePass.setMRT(mrt({ output, normal: normalView }));
      color = scenePass.getTextureNode("output");
      aoNode = ao(scenePass.getTextureNode("depth"), scenePass.getTextureNode("normal"), camera);
      aoNode.resolutionScale = 0.5;
      aoNode.radius.value = 4;
      aoNode.distanceFallOff.value = 1;
    }
    const lit = aoNode ? color.mul(vec4(aoNode.getTextureNode().r.mul(0.85).add(0.15).xxx, 1)) : color;
    const glow = bloom(lit, 0.6, 0.6, 0.9);
    pipeline.outputNode = lit.add(glow);
    return { pipeline, glow, aoNode };
  }, [gl, scene, camera, useAO]);

  useEffect(() => {
    gl.toneMapping = AgXToneMapping;
    gl.toneMappingExposure = 1.15;
  }, [gl]);
  useEffect(
    () => () => {
      post.glow.dispose();
      post.aoNode?.dispose();
      post.pipeline.dispose();
    },
    [post],
  );

  useFrame(() => {
    const night = nightLevel(hourOf(useSim.getState().t));
    post.glow.strength.value = 0.5 + 0.8 * night;
    post.glow.threshold.value = 0.95 - 0.35 * night;
    post.pipeline.render();
  }, 1);
  return null;
}

/** ?gpupost=1: the TSL post pipeline (GTAO + bloom), still experimental: by default the renderer tone-maps directly. */
const POST = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("gpupost") === "1";

export function WebGPUStage() {
  return (
    <>
      <WebGPUSky />
      {POST && <WebGPUPost />}
    </>
  );
}
