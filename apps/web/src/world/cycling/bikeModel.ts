// Procedural bicycles with riders, for the Cyclists module. One merged geometry per body type (a normal bike and
// a long-john cargo bike), drawn as one InstancedMesh each: every moving part is animated in the vertex shader,
// so a whole fleet of pedalling riders costs one draw call per body type.
//
// Each vertex carries aPart = (role, slot):
//   role  how the vertex moves: frame, front/rear wheel (spin), cranks (turn), thighs and shins (two-bone IK to
//         the pedals), rider torso (hidden on parked bikes, tucked for road riders), and optional extras
//         (helmet, delivery box, hire-bike basket, hi-vis bands, lights) that collapse away when the instance's
//         flag is off.
//   slot  where its colour comes from: baked vertex colour, or one of the instance colours (frame, top, legs,
//         accent), skin, or an emissive light (head lamp, blinking tail lamp, bell flash).
// Local frame: front +z, left +x, ground y = 0 (same as world/vehicleModels.ts).
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const ROLE = {
  frame: 0,
  front: 1,
  rear: 2,
  crank: 3,
  thighL: 4,
  shinL: 5,
  thighR: 6,
  shinR: 7,
  torso: 8,
  helmet: 9,
  box: 10,
  basket: 11,
  hivis: 12,
  head: 13,
} as const;

export const SLOT = { baked: 0, frame: 1, top: 2, legs: 3, accent: 4, headLamp: 5, tailLamp: 6, skin: 7, bell: 8 } as const;

/** Instance flags (packed into iTop.w). */
export const FLAG = { rider: 1, helmet: 2, box: 4, basket: 8, hivis: 16, tuck: 32 } as const;

// Geometry constants shared with the shader (metres, local y/z).
const WHEEL_R = 0.34;
const HIP: [number, number] = [0.95, -0.2];
const BB: [number, number] = [0.29, -0.06];
const CRANK = 0.17;
const THIGH = 0.44;
const SHIN = 0.47;
const LEG_X = 0.1;

const TYRE = "#17181a";
const RIM = "#b9bec4";
const DARK = "#26282c";
const SHOE = "#202124";
const WHITE = "#ffffff";

const tmpC = new Color();

function tag(g: BufferGeometry, role: number, slot: number, color = WHITE) {
  const geo = g;
  const n = geo.getAttribute("position").count;
  tmpC.set(color);
  const col = new Float32Array(n * 3);
  const part = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    col[i * 3] = tmpC.r;
    col[i * 3 + 1] = tmpC.g;
    col[i * 3 + 2] = tmpC.b;
    part[i * 2] = role;
    part[i * 2 + 1] = slot;
  }
  geo.setAttribute("color", new BufferAttribute(col, 3));
  geo.setAttribute("aPart", new BufferAttribute(part, 2));
  if (geo.getAttribute("uv")) geo.deleteAttribute("uv");
  return geo;
}

const yAxis = new Vector3(0, 1, 0);
const qTmp = new Quaternion();
const vTmp = new Vector3();

