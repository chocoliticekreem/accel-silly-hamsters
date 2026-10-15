// Shoreditch hero landmarks, built fresh with the Kit (merged vertex-coloured geometry per material slot, brick
// as a tiling texture, canvas signs). Each is recognisable from the street camera:
//   XOYO        – Cowper St club: dark brick warehouse, black ground floor, big lit X O Y O letters, steel doors,
//                 queue barriers on the pavement.
//   art'otel    – Old St / Great Eastern St: oval 26-storey "cogwheel" tower, toothed aluminium shelves, twisted
//                 black fins, glazed top floors, crown sign, 3-storey podium wing (OSM footprint).
//   Encode Hub  – 41 Pitfield St: converted Victorian brick building, sash windows, lit ENCODE HUB fascia band.
//   Boxpark     – stacked black shipping containers, glazed shopfronts, upper terrace with lights, big sign.
//   Old Street  – the roundabout island: sunken tube entrances with roundels, glass canopies, new entrance
//                 pavilion, trees, cycle dock, digital screens.
// Frame: origin at the footprint centre on the ground, street face toward +z, metres. Every model's name is a
// stable `landmark-*` id (interiors / quick travel look the group up by name).
import { BoxGeometry, ExtrudeGeometry, Shape, Vector2 } from "three";
import { rng, type Rng } from "../../mock/rng";
import { Kit, type HeroModel } from "./kit";
import { label } from "./materials";
import { drawCycleDock, drawPlaneTree, drawRoundelPost } from "./street";

const pick = <T,>(r: Rng, a: T[]) => a[Math.floor(r() * a.length)];

/** A sash/industrial window facing +z on a wall at z (frame, panes, glazing bars, sill, lintel). */
function windowAt(
  k: Kit,
  r: Rng,
  x: number,
  y: number,
  w: number,
  h: number,
  z: number,
  o: { frame?: string; cols?: number; rows?: number; sill?: string; lintel?: string; arch?: boolean; glass?: string[] } = {},
) {
  const frame = o.frame ?? "#efece4";
  const glass = o.glass ?? ["#1e2934", "#26323f", "#2f3a46", "#5b5440", "#6a5f44"];
  // everything sits proud of the wall face at z (walls are solid boxes): a dark reveal border, then glass and frame
  k.slab("solid", x - w / 2 - 0.06, x + w / 2 + 0.06, y - 0.04, y + h + 0.04, z, z + 0.015, "#141518");
  k.slab("glass", x - w / 2 + 0.06, x + w / 2 - 0.06, y + 0.06, y + h - 0.06, z + 0.015, z + 0.03, pick(r, glass));
  k.slab("solid", x - w / 2, x + w / 2, y, y + 0.07, z + 0.015, z + 0.08, frame);
  k.slab("solid", x - w / 2, x + w / 2, y + h - 0.07, y + h, z + 0.015, z + 0.08, frame);
  k.slab("solid", x - w / 2, x - w / 2 + 0.07, y, y + h, z + 0.015, z + 0.08, frame);
  k.slab("solid", x + w / 2 - 0.07, x + w / 2, y, y + h, z + 0.015, z + 0.08, frame);
  const cols = o.cols ?? 2, rows = o.rows ?? 2;
  for (let i = 1; i < cols; i++) k.box("solid", 0.04, h, 0.04, x - w / 2 + (w * i) / cols, y + h / 2, z + 0.05, frame);
  for (let j = 1; j < rows; j++) k.box("solid", w, j === Math.floor(rows / 2) && rows === 2 ? 0.07 : 0.04, 0.04, x, y + (h * j) / rows, z + 0.05, frame);
  k.slab("solid", x - w / 2 - 0.1, x + w / 2 + 0.1, y - 0.12, y, z, z + 0.14, o.sill ?? "#cfc8b8");
  if (o.arch) {
    const s = new Shape();
    const cy = -w * 0.9, R0 = Math.hypot(w / 2 + 0.12, cy), a0 = Math.atan2(-cy, w / 2 + 0.12);
    s.absarc(0, cy, R0 + 0.28, a0, Math.PI - a0, false);
    s.absarc(0, cy, R0, Math.PI - a0, a0, true);
    k.extrude("solid", s, 0.07, [x, y + h - 0.02, z], o.lintel ?? "#6b3a2a");
  } else if (o.lintel) k.slab("solid", x - w / 2 - 0.08, x + w / 2 + 0.08, y + h, y + h + 0.22, z, z + 0.08, o.lintel);
}

/** Gig/club poster on a wall (lit by the scene). */
function poster(k: Kit, key: string, x: number, y: number, z: number, w: number, h: number, seed: number) {
  k.sign(`poster-${key}`, w, h, [x, y, z], [128, 180], (c, cw, ch) => {
    const r = rng(seed);
    const cols = ["#ff3ea5", "#18e0d0", "#ffd23f", "#2f5bea", "#ff6b2b", "#f4f1ea", "#111111"];
    c.fillStyle = pick(r, cols);
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = pick(r, cols);
    c.beginPath();
    c.arc(cw * (0.3 + r() * 0.4), ch * (0.3 + r() * 0.2), cw * (0.25 + r() * 0.15), 0, Math.PI * 2);
    c.fill();
    c.fillStyle = pick(r, cols);
    c.fillRect(0, ch * 0.66, cw, ch * 0.12);
    label(c, pick(r, ["LIVE", "XOYO", "ALL NIGHT", "SOLD OUT", "FRI", "SAT"]), cw / 2, ch * 0.86, cw - 10, 30, "#111111");
  }, false);
}

// ---------------------------------------------------------------------------------------------------- XOYO

