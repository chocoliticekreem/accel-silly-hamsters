// Stylised Londoners: eight archetypes (commuter in a coat, hoodie student, tourist with backpack, office worker,
// clubber, police officer in hi-vis, construction worker in hi-vis + hard hat, bouncer) sharing one rig, and a
// GPU skinning-free animation shader: every vertex carries the limb it belongs to (`aPart`) and which colour slot
// it takes (`aSlot`: fixed vertex colour, top, bottom, skin, hair), and the vertex shader poses the limbs
// hierarchically (hip→knee, shoulder→elbow) for four clips: idle, walk, run, dance. One InstancedMesh per
// archetype draws thousands; the CPU only bumps `uTime` (and writes instance matrices when people move).
//
// Frame: feet at y = 0, facing +z, left hand at +x, ~1.75 m tall. ~600–900 triangles per person.
// Usage:
//   const crowd = peopleMesh("commuter", 500, uniforms);      // InstancedMesh, attributes allocated
//   setPerson(crowd, i, matrix, { anim: "walk", phase, rate, top, bottom, skin, hair });
//   useFrame((_, dt) => (uniforms.uTime.value += dt));
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const PART = { torso: 0, head: 1, thighL: 2, thighR: 3, armL: 4, armR: 5, shinL: 6, shinR: 7, foreL: 8, foreR: 9 } as const;
export const SLOT = { fixed: 0, top: 1, bottom: 2, skin: 3, hair: 4 } as const;
export const ANIMS = { idle: 0, walk: 1, run: 2, dance: 3 } as const;
export type Anim = keyof typeof ANIMS;

export type PersonKind = "commuter" | "student" | "tourist" | "office" | "clubber" | "police" | "builder" | "bouncer";
export const PERSON_KINDS: PersonKind[] = ["commuter", "student", "tourist", "office", "clubber", "police", "builder", "bouncer"];

/** Suggested per-instance palettes (the app may pick its own). */
export const PERSON_PALETTES: Record<PersonKind, { top: string[]; bottom: string[] }> = {
  commuter: { top: ["#2b2f3a", "#6b5a48", "#3c4a5c", "#7a6d5d", "#1f2328"], bottom: ["#23262d", "#3a3f4a", "#2d2a26"] },
  student: { top: ["#c2412d", "#3d6bb3", "#2f7d4f", "#6d4ba0", "#d6a12b", "#8a8f99"], bottom: ["#2d3c5a", "#3a3a3a", "#5b6d84"] },
  tourist: { top: ["#e9e4d7", "#5aa0d6", "#e35d5d", "#f0c53d", "#78b86c"], bottom: ["#c7b48b", "#4a5a75", "#7c6f5b"] },
  office: { top: ["#e8edf3", "#cfe0f2", "#f4f1ea", "#dfe6d4"], bottom: ["#2a2e38", "#3b3f48", "#4a4237"] },
  clubber: { top: ["#ff3ea5", "#18e0d0", "#b84cff", "#f4f4f4", "#111111", "#ffde3a"], bottom: ["#111111", "#1d1d2b", "#3a2050"] },
  police: { top: ["#141a2e"], bottom: ["#141a2e"] },
  builder: { top: ["#3b4652", "#5d5f61", "#2e3a2f"], bottom: ["#2f3b52", "#4a4a44"] },
  bouncer: { top: ["#0f0f12"], bottom: ["#15161a"] },
};
export const SKIN_TONES = ["#f1c9a5", "#e0ac83", "#c68a5e", "#a36a43", "#7a4a2c", "#4e2f1d"];
export const HAIR_COLORS = ["#16110d", "#2c1d12", "#5a3a1e", "#8a5a2b", "#c8a060", "#9a9a9a", "#b8361e"];

// ----- joints (shared with the shader) -----
const HIP_Y = 0.92, KNEE_Y = 0.5, SHOULDER_Y = 1.41, ELBOW_Y = 1.12, NECK_Y = 1.5;
const HIP_X = 0.095, SHOULDER_X = 0.235;