/** A cylinder from a to b ([x, y, z]). */
function tube(a: [number, number, number], b: [number, number, number], r: number, seg = 5) {
  const d = vTmp.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = new CylinderGeometry(r, r, len, seg, 1, false);
  qTmp.setFromUnitVectors(yAxis, d.normalize());
  g.applyQuaternion(qTmp);
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

/** A box from a to b (its long axis), w across x, t thick. */
function bar(a: [number, number, number], b: [number, number, number], w: number, t: number) {
  const d = vTmp.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = new BoxGeometry(w, len, t);
  qTmp.setFromUnitVectors(yAxis, d.normalize());
  g.applyQuaternion(qTmp);
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

function box(w: number, h: number, l: number, x: number, y: number, z: number) {
  return new BoxGeometry(w, h, l).translate(x, y, z);
}

/** Tyre, rim, spokes and hub of a wheel centred at (0, hubY, hubZ), all of `role`. */
function wheel(role: number, hubY: number, hubZ: number, r: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  out.push(tag(new TorusGeometry(r - 0.02, 0.026, 5, 18).rotateY(Math.PI / 2).translate(0, hubY, hubZ), role, SLOT.baked, TYRE));
  out.push(tag(new TorusGeometry(r - 0.05, 0.012, 3, 18).rotateY(Math.PI / 2).translate(0, hubY, hubZ), role, SLOT.baked, RIM));
  for (let k = 0; k < 4; k++)
    out.push(tag(new BoxGeometry(0.008, (r - 0.05) * 2, 0.012).rotateX((k * Math.PI) / 4).translate(0, hubY, hubZ), role, SLOT.baked, RIM));
  out.push(tag(new CylinderGeometry(0.035, 0.035, 0.1, 6).rotateZ(Math.PI / 2).translate(0, hubY, hubZ), role, SLOT.baked, DARK));
  return out;
}

/** Legs: thighs hang from the hip (origin) and shins from the knee (origin), straight down; the shader poses them. */
function legs(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const [x, thigh, shin] of [
    [LEG_X, ROLE.thighL, ROLE.shinL],
    [-LEG_X, ROLE.thighR, ROLE.shinR],
  ] as const) {
    out.push(tag(box(0.14, THIGH + 0.06, 0.15, x, -THIGH / 2, 0), thigh, SLOT.legs));
    out.push(tag(box(0.11, SHIN, 0.11, x, -SHIN / 2, 0), shin, SLOT.legs));
    out.push(tag(box(0.1, 0.07, 0.24, x, -SHIN - 0.01, 0.05), shin, SLOT.baked, SHOE));
  }
  return out;
}

/** Torso, arms, head (+ helmet, hi-vis bands, delivery box) for hands on bars at (handY, handZ). */
function rider(handY: number, handZ: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const hip: [number, number, number] = [0, HIP[0], HIP[1]];
  const sh: [number, number, number] = [0, 1.43, 0.08];
  out.push(tag(bar(hip, sh, 0.36, 0.22), ROLE.torso, SLOT.top));
  out.push(tag(box(0.3, 0.16, 0.26, 0, HIP[0] + 0.02, HIP[1] - 0.02), ROLE.torso, SLOT.legs)); // seat of the trousers
  for (const x of [0.19, -0.19]) {
    out.push(tag(bar([x, 1.41, 0.08], [x * 1.1, handY + 0.04, handZ - 0.03], 0.09, 0.09), ROLE.torso, SLOT.top));
    out.push(tag(box(0.08, 0.07, 0.09, x * 1.15, handY + 0.02, handZ), ROLE.torso, SLOT.skin));
  }
  out.push(tag(box(0.09, 0.08, 0.09, 0, 1.5, 0.12), ROLE.torso, SLOT.skin)); // neck
  out.push(tag(new IcosahedronGeometry(0.115, 1).scale(0.92, 1, 1).translate(0, 1.62, 0.17), ROLE.head, SLOT.skin));
  out.push(tag(new SphereGeometry(0.135, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.2).translate(0, 1.64, 0.15), ROLE.helmet, SLOT.accent));
  // hi-vis bands round the torso
  for (const k of [0.35, 0.7]) {
    const y = hip[1] + (sh[1] - hip[1]) * k;
    const z = hip[2] + (sh[2] - hip[2]) * k;
    out.push(tag(bar([0, y - 0.025, z - 0.012], [0, y + 0.025, z + 0.012], 0.375, 0.235), ROLE.hivis, SLOT.baked, "#d9dde0"));
  }
  // insulated delivery box on the back, logo band, straps
  out.push(tag(box(0.44, 0.42, 0.36, 0, 1.3, -0.36).rotateX(0), ROLE.box, SLOT.accent));
  out.push(tag(box(0.45, 0.06, 0.37, 0, 1.4, -0.36), ROLE.box, SLOT.baked, "#f4f4f4"));
  return out;
}

/** The standard bike: frame, wheels, cranks, bars, saddle, lights, hire-bike basket, and the rider. */
function standard(): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const R: [number, number, number] = [0, WHEEL_R, -0.5];
  const F: [number, number, number] = [0, WHEEL_R, 0.52];
  const B: [number, number, number] = [0, BB[0], BB[1]];
  const S: [number, number, number] = [0, 0.8, -0.2];
  const Ht: [number, number, number] = [0, 0.86, 0.38];
  const Hb: [number, number, number] = [0, 0.68, 0.43];
  parts.push(...wheel(ROLE.front, WHEEL_R, 0.52, WHEEL_R), ...wheel(ROLE.rear, WHEEL_R, -0.5, WHEEL_R));
  const frame = [
    tube(S, Ht, 0.022),
    tube(B, Hb, 0.026),
    tube(B, S, 0.022),
    tube(Hb, Ht, 0.028),
    tube([0.05, B[1], B[2]], [0.05, R[1], R[2]], 0.014),
    tube([-0.05, B[1], B[2]], [-0.05, R[1], R[2]], 0.014),
    tube([0.04, S[1], S[2]], [0.05, R[1], R[2]], 0.012),
    tube([-0.04, S[1], S[2]], [-0.05, R[1], R[2]], 0.012),
    tube([0.045, Hb[1], Hb[2]], [0.05, F[1], F[2]], 0.014),
    tube([-0.045, Hb[1], Hb[2]], [-0.05, F[1], F[2]], 0.014),
  ];
  for (const g of frame) parts.push(tag(g, ROLE.frame, SLOT.frame));
  // seat post + saddle, stem + bars
  parts.push(tag(tube(S, [0, 0.87, -0.23], 0.013), ROLE.frame, SLOT.baked, RIM));
  parts.push(tag(box(0.13, 0.05, 0.27, 0, 0.895, -0.22), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(tube(Ht, [0, 0.93, 0.42], 0.015), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(tube([0.27, 0.94, 0.4], [-0.27, 0.94, 0.4], 0.013), ROLE.frame, SLOT.baked, DARK));
  for (const x of [0.25, -0.25]) parts.push(tag(tube([x, 0.94, 0.4], [x, 0.94, 0.34], 0.018), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(new IcosahedronGeometry(0.022, 0).translate(0.12, 0.965, 0.4), ROLE.frame, SLOT.bell));
  // chainring + crank arms + pedals (left arm points up at crank angle 0, right arm down)
  parts.push(tag(new CylinderGeometry(0.1, 0.1, 0.012, 12).rotateZ(Math.PI / 2).translate(-0.045, B[1], B[2]), ROLE.crank, SLOT.baked, RIM));
  parts.push(tag(box(0.025, CRANK, 0.03, 0.075, B[1] + CRANK / 2, B[2]), ROLE.crank, SLOT.baked, DARK));
  parts.push(tag(box(0.025, CRANK, 0.03, -0.075, B[1] - CRANK / 2, B[2]), ROLE.crank, SLOT.baked, DARK));
  parts.push(tag(box(0.09, 0.02, 0.08, 0.11, B[1] + CRANK, B[2]), ROLE.crank, SLOT.baked, DARK));
  parts.push(tag(box(0.09, 0.02, 0.08, -0.11, B[1] - CRANK, B[2]), ROLE.crank, SLOT.baked, DARK));
  // chain (static loop approximated by two strands)
  parts.push(tag(tube([-0.045, B[1] + 0.1, B[2]], [-0.045, R[1] + 0.04, R[2]], 0.006, 3), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(tube([-0.045, B[1] - 0.1, B[2]], [-0.045, R[1] - 0.04, R[2]], 0.006, 3), ROLE.frame, SLOT.baked, DARK));
  // lights
  parts.push(tag(box(0.07, 0.06, 0.05, 0, 0.88, 0.47), ROLE.frame, SLOT.headLamp));
  parts.push(tag(box(0.06, 0.07, 0.03, 0, 0.74, -0.27), ROLE.frame, SLOT.tailLamp));
  // hire bike: front carrier/basket, mudguards, chunky skirt guard (in frame colour)
  parts.push(tag(box(0.34, 0.14, 0.26, 0, 0.84, 0.62), ROLE.basket, SLOT.frame));
  parts.push(tag(bar([0, 0.6, -0.15], [0, 0.66, -0.72], 0.1, 0.03), ROLE.basket, SLOT.frame));
  parts.push(tag(bar([0, 0.66, 0.38], [0, 0.6, 0.82], 0.1, 0.03), ROLE.basket, SLOT.frame));
  parts.push(tag(box(0.16, 0.2, 0.3, 0, 0.5, -0.12), ROLE.basket, SLOT.frame));
  parts.push(...legs(), ...rider(0.94, 0.37));
  return parts;
}

/** A long-john cargo bike: rear half as the standard bike, a low long frame to a small front wheel, a box between. */
function cargo(): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const FR = 0.25;
  const R: [number, number, number] = [0, WHEEL_R, -0.5];
  const F: [number, number, number] = [0, FR, 1.32];
  const B: [number, number, number] = [0, BB[0], BB[1]];
  const S: [number, number, number] = [0, 0.8, -0.2];
  const Ht: [number, number, number] = [0, 0.86, 0.3];
  parts.push(...wheel(ROLE.front, FR, 1.32, FR), ...wheel(ROLE.rear, WHEEL_R, -0.5, WHEEL_R));
  const frame = [
    tube(B, S, 0.024),
    tube(S, Ht, 0.024),
    tube(B, [0, 0.3, 0.35], 0.03),
    tube([0, 0.3, 0.35], [0, 0.3, 1.1], 0.032),
    tube([0, 0.3, 1.1], [0, 0.62, 1.2], 0.028),
    tube([0, 0.62, 1.2], F, 0.02),
    tube(Ht, [0, 0.4, 0.33], 0.026),
    tube([0.05, B[1], B[2]], [0.05, R[1], R[2]], 0.014),
    tube([-0.05, B[1], B[2]], [-0.05, R[1], R[2]], 0.014),
    tube([0.04, S[1], S[2]], [0.05, R[1], R[2]], 0.012),
    tube([-0.04, S[1], S[2]], [-0.05, R[1], R[2]], 0.012),
  ];
  for (const g of frame) parts.push(tag(g, ROLE.frame, SLOT.frame));
  // the cargo box (accent: wood, or a brand colour) with a dark rim
  parts.push(tag(box(0.62, 0.42, 0.72, 0, 0.56, 0.74), ROLE.frame, SLOT.accent));
  parts.push(tag(box(0.64, 0.04, 0.74, 0, 0.78, 0.74), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(tube(S, [0, 0.87, -0.23], 0.013), ROLE.frame, SLOT.baked, RIM));
  parts.push(tag(box(0.14, 0.05, 0.27, 0, 0.895, -0.22), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(tube(Ht, [0, 0.95, 0.3], 0.015), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(tube([0.3, 0.95, 0.32], [-0.3, 0.95, 0.32], 0.014), ROLE.frame, SLOT.baked, DARK));
  parts.push(tag(new IcosahedronGeometry(0.022, 0).translate(0.12, 0.975, 0.32), ROLE.frame, SLOT.bell));
  parts.push(tag(new CylinderGeometry(0.1, 0.1, 0.012, 12).rotateZ(Math.PI / 2).translate(-0.045, B[1], B[2]), ROLE.crank, SLOT.baked, RIM));
  parts.push(tag(box(0.025, CRANK, 0.03, 0.075, B[1] + CRANK / 2, B[2]), ROLE.crank, SLOT.baked, DARK));
  parts.push(tag(box(0.025, CRANK, 0.03, -0.075, B[1] - CRANK / 2, B[2]), ROLE.crank, SLOT.baked, DARK));
  parts.push(tag(box(0.09, 0.02, 0.08, 0.11, B[1] + CRANK, B[2]), ROLE.crank, SLOT.baked, DARK));
  parts.push(tag(box(0.09, 0.02, 0.08, -0.11, B[1] - CRANK, B[2]), ROLE.crank, SLOT.baked, DARK));
  parts.push(tag(box(0.08, 0.06, 0.05, 0, 0.8, 1.12), ROLE.frame, SLOT.headLamp));
  parts.push(tag(box(0.06, 0.07, 0.03, 0, 0.74, -0.27), ROLE.frame, SLOT.tailLamp));
  parts.push(...legs(), ...rider(0.95, 0.29));
  return parts;
}

function merged(parts: BufferGeometry[]) {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  parts.forEach((p) => p.dispose());
  if (!g) throw new Error("bike geometry merge failed");
  g.computeBoundingSphere();
  return g;
}

export type BodyType = "standard" | "cargo";

export const buildBike = (kind: BodyType) => merged(kind === "cargo" ? cargo() : standard());

/** Per-instance attributes the shader reads; write them from the frame loop. */
export interface BikeAttrs {
  frame: InstancedBufferAttribute; // rgb frame colour, w = skin tone 0..1
  top: InstancedBufferAttribute; // rgb jacket/jersey, w = flags
  legs: InstancedBufferAttribute; // rgb trousers, w = head-lamp level
  accent: InstancedBufferAttribute; // rgb helmet/box, w = bell flash
  anim: InstancedBufferAttribute; // wheel angle, crank angle, tail-lamp level, unused
}

/** The bike material: standard PBR with the rider animation and colour slots patched in. */
export function bikeMaterial(kind: BodyType) {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.08 });
  const frontHub = kind === "cargo" ? [0.25, 1.32] : [WHEEL_R, 0.52];
  const frontRatio = kind === "cargo" ? WHEEL_R / 0.25 : 1;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec2 aPart;
attribute vec4 iFrame;
attribute vec4 iTop;
attribute vec4 iLegs;
attribute vec4 iAccent;
attribute vec4 iAnim;
varying vec3 vEmit;
const vec2 HIP = vec2(${HIP[0]}, ${HIP[1]});
const vec2 BB = vec2(${BB[0]}, ${BB[1]});
const float CR = ${CRANK};
const float L1 = ${THIGH};
const float L2 = ${SHIN};
const vec2 FHUB = vec2(${frontHub[0]}, ${frontHub[1]});
const vec2 RHUB = vec2(${WHEEL_R}, -0.5);
bool hasFlag(float flags, float bit) { return mod(floor(flags / bit), 2.0) > 0.5; }
// rotate (y, z) about the x axis by angle a
vec2 rotX(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(p.x * c - p.y * s, p.x * s + p.y * c); }
// rotate (y, z) so that "straight down" points along unit u
vec2 alignDown(vec2 p, vec2 u) { float c = -u.x, s = -u.y; return vec2(p.x * c - p.y * s, p.x * s + p.y * c); }
// knee position for a pedal at crank angle a (planar two-bone IK, knee forward)
vec2 kneeFor(vec2 P) {
  vec2 D = P - HIP; float d = clamp(length(D), abs(L1 - L2) + 0.01, L1 + L2 - 0.005);
  vec2 u = normalize(D);
  float a = (L1 * L1 - L2 * L2 + d * d) / (2.0 * d);
  float h = sqrt(max(0.0, L1 * L1 - a * a));
  vec2 n = vec2(u.y, -u.x);
  if (n.y < 0.0) n = -n;
  return HIP + u * a + n * h;
}
`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
float role = aPart.x;
float flags = iTop.w;
vec2 yz = position.yz;
vec2 nyz = objectNormal.yz;
float hide = 0.0;
bool riderOn = hasFlag(flags, 1.0);
if (role > 0.5 && role < 1.5) { float a = iAnim.x * ${frontRatio.toFixed(4)}; yz = rotX(yz - FHUB, a) + FHUB; nyz = rotX(nyz, a); }
else if (role > 1.5 && role < 2.5) { yz = rotX(yz - RHUB, iAnim.x) + RHUB; nyz = rotX(nyz, iAnim.x); }
else if (role > 2.5 && role < 3.5) { yz = rotX(yz - BB, iAnim.y) + BB; nyz = rotX(nyz, iAnim.y); }
else if (role > 3.5 && role < 7.5) {
  float ang = iAnim.y + (role > 5.5 ? 3.14159265 : 0.0);
  vec2 P = BB + CR * vec2(cos(ang), sin(ang));
  vec2 K = kneeFor(P);
  bool thigh = (role < 4.5) || (role > 5.5 && role < 6.5);
  vec2 u = thigh ? normalize(K - HIP) : normalize(P - K);
  yz = alignDown(yz, u) + (thigh ? HIP : K);
  nyz = alignDown(nyz, u);
  if (!riderOn) hide = 1.0;
}
else if (role > 7.5 && role < 13.5) {
  bool show = riderOn;
  if (role > 8.5 && role < 9.5) show = show && hasFlag(flags, 2.0);
  if (role > 9.5 && role < 10.5) show = show && hasFlag(flags, 4.0);
  if (role > 10.5 && role < 11.5) show = hasFlag(flags, 8.0);
  if (role > 11.5 && role < 12.5) show = show && hasFlag(flags, 16.0);
  if (!show) hide = 1.0;
  // road riders tuck: the upper body pivots forward about the hips
  if (hasFlag(flags, 32.0) && role != 11.0) { float t = 0.32; yz = rotX(yz - HIP, t) + HIP; nyz = rotX(nyz, t); }
}
objectNormal = vec3(objectNormal.x, nyz);
`,
      )
      .replace(
        "#include <begin_vertex>",
        `vec3 transformed = hide > 0.5 ? vec3(0.0) : vec3(position.x, yz);`,
      )
      .replace(
        "#include <color_vertex>",
        `#include <color_vertex>
float slot = aPart.y;
vEmit = vec3(0.0);
if (slot > 0.5 && slot < 1.5) vColor.rgb = iFrame.rgb;
else if (slot > 1.5 && slot < 2.5) vColor.rgb = iTop.rgb;
else if (slot > 2.5 && slot < 3.5) vColor.rgb = iLegs.rgb;
else if (slot > 3.5 && slot < 4.5) vColor.rgb = iAccent.rgb;
else if (slot > 4.5 && slot < 5.5) { vColor.rgb = vec3(0.85, 0.85, 0.8); vEmit = vec3(1.0, 0.94, 0.78) * iLegs.w * 2.2; }
else if (slot > 5.5 && slot < 6.5) { vColor.rgb = vec3(0.35, 0.02, 0.02); vEmit = vec3(1.0, 0.06, 0.03) * iAnim.z * 2.4; }
else if (slot > 6.5 && slot < 7.5) vColor.rgb = mix(vec3(0.94, 0.76, 0.6), vec3(0.36, 0.24, 0.16), iFrame.w);
else if (slot > 7.5) { vColor.rgb = vec3(0.75, 0.75, 0.72); vEmit = vec3(1.0, 0.85, 0.2) * iAccent.w * 2.5; }
`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vEmit;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;");
  };
  m.customProgramCacheKey = () => `cyclist-${kind}`;
  return m;
}

/** An InstancedMesh of `count` bikes of one body type with its per-instance attributes. */
export function createBikeMesh(kind: BodyType, count: number): { mesh: InstancedMesh; attrs: BikeAttrs } {
  const geo = buildBike(kind);
  const mk = () => new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4);
  const attrs: BikeAttrs = { frame: mk(), top: mk(), legs: mk(), accent: mk(), anim: mk() };
  attrs.top.setUsage(35048);
  attrs.legs.setUsage(35048);
  attrs.accent.setUsage(35048);
  attrs.anim.setUsage(35048); // DynamicDrawUsage
  geo.setAttribute("iFrame", attrs.frame);
  geo.setAttribute("iTop", attrs.top);
  geo.setAttribute("iLegs", attrs.legs);
  geo.setAttribute("iAccent", attrs.accent);
  geo.setAttribute("iAnim", attrs.anim);
  const mesh = new InstancedMesh(geo, bikeMaterial(kind), Math.max(1, count));
  mesh.frustumCulled = false;
  mesh.count = 0;
  return { mesh, attrs };
}
