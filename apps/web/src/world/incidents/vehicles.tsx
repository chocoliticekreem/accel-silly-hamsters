// Response vehicles for the public-safety layer: Met police car (white, blue/yellow battenberg, blue light bar),
// ambulance (yellow-green battenberg box van) and plain cars for chases and collisions. Local +z = forward.
// Lights flash with toneMapped-off emissive materials so the Glow module's bloom picks them up.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type ReactNode } from "react";
import { AdditiveBlending, CanvasTexture, MeshBasicMaterial, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, type Group, type Mesh, type Texture } from "three";
import { glowTexture } from "../textures";

const texCache = new Map<string, Texture>();

/** Two-row checker (battenberg) strip: `a` and `b` squares. */
export function battenberg(a: string, b: string): Texture {
  const key = `${a}:${b}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 16;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? a : b;
      g.fillRect(i * 8, j * 8, 8, 8);
    }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/** Blue-and-white "POLICE" cordon tape. */
export function tapeTexture(): Texture {
  const hit = texCache.get("tape");
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 16;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? "#1d3f9c" : "#f5f7fb";
    g.beginPath();
    g.moveTo(i * 16, 16);
    g.lineTo(i * 16 + 8, 0);
    g.lineTo(i * 16 + 24, 0);
    g.lineTo(i * 16 + 16, 16);
    g.fill();
  }
  g.fillStyle = "#1d3f9c";
  g.fillRect(44, 3, 40, 10);
  g.fillStyle = "#ffffff";
  g.font = "bold 9px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("POLICE", 64, 8.5);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  texCache.set("tape", t);
  return t;
}

/** A sign texture with text (club names, the XOYO sign, notices). */
export function textTexture(text: string, opts: { fg?: string; bg?: string; w?: number; h?: number; font?: string } = {}): Texture {
  const key = `text:${text}:${opts.fg}:${opts.bg}:${opts.font}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = opts.w ?? 256;
  c.height = opts.h ?? 64;
  const g = c.getContext("2d")!;
  if (opts.bg) {
    g.fillStyle = opts.bg;
    g.fillRect(0, 0, c.width, c.height);
  }
  g.fillStyle = opts.fg ?? "#ffffff";
  g.font = opts.font ?? `bold ${Math.round(c.height * 0.62)}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/** Shared flashing materials: every blue light in the city flashes on the same beat. */
const BLUE_A = new MeshStandardMaterial({ color: "#2a5bff", emissive: "#2a5bff", emissiveIntensity: 0, toneMapped: false });
const BLUE_B = new MeshStandardMaterial({ color: "#2a5bff", emissive: "#2a5bff", emissiveIntensity: 0, toneMapped: false });
const AMBER = new MeshStandardMaterial({ color: "#ffa21f", emissive: "#ffa21f", emissiveIntensity: 0, toneMapped: false });
const GLOW_BLUE = new MeshBasicMaterial({ map: glowTexture(), color: "#3a6bff", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
const GLOW_AMBER = new MeshBasicMaterial({ map: glowTexture(), color: "#ffa21f", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
let flashFrame = -1;

/** Drives the shared flashing materials (call from any mounted vehicle; runs once per frame). */
function useFlash() {
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (flashFrame === t) return;
    flashFrame = t;
    // Met-style double flash, left/right alternating
    const ph = (t * 2.4) % 1;
    const pulse = (a: number) => (ph > a && ph < a + 0.08) || (ph > a + 0.14 && ph < a + 0.22);
    BLUE_A.emissiveIntensity = pulse(0) ? 9 : 0.3;
    BLUE_B.emissiveIntensity = pulse(0.5) ? 9 : 0.3;
    GLOW_BLUE.opacity = pulse(0) || pulse(0.5) ? 0.55 : 0.08;
    const hz = Math.sin(t * Math.PI * 2 * 1.4) > 0;
    AMBER.emissiveIntensity = hz ? 6 : 0.2;
    GLOW_AMBER.opacity = hz ? 0.4 : 0;
  });
}

function LightBar({ y, w = 1.3 }: { y: number; w?: number }) {
  return (
    <group position-y={y}>
      <mesh position-x={-w / 4} material={BLUE_A}>
        <boxGeometry args={[w / 2 - 0.04, 0.16, 0.32]} />
      </mesh>
      <mesh position-x={w / 4} material={BLUE_B}>
        <boxGeometry args={[w / 2 - 0.04, 0.16, 0.32]} />
      </mesh>
    </group>
  );
}

/** Blue wash on the road around a vehicle with its lights on. */
function BlueWash({ size = 9 }: { size?: number }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={0.18} material={GLOW_BLUE} renderOrder={2}>
      <planeGeometry args={[size, size]} />
    </mesh>
  );
}

function Wheels({ l, w }: { l: number; w: number }) {
  return (
    <>
      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}${sz}`} position={[(sx * w) / 2, 0.34, (sz * l) / 3]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.34, 0.34, 0.24, 10]} />
            <meshStandardMaterial color="#16181c" roughness={0.9} />
          </mesh>
        )),
      )}
    </>
  );
}

