// Low-poly people for every crowd in the city. One instanced mesh for all people (plus one for umbrellas and one
// for dogs), so three draw calls however many people there are. The walk cycle runs in the vertex shader
// (limbs swing, the body bobs, idle people shift weight and gesture); the CPU only writes one transform and a few
// per-instance floats per person. Ported from hamyway-city's Crowds shader, driven by our per-frame `set` API.
// Colours per person: shirt (torso + arms), trousers (legs), skin (head); hair tone, bag, umbrella and dog are
// picked from a hash of those colours, so they stay with the same person from frame to frame.
import {
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  type Material,
} from "three";
import { dogGeometry, personGeometry, umbrellaGeometry } from "./crowdMeshes";

export const SKIN_TONES = ["#f1c9a5", "#e0ac69", "#c68642", "#8d5524", "#5c3a21", "#ffdbac", "#a86b3c"].map((c) => new Color(c));
export const TROUSERS = ["#2b2f3a", "#3a3f4b", "#1f2430", "#4a4036", "#36454f", "#5b6b7d", "#2e3b2e"].map((c) => new Color(c));

const UMBRELLAS = ["#111111", "#1d3557", "#c8201e", "#ffd60a", "#2a9d8f", "#6d6875", "#111111"].map((c) => new Color(c));
const DOGS = ["#3b2a1a", "#c68642", "#f1e3c8", "#111111", "#8d6e63", "#e0c097"].map((c) => new Color(c));

/** Share of people carrying an umbrella / walking a dog. */
const UMBRELLA_SHARE = 0.04;
const DOG_SHARE = 0.035;

export interface People {
  group: Group;
  /** Writes person `i`. `phase` drives the walk cycle; `moving` = false stands still. */
  set(i: number, x: number, y: number, z: number, heading: number, phase: number, moving: boolean, scale: number, shirt: Color, trousers: Color, skin: Color): void;
  /** Shows the first `n` people written this frame. */
  commit(n: number): void;
  dispose(): void;
}

// --- shaders -------------------------------------------------------------------------------------------------

const COMMON = /* glsl */ `
uniform float uTime;
attribute vec4 aAnim;   // phase (rad), moving 0/1, kind (0 person, 1 umbrella holder, 2 dog walker), look seed 0..1
attribute vec3 aShirt;
attribute vec3 aPants;
attribute vec3 aSkin;
attribute float aPart;
varying vec3 vCrowdColor;

vec3 crowdRotX(vec3 p, float pivotY, float pivotZ, float a) {
  float c = cos(a), s = sin(a);
  vec2 q = vec2(p.y - pivotY, p.z - pivotZ);
  return vec3(p.x, pivotY + q.x * c - q.y * s, pivotZ + q.x * s + q.y * c);
}
`;

const PERSON = /* glsl */ `
vec3 crowdDeform(vec3 p) {
  float phase = aAnim.x;
  float moving = aAnim.y;
  float umb = step(0.5, aAnim.z) * step(aAnim.z, 1.5);
  float seed = aAnim.w;
  float idle = 1.0 - moving;
  float sw = sin(phase);
  float amp = 0.48 * moving;
  float part = aPart;
  // legs (and shoes)
  if (part > 1.5 && part < 3.5) p = crowdRotX(p, 0.9, 0.0, sw * amp * (part < 2.5 ? 1.0 : -1.0));
  // arms swing opposite the legs; umbrella holders raise the right arm; idle people gesture now and then
  if (part > 3.5 && part < 5.5) {
    float side = part < 4.5 ? -1.0 : 1.0;
    float a = sw * amp * 0.85 * side;
    if (part > 4.5) a = mix(a, -0.75, umb);
    float talk = idle * step(0.55, sin(uTime * 0.35 + seed * 40.0)) * (-0.45 - 0.3 * sin(uTime * 3.0 + seed * 20.0));
    a += part > 4.5 ? talk : 0.0;
    p = crowdRotX(p, 1.4, 0.0, a);
  }
  // heads nod while chatting
  if ((part > 0.5 && part < 1.5) || (part > 5.5 && part < 6.5)) p = crowdRotX(p, 1.45, 0.0, idle * 0.1 * sin(uTime * 1.7 + seed * 30.0));
  // idle weight shift; a slight forward lean when walking
  p.x += p.y * idle * 0.03 * sin(uTime * 0.6 + seed * 50.0);
  p.z += p.y * moving * 0.04;
  // bob: two steps per stride
  p.y += abs(sw) * 0.05 * moving;

  float tone = fract(seed * 7.13);
  vec3 hair = tone > 0.86 ? vec3(0.62, 0.45, 0.18) : tone > 0.7 ? vec3(0.45, 0.45, 0.47) : mix(vec3(0.015, 0.012, 0.01), vec3(0.32, 0.17, 0.06), tone / 0.7);
  vec3 bag = fract(seed * 3.7) > 0.5 ? vec3(0.06, 0.05, 0.05) : vec3(0.32, 0.2, 0.11);
  vec3 legs = position.y < 0.07 ? vec3(0.03) : aPants;
  vCrowdColor = part < 0.5 || (part > 3.5 && part < 5.5) ? aShirt
              : part < 1.5 ? aSkin
              : part < 3.5 ? legs
              : part < 6.5 ? hair
              : bag;
  return p;
}
`;

