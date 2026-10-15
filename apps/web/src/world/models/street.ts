// London street furniture heroes: K6 telephone box, TfL roundel on a post, bus stop shelter with flag, London
// plane tree, Santander cycle dock and a tower crane (slewing top as node `slew`, rotate about y). Each prop has
// a `draw*(k)` that adds it into any Kit (so landmarks can reuse them inside their own merged geometry) and a
// model wrapper. Frame: front +z, ground y = 0, metres. Trees are seeded so a seed always gives the same tree.
import { ExtrudeGeometry, Shape } from "three";
import { rng } from "../../mock/rng";
import { Kit, type HeroModel } from "./kit";
import { drawRoundel, label } from "./materials";

const K6_RED = "#c8191c";

/** K6 "Jubilee" kiosk (Giles Gilbert Scott, 1935): 0.91 m square, 2.5 m, domed roof, crown, glazing grid. */
export function drawK6(k: Kit) {
  const w = 0.91, h = 2.42;
  k.box("solid", 1.0, 0.1, 1.0, 0, 0.05, 0, "#8d8a84"); // plinth
  // corner posts (fluted look: two boxes each) + roof frieze
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
    k.rbox("paint", 0.11, h, 0.11, x * (w / 2 - 0.05), 0.1 + h / 2, z * (w / 2 - 0.05), K6_RED, 0.02);
  k.box("paint", w - 0.08, h - 0.4, w - 0.08, 0, 0.1 + (h - 0.4) / 2, 0, "#2a2f36"); // dim interior
  k.rbox("paint", w, 0.32, w, 0, 0.1 + h - 0.16, 0, K6_RED, 0.03);
  // shallow segmental vault roof: two crossing half-cylinders + cap
  for (const ry of [0, Math.PI / 2]) {
    k.at(0, 0.1 + h, 0, ry, () => {
      k.add("paint", vault(), K6_RED, [0, 0, 0]);
    });
  }
  // four faces: glazing bars (3 x 8), TELEPHONE fascia, crown
  for (let f = 0; f < 4; f++) {
    k.at(0, 0, 0, (f * Math.PI) / 2, () => {
      const z = w / 2 - 0.035;
      k.box("glass", w - 0.2, h - 0.62, 0.02, 0, 0.1 + 0.2 + (h - 0.62) / 2, z, "#3b4a55");
      for (let i = 0; i <= 3; i++) k.box("paint", 0.035, h - 0.6, 0.04, -0.355 + i * 0.237, 0.1 + 0.2 + (h - 0.6) / 2, z + 0.02, K6_RED);
      for (let j = 0; j <= 8; j++) k.box("paint", w - 0.18, 0.03, 0.04, 0, 0.3 + j * ((h - 0.6) / 8), z + 0.02, K6_RED);
      k.box("paint", w - 0.1, 0.22, 0.05, 0, 0.18, z + 0.01, K6_RED); // kick panel
      k.box("solid", 0.34, 0.12, 0.02, 0.3, 1.25, z + 0.04, "#d8d2c0"); // door handle plate (front only matters)
      k.box("glow", w - 0.24, 0.12, 0.02, 0, 0.1 + h - 0.16, w / 2 + 0.005, "#fff8e8");
      k.sign("k6-telephone", w - 0.26, 0.11, [0, 0.1 + h - 0.16, w / 2 + 0.02], [256, 32], (c, cw, ch) => {
        c.fillStyle = "#fffaf0";
        c.fillRect(0, 0, cw, ch);
        label(c, "TELEPHONE", cw / 2, ch / 2 + 1, cw - 12, 26, "#141414", "500 {px}px 'Gill Sans', 'Helvetica Neue', Arial, sans-serif");
      });
      k.ring("paint", 0, 0.07, 10, [0, 0.1 + h + 0.12, w / 2 + 0.01], "#e0b23a"); // crown
    });
  }
}

/** Shallow segmental vault for the K6 roof: across x, 0.95 long in z, rising 0.14 m. */
function vault() {
  const s = new Shape();
  const R = 0.859, c = 0.719, a0 = Math.atan2(c, 0.47);
  s.moveTo(0.47, 0);
  s.absarc(0, -c, R, a0, Math.PI - a0, false);
  s.lineTo(0.47, 0);
  return new ExtrudeGeometry(s, { depth: 0.95, bevelEnabled: false, curveSegments: 10 }).translate(0, 0, -0.475);
}

