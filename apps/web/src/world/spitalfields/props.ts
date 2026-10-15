// Merged, vertex-coloured street props particular to Spitalfields (one instanced mesh each). Local frame: y up,
// +z is the front (the side facing the aisle or the road).
import { BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry, type BufferGeometry } from "three";
import { merge, paint } from "../propModels";

const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: string) => paint(new BoxGeometry(w, h, d).translate(x, y, z), hex);
const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, hex: string, seg = 8) =>
  paint(new CylinderGeometry(rt, rb, h, seg).translate(x, y, z), hex);

/** Market stall frame: trestle table with goods, four posts (the awning is a separate, tinted mesh). */
export function stallFrameGeometry() {
  const parts: BufferGeometry[] = [box(2.5, 0.08, 1.3, 0, 0.86, 0.25, "#8a6a48"), box(2.4, 0.82, 1.2, 0, 0.42, 0.25, "#3d3f44")];
  for (const x of [-1.2, 1.2]) for (const z of [-0.85, 0.95]) parts.push(cyl(0.035, 0.035, 2.45, x, 1.22, z, "#2b2f33", 5));
  // goods: crates and folded stock in mixed colours
  const goods = ["#c0392b", "#f1c40f", "#2e86c1", "#e8e1d0", "#7d3c98", "#27ae60", "#e67e22", "#1c2833"];
  for (let i = 0; i < 6; i++) parts.push(box(0.36, 0.16 + (i % 3) * 0.08, 0.5, -1.0 + i * 0.4, 0.98 + (i % 3) * 0.04, 0.2 + (i % 2) * 0.15, goods[i]));
  parts.push(box(2.4, 1.4, 0.05, 0, 1.6, -0.85, "#4a4d52")); // back sheet
  return merge(parts);
}

/** The stall's awning (white; tinted per instance): a sloped canopy and a front valance. */
export function stallAwningGeometry() {
  const canopy = new BoxGeometry(2.7, 0.06, 2.1).rotateX(-0.18).translate(0, 2.5, 0.05);
  return merge([paint(canopy, "#ffffff"), box(2.7, 0.32, 0.04, 0, 2.2, 1.12, "#ffffff"), box(2.7, 0.08, 0.05, 0, 2.02, 1.12, "#e6e6e6")]);
}

/** A bicycle side-on along local x. */
export function bikeGeometry() {
  const wheel = (x: number) => paint(new TorusGeometry(0.33, 0.035, 4, 14).translate(x, 0.35, 0), "#1a1a1a");
  const frame = "#ffffff"; // tinted per instance (Santander red, black, teal ...)
  return merge([
    wheel(-0.52),
    wheel(0.52),
    paint(new BoxGeometry(0.75, 0.05, 0.05).translate(0, 0.62, 0), frame),
    paint(new BoxGeometry(0.62, 0.05, 0.05).rotateZ(0.9).translate(-0.25, 0.5, 0), frame),
    paint(new BoxGeometry(0.62, 0.05, 0.05).rotateZ(-0.9).translate(0.27, 0.5, 0), frame),
    paint(new BoxGeometry(0.05, 0.4, 0.05).translate(0.42, 0.78, 0), frame),
    box(0.06, 0.04, 0.46, 0.42, 0.98, 0, "#222"),
    box(0.24, 0.06, 0.12, -0.3, 0.9, 0, "#222"),
    cyl(0.025, 0.025, 0.28, -0.3, 0.76, 0, "#555", 4),
  ]);
}

/** Sheffield stand (inverted U) along local x, or a docking post when `dock`. */
export function standGeometry() {
  return merge([
    cyl(0.03, 0.03, 0.8, -0.35, 0.4, 0, "#5b6066", 6),
    cyl(0.03, 0.03, 0.8, 0.35, 0.4, 0, "#5b6066", 6),
    paint(new TorusGeometry(0.35, 0.03, 4, 10, Math.PI).translate(0, 0.8, 0), "#5b6066"),
  ]);
}

/** Banglatown lamp column: green column banded in red, scrolled bracket, lantern housing (glass separate). */
export function banglaLampGeometry() {
  const GREEN = "#0f6b37";
  const RED = "#c81f25";
  return merge([
    cyl(0.24, 0.3, 0.9, 0, 0.45, 0, GREEN, 10),
    cyl(0.31, 0.31, 0.12, 0, 0.95, 0, RED, 10),
    cyl(0.09, 0.13, 5.0, 0, 3.5, 0, GREEN, 8),
    cyl(0.15, 0.15, 0.18, 0, 2.6, 0, RED, 8),
    cyl(0.15, 0.15, 0.18, 0, 4.4, 0, RED, 8),
    box(0.05, 0.55, 0.05, 0, 5.8, 0.12, GREEN),
    box(0.06, 0.06, 0.95, 0, 6.05, 0.45, GREEN),
    cyl(0.05, 0.32, 0.28, 0, 6.15, 0.9, "#163d2a", 8), // lantern hood
    paint(new SphereGeometry(0.08, 6, 4).translate(0, 6.33, 0.9), "#d4af37"),
    paint(new SphereGeometry(0.12, 6, 4).translate(0, 6.12, 0), "#d4af37"),
  ]);
}

/** The lantern glass under the Banglatown lamp's hood (glows at night). */
export function banglaLanternGeometry() {
  return paint(new CylinderGeometry(0.26, 0.18, 0.5, 8).translate(0, 5.78, 0.9), "#fff1c9");
}
