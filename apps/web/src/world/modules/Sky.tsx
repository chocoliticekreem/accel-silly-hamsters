// Module: Sky. Physically based sky from @takram/three-atmosphere (Bruneton scattering: real sun and moon for
// Shoreditch at the sim's date and hour, sun disc, glow, twilight), stars, and our art-directed lights on top:
// a key light (sun by day, moon by night) with soft PCF shadows whose box follows the camera, a hemisphere fill
// from the sim palette, and an environment map baked (PMREM) from a sky gradient as the hour changes, so glass,
// cars and wet roads reflect the sky. Also publishes an HDR sun disc mesh for Glow's god rays.
// Sun/moon maths: world/atmosphere.ts. Palette: sim/sky.ts. No allocations per frame.
import { Stars } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { AtmosphereContext, Sky as AtmosphereSky } from "@takram/three-atmosphere/r3f";
import { useContext, useEffect, useMemo, useRef } from "react";
import {
  BackSide,
  CircleGeometry,
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
  Vector3,
  type Points,
  type WebGLRenderTarget,
} from "three";
import { createSkySample, sampleSky } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { createCelestial, gainSky, SKY_FLOOR, updateCelestial, WORLD_TO_ECEF } from "../atmosphere";
import { PRESETS, useQuality } from "../quality";

/** Stylised: the sun drawn ~2.5× its real size so it reads at city-builder zoom. */
const SUN_ANGULAR_RADIUS = 0.012;
const DISC_DIST = 2600;