export function k6Box(): HeroModel {
  const k = new Kit();
  drawK6(k);
  return k.model("k6-phone-box", { ao: 0.8 });
}

/** A flat roundel disc (ring + bar) both sides, with station name. Centre at (0, y, 0), facing ±z. */
export function drawRoundelPanel(k: Kit, name: string, y: number, r = 0.55, lit = true, ring = "#dc241f") {
  const ann = new Shape();
  ann.absarc(0, 0, r, 0, Math.PI * 2, false);
  const hole = new Shape();
  hole.absarc(0, 0, r * 0.64, 0, Math.PI * 2, true);
  ann.holes.push(hole);
  k.extrude(lit ? "glow" : "paint", ann, 0.06, [0, y, -0.03], ring, [0, 0, 0], 24);
  k.cylZ("solid", r * 0.64, 0.04, 24, [0, y, 0], lit ? "#f4f4f2" : "#e8e8e4");
  k.box(lit ? "glow" : "paint", r * 2.5, r * 0.46, 0.09, 0, y, 0, "#0019a8");
  for (const s of [1, -1])
    k.sign(`roundel-${name}`, r * 2.36, r * 0.4, [0, y, s * 0.05], [512, 80], (c, w, h) => {
      c.fillStyle = "#0019a8";
      c.fillRect(0, 0, w, h);
      label(c, name.toUpperCase(), w / 2, h / 2 + 2, w - 24, 58, "#ffffff", "600 {px}px 'Johnston', 'Gill Sans', 'Helvetica Neue', Arial, sans-serif");
    }, true, [0, s > 0 ? 0 : Math.PI, 0]);
}

/** Station roundel on a 3.6 m post. */
export function drawRoundelPost(k: Kit, name = "Old Street", height = 3.6) {
  k.cyl("solid", 0.16, 0.2, 0.25, 12, [0, 0.12, 0], "#2b2d31");
  k.cyl("metal", 0.07, 0.08, height, 10, [0, height / 2, 0], "#3a3f45");
  drawRoundelPanel(k, name, height + 0.4);
}

export function roundelSign(name = "Old Street"): HeroModel {
  const k = new Kit();
  drawRoundelPost(k, name);
  return k.model("tube-roundel", { ao: 0.5 });
}

