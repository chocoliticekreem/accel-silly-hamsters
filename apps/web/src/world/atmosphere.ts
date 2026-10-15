// Ties the scene to the real Earth for @takram/three-atmosphere: the world origin sits on Shoreditch High St
// (51.5265°N, 0.0779°W), scene +x = east, +y = up, +z = south (toScene flips north). Sim time maps to a real date
// in early September (BST), whose sunrise ~06:25 and sunset ~19:25 match the sim's day/night palette, so the
// physically based sun sets behind the City exactly when the windows come on.
import { getECIToECEFRotationMatrix, getMoonDirectionECI, getSunDirectionECI } from "@takram/three-atmosphere";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import { Color, Matrix3, Matrix4, Vector3, type ShaderMaterial, type Uniform } from "three";
import type { Effect } from "postprocessing";
import { dayOf, hourOf } from "../sim/time";

const SHOREDITCH = new Geodetic(radians(-0.0779), radians(51.5265), 20);
export const ORIGIN_ECEF = SHOREDITCH.toECEF();

/**
 * Art direction: the compass is turned 50° so the evening sun (really in the west) sets in the south-west, straight
 * behind the City skyline as seen from the default camera. Elevation and timing stay real.
 */
const AZIMUTH_TURN = 50;

/** World (scene) → ECEF: rotation (east, up, south) plus the origin. */
export const WORLD_TO_ECEF = (() => {
  const east = new Vector3();
  const north = new Vector3();
  const up = new Vector3();
  Ellipsoid.WGS84.getEastNorthUpVectors(ORIGIN_ECEF, east, north, up);
  // scene axis pointing at compass azimuth a (clockwise from north), turned by AZIMUTH_TURN
  const axis = (a: number) => {
    const r = radians(a + AZIMUTH_TURN);
    return north.clone().multiplyScalar(Math.cos(r)).addScaledVector(east, Math.sin(r));
  };
  return new Matrix4().makeBasis(axis(90), up, axis(180)).setPosition(ORIGIN_ECEF);
})();
const ECEF_TO_WORLD_ROT = new Matrix3().setFromMatrix4(WORLD_TO_ECEF).transpose();

/** A real instant for sim minute `t`: day 0 = Thu 10 Sep 2026, local clock = BST (UTC+1). */
export function simDate(t: number): number {
  return Date.UTC(2026, 8, 10 + dayOf(t)) + (hourOf(t) - 1) * 3_600_000;
}

export interface Celestial {
  sunECEF: Vector3;
  moonECEF: Vector3;
  inertialToECEF: Matrix4;
  /** Unit vectors in scene space. */
  sun: Vector3;
  moon: Vector3;
}

export const createCelestial = (): Celestial => ({ sunECEF: new Vector3(), moonECEF: new Vector3(), inertialToECEF: new Matrix4(), sun: new Vector3(0, 1, 0), moon: new Vector3(0, -1, 0) });

/**
 * The atmosphere works in physical luminance (its demos run at exposure ~10); our city is lit and tone mapped for
 * exposure ~1. One gain brings the sky and the aerial-perspective inscatter into our range without touching the
 * transmittance (so distant buildings still fade into the real sky colour).
 */
export const SKY_GAIN = { value: 9 };
/** Art-directed floor added to the sky (palette zenith at dusk/night), so twilight never reads as a black hole. */
export const SKY_FLOOR = { value: new Color() };

/** Patches takram's SkyMaterial so its radiance is scaled by SKY_GAIN. */
export function gainSky(material: ShaderMaterial): void {
  if (material.userData.gained) return;
  material.userData.gained = true;
  material.uniforms.uSkyGain = SKY_GAIN;
  material.uniforms.uSkyFloor = SKY_FLOOR;
  // RawShaderMaterial: declare after the precision statements, i.e. just before main()
  material.fragmentShader = material.fragmentShader
    .replace("void main()", "uniform float uSkyGain;\nuniform vec3 uSkyFloor;\nvoid main()")
    .replace(/outputColor\.a = 1\.0;\s*#include <mrt_output>/, "outputColor.rgb = outputColor.rgb * uSkyGain + uSkyFloor;\n  outputColor.a = 1.0;\n  #include <mrt_output>");
  material.needsUpdate = true;
}

/** Patches takram's AerialPerspectiveEffect so inscattered light is scaled by SKY_GAIN (transmittance unchanged). */
export function gainAerial(effect: Effect): void {
  const e = effect as Effect & { fragmentShader: string; setFragmentShader(s: string): void; uniforms: Map<string, Uniform> };
  if (e.uniforms.has("uSkyGain")) return;
  e.uniforms.set("uSkyGain", SKY_GAIN as Uniform<number>);
  e.setFragmentShader(
    "uniform float uSkyGain;\n" +
      e.fragmentShader.replace(
        "applyTransmittanceInscatter(positionECEF, shadowLength, radiance);",
        "radiance /= uSkyGain; applyTransmittanceInscatter(positionECEF, shadowLength, radiance); radiance *= uSkyGain;",
      ),
  );
}

/** Sun and moon for sim minute `t`, in ECEF (for the atmosphere) and scene space (for our lights). */
export function updateCelestial(t: number, out: Celestial): Celestial {
  const date = simDate(t);
  getECIToECEFRotationMatrix(date, out.inertialToECEF);
  getSunDirectionECI(date, out.sunECEF).applyMatrix4(out.inertialToECEF);
  getMoonDirectionECI(date, out.moonECEF).applyMatrix4(out.inertialToECEF);
  out.sun.copy(out.sunECEF).applyMatrix3(ECEF_TO_WORLD_ROT).normalize();
  out.moon.copy(out.moonECEF).applyMatrix3(ECEF_TO_WORLD_ROT).normalize();
  return out;
}
