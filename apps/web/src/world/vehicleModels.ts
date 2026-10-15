// Procedural low-poly London vehicles. Bodies are side silhouettes (with wheel-arch cut-outs, sloped bonnets and
// windscreens, rounded roofs) extruded across the width with a bevel, so they read as cars rather than boxes:
// a lower body in paint, a tinted glasshouse set in a little (tumblehome), a roof skin and pillars in paint,
// bumpers, grilles, mirrors, plates and wheels with hubs. Each model is merged into one geometry per part:
//   paint  per-vehicle colour            fixed  vertex-coloured trim, tyres, signs, liveries
//   glass  tinted windows (bus decks glow at night)
//   head   headlights                    tail   tail/brake lights (brightness per vehicle)
// Local frame: front is +z, left is +x, ground at y = 0, wheels touching it.
// Sizes are real (metres): New Routemaster 11.2 × 2.55 × 4.4, TX taxi 4.6 × 1.9 × 1.85, Transit van 5.5 × 2.0 × 2.5.
// Swap point: a hand-made "hero" model for a kind can replace `buildVehicle(kind)` without touching Traffic.tsx.
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, ExtrudeGeometry, Shape } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type VehicleKind = "bus" | "cab" | "hatch" | "saloon" | "suv" | "estate" | "van" | "police" | "ambulance" | "bike";
export const VEHICLE_KINDS: VehicleKind[] = ["bus", "cab", "hatch", "saloon", "suv", "estate", "van", "police", "ambulance", "bike"];

export type Part = "paint" | "fixed" | "glass" | "head" | "tail";
export const PARTS: Part[] = ["paint", "fixed", "glass", "head", "tail"];

interface Piece {
  part: Part;
  geo: BufferGeometry;
  color?: string;
}

type P2 = [number, number];

/** Window tint (the glass material colour). */
export const GLASS = "#1d2733";
const TRIM = "#1e1f22";
const PLASTIC = "#2a2c30";
const CHROME = "#c3c8ce";
const TYRE = "#161618";
const HUB = "#9aa0a6";
const AMBER = "#ff9a1a";
const PLATE = "#f2efe2";
const PLATE_REAR = "#f2d21a";

const tmpColor = new Color();

function box(part: Part, w: number, h: number, l: number, x: number, y: number, z: number, color?: string): Piece {
  return { part, geo: new BoxGeometry(w, h, l).translate(x, y, z), color };
}

/** Extrudes a side silhouette (points are [along z, up y]) across `width` (centred on x = xOff), with a bevel. */
function sideExtrude(shape: Shape, width: number, bevel: number, xOff = 0) {
  const depth = Math.max(0.005, width - bevel * 2);
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.6, bevelSegments: 2, curveSegments: 8 });
  // shape x -> world z (forward), extrusion z -> world x (across)
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2);
  g.translate(xOff, 0, 0);
  return g;
}

function poly(points: P2[]) {
  const s = new Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  return s;
}

function side(part: Part, points: P2[] | Shape, width: number, bevel = 0, color?: string, xOff = 0): Piece {
  return { part, geo: sideExtrude(Array.isArray(points) ? poly(points) : points, width, bevel, xOff), color };
}

/** The same thin strip on both flanks (pillars, liveries, side glass): extruded `t` thick at x = ±x. */
function flanks(part: Part, points: P2[], x: number, t: number, color?: string): Piece[] {
  return [side(part, points, t, 0, color, x), side(part, points, t, 0, color, -x)];
}

/** Lower-body silhouette: bottom edge at y0 with wheel arches cut round `wheels` (z centres) of radius r. */
function bodyShape(rear: P2[], front: P2[], top: P2[], y0: number, wheels: number[], r: number) {
  const s = new Shape();
  const start = rear[0];
  s.moveTo(start[0], start[1]);
  // along the bottom from rear to front, cutting the arches
  const arch = r + 0.07;
  for (const z of [...wheels].sort((a, b) => a - b)) {
    s.lineTo(z - arch, y0);
    s.lineTo(z - arch, r);
    s.absarc(z, r, arch, Math.PI, 0, true);
    s.lineTo(z + arch, y0);
  }
  for (const p of front) s.lineTo(p[0], p[1]);
  for (const p of top) s.lineTo(p[0], p[1]);
  for (const p of rear.slice(1).reverse()) s.lineTo(p[0], p[1]);
  s.closePath();
  return s;
}