/** Neon letter strokes on the +z wall. Letters 1.8 x 2.1 m, stroke 0.34 m, depth 0.3. */
function xoyoLetters(k: Kit, cx: number, cy: number, z: number) {
  const W = 1.8, H = 2.1, t = 0.34, gap = 0.45;
  const xs = [0, 1, 2, 3].map((i) => cx - (2 * W + 1.5 * gap) + W / 2 + i * (W + gap));
  const WHITE = "#f2f6ff";
  const zz = z + 0.2;
  const letterX = (x: number) => {
    k.bar("glow", [x - W / 2 + 0.15, cy - H / 2, zz], [x + W / 2 - 0.15, cy + H / 2, zz], t, WHITE);
    k.bar("glow", [x + W / 2 - 0.15, cy - H / 2, zz], [x - W / 2 + 0.15, cy + H / 2, zz], t, WHITE);
  };
  const letterO = (x: number) => {
    const s = new Shape();
    s.absellipse(0, 0, W / 2, H / 2, 0, Math.PI * 2, false, 0);
    const hole = new Shape();
    hole.absellipse(0, 0, W / 2 - t, H / 2 - t, 0, Math.PI * 2, true, 0);
    s.holes.push(hole);
    k.extrude("glow", s, t, [x, cy, zz - t / 2], WHITE, [0, 0, 0], 28);
  };
  const letterY = (x: number) => {
    k.bar("glow", [x - W / 2 + 0.12, cy + H / 2, zz], [x, cy - 0.05, zz], t, WHITE);
    k.bar("glow", [x + W / 2 - 0.12, cy + H / 2, zz], [x, cy - 0.05, zz], t, WHITE);
    k.bar("glow", [x, cy + 0.05, zz], [x, cy - H / 2, zz], t, WHITE);
  };
  letterX(xs[0]);
  letterO(xs[1]);
  letterY(xs[2]);
  letterO(xs[3]);
  // mounting rails + dark backing board
  k.slab("solid", cx - 2 * W - 1.2, cx + 2 * W + 1.2, cy - H / 2 - 0.35, cy + H / 2 + 0.35, z - 0.02, z + 0.05, "#0d0d0f");
  for (const dy of [-0.6, 0.6]) k.box("metal", 4 * W + 3 * gap + 0.6, 0.06, 0.12, cx, cy + dy, z + 0.08, "#2a2c30");
}

export function xoyo(): HeroModel {
  const k = new Kit();
  const r = rng(32);
  const W = 24, D = 18, H = 15.6, fz = D / 2;
  const BRICK = "#4a3c36";
  k.slab("brick", -W / 2, W / 2, 0, H, -D / 2, D / 2, BRICK);
  // pilasters between the six bays, proud brick
  for (let i = 0; i <= 6; i++) k.slab("brick", -W / 2 + i * 4 - 0.3, -W / 2 + i * 4 + 0.3, 4.6, H - 0.6, fz, fz + 0.18, "#3f332e");
  // black-painted ground floor + string course + cornice
  k.slab("solid", -W / 2 - 0.04, W / 2 + 0.04, 0, 4.4, fz - 0.1, fz + 0.14, "#111113");
  k.slab("solid", -W / 2 - 0.12, W / 2 + 0.12, 4.4, 4.68, fz - 0.1, fz + 0.3, "#1c1c1f");
  k.slab("solid", -W / 2 - 0.2, W / 2 + 0.2, H - 0.62, H - 0.3, fz - 0.1, fz + 0.32, "#2a2420");
  k.slab("brick", -W / 2, W / 2, H - 0.3, H + 0.5, fz - 0.4, fz + 0.05, BRICK);
  k.slab("solid", -W / 2 - 0.05, W / 2 + 0.05, H + 0.5, H + 0.65, fz - 0.45, fz + 0.12, "#6f6a64"); // coping
  // upper windows: tall industrial, 3 floors x 6 bays; the sign takes the middle of the first floor
  const bayX = [-10, -6, -2, 2, 6, 10];
  for (const [fi, y] of [5.3, 8.7, 12.0].entries())
    for (const x of bayX) {
      if (fi === 0 && Math.abs(x) < 7) continue;
      windowAt(k, r, x, y, 2.5, 2.55, fz, { frame: "#2b2e33", cols: 4, rows: 3, sill: "#5d5852", lintel: "#2a2420", glass: ["#161c22", "#1c242c", "#3a3426", "#4d4230"] });
    }
  xoyoLetters(k, 0, 6.5, fz + 0.18);
  // entrance: recessed void, steel double doors, lit soffit, canopy
  k.slab("solid", -2.6, 2.6, 0, 3.5, fz + 0.14, fz + 0.17, "#060607");
  for (const x of [-1.25, 1.25]) {
    k.slab("metal", x - 1.1, x + 1.1, 0.02, 2.9, fz + 0.17, fz + 0.22, "#3a3d42");
    k.box("solid", 0.04, 2.8, 0.04, x, 1.45, fz + 0.23, "#111");
    k.box("metal", 1.6, 0.06, 0.08, x, 1.1, fz + 0.26, "#9aa0a6"); // push bars
  }
  k.slab("metal", -3.4, 3.4, 3.55, 3.75, fz, fz + 1.8, "#24262a");
  k.slab("glow", -3.2, 3.2, 3.52, 3.56, fz + 0.2, fz + 1.7, "#ffd9a8");
  k.slab("glow", -2.5, 2.5, 3.22, 3.34, fz + 0.17, fz + 0.24, "#ff3ea5"); // pink strip over the doors
  // side bays: blacked-out windows with posters, a roller shutter, wall lamps
  let pi = 0;
  for (const x of [-10, -6, 6]) {
    k.slab("solid", x - 1.5, x + 1.5, 0.6, 3.6, fz + 0.14, fz + 0.18, "#1b1d21");
    for (const dx of [-0.75, 0.75]) poster(k, `xoyo-${pi}`, x + dx, 2.0, fz + 0.2, 1.2, 1.7, 100 + pi++);
  }
  k.slab("metal", 8.4, 11.6, 0.0, 3.7, fz + 0.12, fz + 0.2, "#5f646a");
  for (let y = 0.15; y < 3.7; y += 0.18) k.box("metal", 3.2, 0.04, 0.04, 10, y, fz + 0.22, "#4b4f55");
  for (const x of [-8, -4, 4, 8]) {
    k.box("metal", 0.12, 0.3, 0.3, x, 3.9, fz + 0.3, "#202226");
    k.box("glow", 0.22, 0.1, 0.22, x, 3.72, fz + 0.38, "#ffd59a");
  }
  k.box("solid", 0.25, 0.18, 0.4, -3.2, 4.1, fz + 0.35, "#e8e8e8"); // CCTV
  // queue barriers on the pavement: chrome posts + black belts, two lanes
  for (const zz of [fz + 1.6, fz + 2.6]) {
    const xs = [-11, -9.4, -7.8, -6.2, -4.6, -3.0];
    for (const x of xs) {
      k.cyl("metal", 0.17, 0.17, 0.04, 14, [x, 0.02, zz], "#c9ced4");
      k.cyl("metal", 0.03, 0.03, 0.98, 8, [x, 0.5, zz], "#c9ced4");
      k.cyl("metal", 0.045, 0.045, 0.05, 8, [x, 1.0, zz], "#c9ced4");
    }
    for (let i = 0; i < xs.length - 1; i++) k.box("solid", 1.52, 0.05, 0.01, (xs[i] + xs[i + 1]) / 2, 0.92, zz, "#141416");
  }
  k.box("solid", 1.0, 0.04, 0.01, -2.5, 0.92, fz + 2.1, "#141416");
  // side walls get a few windows too (visible from the street at an angle)
  k.at(W / 2, 0, 0, Math.PI / 2, () => {
    for (const y of [5.3, 8.7, 12.0]) for (const x of [-5, 0, 5]) windowAt(k, r, x, y, 2.2, 2.4, 0.0, { frame: "#2b2e33", cols: 3, rows: 3, sill: "#5d5852" });
  });
  return k.model("landmark-xoyo", { ao: 3 });
}