const UMBRELLA = /* glsl */ `
vec3 crowdDeform(vec3 p) {
  p.y += abs(sin(aAnim.x)) * 0.05 * aAnim.y;
  vCrowdColor = aPart < 0.5 ? aShirt : vec3(0.02);
  return p;
}
`;

const DOG = /* glsl */ `
vec3 crowdDeform(vec3 p) {
  float sw = sin(aAnim.x * 2.0);
  float m = aAnim.y;
  if (aPart > 1.5) p.z += (0.26 - p.y) * sw * 0.9 * m * (aPart < 2.5 ? 1.0 : -1.0);
  p.y += abs(sw) * 0.03 * m;
  if (aPart > 0.5 && aPart < 1.5) p.y += 0.02 * sin(uTime * 2.0 + aAnim.w * 10.0);
  vCrowdColor = aPart > 0.5 && aPart < 1.5 ? aShirt * 0.8 : aShirt;
  return p;
}
`;

type Variant = "person" | "umbrella" | "dog";
const BODY: Record<Variant, string> = { person: PERSON, umbrella: UMBRELLA, dog: DOG };
const BEGIN = "vec3 transformed = crowdDeform(vec3(position));";

function patchVertex(src: string, variant: Variant) {
  return src.replace("#include <common>", `#include <common>\n${COMMON}\n${BODY[variant]}`).replace("#include <begin_vertex>", BEGIN);
}

function crowdMaterials(variant: Variant, uTime: { value: number }, emissive: number) {
  const mat = new MeshStandardMaterial({ roughness: 0.82, metalness: 0, flatShading: true, emissive: "#ffffff", emissiveIntensity: emissive });
  if (variant === "umbrella") mat.side = DoubleSide;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = patchVertex(shader.vertexShader, variant);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCrowdColor;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= vCrowdColor;")
      // the night self-glow tints by the person's colours instead of washing them white
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vCrowdColor;");
  };
  mat.customProgramCacheKey = () => `crowd-${variant}`;
  // shadows follow the swinging limbs too
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = patchVertex(shader.vertexShader, variant);
  };
  depth.customProgramCacheKey = () => `crowd-depth-${variant}`;
  return { mat, depth };
}

// --- instancing ----------------------------------------------------------------------------------------------

interface Layer {
  mesh: InstancedMesh;
  anim: Float32Array;
  shirt: Float32Array;
  pants: Float32Array;
  skin: Float32Array;
  attrs: InstancedBufferAttribute[];
  mats: Material[];
}