function wheels(xs: number, zs: number[], r: number, width = 0.24): Piece[] {
  const out: Piece[] = [];
  for (const z of zs)
    for (const s of [1, -1]) {
      const x = s * xs;
      out.push({ part: "fixed", geo: new CylinderGeometry(r, r, width, 14).rotateZ(Math.PI / 2).translate(x, r, z), color: TYRE });
      out.push({ part: "fixed", geo: new CylinderGeometry(r * 0.58, r * 0.58, width + 0.02, 10).rotateZ(Math.PI / 2).translate(x, r, z), color: HUB });
    }
  return out;
}

interface CarSpec {
  L: number;
  W: number;
  /** Underside height. */
  y0: number;
  /** Belt line (bottom of the side windows). */
  yb: number;
  /** Roof height. */
  yr: number;
  /** Nose (top of the front bumper / bonnet leading edge). */
  yn: number;
  /** Windscreen base and roof front (z). */
  zw: number;
  zrf: number;
  /** Roof rear and rear window base (z). */
  zrr: number;
  zrw: number;
  /** Boot deck rear height (saloon) — omit for hatch/estate/SUV. */
  boot?: number;
  wheelR: number;
  /** Wheel centres (z). */
  wz: [number, number];
  /** B-pillar position (z). */
  zb: number;
}

/** A car from a spec: body, glasshouse, roof skin, pillars, bumpers, lights, mirrors, plates, wheels. */
function car(s: CarSpec): Piece[] {
  const h = s.L / 2;
  const front: P2[] = [
    [h, s.y0 + 0.05],
    [h + 0.02, s.yn - 0.12],
    [h - 0.1, s.yn],
    [s.zw + 0.15, s.yb + 0.05],
    [s.zw, s.yb + 0.06],
  ];
  const rearTop = s.boot ?? s.yb;
  const top: P2[] = s.boot ? [[s.zrw, s.yb + 0.04], [-h + 0.2, s.boot + 0.02], [-h + 0.05, s.boot - 0.04]] : [[s.zrw, s.yb + 0.04], [-h + 0.06, s.yb]];
  const rear: P2[] = [
    [-h, s.y0 + 0.05],
    [-h - 0.02, rearTop - 0.18],
  ];
  const body = bodyShape(rear, front, top, s.y0, s.wz, s.wheelR);
  const glassW = s.W - 0.2;
  const glassPts: P2[] = [
    [s.zw, s.yb],
    [s.zrf, s.yr - 0.05],
    [s.zrr, s.yr - 0.05],
    [s.zrw, s.yb],
  ];
  const roof: P2[] = [
    [s.zrf - 0.02, s.yr - 0.08],
    [s.zrr + 0.02, s.yr - 0.08],
    [s.zrr - 0.06, s.yr],
    [s.zrf + 0.1, s.yr],
  ];
  // pillars along the glass edges, on both flanks (proud of the glass so the windows read as framed)
  const strip = (a: P2, b: P2, t: number): P2[] => [a, b, [b[0] - t, b[1]], [a[0] - t, a[1]]];
  const aPillar = strip([s.zw + 0.02, s.yb], [s.zrf + 0.02, s.yr - 0.05], 0.12);
  const cPillar = strip([s.zrr + 0.12, s.yr - 0.05], [s.zrw + 0.14, s.yb], 0.16);
  const bPillar: P2[] = [
    [s.zb + 0.06, s.yb],
    [s.zb + 0.06, s.yr - 0.05],
    [s.zb - 0.06, s.yr - 0.05],
    [s.zb - 0.06, s.yb],
  ];
  const fx = glassW / 2 + 0.01;
  const p: Piece[] = [
    side("paint", body, s.W, 0.06),
    side("glass", glassPts, glassW, 0.03),
    side("paint", roof, glassW + 0.04, 0.03),
    ...flanks("paint", aPillar, fx, 0.05),
    ...flanks("paint", cPillar, fx, 0.05),
    ...flanks("paint", bPillar, fx, 0.05),
    // dark belt-line trim and sills
    ...flanks("fixed", [[s.zw - 0.05, s.yb - 0.02], [s.zrw, s.yb - 0.02], [s.zrw, s.yb + 0.02], [s.zw - 0.05, s.yb + 0.02]], s.W / 2 + 0.005, 0.03, TRIM),
    ...flanks("fixed", [[s.wz[1] + s.wheelR + 0.1, s.y0 + 0.02], [s.wz[0] - s.wheelR - 0.1, s.y0 + 0.02], [s.wz[0] - s.wheelR - 0.1, s.y0 + 0.12], [s.wz[1] + s.wheelR + 0.1, s.y0 + 0.12]], s.W / 2 + 0.01, 0.04, PLASTIC),
    // bumpers
    box("fixed", s.W + 0.02, 0.2, 0.14, 0, s.y0 + 0.14, h + 0.02, PLASTIC),
    box("fixed", s.W + 0.02, 0.2, 0.14, 0, s.y0 + 0.14, -h - 0.02, PLASTIC),
    // grille and plates
    box("fixed", s.W * 0.42, 0.13, 0.04, 0, s.yn - 0.2, h + 0.07, TRIM),
    box("fixed", 0.52, 0.11, 0.02, 0, s.y0 + 0.28, h + 0.1, PLATE),
    box("fixed", 0.52, 0.11, 0.02, 0, rearTop - 0.32, -h - 0.07, PLATE_REAR),
    // door mirrors
    box("fixed", 0.16, 0.11, 0.08, s.W / 2 + 0.08, s.yb + 0.08, s.zw - 0.12, TRIM),
    box("fixed", 0.16, 0.11, 0.08, -s.W / 2 - 0.08, s.yb + 0.08, s.zw - 0.12, TRIM),
    // indicators on the front wings
    box("fixed", 0.04, 0.05, 0.12, s.W / 2 + 0.01, s.yn - 0.1, h - 0.45, AMBER),
    box("fixed", 0.04, 0.05, 0.12, -s.W / 2 - 0.01, s.yn - 0.1, h - 0.45, AMBER),
  ];
  for (const x of [1, -1]) {
    p.push(box("head", 0.36, 0.12, 0.06, x * (s.W / 2 - 0.26), s.yn - 0.15, h + 0.04));
    p.push(box("tail", 0.3, 0.14, 0.06, x * (s.W / 2 - 0.2), rearTop - 0.16, -h - 0.06));
  }
  p.push(...wheels(s.W / 2 - 0.14, s.wz, s.wheelR));
  return p;
}