// ------------------------------------------------------------------------------------------------- art'otel

/** OSM way 1561019538 (27 levels): tower centre in contract coords (x east, z north). */
export const ARTOTEL_CENTRE = { x: -615.0, z: 336.2 };
/** OSM way 1561019539 (3 levels): the podium wing, contract offsets (east, north) from the tower centre. */
const ARTOTEL_PODIUM: [number, number][] = [
  [7.3, 24.3], [24.2, 28.2], [24.9, 26.2], [33.7, 28.1], [36.4, 15.2], [28.7, 14.4], [19.0, 12.9], [20.4, 8.2],
  [21.0, 4.0], [21.6, -1.9], [39.7, -0.8], [40.1, -13.9], [17.9, -14.9], [19.4, -10.0], [12.6, -7.1], [13.8, -3.0],
  [13.4, 2.3], [12.5, 7.4], [11.1, 11.4], [9.2, 14.2], [15.1, 17.5],
];

/** A box twisted about its own vertical axis (the tower's twisted aluminium fins). */
function twistedFin(w: number, h: number, d: number, twist: number) {
  const g = new BoxGeometry(w, h, d, 1, 3, 1);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const a = twist * (p.getY(i) / h);
    const x = p.getX(i), z = p.getZ(i);
    p.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), p.getY(i), x * Math.sin(a) + z * Math.cos(a));
  }
  g.computeVertexNormals();
  return g;
}

/** Flat elliptical ring lying on y = 0 (thickness t upwards); the outer edge is toothed like a cog when teeth > 0. */
function cogRing(rx: number, rz: number, out: number, inset: number, t: number, teeth: number, phase: number, depth: number) {
  const s = new Shape();
  const N = Math.max(96, teeth * 4);
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const tooth = teeth ? (Math.floor(((a + phase) / (Math.PI * 2)) * teeth * 2) % 2 === 0 ? depth : 0) : 0;
    const x = Math.cos(a) * (rx + out + tooth), y = Math.sin(a) * (rz + out + tooth);
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  const hole = new Shape();
  for (let i = 0; i <= 64; i++) {
    const a = -(i / 64) * Math.PI * 2;
    const x = Math.cos(a) * (rx - inset), y = Math.sin(a) * (rz - inset);
    if (i === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  s.holes.push(hole);
  return new ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 1 }).rotateX(-Math.PI / 2);
}

/**
 * art'otel London Hoxton (Squire & Partners, 2024), 1–3 Rivington St at Old St / Great Eastern St.
 * A 26-storey cylinder (oval in plan, 27.5 × 37 m from OSM) read as a stack of rotated "cogwheels": every
 * double-height band sits on a projecting aluminium shelf with a toothed edge, and twisted black aluminium fins
 * run between the shelves in a syncopated rhythm (dense on the guest-room floors, sparse on the three glazed
 * entertaining floors at the top). Double-height glazed lobby at the base, a three-storey pale podium wing to
 * the east (OSM footprint), the art'otel name on the crown. ≈ 92 m.
 * Local frame: origin at the tower centre, +x east, +z SOUTH (scene z): place it with rotation 0.
 */