function layer(geo: BufferGeometry, variant: Variant, capacity: number, uTime: { value: number }, emissive: number, castShadow: boolean): Layer {
  const { mat, depth } = crowdMaterials(variant, uTime, emissive);
  const mesh = new InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.customDepthMaterial = depth;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  const anim = new Float32Array(capacity * 4);
  const shirt = new Float32Array(capacity * 3);
  const pants = new Float32Array(capacity * 3);
  const skin = new Float32Array(capacity * 3);
  const attr = (name: string, arr: Float32Array, size: number) => {
    const a = new InstancedBufferAttribute(arr, size);
    a.setUsage(DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  const attrs = [attr("aAnim", anim, 4), attr("aShirt", shirt, 3), attr("aPants", pants, 3), attr("aSkin", skin, 3)];
  return { mesh, anim, shirt, pants, skin, attrs, mats: [mat, depth] };
}

function writeColor(arr: Float32Array, i: number, c: Color) {
  arr[i * 3] = c.r;
  arr[i * 3 + 1] = c.g;
  arr[i * 3 + 2] = c.b;
}

function flush(l: Layer, n: number) {
  l.mesh.count = n;
  l.mesh.instanceMatrix.needsUpdate = true;
  for (const a of l.attrs) {
    a.clearUpdateRanges();
    a.addUpdateRange(0, n * a.itemSize);
    a.needsUpdate = true;
  }
}

/** Stable 0..1 identity for a person from their (fixed) colours. */
function lookSeed(shirt: Color, trousers: Color, skin: Color) {
  let h = 2166136261;
  for (const v of [shirt.r, shirt.g, shirt.b, trousers.r, trousers.g, trousers.b, skin.r, skin.g, skin.b]) {
    h ^= Math.round(v * 4095);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const base = new Matrix4();
const scaleM = new Matrix4();
const dogM = new Matrix4();

export function createPeople(capacity: number, opts: { emissive?: number } = {}): People {
  const uTime = { value: 0 };
  const emissive = opts.emissive ?? 0.04;
  const people = layer(personGeometry(), "person", capacity, uTime, emissive, true);
  const accessories = Math.max(8, Math.ceil(capacity * 0.08));
  const umbrellas = layer(umbrellaGeometry(), "umbrella", accessories, uTime, emissive * 0.5, true);
  const dogs = layer(dogGeometry(), "dog", accessories, uTime, emissive * 0.5, false);
  const group = new Group();
  group.name = "people";
  // children[0] must stay the people mesh: modules tune its material's emissiveIntensity for the night glow
  group.add(people.mesh, umbrellas.mesh, dogs.mesh);
  let nUmb = 0;
  let nDog = 0;
  const t0 = performance.now();

  return {
    group,
    set(i, x, y, z, heading, phase, moving, scale, shirt, trousers, skin) {
      base.makeRotationY(heading).multiply(scaleM.makeScale(scale, scale, scale));
      base.setPosition(x, y, z);
      people.mesh.setMatrixAt(i, base);
      const seed = lookSeed(shirt, trousers, skin);
      const kind = seed < UMBRELLA_SHARE ? 1 : seed < UMBRELLA_SHARE + DOG_SHARE ? 2 : 0;
      const a = people.anim;
      a[i * 4] = phase;
      a[i * 4 + 1] = moving ? 1 : 0;
      a[i * 4 + 2] = kind;
      a[i * 4 + 3] = seed;
      writeColor(people.shirt, i, shirt);
      writeColor(people.pants, i, trousers);
      writeColor(people.skin, i, skin);
      if (kind === 1 && nUmb < umbrellas.mesh.instanceMatrix.count) {
        const u = nUmb++;
        umbrellas.mesh.setMatrixAt(u, base);
        umbrellas.anim.set([phase, moving ? 1 : 0, 1, seed], u * 4);
        writeColor(umbrellas.shirt, u, UMBRELLAS[Math.floor(seed * 1000) % UMBRELLAS.length]);
      } else if (kind === 2 && nDog < dogs.mesh.instanceMatrix.count) {
        const d = nDog++;
        // the dog trots a little ahead and to the left of its owner
        dogM.makeTranslation(0.6, 0, 1.15).multiply(scaleM.makeScale(0.9, 0.9, 0.9));
        dogs.mesh.setMatrixAt(d, dogM.premultiply(base));
        dogs.anim.set([phase, moving ? 1 : 0, 2, seed], d * 4);
        writeColor(dogs.shirt, d, DOGS[Math.floor(seed * 1000) % DOGS.length]);
      }
    },
    commit(n) {
      uTime.value = (performance.now() - t0) / 1000;
      flush(people, n);
      flush(umbrellas, nUmb);
      flush(dogs, nDog);
      nUmb = 0;
      nDog = 0;
    },
    dispose() {
      for (const l of [people, umbrellas, dogs]) {
        l.mesh.geometry.dispose();
        l.mats.forEach((m) => m.dispose());
        l.mesh.dispose();
      }
    },
  };
}