// --- cars ----------------------------------------------------------------------------------------------------

const hatch = () =>
  car({ L: 4.05, W: 1.76, y0: 0.18, yb: 0.92, yr: 1.46, yn: 0.74, zw: 0.85, zrf: 0.05, zrr: -1.55, zrw: -1.9, wheelR: 0.31, wz: [1.32, -1.28], zb: -0.55 });
const saloon = () =>
  car({ L: 4.7, W: 1.82, y0: 0.17, yb: 0.9, yr: 1.43, yn: 0.72, zw: 0.95, zrf: 0.15, zrr: -1.2, zrw: -1.75, boot: 0.98, wheelR: 0.32, wz: [1.45, -1.4], zb: -0.5 });
const suv = () =>
  car({ L: 4.6, W: 1.88, y0: 0.26, yb: 1.08, yr: 1.7, yn: 0.95, zw: 0.98, zrf: 0.3, zrr: -2.0, zrw: -2.18, wheelR: 0.37, wz: [1.42, -1.38], zb: -0.62 });
const estate = () =>
  car({ L: 4.8, W: 1.82, y0: 0.17, yb: 0.92, yr: 1.48, yn: 0.73, zw: 1.0, zrf: 0.2, zrr: -2.15, zrw: -2.32, wheelR: 0.32, wz: [1.48, -1.45], zb: -0.5 });

/** London taxi (TX4 shape): tall upright cabin, rounded nose, chrome grille, amber TAXI sign. */
function cab(): Piece[] {
  const p = car({ L: 4.58, W: 1.9, y0: 0.2, yb: 1.0, yr: 1.84, yn: 0.86, zw: 1.05, zrf: 0.55, zrr: -1.95, zrw: -2.15, wheelR: 0.35, wz: [1.5, -1.38], zb: -0.35 });
  p.push(box("fixed", 0.9, 0.42, 0.06, 0, 0.62, 2.36, CHROME)); // big chrome grille
  p.push(box("fixed", 0.08, 0.3, 0.06, 0, 0.62, 2.38, TRIM));
  p.push(box("fixed", 0.62, 0.17, 0.24, 0, 1.92, 0.42, "#ffb000")); // TAXI sign
  p.push(box("fixed", 0.66, 0.04, 0.26, 0, 1.84, 0.42, TRIM));
  p.push(box("fixed", 0.03, 0.03, 1.3, 0.96, 0.62, -0.4, CHROME)); // door handles strip
  p.push(box("fixed", 0.03, 0.03, 1.3, -0.96, 0.62, -0.4, CHROME));
  return p;
}