export function artotel(): HeroModel {
  const k = new Kit();
  const r = rng(1931);
  const RX = 13.8, RZ = 18.5;
  const LOBBY = 8.0, BAND = 6.6, BANDS = 11, TOPH = 11.4;
  const topY = LOBBY + BANDS * BAND; // 80.6
  const H = topY + TOPH; // 92
  const ALU = "#e2e4e7", FIN = "#1e1f23", CORE = "#15181d";
  const GLASS = ["#2a3540", "#26313d", "#2e3944", "#232d38", "#6b6048", "#7a6b4c", "#2b3743"];
  const ell = (a: number, s = 1): [number, number, number] => {
    const x = Math.cos(a) * RX * s, z = Math.sin(a) * RZ * s;
    return [x, z, Math.atan2(Math.cos(a) / RX, Math.sin(a) / RZ)];
  };
  /** Glass facets around the oval between y0 and y1 (at scale s of the oval). */
  const glazing = (y0: number, y1: number, s: number, n: number, palette: string[]) => {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const [x0, z0] = ell(a0, s), [x1, z1] = ell(a1, s);
      const yaw = ell((a0 + a1) / 2, s)[2];
      const w = Math.hypot(x1 - x0, z1 - z0) + 0.04;
      k.box("glass", w, y1 - y0, 0.08, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, pick(r, palette), [0, yaw, 0]);
    }
  };
  // solid core so the facets never show daylight through the joins
  k.cyl("solid", 1, 1, H - LOBBY, 48, [0, (H + LOBBY) / 2, 0], CORE, [0, 0, 0], [RX * 0.96, 1, RZ * 0.96]);

  // lobby: double-height glazing set back behind black columns, warm glow line under the first shelf
  glazing(0.15, LOBBY - 0.3, 0.9, 40, ["#5d5441", "#6b5f45", "#4f4a3c"]);
  for (let i = 0; i < 20; i++) {
    const [x, z] = ell((i / 20) * Math.PI * 2, 0.97);
    k.cyl("metal", 0.32, 0.32, LOBBY, 10, [x, LOBBY / 2, z], "#1b1c1f");
  }
  k.add("glow", cogRing(RX * 0.9, RZ * 0.9, 0.05, 0.4, 0.06, 0, 0, 0), "#ffd9a8", [0, LOBBY - 0.45, 0]);

  // the cogwheel bands
  const fin = (h: number, twist: number) => twistedFin(0.14, h, 0.85, twist);
  for (let b = 0; b < BANDS; b++) {
    const y = LOBBY + b * BAND;
    const phase = b * 0.37;
    k.add("solid", cogRing(RX, RZ, 1.0, 0.6, 0.55, 36, phase, 0.55), ALU, [0, y, 0]);
    k.add("solid", cogRing(RX, RZ, 0.7, 0.55, 0.06, 0, 0, 0), "#3a3d42", [0, y - 0.06, 0]);
    glazing(y + 0.55, y + BAND, 1, 44, GLASS);
    k.add("solid", cogRing(RX, RZ, 0.08, 0.2, 0.2, 0, 0, 0), "#2a2d33", [0, y + BAND / 2, 0]); // mid floor line
    // fins in a syncopated rhythm: clusters with uneven gaps, twist direction alternating per band
    let a = phase;
    while (a < phase + Math.PI * 2 - 0.05) {
      const [x, z, yaw] = ell(a, 1.045);
      const tw = (b % 2 ? 1 : -1) * (0.6 + r() * 0.5);
      k.add("solid", fin(BAND - 0.36, tw), FIN, [x, y + 0.32 + (BAND - 0.36) / 2, z], [0, yaw, 0]);
      a += r() < 0.3 ? 0.2 + r() * 0.12 : 0.07 + r() * 0.05;
    }
  }

  // three entertaining floors on top: near-continuous glass, few fins, glass balustrades on the shelves
  for (let f = 0; f < 3; f++) {
    const y = topY + f * (TOPH / 3);
    const out = f === 0 ? 1.4 : 0.6;
    k.add("solid", cogRing(RX, RZ, out, 0.6, 0.3, 36, 4.1 + f, 0.4), ALU, [0, y, 0]);
    glazing(y + 0.3, y + TOPH / 3, 0.985, 44, ["#5d5441", "#6b5f45", "#2a3542", "#5a5a4c"]);
    k.add("glass", cogRing(RX, RZ, out - 0.05, -(out - 0.15), 1.1, 0, 0, 0), "#9fb7c2", [0, y + 0.3, 0]);
    for (let i = 0; i < 9; i++) {
      const [x, z, yaw] = ell((i / 9) * Math.PI * 2 + f, 1.045);
      k.add("solid", fin(TOPH / 3 - 0.3, 0.9), FIN, [x, y + 0.3 + (TOPH / 3 - 0.3) / 2, z], [0, yaw, 0]);
    }
  }
  // roof: parapet cog, lit rim, plant enclosure, aviation lamp
  k.add("solid", cogRing(RX, RZ, 0.9, 0.6, 0.45, 36, 7.3, 0.5), ALU, [0, H, 0]);
  k.add("glow", cogRing(RX, RZ, 0.95, -0.85, 0.08, 0, 0, 0), "#ffe6c4", [0, H - 0.1, 0]);
  k.cyl("solid", 1, 1, 0.3, 40, [0, H + 0.15, 0], "#3a3d42", [0, 0, 0], [RX * 0.95, 1, RZ * 0.95]);
  k.rbox("solid", 12, 3.2, 14, 0, H + 1.9, -1, "#2a2d33", 0.2);
  for (let i = 0; i < 4; i++) k.rbox("solid", 2.2, 1.6, 2.2, -4 + i * 2.7, H + 4.3, -4, "#4a4e55", 0.1);
  k.box("glow", 0.35, 0.35, 0.35, 0, H + 5.3, -1, "#ff2a1a");
  // the name on the crown: south face (Old St junction) and west face (toward the roundabout)
  for (const [a, key] of [[Math.PI / 2, "s"], [Math.PI, "w"]] as const) {
    const [x, z, yaw] = ell(a, 1.0);
    k.at(x, 0, z, yaw, () => {
      k.slab("solid", -4.6, 4.6, H + 0.6, H + 3.0, -0.3, 0.05, "#0d0e10");
      k.sign(`artotel-crown-${key}`, 9.0, 2.2, [0, H + 1.8, 0.07], [1024, 250], (c, w, h) => {
        c.fillStyle = "#0d0e10";
        c.fillRect(0, 0, w, h);
        label(c, "art'otel", w / 2, h / 2 + 8, w - 60, 200, "#ffffff", "300 {px}px 'Helvetica Neue', Arial, sans-serif");
      });
    });
  }

  // podium wing (3 storeys): pale stone, ribbon windows, dark ground-floor shopfront line
  const pod = new Shape(ARTOTEL_PODIUM.map(([x, z]) => new Vector2(x, z)));
  const PH = 12.6;
  k.add("solid", new ExtrudeGeometry(pod, { depth: PH, bevelEnabled: false }).rotateX(-Math.PI / 2), "#d7d3ca", [0, 0, 0]);
  k.add("solid", new ExtrudeGeometry(pod, { depth: 0.4, bevelEnabled: false }).rotateX(-Math.PI / 2), "#9aa0a6", [0, PH, 0]);
  const n = ARTOTEL_PODIUM.length;
  for (let i = 0; i < n; i++) {
    const [ax, an] = ARTOTEL_PODIUM[i], [bx, bn] = ARTOTEL_PODIUM[(i + 1) % n];
    const az = -an, bz = -bn; // north → scene -z
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 2.5) continue;
    const yaw = -Math.atan2(bz - az, bx - ax);
    const cx = (ax + bx) / 2, cz = (az + bz) / 2;
    k.box("glass", len - 0.8, 3.2, 0.3, cx, 1.9, cz, pick(r, ["#5d5441", "#4f4a3c", "#22303c"]), [0, yaw, 0]);
    k.box("solid", len - 0.4, 0.5, 0.36, cx, 3.8, cz, "#1b1c1f", [0, yaw, 0]);
    for (const y of [6.0, 9.6]) k.box("glass", len - 1.2, 2.0, 0.3, cx, y, cz, pick(r, GLASS), [0, yaw, 0]);
  }
  return k.model("landmark-artotel", { ao: 4 });
}

// ---------------------------------------------------------------------------------------------- Encode Hub

