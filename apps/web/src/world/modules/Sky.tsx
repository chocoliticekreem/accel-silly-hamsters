// Module: Sky. Day/night from sim time: a gradient sky dome with sun glow, an HDR sun disc (blooms, drives god rays)
// and moon, stars, fog, hemisphere + key light with soft shadows that follow the camera, and an environment map
// re-baked from the sky (PMREM) as the hour changes, so glass, cars and wet roads reflect the real sky.
// Palette maths is pure in sim/sky.ts; this module only applies it each frame (no allocations).
import { Stars } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  CircleGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Points,
  type WebGLRenderTarget,
} from "three";
import { createSkySample, moonDirection, sampleSky, sunDirection } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { PRESETS, useQuality } from "../quality";
import { glowTexture } from "../textures";

const DOME_R = 3000;
const DISC_DIST = 2600;

const domeVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const domeFrag = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform vec3 uMoonDir;
uniform float uMoonGlow;
uniform float uDisc;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  float y = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.5));
  col = mix(col, uGround, smoothstep(0.0, -0.12, y));
  float sd = max(dot(d, uSunDir), 0.0);
  // wide warm wash + tighter glow round the sun, and a warm horizon band on the sun's side
  col += uSunColor * uSunGlow * (pow(sd, 5.0) * 0.28 + pow(sd, 64.0) * 0.9);
  col += uSunColor * uSunGlow * pow(1.0 - abs(y), 10.0) * pow(sd, 1.5) * 0.45;
  // the disc itself only when baking the environment (the visible disc is a mesh, for god rays)
  col += uSunColor * uDisc * smoothstep(0.9990, 0.9995, sd) * 40.0;
  float md = max(dot(d, uMoonDir), 0.0);
  col += vec3(0.55, 0.65, 1.0) * uMoonGlow * (pow(md, 24.0) * 0.18 + pow(md, 3.0) * 0.03);
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // dither: no banding in the gradient
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <colorspace_fragment>
}`;

const NIGHT_ZENITH = new Color("#04070f");
const DAY_ZENITH = new Color("#2f63b3");
const GOLD = new Color("#ff9a4a");
const MOON = new Color("#dfe7ff");
const WHITE_HOT = new Color("#fff6e8");

export default function Sky() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const level = useQuality((s) => s.level);
  const preset = PRESETS[level];
  const sample = useMemo(createSkySample, []);
  const hemi = useRef<HemisphereLight>(null);
  const sun = useRef<DirectionalLight>(null);
  const stars = useRef<Points>(null);

  const parts = useMemo(() => {
    const uniforms = {
      uHorizon: { value: new Color() },
      uZenith: { value: new Color() },
      uGround: { value: new Color() },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color() },
      uSunGlow: { value: 0 },
      uMoonDir: { value: new Vector3(0, 1, 0) },
      uMoonGlow: { value: 0 },
      uDisc: { value: 0 },
    };
    const domeMat = new ShaderMaterial({ uniforms, vertexShader: domeVert, fragmentShader: domeFrag, side: BackSide, depthWrite: false, fog: false });
    const dome = new Mesh(new SphereGeometry(DOME_R, 48, 24), domeMat);
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    dome.name = "sky-dome";
    dome.raycast = () => null;
    // environment bake: the same sky (with the sun disc) seen from the origin
    const envScene = new Scene();
    const envDome = new Mesh(new SphereGeometry(50, 32, 16), domeMat);
    envScene.add(envDome);

    // the sun: an HDR disc (a light source for GodRays: transparent, no depth write) and a soft additive halo
    const discMat = new MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false, fog: false });
    const disc = new Mesh(new CircleGeometry(DISC_DIST * 0.022, 32), discMat);
    disc.name = "sun-disc";
    disc.raycast = () => null;
    disc.frustumCulled = false;
    const haloMat = new SpriteMaterial({ map: glowTexture(), blending: AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    const halo = new Sprite(haloMat);
    halo.scale.setScalar(DISC_DIST * 0.5);
    halo.raycast = () => null;
    const moonMat = new MeshBasicMaterial({ color: MOON, transparent: true, depthWrite: false, fog: false });
    const moon = new Mesh(new CircleGeometry(DISC_DIST * 0.014, 32), moonMat);
    moon.raycast = () => null;
    const moonHaloMat = new SpriteMaterial({ map: glowTexture(), color: "#9fb4ff", blending: AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0.35 });
    const moonHalo = new Sprite(moonHaloMat);
    moonHalo.scale.setScalar(DISC_DIST * 0.16);
    moonHalo.raycast = () => null;
    for (const m of [disc, halo, moon, moonHalo]) m.renderOrder = -9;
    return { uniforms, dome, domeMat, envScene, envDome, disc, discMat, halo, haloMat, moon, moonMat, moonHalo };
  }, []);

  // Glow (post) finds the sun disc here for its god rays
  useEffect(() => {
    scene.userData.sunDisc = parts.disc;
    return () => {
      if (scene.userData.sunDisc === parts.disc) delete scene.userData.sunDisc;
    };
  }, [scene, parts]);

  useMemo(() => {
    scene.background = new Color("#121a2e");
    // far enough that the City skyline (1–2 km south-west) sits in soft haze, not in a void
    scene.fog = new Fog("#121a2e", 650, 3000);
  }, [scene]);

  const pmrem = useMemo(() => new PMREMGenerator(gl), [gl]);
  const env = useRef<{ rt: WebGLRenderTarget | null; hour: number; at: number }>({ rt: null, hour: -99, at: -1 });
  useEffect(
    () => () => {
      env.current.rt?.dispose();
      pmrem.dispose();
      if (scene.environment) scene.environment = null;
      parts.dome.geometry.dispose();
      parts.envDome.geometry.dispose();
      parts.domeMat.dispose();
      parts.disc.geometry.dispose();
      parts.discMat.dispose();
      parts.haloMat.dispose();
      parts.moon.geometry.dispose();
      parts.moonMat.dispose();
    },
    [pmrem, parts, scene],
  );

  // shadow-map resolution follows the quality level
  useEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.shadow.mapSize.set(preset.shadowMap, preset.shadowMap);
    l.shadow.radius = preset.shadowRadius;
    l.shadow.map?.dispose();
    l.shadow.map = null;
    env.current.hour = -99; // and re-bake the env at the new size
  }, [preset.shadowMap, preset.shadowRadius]);

  const sunDir = useMemo<[number, number, number]>(() => [0, 1, 0], []);
  const moonDir = useMemo<[number, number, number]>(() => [0, 1, 0], []);
  const v = useMemo(() => ({ fwd: new Vector3(), focus: new Vector3(), key: new Vector3() }), []);

  useFrame(({ clock }) => {
    const hour = hourOf(useSim.getState().t);
    sampleSky(hour, sample);
    const u = parts.uniforms;
    sunDirection(hour, sunDir);
    moonDirection(hour, moonDir);
    const sunUp = Math.max(0, Math.min(1, (sunDir[1] + 0.04) / 0.08));
    const low = 1 - Math.min(1, Math.max(0, sunDir[1]) / 0.45); // 1 at the horizon, 0 high up
    const moonUp = Math.max(0, Math.min(1, moonDir[1] / 0.1)) * sample.night;

    // sky colours: horizon = palette sky, zenith deeper and bluer, a warm cast when the sun is low
    u.uHorizon.value.copy(sample.sky).lerp(GOLD, 0.22 * low * sunUp);
    u.uZenith.value.copy(sample.sky).lerp(DAY_ZENITH, 0.5).lerp(NIGHT_ZENITH, sample.night * 0.85);
    u.uGround.value.copy(sample.hemiGround).lerp(sample.sky, 0.5);
    u.uSunDir.value.set(sunDir[0], sunDir[1], sunDir[2]);
    u.uSunColor.value.copy(sample.sun).lerp(GOLD, 0.5 * low);
    u.uSunGlow.value = sunUp * (0.35 + 1.4 * low);
    u.uMoonDir.value.set(moonDir[0], moonDir[1], moonDir[2]);
    u.uMoonGlow.value = moonUp;
    (scene.background as Color).copy(u.uHorizon.value);
    (scene.fog as Fog).color.copy(u.uHorizon.value);

    // dome, sun and moon ride with the camera (they're "at infinity")
    parts.dome.position.copy(camera.position);
    parts.disc.position.set(sunDir[0], sunDir[1], sunDir[2]).multiplyScalar(DISC_DIST).add(camera.position);
    parts.disc.lookAt(camera.position);
    parts.disc.visible = sunUp > 0.01;
    // HDR: white-hot core, tinted, strongest near the horizon (bloom + god rays do the rest)
    parts.discMat.color.copy(u.uSunColor.value).lerp(WHITE_HOT, 0.35).multiplyScalar(6 + 10 * low);
    parts.halo.position.copy(parts.disc.position);
    parts.haloMat.color.copy(u.uSunColor.value).multiplyScalar(0.25 + 0.9 * low);
    parts.halo.visible = parts.disc.visible;
    parts.moon.position.set(moonDir[0], moonDir[1], moonDir[2]).multiplyScalar(DISC_DIST).add(camera.position);
    parts.moon.lookAt(camera.position);
    parts.moon.visible = moonUp > 0.02;
    parts.moonMat.color.copy(MOON).multiplyScalar(1 + 2.5 * moonUp);
    parts.moonHalo.position.copy(parts.moon.position);
    parts.moonHalo.visible = parts.moon.visible;

    if (hemi.current) {
      hemi.current.color.copy(sample.hemiSky);
      hemi.current.groundColor.copy(sample.hemiGround);
      // the env map now carries most of the sky light
      hemi.current.intensity = sample.hemi * 0.7;
    }
    const l = sun.current;
    if (l) {
      // key light: sun by day, moon by night; its shadow box follows where the camera looks
      const day = sunDir[1] > -0.02;
      const d = day ? sunDir : moonDir;
      const y = Math.max(0.21, d[1]);
      const flat = Math.hypot(d[0], d[2]) || 1;
      const r = Math.sqrt(1 - y * y) / flat;
      v.key.set(d[0] * r, y, d[2] * r);
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
      l.color.copy(day ? u.uSunColor.value : sample.sun);
      l.intensity = day ? sample.sunI * (1.15 + 0.5 * low) : sample.sunI * 0.9;
    }
    if (stars.current) {
      const m = stars.current.material as { opacity: number; transparent: boolean };
      m.transparent = true;
      m.opacity = Math.max(0, sample.night - 0.4) / 0.6;
      stars.current.visible = m.opacity > 0.02;
    }

    // environment: re-bake from the sky when the hour has moved (throttled in real time)
    const e = env.current;
    const now = clock.elapsedTime;
    if (Math.abs(hour - e.hour) > 0.12 && now - e.at > 0.3) {
      u.uDisc.value = sunUp;
      const rt = pmrem.fromScene(parts.envScene, 0, 0.1, 100, { size: preset.envSize });
      u.uDisc.value = 0;
      e.rt?.dispose();
      e.rt = rt;
      e.hour = hour;
      e.at = now;
      scene.environment = rt.texture;
    }
    scene.environmentIntensity = 0.75 - 0.35 * sample.night;
  });

  return (
    <group name="sky">
      <primitive object={parts.dome} />
      <primitive object={parts.halo} />
      <primitive object={parts.disc} />
      <primitive object={parts.moonHalo} />
      <primitive object={parts.moon} />
      <hemisphereLight ref={hemi} args={["#ffffff", "#444444", 1]} />
      <directionalLight
        ref={sun}
        castShadow
        position={[200, 300, -200]}
        shadow-mapSize={[preset.shadowMap, preset.shadowMap]}
        shadow-radius={preset.shadowRadius}
        shadow-camera-near={10}
        shadow-camera-far={1500}
        shadow-bias={-0.0004}
        shadow-normalBias={0.6}
      />
      <Stars ref={stars} radius={700} depth={120} count={2500} factor={6} saturation={0} fade speed={0.4} />
    </group>
  );
}