/** White Transit-style panel van (high roof): short bonnet, steep screen, cab windows only. */
function van(): Piece[] {
  const L = 5.5;
  const W = 2.0;
  const h = L / 2;
  const r = 0.36;
  const wz: [number, number] = [h - 0.85, -h + 1.15];
  const shape = new Shape();
  const y0 = 0.3;
  shape.moveTo(-h, y0);
  const arch = r + 0.07;
  for (const z of [wz[1], wz[0]]) {
    shape.lineTo(z - arch, y0);
    shape.lineTo(z - arch, r);
    shape.absarc(z, r, arch, Math.PI, 0, true);
    shape.lineTo(z + arch, y0);
  }
  shape.lineTo(h, y0);
  shape.lineTo(h + 0.02, 0.85);
  shape.lineTo(h - 0.15, 1.08); // bonnet
  shape.lineTo(h - 0.75, 1.25);
  shape.lineTo(h - 1.35, 2.2); // windscreen
  shape.quadraticCurveTo(h - 1.5, 2.5, h - 1.9, 2.5); // rounded roof front
  shape.lineTo(-h + 0.15, 2.5);
  shape.quadraticCurveTo(-h, 2.5, -h, 2.35);
  shape.closePath();
  const p: Piece[] = [
    side("paint", shape, W, 0.06),
    // windscreen and cab side windows: one glass slab proud of the cab
    side("glass", [[h - 0.8, 1.28], [h - 1.36, 2.18], [h - 1.95, 2.18], [h - 1.95, 1.3]], W + 0.02, 0.01),
    side("paint", [[h - 1.95, 1.25], [h - 2.12, 1.25], [h - 2.12, 2.3], [h - 1.95, 2.3]], W + 0.04, 0.01), // B pillar
    ...flanks("fixed", [[-h + 0.2, 1.25], [-h + 3.0, 1.25], [-h + 3.0, 1.28], [-h + 0.2, 1.28]], W / 2 + 0.01, 0.02, "#d8dadc"), // panel crease
    ...flanks("fixed", [[-h + 2.95, 0.5], [-h + 2.98, 0.5], [-h + 2.98, 2.1], [-h + 2.95, 2.1]], W / 2 + 0.01, 0.02, "#b5b8bc"), // sliding door seam
    box("fixed", W + 0.04, 0.24, 0.16, 0, 0.42, h + 0.03, PLASTIC),
    box("fixed", W + 0.04, 0.24, 0.16, 0, 0.42, -h - 0.03, PLASTIC),
    box("fixed", 1.0, 0.28, 0.04, 0, 0.72, h + 0.07, TRIM), // grille
    box("fixed", 0.52, 0.11, 0.02, 0, 0.58, h + 0.12, PLATE),
    box("fixed", 0.52, 0.11, 0.02, 0, 0.62, -h - 0.12, PLATE_REAR),
    box("fixed", 0.03, 2.0, 0.03, 0, 1.4, -h - 0.06, "#b5b8bc"), // rear door split
    box("fixed", 0.2, 0.26, 0.1, W / 2 + 0.1, 1.55, h - 1.0, TRIM), // mirrors
    box("fixed", 0.2, 0.26, 0.1, -W / 2 - 0.1, 1.55, h - 1.0, TRIM),
    ...flanks("fixed", [[wz[1] + 0.5, y0], [wz[0] - 0.5, y0], [wz[0] - 0.5, y0 + 0.14], [wz[1] + 0.5, y0 + 0.14]], W / 2 + 0.01, 0.04, PLASTIC),
  ];
  for (const x of [1, -1]) {
    p.push(box("head", 0.34, 0.16, 0.06, x * (W / 2 - 0.25), 0.9, h + 0.05));
    p.push(box("tail", 0.14, 0.5, 0.06, x * (W / 2 - 0.1), 1.0, -h - 0.06));
  }
  p.push(...wheels(W / 2 - 0.14, wz, r, 0.26));
  return p;
}