export function encodeHub(): HeroModel {
  const k = new Kit();
  const r = rng(41);
  const W = 15, D = 14, fz = D / 2;
  const BRICK = "#8d5a43";
  const STONE = "#d9d1bf";
  k.slab("brick", -W / 2, W / 2, 3.4, 13.4, -D / 2, D / 2, BRICK);
  k.slab("solid", -W / 2, W / 2, 0, 3.4, -D / 2, D / 2 - 0.3, "#3a3026"); // ground floor (shop interior behind glass)
  // party-wall piers, string courses, cornice, parapet + coping
  for (const x of [-W / 2, W / 2]) k.slab("brick", x - 0.25, x + 0.25, 0, 14.2, fz - 0.3, fz + 0.15, "#7f4f3a");
  for (const y of [7.7, 10.55]) k.slab("solid", -W / 2, W / 2, y, y + 0.16, fz, fz + 0.08, STONE);
  k.slab("solid", -W / 2 - 0.1, W / 2 + 0.1, 13.0, 13.4, fz - 0.1, fz + 0.3, STONE);
  k.slab("brick", -W / 2, W / 2, 13.4, 14.2, fz - 0.3, fz + 0.05, BRICK);
  k.slab("solid", -W / 2 - 0.05, W / 2 + 0.05, 14.2, 14.35, fz - 0.35, fz + 0.12, STONE);
  // slate roof behind the parapet + chimney stacks
  const roof = new Shape();
  roof.moveTo(-D / 2 + 0.3, 0);
  roof.lineTo(D / 2 - 0.5, 0);
  roof.lineTo(0, 3.2);
  roof.closePath();
  k.extrude("solid", roof, W - 0.6, [-W / 2 + 0.3, 13.4, 0], "#4b4f58", [0, Math.PI / 2, 0]);
  for (const x of [-W / 2 + 0.6, W / 2 - 0.6]) {
    k.slab("brick", x - 0.5, x + 0.5, 13.4, 17.6, -1.2, 1.2, "#7f4f3a");
    k.slab("solid", x - 0.6, x + 0.6, 17.6, 17.8, -1.3, 1.3, STONE);
    for (const z of [-0.6, 0, 0.6]) k.cyl("solid", 0.13, 0.15, 0.6, 8, [x, 18.1, z], "#b5603e");
  }
  // upper floors: four bays of white sash windows, arched on the top floor
  const bays = [-5.25, -1.75, 1.75, 5.25];
  for (const x of bays) {
    windowAt(k, r, x, 4.9, 1.45, 2.25, fz, { lintel: "#6b3a2a", arch: true });
    windowAt(k, r, x, 7.95, 1.45, 2.05, fz, { lintel: "#6b3a2a", arch: true });
    windowAt(k, r, x, 10.9, 1.35, 1.75, fz, { lintel: "#6b3a2a", arch: true });
  }
  // ground floor: black-framed shopfront glazing, entrance with fanlight, stall riser
  const FR = "#15171a";
  k.slab("solid", -W / 2 + 0.25, W / 2 - 0.25, 0, 0.6, fz - 0.2, fz + 0.06, "#1d2026");
  k.slab("glass", -W / 2 + 0.3, W / 2 - 2.5, 0.6, 3.3, fz - 0.15, fz - 0.1, "#55503d");
  for (let x = -W / 2 + 0.3; x <= W / 2 - 2.4; x += 2.1) k.box("solid", 0.1, 2.7, 0.12, x, 1.95, fz - 0.07, FR);
  k.slab("solid", -W / 2 + 0.25, W / 2 - 0.25, 3.3, 3.4, fz - 0.15, fz + 0.04, FR);
  // door (right)
  k.slab("solid", W / 2 - 2.35, W / 2 - 0.3, 0, 3.3, fz - 0.3, fz - 0.2, "#0b0c0e");
  k.slab("glass", W / 2 - 2.2, W / 2 - 0.45, 0.05, 2.6, fz - 0.2, fz - 0.17, "#3d4552");
  k.box("metal", 0.05, 1.2, 0.08, W / 2 - 1.35, 1.2, fz - 0.13, "#b9bec4");
  k.slab("glow", W / 2 - 2.2, W / 2 - 0.45, 2.75, 3.2, fz - 0.2, fz - 0.17, "#ffe6bf"); // fanlight glow
  // the signage band: deep fascia with lit ENCODE HUB lettering, end consoles, projecting blade sign
  k.slab("solid", -W / 2 + 0.1, W / 2 - 0.1, 3.4, 4.45, fz, fz + 0.32, "#0f1726");
  for (const x of [-W / 2 + 0.25, W / 2 - 0.25]) k.slab("solid", x - 0.25, x + 0.25, 3.2, 4.65, fz, fz + 0.45, STONE);
  k.sign("encode-fascia", W - 1.4, 0.82, [0, 3.92, fz + 0.335], [1024, 64], (c, w, h) => {
    c.fillStyle = "#0f1726";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#29f0c6";
    c.fillRect(40, h / 2 - 14, 28, 28); // logo block
    c.fillStyle = "#0f1726";
    c.fillRect(48, h / 2 - 6, 12, 12);
    label(c, "ENCODE  HUB", w / 2 + 20, h / 2 + 2, w - 160, 50, "#f4fbff", "700 {px}px 'Helvetica Neue', Arial, sans-serif");
  });
  k.slab("glow", -W / 2 + 0.6, W / 2 - 0.6, 3.36, 3.4, fz + 0.05, fz + 0.3, "#29f0c6"); // under-glow line
  k.at(-W / 2 + 1.3, 5.6, fz + 0.75, 0, () => {
    k.box("metal", 0.05, 0.05, 0.7, 0, 0.55, -0.35, "#2a2c30");
    k.rbox("solid", 0.12, 0.9, 0.9, 0, 0, 0, "#0f1726", 0.04);
    for (const s of [1, -1])
      k.sign("encode-blade", 0.75, 0.75, [s * 0.065, 0, 0], [128, 128], (c, w, h) => {
        c.fillStyle = "#0f1726";
        c.fillRect(0, 0, w, h);
        c.strokeStyle = "#29f0c6";
        c.lineWidth = 10;
        c.strokeRect(22, 22, w - 44, h - 44);
        label(c, "EH", w / 2, h / 2 + 2, w - 50, 48, "#f4fbff");
      }, true, [0, (s * Math.PI) / 2, 0]);
  });
  // street bits: bike stands, planters, a blue plaque
  for (const x of [-5.5, -4.2, -2.9]) k.torus("metal", 0.42, 0.035, 6, 14, [x, 0.42, fz + 1.4], "#3a3f45", [0, Math.PI / 2, 0], Math.PI);
  for (const x of [-W / 2 + 1, 2]) {
    k.rbox("solid", 1.4, 0.6, 0.6, x, 0.3, fz + 0.6, "#2b2f35", 0.06);
    k.blob("solid", 0.45, 1, [x - 0.3, 0.85, fz + 0.6], "#4f8a3c");
    k.blob("solid", 0.4, 1, [x + 0.35, 0.8, fz + 0.6], "#5d9a45");
  }
  k.cylZ("paint", 0.32, 0.05, 20, [3.5, 6.2, fz + 0.03], "#1f4fa3");
  return k.model("landmark-encode", { ao: 2.5 });
}

