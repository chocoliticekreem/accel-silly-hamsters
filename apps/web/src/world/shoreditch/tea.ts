// The Tea Building (the 1930s Lipton tea warehouse at 56 Shoreditch High Street, corner of Bethnal Green Road):
// a big London-stock brick warehouse, eight storeys on the High Street and seven along Bethnal Green Road, with long
// ranks of steel-framed windows, a stone string course and cornice, shopfronts at street level, white painted
// lettering on the corner and Shoreditch House's rooftop pool. Outlines from OSM (ways 273244686, 164600036).
// Drawn into the area Kit (brick / glass / solid / metal slots), so it costs no extra draw calls but one sign.
import { Shape, ExtrudeGeometry, Vector2 } from "three";
import { toScene } from "../../sim/geometry";
import type { Kit } from "../models/kit";
import { label } from "../models/materials";

export const TEA_HIGH_ST: [number, number][] = [
  [-142.7, 112.6], [-142.2, 73.2], [-139.6, 69.8], [-139.5, 62.3], [-140.1, 59], [-140.9, 51.8], [-174, 52.7], [-177.9, 57.6],
  [-175.5, 108.8], [-170.5, 113.3], [-142.9, 115.3],
];
export const TEA_BGR: [number, number][] = [
  [-140.9, 51.8], [-122.3, 51.3], [-122.7, 58.3], [-125, 61.3], [-125.5, 68.3], [-123.1, 71.4], [-123.4, 77.8], [-124, 91.2],
  [-126.8, 114.5], [-140.1, 112.8], [-142.7, 112.6], [-142.2, 73.2], [-139.6, 69.8], [-139.5, 62.3], [-140.1, 59],
];

const GF = 4.4; // ground floor
const FL = 3.3; // upper floors