/** TfL bus shelter: steel frame, glass back + end panels, roof, perch seat, lit ad panel, flag post. */
export function drawBusStop(k: Kit, stop = "Shoreditch High St", routes = ["8", "26", "35", "47", "78", "135", "242", "388"]) {
  const L = 4.6, D = 1.4, H = 2.55;
  const STEEL = "#4d5258";
  for (const x of [-L / 2, -L / 6, L / 6, L / 2]) k.box("metal", 0.08, H, 0.08, x, H / 2, -D / 2, STEEL);
  for (const x of [-L / 2, L / 2]) k.box("metal", 0.08, H, 0.08, x, H / 2, D / 2 - 0.3, STEEL);
  k.rbox("metal", L + 0.4, 0.12, D + 0.35, 0, H + 0.06, 0, "#3c4046", 0.04);
  k.box("glass", L + 0.3, 0.02, D + 0.2, 0, H + 0.13, 0, "#9fb7c2");
  k.box("glass", L, H - 0.35, 0.03, 0, 0.2 + (H - 0.35) / 2, -D / 2, "#a9c3cf");
  k.box("glass", 0.03, H - 0.35, D - 0.4, -L / 2, 0.2 + (H - 0.35) / 2, -0.15, "#a9c3cf");
  k.box("metal", 2.2, 0.06, 0.32, -0.6, 0.68, -D / 2 + 0.2, "#7c8288"); // perch seat
  // ad panel (lit) at the open end
  k.rbox("solid", 0.22, 1.95, 1.25, L / 2 + 0.05, 1.15, -0.05, "#26292d", 0.04);
  for (const s of [1, -1])
    k.sign(`busstop-ad-${s}`, 1.1, 1.75, [L / 2 + 0.05 + s * 0.115, 1.15, -0.05], [256, 400], (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, s > 0 ? "#ff5a36" : "#2d6cdf");
      g.addColorStop(1, s > 0 ? "#ffcf3a" : "#5de0c4");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.fillStyle = "rgba(255,255,255,0.9)";
      c.beginPath();
      c.arc(w / 2, h * 0.42, w * 0.28, 0, Math.PI * 2);
      c.fill();
      label(c, s > 0 ? "SUMMER SALE" : "LIVE AT XOYO", w / 2, h * 0.82, w - 20, 34, "#ffffff");
    }, true, [0, (s * Math.PI) / 2, 0]);
  // stop name on the roof edge
  k.sign(`busstop-name-${stop}`, 2.4, 0.2, [-0.8, H + 0.06, D / 2 + 0.18], [512, 44], (c, w, h) => {
    c.fillStyle = "#1c1f24";
    c.fillRect(0, 0, w, h);
    label(c, stop, w / 2, h / 2 + 1, w - 20, 30, "#ffffff", "600 {px}px 'Johnston', 'Gill Sans', 'Helvetica Neue', Arial, sans-serif");
  });
  // countdown display
  k.rbox("solid", 0.9, 0.3, 0.1, -0.6, H - 0.25, -D / 2 + 0.08, "#121316", 0.03);
  k.box("glow", 0.8, 0.2, 0.02, -0.6, H - 0.25, -D / 2 + 0.135, "#ffb12a");
  // flag post with the bus stop roundel and route plates
  k.at(-L / 2 - 0.8, 0, D / 2, 0, () => {
    k.cyl("metal", 0.05, 0.06, 3.1, 8, [0, 1.55, 0], "#4a4f55");
    k.box("solid", 0.04, 0.6, 0.6, 0.0, 2.95, 0, "#f6f6f2");
    for (const s of [1, -1])
      k.sign("bus-flag", 0.56, 0.56, [s * 0.025, 2.95, 0], [128, 128], (c, w, h) => {
        drawRoundel(c, w, h, "BUS STOP", "#dc241f", "#dc241f");
      }, false, [0, (s * Math.PI) / 2, 0]);
    k.box("solid", 0.04, 0.42, 0.6, 0, 2.42, 0, "#dc241f");
    for (const s of [1, -1])
      k.sign(`bus-routes-${routes.join(",")}`, 0.56, 0.38, [s * 0.025, 2.42, 0], [128, 88], (c, w, h) => {
        c.fillStyle = "#dc241f";
        c.fillRect(0, 0, w, h);
        routes.slice(0, 8).forEach((r, i) => {
          c.fillStyle = "#ffffff";
          c.fillRect(4 + (i % 4) * 31, 6 + Math.floor(i / 4) * 40, 28, 34);
          label(c, r, 18 + (i % 4) * 31, 24 + Math.floor(i / 4) * 40, 26, 18, "#111");
        });
      }, false, [0, (s * Math.PI) / 2, 0]);
  });
}

export function busStop(): HeroModel {
  const k = new Kit();
  drawBusStop(k);
  return k.model("bus-stop", { ao: 0.8 });
}

/**
 * London plane (Platanus × acerifolia): pale camouflage-mottled trunk, a few big limbs, a broad lumpy crown
 * of overlapping leaf clusters. ~1.4k tris. `height` scales the whole tree (default 12 m).
 */