// -------------------------------------------------------------------------------------------------- Boxpark

const CL = 6.06, CH = 2.59, CD = 2.44;

/** A black 20 ft container with corrugated ribs, corner posts and rails. Long axis along x. */
function container(k: Kit, x: number, y: number, z: number, o: { color?: string; ribsFront?: boolean; ribsBack?: boolean; doorEnd?: 1 | -1 | 0 } = {}) {
  const col = o.color ?? "#16171a";
  k.slab("paint", x - CL / 2 + 0.06, x + CL / 2 - 0.06, y + 0.12, y + CH - 0.12, z - CD / 2 + 0.03, z + CD / 2 - 0.03, col);
  const F = "#26282c";
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) k.slab("paint", x + sx * CL / 2 - 0.15 * (sx + 1) / 2, x + sx * CL / 2 + 0.15 * (1 - sx) / 2, y, y + CH, z + sz * CD / 2 - 0.15 * (sz + 1) / 2, z + sz * CD / 2 + 0.15 * (1 - sz) / 2, F);
  for (const yy of [y, y + CH - 0.14]) {
    k.slab("paint", x - CL / 2, x + CL / 2, yy, yy + 0.14, z - CD / 2, z - CD / 2 + 0.1, F);
    k.slab("paint", x - CL / 2, x + CL / 2, yy, yy + 0.14, z + CD / 2 - 0.1, z + CD / 2, F);
  }
  const ribs = (zf: number) => {
    for (let i = 0; i < 20; i++) k.box("paint", 0.14, CH - 0.32, 0.06, x - CL / 2 + 0.3 + i * ((CL - 0.6) / 19), y + CH / 2, zf, col);
  };
  if (o.ribsFront) ribs(z + CD / 2 - 0.01);
  if (o.ribsBack) ribs(z - CD / 2 + 0.01);
  if (o.doorEnd) {
    const xe = x + o.doorEnd * (CL / 2 + 0.01);
    for (const dz of [-0.75, -0.3, 0.3, 0.75]) k.box("metal", 0.05, CH - 0.4, 0.05, xe, y + CH / 2, z + dz, "#3d4046");
    k.box("solid", 0.03, CH - 0.3, 0.04, xe, y + CH / 2, z, "#0a0a0b");
  }
}

const SHOPS = [
  ["COFFEE", "#f4e3c1", "#3b2316"],
  ["VINYL", "#111111", "#ff3ea5"],
  ["TACOS", "#ffd23f", "#b3221c"],
  ["BAO", "#ffffff", "#111111"],
  ["SNEAKERS", "#2f5bea", "#ffffff"],
  ["BOOKS", "#0f5a3a", "#f4f1ea"],
  ["RAMEN", "#b3221c", "#ffffff"],
  ["GIN BAR", "#141414", "#ffd23f"],
  ["DENIM", "#24406b", "#f4f1ea"],
  ["PIZZA", "#f4f1ea", "#1f7a3a"],
];