/** Battenburg squares along both flanks between y0 and y1, from z0 to z1. */
function battenburg(z0: number, z1: number, y0: number, y1: number, x: number, a: string, b: string): Piece[] {
  const out: Piece[] = [];
  const n = Math.max(2, Math.round((z1 - z0) / ((y1 - y0) / 2 + 0.25)));
  const w = (z1 - z0) / n;
  const hy = (y1 - y0) / 2;
  for (let k = 0; k < n; k++)
    for (let row = 0; row < 2; row++) {
      const za = z0 + k * w;
      const ya = y0 + row * hy;
      out.push(...flanks("fixed", [[za, ya], [za + w, ya], [za + w, ya + hy], [za, ya + hy]], x, 0.015, (k + row) % 2 ? a : b));
    }
  return out;
}

/** Met police estate: white, blue/yellow Battenburg, roof light bar. */
function police(): Piece[] {
  const p = estate();
  p.push(...battenburg(-2.2, 1.9, 0.42, 0.86, 0.915, "#1d3fb8", "#f4d21c"));
  p.push(box("fixed", 1.25, 0.12, 0.3, 0, 1.53, -0.3, "#1f4fff"));
  p.push(box("fixed", 0.32, 0.13, 0.31, 0, 1.53, -0.3, "#e8e8e8"));
  return p;
}

/** NHS ambulance: yellow high-roof van, green/yellow Battenburg, blue light bar. */
function ambulance(): Piece[] {
  const p = van();
  p.push(...battenburg(-2.7, 2.6, 0.5, 1.2, 1.006, "#1f8a3a", "#f2e21a"));
  p.push(...flanks("fixed", [[-2.7, 1.62], [0.7, 1.62], [0.7, 1.82], [-2.7, 1.82]], 1.006, 0.015, "#1f5fd0"));
  p.push(box("fixed", 1.5, 0.14, 0.28, 0, 2.58, 0.9, "#1f4fff"));
  return p;
}