/** Met police response car (BMW-estate-ish proportions). `lights` = blues on. */
export function PoliceCar({ lights = true, siren = false }: { lights?: boolean; siren?: boolean }) {
  useFlash();
  const side = useMemo(() => {
    const t = battenberg("#1d3f9c", "#f4e21b").clone();
    t.repeat.set(5, 1);
    t.needsUpdate = true;
    return t;
  }, []);
  const l = 4.7;
  const w = 1.85;
  return (
    <group>
      <mesh position-y={0.85} castShadow>
        <boxGeometry args={[w, 0.75, l]} />
        <meshStandardMaterial color="#f3f4f6" roughness={0.4} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * w) / 2 + s * 0.01, 0.85, 0]} rotation-y={(s * Math.PI) / 2}>
          <planeGeometry args={[l * 0.96, 0.34]} />
          <meshStandardMaterial map={side} roughness={0.5} />
        </mesh>
      ))}
      {/* bonnet chevrons (front) */}
      <mesh position={[0, 1.235, l / 2 - 0.5]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[w * 0.9, 0.8]} />
        <meshStandardMaterial map={side} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.45, -0.25]} castShadow>
        <boxGeometry args={[w * 0.92, 0.55, l * 0.55]} />
        <meshStandardMaterial color="#2a3240" roughness={0.2} metalness={0.3} />
      </mesh>
      {lights ? <LightBar y={1.82} /> : <mesh position-y={1.8}><boxGeometry args={[1.3, 0.14, 0.3]} /><meshStandardMaterial color="#334" /></mesh>}
      <Wheels l={l} w={w} />
      {lights && <BlueWash />}
      {siren && <SirenPulse />}
    </group>
  );
}

/** NHS ambulance: yellow-green battenberg box van with blue lights. */
export function Ambulance({ lights = true }: { lights?: boolean }) {
  useFlash();
  const side = useMemo(() => {
    const t = battenberg("#1f8a3d", "#e3ee2a").clone();
    t.repeat.set(6, 1);
    t.needsUpdate = true;
    return t;
  }, []);
  const l = 6.2;
  const w = 2.25;
  return (
    <group>
      <mesh position={[0, 1.55, -0.5]} castShadow>
        <boxGeometry args={[w, 2.3, l - 1.2]} />
        <meshStandardMaterial color="#eef25a" roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.05, l / 2 - 0.65]} castShadow>
        <boxGeometry args={[w * 0.96, 1.3, 1.3]} />
        <meshStandardMaterial color="#eef25a" roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.55, l / 2 - 0.3]}>
        <boxGeometry args={[w * 0.9, 0.5, 0.6]} />
        <meshStandardMaterial color="#2a3240" roughness={0.2} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * w) / 2 + s * 0.01, 1.0, -0.2]} rotation-y={(s * Math.PI) / 2}>
          <planeGeometry args={[l * 0.9, 0.55]} />
          <meshStandardMaterial map={side} roughness={0.5} />
        </mesh>
      ))}
      {lights ? <LightBar y={2.78} w={1.8} /> : null}
      <Wheels l={l} w={w} />
      {lights && <BlueWash size={11} />}
    </group>
  );
}