export function boxpark(): HeroModel {
  const k = new Kit();
  const r = rng(2011);
  const N = 10;
  const x0 = -((N * CL) / 2) + CL / 2;
  const zF = CD / 2, zB = -CD / 2;
  for (let i = 0; i < N; i++) {
    const x = x0 + i * CL;
    const end = i === 0 ? -1 : i === N - 1 ? 1 : 0;
    // ground floor: front row = shops (glazed long face), back row = ribbed back
    container(k, x, 0, zF, { doorEnd: end as 0 | 1 | -1 });
    container(k, x, 0, zB, { ribsBack: true, doorEnd: end as 0 | 1 | -1 });
    // upper floor on the back row: restaurants with windows onto the terrace
    container(k, x, CH, zB, { ribsBack: true, doorEnd: end as 0 | 1 | -1 });
    // shopfront: frame, glass, door, lit interior colour
    const [name, bg, fg] = SHOPS[i % SHOPS.length];
    k.slab("solid", x - 2.7, x + 2.7, 0.15, 2.45, zF + CD / 2 - 0.02, zF + CD / 2 + 0.03, "#0c0c0d");
    k.slab("glass", x - 2.55, x + 2.55, 0.3, 2.3, zF + CD / 2 + 0.03, zF + CD / 2 + 0.05, pick(r, ["#6a5d42", "#7a6a48", "#5a5a52", "#665238"]));
    for (const dx of [-1.3, 0, 1.3]) k.box("solid", 0.06, 2.0, 0.06, x + dx, 1.3, zF + CD / 2 + 0.06, "#0c0c0d");
    // terrace windows on the upper back row
    k.slab("glass", x - 2.6, x + 2.6, CH + 0.35, CH + 2.25, zB + CD / 2 + 0.0, zB + CD / 2 + 0.03, pick(r, ["#6a5d42", "#4f4a3c", "#7a6a48"]));
    for (const dx of [-1.73, -0.58, 0.58, 1.73]) k.box("solid", 0.07, 1.9, 0.06, x + dx, CH + 1.3, zB + CD / 2 + 0.05, "#0c0c0d");
    // shop sign on the terrace fascia
    k.sign(`boxpark-shop-${name}`, 4.6, 0.42, [x, CH + 0.28, zF + CD / 2 + 0.14], [512, 48], (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      label(c, name, w / 2, h / 2 + 1, w - 30, 36, fg);
    });
  }
  // terrace deck over the front row: fascia, railing, string lights, tables + umbrellas
  const xa = x0 - CL / 2, xb = x0 + (N - 0.5) * CL;
  k.slab("solid", xa, xb, CH, CH + 0.12, 0, CD + 0.1, "#3a3127");
  k.slab("solid", xa, xb, CH + 0.02, CH + 0.56, CD + 0.08, CD + 0.12, "#0c0c0d");
  for (let x = xa; x <= xb + 0.01; x += 1.5) k.box("metal", 0.05, 1.05, 0.05, x, CH + 0.12 + 0.52, CD + 0.05, "#2a2c30");
  k.slab("metal", xa, xb, CH + 1.12, CH + 1.18, CD + 0.0, CD + 0.1, "#2a2c30");
  k.slab("glass", xa, xb, CH + 0.15, CH + 1.1, CD + 0.03, CD + 0.06, "#8ea3ad");
  for (let x = xa + 0.5; x < xb; x += 0.9) {
    const sag = 0.28 * Math.sin(((x - xa) / 4.5) * Math.PI) ** 2;
    k.sphere("glow", 0.07, 6, 4, [x, CH + 3.3 - sag, CD - 0.2], "#ffd99a");
  }
  for (let i = 0; i < N; i += 2) {
    const x = x0 + i * CL + 1.2;
    k.cyl("solid", 0.45, 0.45, 0.05, 12, [x, CH + 0.85, 1.2], "#d8d2c4");
    k.cyl("metal", 0.03, 0.03, 0.75, 6, [x, CH + 0.48, 1.2], "#2a2c30");
    k.cyl("metal", 0.025, 0.025, 1.6, 6, [x, CH + 1.5, 1.2], "#2a2c30");
    k.cone("solid", 1.3, 0.5, 10, [x, CH + 2.4, 1.2], pick(r, ["#e9e4d7", "#b3221c", "#141414"]));
  }
  // big BOXPARK sign on the upper containers, facing the street
  k.slab("solid", -7.2, 7.2, CH + 2.3, CH + 2.58, zB + CD / 2 - 0.01, zB + CD / 2 + 0.06, "#0c0c0d");
  k.at(0, 0, 0, 0, () => {
    k.slab("solid", -7.5, 7.5, 2 * CH + 0.05, 2 * CH + 1.9, zB + 0.2, zB + 0.45, "#0c0c0d");
    k.sign("boxpark-sign", 14.4, 1.6, [0, 2 * CH + 0.98, zB + 0.47], [1024, 112], (c, w, h) => {
      c.fillStyle = "#0c0c0d";
      c.fillRect(0, 0, w, h);
      label(c, "BOXPARK", w / 2, h / 2 + 4, w - 40, 100, "#ffffff", "900 {px}px 'Helvetica Neue', Arial, sans-serif");
    });
    for (const x of [-6.5, 0, 6.5]) k.box("metal", 0.12, 0.6, 0.12, x, 2 * CH + 0.3, zB + 0.35, "#2a2c30");
  });
  // steel stair from the street up to the terrace at the +x end
  const sx = xb + 1.0;
  for (let i = 0; i < 15; i++) k.box("metal", 1.2, 0.05, 0.3, sx, 0.17 * (i + 1), CD + 1.8 - i * 0.28, "#3a3d42");
  k.bar("metal", [sx - 0.62, 0.0, CD + 2.0], [sx - 0.62, CH, CD + 1.8 - 15 * 0.28], 0.1, "#2a2c30");
  k.bar("metal", [sx + 0.62, 0.0, CD + 2.0], [sx + 0.62, CH, CD + 1.8 - 15 * 0.28], 0.1, "#2a2c30");
  k.bar("metal", [sx + 0.62, 1.0, CD + 2.0], [sx + 0.62, CH + 1.0, CD + 1.8 - 15 * 0.28], 0.04, "#2a2c30");
  k.box("metal", 1.4, 0.1, 2.0, sx, CH, -0.2, "#3a3d42");
  return k.model("landmark-boxpark", { ao: 2.5 });
}

// ----------------------------------------------------------------------------------------------- Old Street

/** A sunken stair entrance: parapets with railings, steps fading into the dark, glass canopy, roundel. */
function stairEntrance(k: Kit, x: number, z: number, ry: number) {
  k.at(x, 0, z, ry, () => {
    const w = 3.6, l = 8;
    // floor of the well, steps getting darker as they go down (the city ground is solid, so this is forced perspective)
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const v = Math.round(0x8a * (1 - t) + 0x10 * t).toString(16).padStart(2, "0");
      k.box("solid", w - 0.1, 0.03, l / 12, 0, 0.17 + 0.0015 * (12 - i), l / 2 - (i + 0.5) * (l / 12), `#${v}${v}${v}`);
      k.box("solid", w - 0.1, 0.012, 0.05, 0, 0.19 + 0.0015 * (12 - i), l / 2 - i * (l / 12), "#c9b25a"); // nosings
    }
    k.box("glow", w - 0.3, 0.02, 0.4, 0, 0.2, -l / 2 + 0.4, "#fff2d0"); // lit passage glimpsed at the bottom
    // parapets (granite capped) with steel railings, open at the top of the stair (+z)
    for (const sx of [-1, 1]) {
      k.box("solid", 0.35, 1.0, l, sx * (w / 2 + 0.17), 0.5, 0, "#8f8b84");
      k.box("solid", 0.45, 0.08, l + 0.1, sx * (w / 2 + 0.17), 1.04, 0, "#c9c5bc");
      for (let zz = -l / 2; zz <= l / 2; zz += 1.0) k.box("metal", 0.04, 0.9, 0.04, sx * (w / 2 + 0.17), 1.5, zz, "#2f3338");
      k.box("metal", 0.06, 0.06, l, sx * (w / 2 + 0.17), 1.95, 0, "#2f3338");
    }
    k.box("solid", w + 0.7, 1.0, 0.35, 0, 0.5, -l / 2 - 0.17, "#8f8b84");
    k.box("solid", w + 0.8, 0.08, 0.45, 0, 1.04, -l / 2 - 0.17, "#c9c5bc");
    // glass canopy on slim posts
    for (const sx of [-1, 1]) for (const zz of [-l / 2, 0, l / 2]) k.box("metal", 0.1, 3.2, 0.1, sx * (w / 2 + 0.4), 1.6, zz, "#2a2d31");
    k.box("metal", w + 1.2, 0.12, l + 0.4, 0, 3.25, 0, "#2a2d31");
    k.box("glass", w + 1.0, 0.04, l + 0.2, 0, 3.33, 0, "#a9c3cf");
    k.box("glow", w + 1.0, 0.04, 0.12, 0, 3.18, l / 2 + 0.1, "#fff2d0");
    k.at(w / 2 + 1.0, 0, l / 2 + 0.6, 0, () => drawRoundelPost(k, "Old Street"));
  });
}