/** New Routemaster-style double-decker, 11.2 × 2.55 × 4.4 m. */
function bus(): Piece[] {
  const L = 11.2;
  const W = 2.55;
  const H = 4.4;
  const h = L / 2;
  const r = 0.5;
  const wz: [number, number] = [h - 2.35, -h + 3.0];
  const y0 = 0.32;
  const s = new Shape();
  s.moveTo(-h, y0);
  const arch = r + 0.08;
  for (const z of [wz[1], wz[0]]) {
    s.lineTo(z - arch, y0);
    s.lineTo(z - arch, r);
    s.absarc(z, r, arch, Math.PI, 0, true);
    s.lineTo(z + arch, y0);
  }
  s.lineTo(h - 0.1, y0);
  s.quadraticCurveTo(h + 0.05, y0, h + 0.05, y0 + 0.4);
  s.lineTo(h + 0.05, 2.1);
  s.lineTo(h - 0.05, 2.45);
  s.lineTo(h - 0.05, 3.7);
  s.quadraticCurveTo(h - 0.05, H, h - 0.75, H); // rounded front dome
  s.lineTo(-h + 0.9, H);
  s.quadraticCurveTo(-h, H, -h, H - 0.85); // rounded rear dome
  s.closePath();
  const lowerBand: P2[] = [
    [-h + 0.3, 1.25],
    [h + 0.16, 1.25],
    [h + 0.16, 2.05],
    [-h + 0.3, 2.05],
  ];
  const upperBand: P2[] = [
    [-h + 0.35, 2.75],
    [h + 0.05, 2.75],
    [h + 0.05, 3.62],
    [h - 0.25, 3.82],
    [-h + 0.6, 3.82],
    [-h + 0.25, 3.5],
  ];
  const p: Piece[] = [
    side("paint", s, W, 0.08),
    side("glass", lowerBand, W + 0.03, 0.01),
    side("glass", upperBand, W + 0.03, 0.01),
    // the New Routemaster's sweeping staircase glass: front nearside (left, +x) and rear offside (-x)
    side("glass", [[h - 0.35, 1.3], [h - 0.95, 1.3], [h - 2.3, 3.7], [h - 1.7, 3.7]], 0.04, 0, undefined, W / 2 + 0.01),
    side("glass", [[-h + 0.4, 1.3], [-h + 1.0, 1.3], [-h + 2.3, 3.7], [-h + 1.7, 3.7]], 0.04, 0, undefined, -W / 2 - 0.01),
    // black window surrounds (between the panes) and the skirt
    ...flanks("fixed", [[-h + 0.3, 2.05], [h, 2.05], [h, 2.12], [-h + 0.3, 2.12]], W / 2 + 0.012, 0.02, TRIM),
    ...flanks("fixed", [[-h + 0.35, 2.68], [h - 0.03, 2.68], [h - 0.03, 2.75], [-h + 0.35, 2.75]], W / 2 + 0.012, 0.02, TRIM),
    side("fixed", [[-h + 0.05, y0], [wz[1] - arch - 0.02, y0], [wz[1] - arch - 0.02, 0.72], [-h + 0.05, 0.72]], W + 0.02, 0, TRIM),
    side("fixed", [[wz[1] + arch + 0.02, y0], [wz[0] - arch - 0.02, y0], [wz[0] - arch - 0.02, 0.72], [wz[1] + arch + 0.02, 0.72]], W + 0.02, 0, TRIM),
    side("fixed", [[wz[0] + arch + 0.02, y0], [h, y0], [h, 0.72], [wz[0] + arch + 0.02, 0.72]], W + 0.02, 0, TRIM),
    // doors on the nearside (left): front, centre, rear
    ...[h - 1.3, -0.3, -h + 1.7].map((z) => side("fixed", [[z - 0.6, 0.4], [z + 0.6, 0.4], [z + 0.6, 2.05], [z - 0.6, 2.05]], 0.03, 0, "#2b2f35", W / 2 + 0.02)),
    // destination blind (lit) and route number box, front and rear
    box("glass", W - 0.25, 1.3, 0.06, 0, 1.5, h + 0.11), // big windscreen
    box("glass", W - 0.6, 0.7, 0.06, 0, 3.12, -h - 0.06), // rear upper window
    box("head", 1.9, 0.3, 0.04, 0, 2.36, h + 0.12),
    box("fixed", 2.1, 0.42, 0.03, 0, 2.36, h + 0.1, TRIM),
    box("head", 0.55, 0.3, 0.04, 0, 2.4, -h - 0.07), // rear route number
    // front grille, plates, mirrors on stalks
    box("fixed", 1.1, 0.2, 0.04, 0, 0.62, h + 0.11, TRIM),
    box("fixed", 0.52, 0.11, 0.02, 0, 0.42, h + 0.12, PLATE),
    box("fixed", 0.52, 0.11, 0.02, 0, 0.7, -h - 0.08, PLATE_REAR),
    box("fixed", 0.5, 0.06, 0.06, W / 2 + 0.22, 2.3, h - 0.1, TRIM), // mirror arms
    box("fixed", 0.5, 0.06, 0.06, -W / 2 - 0.22, 2.3, h - 0.1, TRIM),
    box("fixed", 0.08, 0.4, 0.16, W / 2 + 0.45, 2.1, h - 0.1, TRIM),
    box("fixed", 0.08, 0.4, 0.16, -W / 2 - 0.45, 2.1, h - 0.1, TRIM),
  ];
  for (const x of [1, -1]) {
    p.push(box("head", 0.3, 0.16, 0.05, x * (W / 2 - 0.3), 0.66, h + 0.12));
    p.push(box("tail", 0.18, 0.5, 0.05, x * (W / 2 - 0.16), 1.0, -h - 0.07));
    p.push(box("tail", 0.18, 0.3, 0.05, x * (W / 2 - 0.16), 3.2, -h - 0.07));
  }
  p.push(...wheels(W / 2 - 0.2, wz, r, 0.34));
  return p;
}