interface Piece {
  geo: BufferGeometry;
  part: number;
  slot: number;
  color: string;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();

class Body {
  pieces: Piece[] = [];
  add(geo: BufferGeometry, part: number, slot: number, color: string, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]) {
    _m.compose(_p.set(...pos), _q.setFromEuler(_e.set(...rot)), _s.set(...scale));
    geo.applyMatrix4(_m);
    this.pieces.push({ geo, part, slot, color });
  }
  /** Limb segment from y0 down/up to y1 at (x, z). */
  limb(part: number, slot: number, color: string, x: number, y0: number, y1: number, r0: number, r1: number, z = 0, seg = 8, sz = 1) {
    this.add(new CylinderGeometry(r1, r0, Math.abs(y1 - y0), seg), part, slot, color, [x, (y0 + y1) / 2, z], [0, 0, 0], [1, 1, sz]);
  }
  box(part: number, slot: number, color: string, w: number, h: number, d: number, x: number, y: number, z: number, rot: [number, number, number] = [0, 0, 0]) {
    this.add(new BoxGeometry(w, h, d), part, slot, color, [x, y, z], rot);
  }
  ball(part: number, slot: number, color: string, r: number, x: number, y: number, z: number, scale: [number, number, number] = [1, 1, 1], ws = 8, hs = 6) {
    this.add(new SphereGeometry(r, ws, hs), part, slot, color, [x, y, z], [0, 0, 0], scale);
  }
  cap(part: number, slot: number, color: string, r: number, x: number, y: number, z: number, scale: [number, number, number] = [1, 1, 1], thetaLen = Math.PI / 2) {
    this.add(new SphereGeometry(r, 10, 5, 0, Math.PI * 2, 0, thetaLen), part, slot, color, [x, y, z], [0, 0, 0], scale);
  }
  geometry(): BufferGeometry {
    const geos = this.pieces.map((p) => {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
      const n = g.getAttribute("position").count;
      const col = new Float32Array(n * 3);
      _c.set(p.color);
      for (let i = 0; i < n; i++) col.set([_c.r, _c.g, _c.b], i * 3);
      g.setAttribute("color", new BufferAttribute(col, 3));
      g.setAttribute("aPart", new BufferAttribute(new Float32Array(n).fill(p.part), 1));
      g.setAttribute("aSlot", new BufferAttribute(new Float32Array(n).fill(p.slot), 1));
      return g;
    });
    const out = mergeGeometries(geos, false)!;
    geos.forEach((g) => g.dispose());
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}

interface Shape {
  broad?: number; // shoulder/torso width scale
  coat?: boolean; // long coat (top colour) down to the knee
  shorts?: boolean;
  sleeveless?: boolean;
  hair?: "short" | "long" | "bun" | "none";
  shoes?: string;
}

/** The shared base body. */
function base(b: Body, s: Shape) {
  const k = s.broad ?? 1;
  const shoe = s.shoes ?? "#1b1b1e";
  const { top, bottom, skin, hair, fixed } = SLOT;
  for (const [side, thigh, shin] of [[1, PART.thighL, PART.shinL], [-1, PART.thighR, PART.shinR]] as const) {
    const x = side * HIP_X * k;
    b.limb(thigh, bottom, "#fff", x, KNEE_Y - 0.02, HIP_Y + 0.04, 0.072, 0.088 * k);
    b.limb(shin, s.shorts ? skin : bottom, "#fff", x, 0.09, KNEE_Y + 0.02, 0.05, 0.066);
    b.ball(shin, s.shorts ? skin : bottom, "#fff", 0.066, x, KNEE_Y, 0, [1, 0.8, 1], 6, 4);
    b.box(shin, fixed, shoe, 0.1, 0.09, 0.25, x, 0.045, 0.045);
  }
  // pelvis + torso (elliptical, wider at the chest)
  b.limb(PART.torso, bottom, "#fff", 0, HIP_Y - 0.06, HIP_Y + 0.08, 0.17 * k, 0.17 * k, 0, 10, 0.65);
  b.limb(PART.torso, top, "#fff", 0, HIP_Y + 0.04, SHOULDER_Y + 0.04, 0.165 * k, 0.215 * k, 0, 10, 0.6);
  b.ball(PART.torso, top, "#fff", 0.2 * k, 0, SHOULDER_Y + 0.02, 0, [1.1, 0.42, 0.62], 10, 5); // shoulders
  if (s.coat) b.limb(PART.torso, top, "#fff", 0, 0.58, HIP_Y + 0.06, 0.2 * k, 0.175 * k, 0, 10, 0.72);
  b.limb(PART.head, skin, "#fff", 0, NECK_Y - 0.06, NECK_Y + 0.06, 0.05, 0.048);
  b.ball(PART.head, skin, "#fff", 0.115, 0, 1.64, 0.01, [0.92, 1.1, 1]);
  b.box(PART.head, skin, "#fff", 0.03, 0.05, 0.04, 0, 1.63, 0.12); // nose
  for (const ex of [0.042, -0.042]) b.box(PART.head, fixed, "#141414", 0.022, 0.018, 0.01, ex, 1.665, 0.112);
  if (s.hair === "long") {
    b.cap(PART.head, hair, "#fff", 0.125, 0, 1.655, -0.005, [0.98, 1.05, 1.04]);
    b.box(PART.head, hair, "#fff", 0.22, 0.26, 0.08, 0, 1.55, -0.08);
  } else if (s.hair === "bun") {
    b.cap(PART.head, hair, "#fff", 0.123, 0, 1.66, -0.005, [0.98, 1.0, 1.03]);
    b.ball(PART.head, hair, "#fff", 0.06, 0, 1.8, -0.06);
  } else if (s.hair !== "none") b.cap(PART.head, hair, "#fff", 0.122, 0, 1.665, -0.01, [0.97, 0.9, 1.03]);
  // arms
  for (const [side, arm, fore] of [[1, PART.armL, PART.foreL], [-1, PART.armR, PART.foreR]] as const) {
    const x = side * SHOULDER_X * k;
    b.limb(arm, s.sleeveless ? skin : top, "#fff", x, ELBOW_Y - 0.02, SHOULDER_Y, 0.046, 0.058 * k);
    b.limb(fore, s.sleeveless ? skin : top, "#fff", x, 0.86, ELBOW_Y + 0.02, 0.04, 0.047);
    b.ball(fore, skin, "#fff", 0.052, x, 0.82, 0.01, [0.8, 1.15, 0.9], 6, 5);
  }
}

function hiVis(b: Body, color: string, k = 1) {
  b.limb(PART.torso, SLOT.fixed, color, 0, HIP_Y + 0.1, SHOULDER_Y + 0.02, 0.172 * k, 0.222 * k, 0, 10, 0.64);
  for (const y of [1.12, 1.25]) b.limb(PART.torso, SLOT.fixed, "#d9dde2", 0, y - 0.022, y + 0.022, 0.2 * k, 0.212 * k, 0, 10, 0.66);
}

function build(kind: PersonKind): BufferGeometry {
  const b = new Body();
  switch (kind) {
    case "commuter":
      base(b, { coat: true, hair: "short" });
      b.limb(PART.torso, SLOT.fixed, "#8a1f2b", 0, SHOULDER_Y - 0.03, SHOULDER_Y + 0.07, 0.11, 0.105, 0.01, 8); // scarf
      b.box(PART.foreR, SLOT.fixed, "#3a2a1c", 0.08, 0.28, 0.36, -SHOULDER_X - 0.02, 0.68, 0.02); // briefcase
      b.box(PART.foreR, SLOT.fixed, "#1a120c", 0.02, 0.05, 0.12, -SHOULDER_X - 0.02, 0.84, 0.02);
      break;
    case "student":
      base(b, { hair: "short", shoes: "#e9e9e6" });
      b.add(new TorusGeometry(0.11, 0.045, 5, 10, Math.PI * 1.3), PART.torso, SLOT.top, "#fff", [0, 1.47, -0.07], [Math.PI / 2 + 0.5, 0, -Math.PI * 0.15 - Math.PI / 2]); // hood
      b.box(PART.torso, SLOT.top, "#fff", 0.2, 0.1, 0.03, 0, 1.06, 0.105); // pocket
      for (const x of [0.04, -0.04]) b.box(PART.torso, SLOT.fixed, "#efefef", 0.008, 0.12, 0.008, x, 1.3, 0.13); // drawstrings
      b.box(PART.torso, SLOT.fixed, "#2b2b2b", 0.03, 0.42, 0.02, 0.1, 1.18, 0.12, [0, 0, 0.6]); // bag strap
      b.box(PART.torso, SLOT.fixed, "#2b2b2b", 0.08, 0.26, 0.3, -0.21, 0.98, 0); // shoulder bag
      break;
    case "tourist":
      base(b, { shorts: true, hair: "short", shoes: "#d8d2c4" });
      b.box(PART.torso, SLOT.fixed, "#d4532b", 0.3, 0.42, 0.18, 0, 1.17, -0.19); // backpack
      b.box(PART.torso, SLOT.fixed, "#a93d1d", 0.24, 0.14, 0.05, 0, 1.06, -0.29);
      for (const x of [0.11, -0.11]) b.box(PART.torso, SLOT.fixed, "#2a2a2a", 0.035, 0.36, 0.02, x, 1.24, 0.12, [0.15, 0, 0]);
      b.cap(PART.head, SLOT.fixed, "#1f5fa8", 0.125, 0, 1.69, 0, [1, 0.6, 1.02]); // cap
      b.box(PART.head, SLOT.fixed, "#1f5fa8", 0.16, 0.02, 0.12, 0, 1.7, 0.14); // peak
      b.box(PART.torso, SLOT.fixed, "#151515", 0.1, 0.07, 0.06, 0, 1.2, 0.14); // camera
      break;
    case "office":
      base(b, { hair: "short", shoes: "#2a1a10" });
      b.box(PART.torso, SLOT.fixed, "#7a1d2e", 0.045, 0.32, 0.015, 0, 1.24, 0.122, [0.12, 0, 0]); // tie
      b.box(PART.torso, SLOT.fixed, "#2563a6", 0.012, 0.3, 0.012, 0.06, 1.28, 0.12, [0.1, 0, 0.25]); // lanyard
      b.box(PART.torso, SLOT.fixed, "#f4f4f4", 0.06, 0.08, 0.01, 0.04, 1.12, 0.125); // pass
      b.box(PART.foreL, SLOT.fixed, "#111", 0.02, 0.15, 0.08, SHOULDER_X + 0.03, 0.83, 0.03); // phone
      break;
    case "clubber":
      base(b, { sleeveless: true, hair: "bun", shoes: "#f4f4f4" });
      b.limb(PART.torso, SLOT.fixed, "#e8e8e8", 0, HIP_Y + 0.02, HIP_Y + 0.06, 0.18, 0.18, 0, 10, 0.65); // belt
      b.limb(PART.head, SLOT.fixed, "#39ff88", 0, NECK_Y - 0.03, NECK_Y + 0.0, 0.058, 0.058, 0, 8); // glow choker
      for (const s of [1, -1]) b.limb(s > 0 ? PART.foreL : PART.foreR, SLOT.fixed, "#ff3ea5", s * SHOULDER_X, 0.9, 0.94, 0.05, 0.05); // wristbands
      break;
    case "police":
      base(b, { hair: "short", shoes: "#0b0b0b" });
      hiVis(b, "#d8f21a");
      b.box(PART.torso, SLOT.fixed, "#111", 0.18, 0.06, 0.02, 0, 1.3, 0.14); // POLICE patch
      b.box(PART.torso, SLOT.fixed, "#101010", 0.07, 0.1, 0.05, 0.13, 1.33, 0.12); // radio
      b.limb(PART.torso, SLOT.fixed, "#111", 0, HIP_Y - 0.02, HIP_Y + 0.04, 0.18, 0.18, 0, 10, 0.67); // duty belt
      // custodian helmet
      b.limb(PART.head, SLOT.fixed, "#141a2e", 0, 1.68, 1.86, 0.105, 0.128, 0, 12);
      b.cap(PART.head, SLOT.fixed, "#141a2e", 0.105, 0, 1.86, 0, [1, 0.8, 1.05]);
      b.ball(PART.head, SLOT.fixed, "#c9ced4", 0.022, 0, 1.96, 0); // rose top
      b.box(PART.head, SLOT.fixed, "#c9ced4", 0.06, 0.07, 0.02, 0, 1.78, 0.125); // star badge
      b.limb(PART.head, SLOT.fixed, "#0e1220", 0, 1.67, 1.7, 0.14, 0.14, 0, 12); // brim
      break;
    case "builder":
      base(b, { hair: "short", shoes: "#8a5a2b" });
      hiVis(b, "#ff7a1a");
      b.cap(PART.head, SLOT.fixed, "#f2c200", 0.135, 0, 1.68, 0, [1, 0.9, 1.1]); // hard hat
      b.limb(PART.head, SLOT.fixed, "#f2c200", 0, 1.68, 1.695, 0.16, 0.16, 0.02, 12);
      b.box(PART.head, SLOT.fixed, "#e0b200", 0.03, 0.03, 0.26, 0, 1.8, 0); // ridge
      b.limb(PART.torso, SLOT.fixed, "#4a3a2a", 0, HIP_Y - 0.02, HIP_Y + 0.04, 0.18, 0.18, 0, 10, 0.67); // tool belt
      b.box(PART.torso, SLOT.fixed, "#6b5032", 0.1, 0.14, 0.08, 0.17, HIP_Y - 0.06, 0.06);
      break;
    case "bouncer":
      base(b, { broad: 1.28, coat: true, hair: "none", shoes: "#0b0b0b" });
      b.box(PART.head, SLOT.fixed, "#111", 0.012, 0.012, 0.012, 0.11, 1.63, 0.0); // earpiece
      b.box(PART.torso, SLOT.fixed, "#d7dbe0", 0.09, 0.06, 0.01, 0.12, 1.3, 0.14); // SIA badge
      b.ball(PART.head, SLOT.skin, "#fff", 0.07, 0, 1.585, 0.02, [1.3, 0.7, 1.1]); // jaw
      break;
  }
  return b.geometry();
}

const geoCache = new Map<PersonKind, BufferGeometry>();
export function personGeometry(kind: PersonKind): BufferGeometry {
  let g = geoCache.get(kind);
  if (!g) geoCache.set(kind, (g = build(kind)));
  return g;
}

// ----------------------------------------------------------------- shader

export interface PeopleUniforms {
  uTime: { value: number };
  [k: string]: { value: unknown };
}
export const peopleUniforms = (): PeopleUniforms => ({ uTime: { value: 0 } });

const VERT = /* glsl */ `
uniform float uTime;
attribute float aPart;
attribute float aSlot;
attribute vec4 aAnim;   // mode (0 idle,1 walk,2 run,3 dance), phase (rad), rate (1 = normal), unused
attribute vec3 aTop;
attribute vec3 aBottom;
attribute vec3 aSkin;
attribute vec3 aHair;
varying vec3 vPersonColor;

vec3 pRotX(vec3 p, float py, float pz, float a) {
  float c = cos(a), s = sin(a);
  vec2 q = vec2(p.y - py, p.z - pz);
  return vec3(p.x, py + q.x * c - q.y * s, pz + q.x * s + q.y * c);
}
vec3 pRotZ(vec3 p, float px, float py, float a) {
  float c = cos(a), s = sin(a);
  vec2 q = vec2(p.x - px, p.y - py);
  return vec3(px + q.x * c - q.y * s, py + q.x * s + q.y * c, p.z);
}
vec3 pRotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

vec3 personPose(vec3 p) {
  float mode = aAnim.x;
  float t = uTime * aAnim.z;
  float idle = 1.0 - step(0.5, mode);
  float walk = step(0.5, mode) * (1.0 - step(1.5, mode));
  float run = step(1.5, mode) * (1.0 - step(2.5, mode));
  float dance = step(2.5, mode);
  float w = t * mix(mix(6.0, 9.6, run), 7.6, dance) + aAnim.y;   // stride / beat phase
  float sw = sin(w);

  // joint angles (positive X rotation swings a hanging limb backwards)
  float hipL = -sw * (0.45 * walk + 0.85 * run);
  float hipR = -hipL;
  float kneeL = max(0.0, sin(w - 1.3)) * (0.55 * walk + 1.5 * run) + 0.12 * run;
  float kneeR = max(0.0, sin(w + 1.84)) * (0.55 * walk + 1.5 * run) + 0.12 * run;
  float armL = sw * (0.38 * walk + 0.9 * run);
  float armR = -armL;
  float elbow = -(0.18 * walk + 1.45 * run + 0.08 * idle);
  float elbowL = elbow, elbowR = elbow;
  float abL = 0.06 * idle, abR = -0.06 * idle;
  float lean = 0.04 * walk + 0.2 * run;
  float bob = abs(sw) * (0.035 * walk + 0.09 * run);
  float sway = 0.0;
  float nod = 0.0;
  float turn = 0.0;

  // idle: breathe, shift weight, glance around now and then
  float slow = sin(uTime * 0.7 + aAnim.y);
  sway += idle * 0.025 * slow;
  turn += idle * 0.5 * smoothstep(0.6, 0.95, sin(uTime * 0.31 + aAnim.y * 3.0)) * sign(sin(aAnim.y * 7.0));
  nod += idle * 0.04 * sin(uTime * 1.3 + aAnim.y);

  // dance: bouncing knees on the beat, arms up and pumping, hips swaying
  float beat = 0.5 + 0.5 * sin(w * 2.0);
  hipL += dance * (-0.35 * beat);
  hipR += dance * (-0.35 * beat);
  kneeL += dance * 0.7 * beat;
  kneeR += dance * 0.7 * beat;
  bob -= dance * 0.06 * beat;
  armL += dance * (-2.5 + 0.45 * sin(w * 2.0));
  armR += dance * (-2.1 + 0.45 * sin(w * 2.0 + 1.5));
  elbowL += dance * (-0.5);
  elbowR += dance * (-0.7);
  abL += dance * (0.35 + 0.15 * sw);
  abR -= dance * (0.35 - 0.15 * sw);
  sway += dance * 0.12 * sw;
  nod += dance * 0.18 * sin(w * 2.0);
  turn += dance * 0.25 * sin(w * 0.5);

  float part = aPart;
  // legs: knee then hip
  if (part > 1.5 && part < 3.5 || part > 5.5 && part < 7.5) {
    bool left = part < 2.5 || (part > 5.5 && part < 6.5);
    if (part > 5.5) p = pRotX(p, ${KNEE_Y.toFixed(3)}, 0.0, left ? kneeL : kneeR);
    p = pRotX(p, ${HIP_Y.toFixed(3)}, 0.0, left ? hipL : hipR);
  } else {
    // upper body: arms (elbow then shoulder), head (nod + turn), then lean about the hips
    if (part > 3.5 && part < 5.5 || part > 7.5) {
      bool left = part < 4.5 || (part > 7.5 && part < 8.5);
      float sx = left ? ${SHOULDER_X.toFixed(3)} : -${SHOULDER_X.toFixed(3)};
      if (part > 7.5) p = pRotX(p, ${ELBOW_Y.toFixed(3)}, 0.0, left ? elbowL : elbowR);
      p = pRotX(p, ${SHOULDER_Y.toFixed(3)}, 0.0, left ? armL : armR);
      p = pRotZ(p, sx, ${SHOULDER_Y.toFixed(3)}, left ? abL : abR);
    }
    if (part > 0.5 && part < 1.5) {
      p = pRotX(p, ${NECK_Y.toFixed(3)}, 0.0, nod);
      p = pRotY(p, turn);
    }
    p = pRotX(p, ${HIP_Y.toFixed(3)}, 0.0, lean);
    p = pRotZ(p, 0.0, ${HIP_Y.toFixed(3)}, sway * 0.6);
  }
  p = pRotZ(p, 0.0, 0.0, sway * 0.25);
  p.y += bob + idle * 0.004 * sin(uTime * 2.2 + aAnim.y);

  vPersonColor = aSlot < 0.5 ? vec3(1.0) : aSlot < 1.5 ? aTop : aSlot < 2.5 ? aBottom : aSlot < 3.5 ? aSkin : aHair;
  return p;
}
`;

let mat: MeshStandardMaterial | null = null;
let matUniforms: PeopleUniforms | null = null;

/** One material for every archetype (they share the shader). Pass the same uniforms object everywhere. */
export function peopleMaterial(uniforms: PeopleUniforms): MeshStandardMaterial {
  if (mat && matUniforms === uniforms) return mat;
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, flatShading: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT}`)
      .replace("#include <begin_vertex>", "vec3 transformed = personPose(vec3(position));");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPersonColor;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= vPersonColor;");
  };
  m.customProgramCacheKey = () => "hero-people";
  mat = m;
  matUniforms = uniforms;
  return m;
}

/** An InstancedMesh of one archetype with all per-instance attributes allocated (count = capacity). */
export function peopleMesh(kind: PersonKind, capacity: number, uniforms: PeopleUniforms): InstancedMesh {
  const geo = personGeometry(kind).clone();
  geo.setAttribute("aAnim", new InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  for (const a of ["aTop", "aBottom", "aSkin", "aHair"]) geo.setAttribute(a, new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(0.8), 3));
  const mesh = new InstancedMesh(geo, peopleMaterial(uniforms), capacity);
  mesh.name = `people:${kind}`;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

export interface PersonLook {
  anim?: Anim;
  phase?: number;
  rate?: number;
  top?: string;
  bottom?: string;
  skin?: string;
  hair?: string;
}

/** Write one person's transform and look. Remember `needsUpdate` on the attributes you touched (done here). */
export function setPerson(mesh: InstancedMesh, i: number, matrix: Matrix4, look: PersonLook) {
  mesh.setMatrixAt(i, matrix);
  mesh.instanceMatrix.needsUpdate = true;
  const g = mesh.geometry;
  const anim = g.getAttribute("aAnim") as InstancedBufferAttribute;
  anim.setXYZW(i, ANIMS[look.anim ?? "walk"], look.phase ?? 0, look.rate ?? 1, 0);
  anim.needsUpdate = true;
  const put = (name: string, hex: string | undefined) => {
    if (!hex) return;
    _c.set(hex);
    const a = g.getAttribute(name) as InstancedBufferAttribute;
    a.setXYZ(i, _c.r, _c.g, _c.b);
    a.needsUpdate = true;
  };
  put("aTop", look.top);
  put("aBottom", look.bottom);
  put("aSkin", look.skin);
  put("aHair", look.hair);
}
