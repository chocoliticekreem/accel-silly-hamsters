// Billboard particle meshes driven straight from ParticlePool arrays (adapted from hamyway-city Crashes/vfx.ts).
import * as THREE from "three";
import type { ParticlePool } from "./fx";

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aParams; // size, alpha, rotation
attribute vec3 aColor;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
void main() {
  vUv = uv;
  vAlpha = aParams.y;
  vColor = aColor;
  vSeed = aParams.z;
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  float c = cos(aParams.z);
  float s = sin(aParams.z);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  mv.xy += p * aParams.x;
  gl_Position = projectionMatrix * mv;
}
`;

const SMOKE_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
void main() {
  vec2 q = vUv - 0.5;
  float d = length(q) * 2.0;
  float lumps = sin(q.x * 13.0 + vSeed * 3.0) * sin(q.y * 11.0 - vSeed * 2.0) * 0.16;
  float a = smoothstep(1.0, 0.25, d + lumps) * vAlpha;
  if (a < 0.01) discard;
  vec3 col = vColor * (0.82 + 0.4 * vUv.y);
  gl_FragColor = vec4(col, a);
}
`;

const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float body = pow(max(0.0, 1.0 - d), 1.7);
  float core = pow(max(0.0, 1.0 - d * 1.8), 3.0);
  float a = body * vAlpha;
  if (a < 0.004) discard;
  vec3 col = vColor * body + vec3(1.0, 0.95, 0.8) * core;
  gl_FragColor = vec4(col * vAlpha, 1.0);
}
`;

/** One draw call for a whole pool. Attributes alias the pool's arrays (zero copy). */
export function makeParticleMesh(pool: ParticlePool, additive: boolean): THREE.Mesh {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute("position", base.getAttribute("position"));
  geo.setAttribute("uv", base.getAttribute("uv"));
  const aPos = new THREE.InstancedBufferAttribute(pool.pos, 3);
  const aParams = new THREE.InstancedBufferAttribute(pool.params, 3);
  const aColor = new THREE.InstancedBufferAttribute(pool.color, 3);
  for (const a of [aPos, aParams, aColor]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aPos", aPos);
  geo.setAttribute("aParams", aParams);
  geo.setAttribute("aColor", aColor);
  geo.instanceCount = pool.n;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: additive ? GLOW_FRAG : SMOKE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = additive ? 12 : 10;
  return mesh;
}

export function markParticlesDirty(mesh: THREE.Mesh) {
  const g = mesh.geometry;
  (g.getAttribute("aPos") as THREE.InstancedBufferAttribute).needsUpdate = true;
  (g.getAttribute("aParams") as THREE.InstancedBufferAttribute).needsUpdate = true;
  (g.getAttribute("aColor") as THREE.InstancedBufferAttribute).needsUpdate = true;
}
