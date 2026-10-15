// Day/night palette as a pure function of the hour. The Sky module turns this into lights, fog and background.
// Keyframes are blended linearly and wrap around midnight.
import { Color } from "three";

export interface SkyKey {
  h: number;
  sky: string; // background + fog
  hemiSky: string;
  hemiGround: string;
  hemi: number; // hemisphere light intensity
  sun: string;
  sunI: number;
  night: number; // 0 = day, 1 = full night (drives window glow, street lights, bloom)
}

// Calm, muted blues and greys; warm dusk; deep blue night (never pure black).
export const SKY_KEYS: SkyKey[] = [
  { h: 0, sky: "#121a2e", hemiSky: "#3a4a78", hemiGround: "#1a1d26", hemi: 0.45, sun: "#8fa6e0", sunI: 0.25, night: 1 },
  { h: 5, sky: "#1d2742", hemiSky: "#45558a", hemiGround: "#1f2230", hemi: 0.5, sun: "#9fb2e8", sunI: 0.25, night: 0.95 },
  { h: 6.5, sky: "#e9b8a0", hemiSky: "#f2c9b4", hemiGround: "#5d5a66", hemi: 0.75, sun: "#ffc79a", sunI: 0.9, night: 0.45 },
  { h: 8, sky: "#a9c4e0", hemiSky: "#dce8f5", hemiGround: "#6f7480", hemi: 1.0, sun: "#fff3e0", sunI: 1.5, night: 0 },
  { h: 13, sky: "#9fc0e3", hemiSky: "#e6f0fa", hemiGround: "#737985", hemi: 1.1, sun: "#ffffff", sunI: 1.8, night: 0 },
  { h: 17.5, sky: "#b3c3dc", hemiSky: "#e3e4f0", hemiGround: "#6c6f7c", hemi: 0.95, sun: "#ffe2bf", sunI: 1.3, night: 0.1 },
  { h: 19.5, sky: "#d79a8a", hemiSky: "#e8a99a", hemiGround: "#4c4658", hemi: 0.7, sun: "#ff9f73", sunI: 0.7, night: 0.55 },
  { h: 21, sky: "#2a3253", hemiSky: "#4d5a90", hemiGround: "#22232f", hemi: 0.5, sun: "#8a9ee0", sunI: 0.3, night: 0.95 },
  { h: 24, sky: "#121a2e", hemiSky: "#3a4a78", hemiGround: "#1a1d26", hemi: 0.45, sun: "#8fa6e0", sunI: 0.25, night: 1 },
];

export interface SkySample {
  sky: Color;
  hemiSky: Color;
  hemiGround: Color;
  hemi: number;
  sun: Color;
  sunI: number;
  night: number;
}

const ca = new Color();
const cb = new Color();

function lerpColor(out: Color, a: string, b: string, k: number) {
  return out.copy(ca.set(a)).lerp(cb.set(b), k);
}

export function createSkySample(): SkySample {
  return { sky: new Color(), hemiSky: new Color(), hemiGround: new Color(), hemi: 0, sun: new Color(), sunI: 0, night: 0 };
}

/** Writes the palette for `hour` (0..24) into `out`. */
export function sampleSky(hour: number, out: SkySample): SkySample {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1].h <= h) i++;
  const a = SKY_KEYS[i];
  const b = SKY_KEYS[i + 1];
  const k = (h - a.h) / (b.h - a.h);
  lerpColor(out.sky, a.sky, b.sky, k);
  lerpColor(out.hemiSky, a.hemiSky, b.hemiSky, k);
  lerpColor(out.hemiGround, a.hemiGround, b.hemiGround, k);
  lerpColor(out.sun, a.sun, b.sun, k);
  out.hemi = a.hemi + (b.hemi - a.hemi) * k;
  out.sunI = a.sunI + (b.sunI - a.sunI) * k;
  out.night = a.night + (b.night - a.night) * k;
  return out;
}

/** Night level only (cheap; for components that just need glow). */
export function nightLevel(hour: number): number {
  return sampleSky(hour, scratch).night;
}
const scratch = createSkySample();

/** Sun direction: rises east (+x) at 06:00, sets west at 20:00, leans south (-z). Moon-ish from the other side at night. */
export function sunPosition(hour: number, radius = 400): [number, number, number] {
  const h = ((hour % 24) + 24) % 24;
  const day = h >= 6 && h <= 20;
  const phi = day ? (Math.PI * (h - 6)) / 14 : (Math.PI * ((h - 20 + 24) % 24)) / 10;
  const y = Math.max(0.25, Math.sin(phi));
  const x = Math.cos(phi) * (day ? 1 : -1);
  return [x * radius, y * radius, -0.5 * radius];
}