export function drawPlaneTree(k: Kit, seed = 1, height = 12) {
  const r = rng(seed * 7919 + 17);
  const s = height / 12;
  const BARK = ["#b9b29c", "#8f8a74", "#c9c2a6", "#7d7a66"];
  k.cyl("solid", 0.26 * s, 0.36 * s, 4.2 * s, 9, [0, 2.1 * s, 0], "#a39c84");
  // mottled patches
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2, y = (0.4 + r() * 3.4) * s;
    const rr = (0.33 - (y / s) * 0.02) * s;
    k.box("solid", 0.22 * s, (0.25 + r() * 0.35) * s, 0.06 * s, Math.cos(a) * rr, y, Math.sin(a) * rr, BARK[i % 4], [0, -a + Math.PI / 2, 0]);
  }
  // limbs
  const tips: [number, number, number][] = [];
  const n = 4 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.6;
    const base: [number, number, number] = [0, (3.6 + r() * 0.6) * s, 0];
    const tip: [number, number, number] = [Math.cos(a) * (2.4 + r()) * s, (7 + r() * 2) * s, Math.sin(a) * (2.4 + r()) * s];
    k.beam("solid", base, tip, 0.15 * s, "#9e977f", 6);
    tips.push(tip);
  }
  k.beam("solid", [0, 3.8 * s, 0], [0.2 * s, 9.5 * s, -0.1 * s], 0.16 * s, "#9e977f", 6);
  tips.push([0.2 * s, 9.5 * s, -0.1 * s]);
  // crown clusters around the limb tips + a central mass
  const GREENS = ["#4f7d36", "#5d8c3e", "#6a9a46", "#47722f", "#76a650"];
  k.blob("solid", 3.4 * s, 1, [0, 8.6 * s, 0], GREENS[1], [1.15, 0.78, 1.15]);
  for (const t of tips) {
    const m = 2 + Math.floor(r() * 2);
    for (let j = 0; j < m; j++)
      k.blob("solid", (1.5 + r() * 1.1) * s, 1, [t[0] + (r() - 0.5) * 1.6 * s, t[1] + (r() - 0.3) * 1.2 * s, t[2] + (r() - 0.5) * 1.6 * s], GREENS[Math.floor(r() * GREENS.length)], [1, 0.8, 1]);
  }
  // tree pit grille
  k.box("metal", 1.4 * s, 0.03, 1.4 * s, 0, 0.015, 0, "#3a3c40");
}

export function planeTree(seed = 1): HeroModel {
  const k = new Kit();
  drawPlaneTree(k, seed);
  return k.model(`plane-tree-${seed}`, { ao: 3 });
}

/** Santander Cycles docking station: terminal + docked red bikes. */
export function drawCycleDock(k: Kit, bikes = 8) {
  k.rbox("solid", 0.5, 1.9, 0.35, 0, 0.95, 0, "#3c4148", 0.06);
  k.box("glow", 0.36, 0.3, 0.02, 0, 1.45, 0.18, "#8fd3ff");
  k.box("paint", 0.5, 0.15, 0.36, 0, 1.75, 0, "#e2231a");
  k.box("metal", bikes * 0.7 + 0.4, 0.08, 0.2, bikes * 0.35 + 0.6, 0.05, 0, "#55595f");
  for (let i = 0; i < bikes; i++) {
    const x = 0.85 + i * 0.7;
    k.box("metal", 0.12, 0.7, 0.12, x, 0.35, 0, "#55595f");
    // bike, front wheel into the dock (along z)
    k.at(x, 0, 0.9, 0, () => {
      for (const z of [-0.5, 0.5]) k.torus("solid", 0.32, 0.03, 4, 14, [0, 0.34, z], "#1b1b1d", [0, Math.PI / 2, 0]);
      k.bar("paint", [0, 0.34, -0.5], [0, 0.75, -0.05], 0.05, "#e2231a");
      k.bar("paint", [0, 0.75, -0.05], [0, 0.85, 0.42], 0.05, "#e2231a");
      k.bar("paint", [0, 0.34, -0.5], [0, 0.85, 0.42], 0.045, "#d6d8db");
      k.box("solid", 0.12, 0.05, 0.25, 0, 0.92, -0.2, "#151515"); // saddle
      k.box("metal", 0.55, 0.03, 0.03, 0, 1.05, 0.45, "#2a2c30"); // bars
      k.box("solid", 0.28, 0.16, 0.2, 0, 0.88, 0.62, "#e2231a"); // front carrier
    });
  }
}

