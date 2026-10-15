// Multi-part low-poly models in ONE draw call: each piece of a model carries a vertex colour, a "tint" weight
// (how much the per-instance colour applies: car body yes, tyres no) and a "glow" weight (headlights, lit windows).
// partMaterial() is a MeshStandardMaterial patched to read those; `uGlow` scales every glowing part at once
// (headlights come on at dusk by setting one uniform).
import { BufferAttribute, Color, MeshStandardMaterial, type BufferGeometry, type MeshStandardMaterialParameters } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface PartOpts {
  /** 0 = keep the vertex colour, 1 = multiply by the instance colour. */
  tint?: number;
  /** Emissive weight (× uGlow). */
  glow?: number;
}

const tmp = new Color();

/** Paints a geometry as one part: vertex colour + tint/glow weights. Returns the same geometry. */
export function part(g: BufferGeometry, color: string | Color, { tint = 0, glow = 0 }: PartOpts = {}): BufferGeometry {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  tmp.set(color);
  for (let i = 0; i < n; i++) {
    c[i * 3] = tmp.r;
    c[i * 3 + 1] = tmp.g;
    c[i * 3 + 2] = tmp.b;
  }
  g.setAttribute("color", new BufferAttribute(c, 3));
  g.setAttribute("aTint", new BufferAttribute(new Float32Array(n).fill(tint), 1));
  g.setAttribute("aGlow", new BufferAttribute(new Float32Array(n).fill(glow), 1));
  if (!g.attributes.uv) g.setAttribute("uv", new BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

/** Merges painted parts into one geometry (all indexed or all not: we normalise to non-indexed). */
export function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(flat, false)!;
  flat.forEach((p, i) => {
    if (p !== parts[i]) p.dispose();
    parts[i].dispose();
  });
  g.computeBoundingSphere();
  return g;
}

export type PartMaterial = MeshStandardMaterial & { userData: { uGlow: { value: number } } };

export function partMaterial(params: MeshStandardMaterialParameters = {}): PartMaterial {
  const m = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, ...params, vertexColors: true }) as PartMaterial;
  const uGlow = { value: 0 };
  m.userData.uGlow = uGlow;
  m.onBeforeCompile = (s) => {
    s.uniforms.uGlow = uGlow;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aTint;\nattribute float aGlow;\nvarying float vGlow;")
      .replace(
        "#include <color_vertex>",
        `vColor = vec3(1.0);
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor *= mix(vec3(1.0), instanceColor.xyz, aTint);
#endif
  vGlow = aGlow;`,
      );
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uGlow;\nvarying float vGlow;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += vColor.rgb * vGlow * uGlow;");
  };
  m.customProgramCacheKey = () => "parts-v1";
  return m;
}