function signedArea(r: [number, number][]) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, z0] = r[i];
    const [x1, z1] = r[(i + 1) % r.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** A brick warehouse on an OSM ring (contract coords): mass, windows on every facade, string course and cornice. */
export function warehouse(k: Kit, ring: [number, number][], floors: number, opts: { brick: string; seed: number; shopfronts?: boolean }) {
  const H = GF + (floors - 1) * FL;
  const shape = new Shape(ring.map(([x, z]) => new Vector2(x, z)));
  const mass = new ExtrudeGeometry(shape, { depth: H, bevelEnabled: false });
  mass.rotateX(-Math.PI / 2);
  k.add("brick", mass, opts.brick, [0, 0, 0]);
  // stone cornice and parapet (a slightly larger extrusion, shrunk back on the inside by drawing it thin)
  const cornice = new ExtrudeGeometry(shape, { depth: 0.55, bevelEnabled: false });
  cornice.rotateX(-Math.PI / 2);
  k.add("solid", cornice, "#d7cfbf", [0, H, 0], [0, 0, 0], [1, 1, 1]);
  const ccw = signedArea(ring) > 0;
  let lit = opts.seed;
  const rnd = () => ((lit = (lit * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 5) continue;
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    // outward normal (contract)
    const ox = ccw ? dz : -dz;
    const oz = ccw ? -dx : dx;
    const yaw = Math.atan2(ox, -oz); // scene yaw whose local +z is the outward normal
    const at = (t: number, out: number): [number, number] => toScene(ax + dx * t + ox * out, az + dz * t + oz * out);
    const bays = Math.floor((len - 1.2) / 3.6);
    const pad = (len - bays * 3.6) / 2;
    // string course over the ground floor and a band under the cornice
    for (const y of [GF - 0.1, H - 0.9]) {
      const [cx, cz] = at(len / 2, 0.08);
      k.box("solid", len, 0.32, 0.18, cx, y, cz, "#cfc6b4", [0, yaw, 0]);
    }
    for (let b = 0; b < bays; b++) {
      const t = pad + (b + 0.5) * 3.6;
      // shopfronts / ground floor glazing
      const [gx, gz] = at(t, 0.06);
      if (opts.shopfronts !== false) {
        k.box("glass", 3.0, GF - 1.0, 0.1, gx, (GF - 1.0) / 2 + 0.25, gz, rnd() < 0.7 ? "#7b8a96" : "#2a3540", [0, yaw, 0]);
        k.box("metal", 3.2, 0.12, 0.16, gx, GF - 0.72, gz, "#22262b", [0, yaw, 0]);
      }
      for (let f = 1; f < floors; f++) {
        const y = GF + (f - 1) * FL + FL * 0.52;
        const [wx, wz] = at(t, 0.05);
        // lit or dark glass (the hero glass slot glows warm at night only for the lighter tones)
        k.box("glass", 2.3, 2.15, 0.1, wx, y, wz, rnd() < 0.42 ? "#6f7f8c" : "#25303a", [0, yaw, 0]);
        // steel glazing bars: a transom and two mullions
        k.box("metal", 2.34, 0.06, 0.14, wx, y + 0.35, wz, "#1d2126", [0, yaw, 0]);
        for (const m of [-0.4, 0.4]) {
          const [mx, mz] = at(t + m, 0.05);
          k.box("metal", 0.05, 2.15, 0.14, mx, y, mz, "#1d2126", [0, yaw, 0]);
        }
        // stone sill
        const [sx, sz] = at(t, 0.12);
        k.box("solid", 2.6, 0.12, 0.22, sx, y - 1.13, sz, "#cbc2b0", [0, yaw, 0]);
      }
    }
  }
  return H;
}

/** The Tea Building pair, the corner lettering and Shoreditch House's rooftop pool. */
export function teaBuilding(k: Kit) {
  const hA = warehouse(k, TEA_HIGH_ST, 8, { brick: "#9a5f45", seed: 11 });
  warehouse(k, TEA_BGR, 7, { brick: "#8f5842", seed: 29 });
  // white painted lettering on a raised brick parapet over the Bethnal Green Road front, by the High Street corner
  const [wx, wz] = toScene(-160, 52.1);
  k.slab("brick", wx - 9, wx + 9, hA + 0.5, hA + 3.3, wz - 0.4, wz + 0.1, "#9a5f45");
  k.slab("solid", wx - 9.1, wx + 9.1, hA + 3.3, hA + 3.5, wz - 0.5, wz + 0.2, "#d7cfbf");
  k.sign("shs-tea-letters", 17, 2.4, [wx, hA + 1.9, wz + 0.12], [1024, 144], (c, w, h) => {
    c.clearRect(0, 0, w, h);
    label(c, "THE TEA BUILDING", w / 2, h / 2 + 4, w - 30, 120, "#f3efe6", "800 {px}px 'Helvetica Neue', Arial, sans-serif");
  }, false);
  // Shoreditch House on the roof: a glazed pavilion, the pool and loungers
  const [px, pz] = toScene(-160, 95);
  k.slab("glass", px - 9, px + 9, hA + 0.55, hA + 4.2, pz - 4, pz + 4, "#7b8c98");
  k.slab("metal", px - 9.3, px + 9.3, hA + 4.2, hA + 4.5, pz - 4.3, pz + 4.3, "#2b2f35");
  const [qx, qz] = toScene(-160, 75);
  k.slab("solid", qx - 9, qx + 9, hA + 0.55, hA + 0.75, qz - 5, qz + 5, "#d9d2c3");
  k.slab("paint", qx - 7, qx + 7, hA + 0.75, hA + 0.8, qz - 2.6, qz + 2.6, "#3fb4dc");
  for (let i = 0; i < 6; i++) k.slab("solid", qx - 6 + i * 2.4, qx - 5 + i * 2.4, hA + 0.75, hA + 1.1, qz + 3.3, qz + 4.6, "#f1ede4");
  // plant and lift overruns on the lower block
  const [rx, rz] = toScene(-132, 95);
  k.slab("solid", rx - 4, rx + 4, GF + 6 * FL + 0.55, GF + 6 * FL + 3.2, rz - 6, rz + 6, "#8e8a84");
}