/** Tower crane: lattice mast (static) + slewing top node `slew` (jib, counter-jib, cab, trolley, hook). */
export function towerCrane(mast = 42, jib = 40): HeroModel {
  const k = new Kit();
  const YEL = "#f2b705";
  const a = 1.0; // half mast width
  k.box("solid", 5, 1.2, 5, 0, 0.6, 0, "#9c9a94"); // base ballast
  const lattice = (h0: number, h1: number) => {
    for (const [x, z] of [[a, a], [a, -a], [-a, -a], [-a, a]]) k.bar("paint", [x, h0, z], [x, h1, z], 0.14, YEL);
    for (let y = h0; y < h1 - 0.1; y += 2) {
      const y1 = Math.min(h1, y + 2);
      const c = [[a, a], [a, -a], [-a, -a], [-a, a]];
      for (let i = 0; i < 4; i++) {
        const [x0, z0] = c[i], [x1, z1] = c[(i + 1) % 4];
        k.bar("paint", [x0, y, z0], [x1, y1, z1], 0.07, YEL);
        k.bar("paint", [x0, y1, z0], [x1, y1, z1], 0.06, YEL);
      }
    }
  };
  lattice(1.2, mast);
  k.node("slew", [0, mast, 0], (n) => {
    n.box("paint", 2.6, 0.6, 2.6, 0, 0.3, 0, YEL); // slewing ring
    // A-frame apex
    for (const [x, z] of [[a, a], [a, -a], [-a, -a], [-a, a]]) n.bar("paint", [x, 0.6, z], [0, 7, 0], 0.12, YEL);
    // jib (+x): triangular lattice
    const jy = 0.6, jh = 1.8;
    for (const z of [0.8, -0.8]) n.bar("paint", [0, jy, z], [jib, jy, z], 0.12, YEL);
    n.bar("paint", [0, jy + jh, 0], [jib, jy + 0.6, 0], 0.12, YEL);
    for (let x = 0; x < jib - 0.5; x += 2) {
      const t0 = jy + jh - (x / jib) * (jh - 0.6), t1 = jy + jh - ((x + 2) / jib) * (jh - 0.6);
      for (const z of [0.8, -0.8]) n.bar("paint", [x, jy, z], [x + 2, t1, 0], 0.06, YEL);
      n.bar("paint", [x, jy, 0.8], [x, jy, -0.8], 0.06, YEL);
      void t0;
    }
    // ties from apex
    n.bar("metal", [0, 7, 0], [jib * 0.62, jy + jh - 0.62 * (jh - 0.6), 0], 0.04, "#6c7076");
    n.bar("metal", [0, 7, 0], [-11, jy + 1.2, 0], 0.04, "#6c7076");
    // counter-jib (-x) with walkway, counterweights, winch house
    for (const z of [0.9, -0.9]) n.bar("paint", [0, jy, z], [-12, jy, z], 0.14, YEL);
    n.box("metal", 12, 0.06, 1.6, -6, jy + 0.06, 0, "#7a7e84");
    for (let i = 0; i < 4; i++) n.box("solid", 0.7, 2.4, 2.0, -9.2 - i * 0.75, jy - 0.9, 0, "#a7a49b");
    n.rbox("solid", 2.6, 1.6, 1.6, -5, jy + 0.9, 0, "#d9d7d0", 0.08);
    // cab
    n.rbox("paint", 1.8, 2.2, 1.8, 1.4, -0.6, 1.4, YEL, 0.1);
    n.box("glass", 1.82, 1.1, 1.5, 1.5, -0.2, 1.4, "#2a3a48");
    // trolley + hook block hanging at mid-jib
    n.box("solid", 1.6, 0.5, 1.4, jib * 0.55, jy - 0.3, 0, "#2b2d31");
    n.beam("metal", [jib * 0.55, jy - 0.5, 0.15], [jib * 0.55, -14, 0.15], 0.025, "#2a2a2a", 4);
    n.beam("metal", [jib * 0.55, jy - 0.5, -0.15], [jib * 0.55, -14, -0.15], 0.025, "#2a2a2a", 4);
    n.box("paint", 0.5, 0.7, 0.4, jib * 0.55, -14.3, 0, "#e23b1f");
    n.box("glow", 0.25, 0.25, 0.25, jib + 0.1, jy + 0.9, 0, "#ff2a1a"); // aviation lamps
    n.box("glow", 0.25, 0.25, 0.25, 0, 7.2, 0, "#ff2a1a");
  });
  return k.model("tower-crane", { ao: 2 });
}