/** A plain car; `crumple` folds the bonnet (collisions), `hazards` blinks amber corners. */
export function PlainCar({ color = "#3b4252", crumple = 0, hazards = false }: { color?: string; crumple?: number; hazards?: boolean }) {
  useFlash();
  const l = 4.3;
  const w = 1.8;
  const front = l * 0.3;
  return (
    <group>
      <mesh position={[0, 0.8, -front / 2]} castShadow>
        <boxGeometry args={[w, 0.7, l - front]} />
        <meshStandardMaterial color={color} roughness={0.45} metalness={0.15} />
      </mesh>
      {/* bonnet: shorter and tilted when crumpled */}
      <mesh position={[0, 0.78 + crumple * 0.12, l / 2 - front / 2 - (crumple * front) / 4]} rotation-x={-crumple * 0.35} rotation-z={crumple * 0.12} castShadow>
        <boxGeometry args={[w * (1 - crumple * 0.05), 0.62, front * (1 - crumple * 0.45)]} />
        <meshStandardMaterial color={color} roughness={0.55} metalness={0.15} />
      </mesh>
      <mesh position={[0, 1.38, -0.35]} castShadow>
        <boxGeometry args={[w * 0.9, 0.5, l * 0.48]} />
        <meshStandardMaterial color="#27303d" roughness={0.2} />
      </mesh>
      <Wheels l={l} w={w} />
      {hazards &&
        [-1, 1].flatMap((sx) =>
          [-1, 1].map((sz) => (
            <mesh key={`${sx}${sz}`} position={[sx * (w / 2 - 0.15), 0.95, sz * (l / 2 - 0.02)]} material={AMBER}>
              <boxGeometry args={[0.3, 0.14, 0.06]} />
            </mesh>
          )),
        )}
      {hazards && (
        <mesh rotation-x={-Math.PI / 2} position-y={0.18} material={GLOW_AMBER} renderOrder={2}>
          <planeGeometry args={[7, 7]} />
        </mesh>
      )}
    </group>
  );
}

/** An expanding blue ring on the road: the siren, drawn. */
export function SirenPulse() {
  const ring = useRef<Mesh>(null);
  const mat = useMemo(() => new MeshBasicMaterial({ color: "#4d7bff", transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: AdditiveBlending }), []);
  useFrame(({ clock }) => {
    if (!ring.current) return;
    const k = (clock.elapsedTime * 1.6) % 1;
    const s = 2 + k * 16;
    ring.current.scale.set(s, s, s);
    mat.opacity = (1 - k) * 0.5;
  });
  return (
    <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.22} material={mat} renderOrder={3}>
      <ringGeometry args={[0.9, 1, 40]} />
    </mesh>
  );
}

/** A few grey puffs rising from a point (collision smoke / steam). Loops in real time. */
export function Smoke({ n = 6 }: { n?: number }) {
  const g = useRef<Group>(null);
  const mat = useMemo(() => new MeshStandardMaterial({ color: "#c9ccd2", transparent: true, opacity: 0.45, roughness: 1, depthWrite: false }), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    g.current?.children.forEach((c, i) => {
      const k = (t * 0.35 + i / n) % 1;
      c.position.set(Math.sin(i * 2.1) * 0.4 + k * 0.6, 1 + k * 4, Math.cos(i * 1.7) * 0.4);
      const s = 0.4 + k * 1.3;
      c.scale.set(s, s, s);
    });
    mat.opacity = 0.35;
  });
  return (
    <group ref={g}>
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} material={mat}>
          <icosahedronGeometry args={[0.6, 0]} />
        </mesh>
      ))}
    </group>
  );
}

/** Positions a vehicle: contract coords + contract heading (atan2(dx, dz)). */
export function Placed({ x, z, heading, children }: { x: number; z: number; heading: number; children: ReactNode }) {
  return (
    <group position={[x, 0, -z]} rotation-y={Math.PI - heading}>
      {children}
    </group>
  );
}