/** A hire bike with a rider (green frame, like the dockless e-bikes), facing +z. */
function bike(): Piece[] {
  const p: Piece[] = [];
  for (const z of [0.52, -0.52]) {
    p.push({ part: "fixed", geo: new CylinderGeometry(0.34, 0.34, 0.05, 14).rotateZ(Math.PI / 2).translate(0, 0.34, z), color: TYRE });
    p.push({ part: "fixed", geo: new CylinderGeometry(0.25, 0.25, 0.06, 10).rotateZ(Math.PI / 2).translate(0, 0.34, z), color: "#3a3d40" });
  }
  p.push(box("paint", 0.06, 0.08, 1.0, 0, 0.62, 0.0)); // top tube
  p.push(box("paint", 0.06, 0.5, 0.06, 0, 0.55, -0.2)); // seat tube
  p.push(box("paint", 0.16, 0.18, 0.28, 0, 0.45, -0.05)); // battery
  p.push(box("fixed", 0.5, 0.04, 0.04, 0, 1.0, 0.42, TRIM)); // bars
  p.push(box("fixed", 0.06, 0.4, 0.06, 0, 0.8, 0.42, TRIM));
  // rider: legs, torso leaning forward, arms to the bars, head with helmet
  p.push(box("fixed", 0.13, 0.55, 0.13, 0.1, 0.62, -0.05, "#2b2f3a"));
  p.push(box("fixed", 0.13, 0.55, 0.13, -0.1, 0.62, -0.05, "#2b2f3a"));
  const torso = new BoxGeometry(0.4, 0.62, 0.24).rotateX(0.45).translate(0, 1.22, 0.02);
  p.push({ part: "fixed", geo: torso, color: "#4f6bb0" });
  p.push(box("fixed", 0.1, 0.1, 0.5, 0.2, 1.18, 0.25, "#4f6bb0"));
  p.push(box("fixed", 0.1, 0.1, 0.5, -0.2, 1.18, 0.25, "#4f6bb0"));
  p.push(box("fixed", 0.24, 0.26, 0.26, 0, 1.6, 0.16, "#e0ac69"));
  p.push(box("fixed", 0.28, 0.12, 0.32, 0, 1.75, 0.14, "#f2f2f2"));
  p.push(box("head", 0.08, 0.06, 0.04, 0, 0.95, 0.48));
  p.push(box("tail", 0.06, 0.05, 0.04, 0, 0.8, -0.5));
  return p;
}

const SPECS: Record<VehicleKind, () => Piece[]> = { bus, cab, hatch, saloon, suv, estate, van, police, ambulance, bike };

/** Strips everything but position + normal (+ vertex colour for `fixed`) so pieces of any primitive merge. */
function prepare(p: Piece, withColor: boolean) {
  const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
  for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  g.clearGroups();
  if (withColor) {
    tmpColor.set(p.color ?? "#888888");
    const n = g.getAttribute("position").count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = tmpColor.r;
      arr[i * 3 + 1] = tmpColor.g;
      arr[i * 3 + 2] = tmpColor.b;
    }
    g.setAttribute("color", new BufferAttribute(arr, 3));
  }
  return g;
}

/** One merged geometry per part (null when the model has no pieces for that part). */
export function buildVehicle(kind: VehicleKind): Record<Part, BufferGeometry | null> {
  const pieces = SPECS[kind]();
  const out = {} as Record<Part, BufferGeometry | null>;
  for (const part of PARTS) {
    const list = pieces.filter((p) => p.part === part);
    if (!list.length) {
      out[part] = null;
      continue;
    }
    const geos = list.map((p) => prepare(p, part === "fixed"));
    out[part] = mergeGeometries(geos, false);
    for (const p of list) p.geo.dispose();
    for (const g of geos) g.dispose();
  }
  return out;
}

/** Paint colours per kind (sRGB hex). */
export const PALETTES: Record<VehicleKind, string[]> = {
  bus: ["#d3201b"],
  cab: ["#111214", "#111214", "#111214", "#1d232c", "#3a1418", "#e8e8e8"],
  hatch: ["#c8ced6", "#2f6db5", "#f2f2f2", "#c4322b", "#3d6b4a", "#9aa3ab", "#26282b", "#e0a92e", "#6b7a8f"],
  saloon: ["#1f2a44", "#c9ccd1", "#26282b", "#7a1f2b", "#3b5f8a", "#f2f2f2", "#5a6b5a", "#8e9298"],
  suv: ["#26282b", "#f2f2f2", "#4a5568", "#2f4f3a", "#9aa3ab", "#8a6a4a", "#1f2a44"],
  estate: ["#5b6770", "#f2f2f2", "#2c3e50", "#7d2e2e", "#a8b2a0", "#202020"],
  van: ["#f4f4f4", "#f4f4f4", "#f4f4f4", "#c9ccd1", "#2b4c7e", "#d9d4c7"],
  police: ["#f4f4f4"],
  ambulance: ["#f2e21a"],
  bike: ["#2fae4a", "#2fae4a", "#d42a2a", "#e8e8e8"],
};

/** Body length (m), for spacing. */
export const LENGTH: Record<VehicleKind, number> = { bus: 11.2, cab: 4.6, hatch: 4.05, saloon: 4.7, suv: 4.6, estate: 4.8, van: 5.5, police: 4.8, ambulance: 5.5, bike: 1.8 };
