// One material for every real building wall and roof (and the railway viaduct's arches): vertex colours carry the
// wall / roof colour, a per-vertex `aWin` attribute carries the facade layout, and the fragment shader draws the
// windows. aWin = (u, v, style + seed, rows):
//   u     window cells along the wall (integer per wall edge, so windows never straddle a corner)
//   v     floors above the ground (y / floor height)
//   style 0 brick sash, 1 office ribbon, 2 glass curtain wall, 3 industrial, 5 viaduct arches (u = arches, v = metres);
//         +8 = shopfront on the ground floor. The fraction is a per-building seed.
//   rows  number of window rows (0: no windows, e.g. roofs and parapets)
// Lit windows at night: uniforms.night (0..1). Far away the pattern fades to its average so it doesn't shimmer.
import { MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from "three";

export interface FacadeMaterial extends MeshStandardMaterial {
  uniforms: { night: { value: number } };
}

let shared: FacadeMaterial | null = null;

/** The shared facade material (one shader program for buildings and viaducts). */
export function facadeMaterial(): FacadeMaterial {
  if (shared) return shared;
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02 }) as FacadeMaterial;
  mat.uniforms = { night: { value: 0 } };
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uNight = mat.uniforms.night;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 aWin;\nvarying vec4 vWin;\nvarying vec3 vFacadePos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWin = aWin;\nvFacadePos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec4 vWin;
        varying vec3 vFacadePos;
        uniform float uNight;
        float fHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        float fBox(float x, float y, float x0, float x1, float y0, float y1) {
          return step(x0, x) * step(x, x1) * step(y0, y) * step(y, y1);
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float fRows = vWin.w;
        float fStyleAll = floor(vWin.z + 0.001);
        float fSeed = fract(vWin.z);
        float fShop = step(7.5, fStyleAll);
        float fStyle = fStyleAll - 8.0 * fShop;
        float fu = vWin.x;
        float fv = vWin.y;
        float fFloor = floor(fv);
        float fx = fract(fu);
        float fy = fract(fv);
        float fWin = 0.0;
        float fAvg = 0.0;
        float fLitShare = 0.3;
        if (fStyle < 0.5) { fWin = fBox(fx, fy, 0.3, 0.7, 0.28, 0.82); fAvg = 0.22; fLitShare = 0.32; }
        else if (fStyle < 1.5) { fWin = fBox(fx, fy, 0.08, 0.92, 0.3, 0.86); fAvg = 0.47; fLitShare = 0.42; }
        else if (fStyle < 2.5) { fWin = fBox(fx, fy, 0.03, 0.97, 0.06, 0.94); fAvg = 0.82; fLitShare = 0.45; }
        else if (fStyle < 3.5) { fWin = fBox(fx, fy, 0.16, 0.84, 0.25, 0.85); fAvg = 0.4; fLitShare = 0.2; }
        float fArch = 0.0;
        if (fStyle > 4.5 && fStyle < 5.5) {
          // viaduct: an arch per cell, recessed and dark; a few let as lit workshops and bars
          float ax = (fx - 0.5) / 0.4;
          float top = 3.6 + 2.4 * sqrt(max(0.0, 1.0 - ax * ax));
          fArch = step(abs(ax), 1.0) * step(fv, top);
          fWin = 0.0;
        }
        float fGround = fShop * step(fFloor, 0.5);
        if (fGround > 0.5) { fWin = fBox(fx, fy, 0.04, 0.96, 0.06, 0.8); fAvg = 0.7; }
        fWin *= step(fFloor + 0.5, fRows) * step(0.5, fRows);
        fAvg *= step(0.5, fRows) * step(fFloor + 0.5, fRows);
        float fDist = length(vFacadePos - cameraPosition);
        float fFade = 1.0 - smoothstep(380.0, 1150.0, fDist);
        float fMask = mix(fAvg, fWin, fFade);
        float fCell = fHash(vec3(floor(fu) + fSeed * 97.0, fFloor, fSeed * 13.0));
        vec3 fGlass = mix(vec3(0.07, 0.09, 0.12), vec3(0.26, 0.32, 0.4), fCell * 0.6 + fShop * fGround * 0.2);
        diffuseColor.rgb = mix(diffuseColor.rgb, fGlass, fMask * 0.92);
        // window reveals: a thin dark frame line around each opening (near only)
        diffuseColor.rgb *= 1.0 - fArch * 0.78;
        float fLit = step(1.0 - fLitShare - fGround * 0.4, fCell);
        float fGlow = mix(fAvg * fLitShare, fWin * fLit, fFade) + fArch * step(0.72, fHash(vec3(floor(fu), fSeed, 3.0))) * 0.8;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.22, fMask);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.76, 0.42) * fGlow * uNight * 1.35;`,
      );
  };
  mat.customProgramCacheKey = () => "real-facade-v1";
  shared = mat;
  return mat;
}
