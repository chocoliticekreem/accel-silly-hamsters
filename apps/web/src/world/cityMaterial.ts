// A building material for instanced boxes of any size: windows are drawn procedurally from world position
// (one window every 4 m, one floor every 3.5 m) instead of a texture, so stretched unit boxes still get
// correctly sized windows, and ~a third of them light up at night (set `uniforms.night.value`, 0..1).
// Far away the window grid fades to its average tone so it doesn't shimmer.
import { MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from "three";

export interface CityMaterial extends MeshStandardMaterial {
  uniforms: { night: { value: number } };
}

export function cityMaterial(opts: { litShare?: number; roughness?: number } = {}): CityMaterial {
  const mat = new MeshStandardMaterial({ roughness: opts.roughness ?? 0.88, metalness: 0.05 }) as CityMaterial;
  mat.uniforms = { night: { value: 0 } };
  const lit = (1 - (opts.litShare ?? 0.35)).toFixed(3);
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uNight = mat.uniforms.night;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCityPos;\nvarying vec3 vCityNormal;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          mat4 cityModel = modelMatrix;
          #ifdef USE_INSTANCING
            cityModel = modelMatrix * instanceMatrix;
          #endif
          vCityPos = (cityModel * vec4(transformed, 1.0)).xyz;
          vCityNormal = normalize(mat3(cityModel) * objectNormal);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vCityPos;
        varying vec3 vCityNormal;
        uniform float uNight;
        float cityHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 cn = abs(vCityNormal);
        float wall = step(cn.y, 0.5);
        float along = cn.x > cn.z ? vCityPos.z : vCityPos.x;
        float across = cn.x > cn.z ? vCityPos.x : vCityPos.z;
        float fx = fract(along / 4.0);
        float fy = fract(vCityPos.y / 3.5);
        float win = wall * step(0.24, fx) * step(fx, 0.76) * step(0.3, fy) * step(fy, 0.82) * step(3.5, vCityPos.y);
        float camDist = length(vCityPos - cameraPosition);
        float fade = 1.0 - smoothstep(500.0, 1400.0, camDist);
        float winAvg = wall * 0.52 * 0.52 * step(3.5, vCityPos.y);
        float winMix = mix(winAvg, win, fade);
        float litCell = step(${lit}, cityHash(vec3(floor(along / 4.0), floor(vCityPos.y / 3.5), floor(across / 3.0))));
        float litMix = mix(winAvg * (1.0 - ${lit}), win * litCell, fade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.24, 0.3), winMix * 0.7);
        // roofs a little darker than the walls
        diffuseColor.rgb *= mix(1.0, 0.72, 1.0 - wall);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * litMix * uNight * 1.25;`,
      );
  };
  mat.customProgramCacheKey = () => `city-${lit}`;
  return mat;
}