/** Digital advertising screen on a pole (the roundabout's famous billboards). */
function screen(k: Kit, key: string, x: number, z: number, ry: number, seed: number) {
  k.at(x, 0, z, ry, () => {
    k.box("metal", 0.5, 6, 0.5, 0, 3, 0, "#2a2d31");
    k.rbox("solid", 8.4, 4.6, 0.6, 0, 8, 0, "#141518", 0.1);
    for (const s of [1, -1])
      k.sign(`${key}-${s}`, 8.0, 4.2, [0, 8, s * 0.31], [512, 268], (c, w, h) => {
        const r = rng(seed + s);
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, pick(r, ["#2f5bea", "#ff4f8b", "#00c2a8", "#7b2ff7"]));
        g.addColorStop(1, pick(r, ["#ffd23f", "#ff6b2b", "#18e0d0", "#111111"]));
        c.fillStyle = g;
        c.fillRect(0, 0, w, h);
        c.fillStyle = "rgba(255,255,255,0.92)";
        c.beginPath();
        c.arc(w * 0.75, h * 0.45, h * 0.28, 0, Math.PI * 2);
        c.fill();
        label(c, pick(r, ["BUILD THE FUTURE", "TECH CITY", "SHIP IT", "HELLO LONDON"]), w * 0.38, h * 0.42, w * 0.62, 48, "#ffffff");
        label(c, pick(r, ["Silicon Roundabout", "Old Street EC1", "Now hiring"]), w * 0.38, h * 0.62, w * 0.6, 26, "#ffffff", "500 {px}px 'Helvetica Neue', Arial, sans-serif");
      }, true, [0, s > 0 ? 0 : Math.PI, 0]);
  });
}

export function oldStreet(): HeroModel {
  const k = new Kit();
  const R = 24;
  // island: kerb, paving, inner rings
  k.cyl("solid", R + 0.25, R + 0.25, 0.16, 64, [0, 0.08, 0], "#cfcac0");
  k.cyl("solid", R, R, 0.17, 64, [0, 0.085, 0], "#a29d94");
  for (const [rr, col] of [[R - 3, "#9a958b"], [R - 3.4, "#a29d94"], [9, "#958f85"], [8.6, "#a29d94"]] as const)
    k.cyl("solid", rr, rr, 0.005, 48, [0, 0.172 + (rr < 10 ? 0.002 : 0), 0], col);
  // planted beds with London planes
  for (const [i, [x, z]] of [[-13, -10], [12, 11], [-4, -17], [16, -6]].entries()) {
    k.cyl("solid", 3.3, 3.3, 0.45, 20, [x, 0.22, z], "#8a857c");
    k.cyl("solid", 3.0, 3.0, 0.47, 20, [x, 0.24, z], "#5a8a40");
    k.at(x, 0.45, z, i, () => drawPlaneTree(k, 40 + i, 10));
  }
  stairEntrance(k, -10, 6, Math.PI * 0.15);
  stairEntrance(k, 9, -4, Math.PI * 1.2);
  // new main entrance pavilion: glass box under a deep timber-soffit roof with a green top
  k.at(2, 0, 12, -0.15, () => {
    k.box("glass", 9, 3.6, 5, 0, 1.97, 0, "#5a5a4c");
    for (let x = -4.5; x <= 4.5; x += 1.5) k.box("metal", 0.08, 3.6, 0.1, x, 1.97, 2.52, "#2a2d31");
    k.rbox("solid", 13, 0.55, 8, 0, 4.05, 0.4, "#2a2d31", 0.1);
    k.box("solid", 12.6, 0.06, 7.6, 0, 3.75, 0.4, "#b98a58"); // timber soffit
    k.box("solid", 12.4, 0.2, 7.4, 0, 4.4, 0.4, "#5a8a40"); // green roof
    k.box("glow", 12.6, 0.05, 0.12, 0, 3.74, 4.3, "#fff2d0");
    k.sign("oldstreet-pavilion", 8, 0.5, [0, 4.05, 4.42], [1024, 64], (c, w, h) => {
      c.fillStyle = "#2a2d31";
      c.fillRect(0, 0, w, h);
      label(c, "OLD STREET STATION", w / 2 + 40, h / 2 + 2, w - 160, 44, "#ffffff", "600 {px}px 'Johnston', 'Gill Sans', 'Helvetica Neue', Arial, sans-serif");
      c.strokeStyle = "#dc241f";
      c.lineWidth = 9;
      c.beginPath();
      c.arc(70, h / 2, 20, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "#0019a8";
      c.fillRect(38, h / 2 - 7, 64, 14);
    });
    for (const x of [-3, 3]) k.slab("solid", x - 0.9, x + 0.9, 0.17, 2.6, 2.48, 2.52, "#0c0d0f"); // doors
  });
  // digital screens, cycle dock, benches, bollards, lamps
  screen(k, "oldstreet-screen-a", -6, -6, 0.7, 5);
  screen(k, "oldstreet-screen-b", 15, 4, -1.2, 9);
  k.at(-18, 0.17, 3, Math.PI / 2, () => drawCycleDock(k, 9));
  for (const [x, z, ry] of [[-2, -8, 0.3], [6, 2, -0.5], [-15, -3, 1.2]] as const)
    k.at(x, 0.17, z, ry, () => {
      k.box("solid", 2.2, 0.08, 0.6, 0, 0.45, 0, "#9b7b54");
      for (const sx of [-0.9, 0.9]) k.box("metal", 0.08, 0.45, 0.5, sx, 0.22, 0, "#2a2d31");
    });
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    k.cyl("solid", 0.1, 0.12, 0.95, 6, [Math.cos(a) * (R - 0.4), 0.6, Math.sin(a) * (R - 0.4)], "#1d1f22");
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const x = Math.cos(a) * (R - 1.5), z = Math.sin(a) * (R - 1.5);
    k.cyl("metal", 0.09, 0.13, 8, 8, [x, 4.15, z], "#2f3338");
    k.box("metal", 0.12, 0.12, 1.4, x, 8.1, z, "#2f3338");
    k.box("glow", 0.5, 0.08, 0.7, x, 8.0, z - 0.6, "#fff2d0");
  }
  return k.model("landmark-oldstreet", { ao: 1 });
}

/** Landmark model builders keyed by id (the `landmark-*` names drop the prefix here). */
export const LANDMARKS: Record<string, () => HeroModel> = {
  xoyo,
  artotel,
  encode: encodeHub,
  boxpark,
  oldstreet: oldStreet,
};