// environment bake: a cheap gradient of the same palette (+ sun) for reflections
const envVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;
const envFrag = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = mix(uHorizon, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.5));
  col = mix(col, uGround, smoothstep(0.0, -0.15, d.y));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * uSunGlow * (pow(sd, 6.0) * 0.3 + pow(sd, 80.0) * 1.5 + smoothstep(0.9990, 0.9995, sd) * 30.0);
  gl_FragColor = vec4(col, 1.0);
}`;

const NIGHT_ZENITH = new Color("#04070f");
const DAY_ZENITH = new Color("#2f63b3");
const GOLD = new Color("#ff9a4a");
const WHITE_HOT = new Color("#fff6e8");

export default function Sky() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const atmosphere = useContext(AtmosphereContext);
  const level = useQuality((s) => s.level);
  const preset = PRESETS[level];
  const sample = useMemo(createSkySample, []);
  const celestial = useMemo(createCelestial, []);
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
    };
    const envMat = new ShaderMaterial({ uniforms, vertexShader: envVert, fragmentShader: envFrag, side: BackSide, depthWrite: false });
    const envScene = new Scene();
    envScene.add(new Mesh(new SphereGeometry(50, 32, 16), envMat));
    // the sun as a mesh too: an HDR disc on top of the atmosphere's, the light source for GodRays
    // (transparent + no depth write, as GodRays requires)
    const discMat = new MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false, fog: false });
    const disc = new Mesh(new CircleGeometry(DISC_DIST * SUN_ANGULAR_RADIUS * 0.92, 40), discMat);
    disc.name = "sun-disc";
    disc.raycast = () => null;
    disc.frustumCulled = false;
    disc.renderOrder = -9;
    return { uniforms, envMat, envScene, disc, discMat };
  }, []);

  // Glow (post) finds the sun disc and direction here
  useEffect(() => {
    scene.userData.sunDisc = parts.disc;
    scene.userData.sunDir = celestial.sun;
    return () => {
      if (scene.userData.sunDisc === parts.disc) delete scene.userData.sunDisc;
    };
  }, [scene, parts, celestial]);

  useMemo(() => {
    scene.background = new Color("#121a2e");
    // light haze for the far skyline (the atmosphere's aerial perspective does the rest on higher settings)
    scene.fog = new Fog("#121a2e", 900, 4000);
  }, [scene]);

  const pmrem = useMemo(() => new PMREMGenerator(gl), [gl]);
  const env = useRef<{ rt: WebGLRenderTarget | null; hour: number; at: number }>({ rt: null, hour: -99, at: -1 });
  useEffect(
    () => () => {
      env.current.rt?.dispose();
      env.current = { rt: null, hour: -99, at: -1 }; // StrictMode remounts: bake again
      pmrem.dispose();
      scene.environment = null;
      parts.envMat.dispose();
      parts.disc.geometry.dispose();
      parts.discMat.dispose();
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

  const v = useMemo(() => ({ fwd: new Vector3(), focus: new Vector3(), key: new Vector3() }), []);

  // priority -1: runs before the atmosphere components read the shared sun/moon state this frame
  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const hour = hourOf(t);
    sampleSky(hour, sample);
    updateCelestial(t, celestial);
    const ts = atmosphere.transientStates;
    if (ts) {
      ts.sunDirection.copy(celestial.sunECEF);
      ts.moonDirection.copy(celestial.moonECEF);
      ts.inertialToECEFMatrix.copy(celestial.inertialToECEF);
      ts.worldToECEFMatrix.copy(WORLD_TO_ECEF);
    }
    const s = celestial.sun;
    const m = celestial.moon;
    const sunUp = Math.max(0, Math.min(1, (s.y + 0.03) / 0.06));
    const low = 1 - Math.min(1, Math.max(0, s.y) / 0.45); // 1 at the horizon, 0 high up
    const u = parts.uniforms;

    // palette colours for fog, fill light and the reflection env (the visible sky is the atmosphere's)
    u.uHorizon.value.copy(sample.sky).lerp(GOLD, 0.22 * low * sunUp);
    u.uZenith.value.copy(sample.sky).lerp(DAY_ZENITH, 0.5).lerp(NIGHT_ZENITH, sample.night * 0.85);
    u.uGround.value.copy(sample.hemiGround).lerp(sample.sky, 0.4);
    u.uSunDir.value.copy(s);
    u.uSunColor.value.copy(sample.sun).lerp(GOLD, 0.5 * low);
    u.uSunGlow.value = sunUp * (0.35 + 1.4 * low);
    SKY_FLOOR.value.copy(u.uZenith.value).lerp(u.uHorizon.value, 0.3).multiplyScalar(0.55 * Math.max(sample.night, low * low));
    (scene.background as Color).copy(u.uHorizon.value);
    (scene.fog as Fog).color.copy(u.uHorizon.value).lerp(u.uZenith.value, 0.15);

    // god-ray source: rides with the camera at "infinity", white-hot and tinted, hottest near the horizon
    parts.disc.position.copy(s).multiplyScalar(DISC_DIST).add(camera.position);
    parts.disc.lookAt(camera.position);
    parts.disc.visible = sunUp > 0.01;
    parts.discMat.color.copy(u.uSunColor.value).lerp(WHITE_HOT, 0.4).multiplyScalar(5 + 9 * low);

    if (hemi.current) {
      hemi.current.color.copy(sample.hemiSky);
      hemi.current.groundColor.copy(sample.hemiGround);
      // the env map carries part of the sky light now
      hemi.current.intensity = sample.hemi * 0.5;
    }
    const l = sun.current;
    if (l) {
      // key light: sun by day, moon by night (never lower than ~12°, so shadows stay readable);
      // its shadow box follows where the camera looks, snapped to texels so edges don't crawl
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
      l.color.copy(day ? u.uSunColor.value : sample.sun);
      l.intensity = day ? sample.sunI * (1.7 + 0.6 * low) * Math.max(0.25, sunUp) : sample.sunI * 0.9;
    }
    if (stars.current) {
      const sm = stars.current.material as { opacity: number; transparent: boolean };
      sm.transparent = true;
      sm.opacity = Math.max(0, sample.night - 0.4) / 0.6;
      stars.current.visible = sm.opacity > 0.02;
    }

    // environment: re-bake when the hour has moved (throttled in real time)
    const e = env.current;
    const now = clock.elapsedTime;
    if (Math.abs(hour - e.hour) > 0.12 && now - e.at > 0.3) {
      const rt = pmrem.fromScene(parts.envScene, 0, 0.1, 100, { size: preset.envSize });
      e.rt?.dispose();
      e.rt = rt;
      e.hour = hour;
      e.at = now;
      scene.environment = rt.texture;
    }
    scene.environmentIntensity = 0.65 - 0.3 * sample.night;
  }, -1);

  return (
    <group name="sky">
      <AtmosphereSky ref={(m: Mesh | null) => { if (m) gainSky(m.material as ShaderMaterial); }} sunAngularRadius={SUN_ANGULAR_RADIUS} moonAngularRadius={0.009} lunarRadianceScale={6} renderOrder={-10} />
      <primitive object={parts.disc} />
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
