// Shoreditch High Street station (London Overground, 2010): the long grey concrete box that encloses both platforms
// on top of the viaduct deck, built so the Goodsyard development could one day go over it. Ribbed precast concrete
// walls with a continuous strip of glazing at platform height (trains and passengers show through), a lightweight
// standing-seam roof with a rooflight down the middle, the tracks running in through portals at both ends. Below:
// paired concrete legs and, beside Braithwaite Street, the glazed street-level ticket hall with its gate line,
// ticket machines, stairs and lift up to the platforms, a canopy and the orange-ringed Overground roundels.
//
// Built with the hero-model Kit (world/models/kit.ts): every primitive is baked into one vertex-coloured geometry
// per material slot, so the whole station is ~5 draw calls plus its window glass and a few merged sign planes.
// Local frame: origin on the track centreline at the station's middle, at street level; +x along the line
// (east), +z = scene +z (contract south). Dimensions from OSM way 170081284 (193 m × ~16 m) and platform ways.
import { BufferGeometry, PlaneGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { DECK_Y, TRACK_OFFSET } from "../../sim/overground";
import { Kit, type HeroModel } from "../models/kit";
import { label } from "../models/materials";

export const PLATFORM_TOP = DECK_Y + 1.05;
/** Platform edge and back, measured from the track centreline. */
export const PLATFORM_IN = TRACK_OFFSET + 1.6;
export const PLATFORM_OUT = TRACK_OFFSET + 5.4;

/** Box section (metres). */
export const BOX = {
  /** Outer face of the side walls from the centreline. */
  HW: 8.2,
  WALL: 0.45,
  /** Underside of the box (the street-level clearance). */
  SOFFIT: 6.2,
  /** Top of the deck slab the platforms stand on. */
  DECK: 8.35,
  /** Window strip at platform height. */
  SILL: PLATFORM_TOP + 0.95,
  HEAD: PLATFORM_TOP + 4.35,
  /** Top of the walls / underside of the roof. */
  TOP: PLATFORM_TOP + 7.05,
  /** Track portals in the end walls. */
  PORTAL_HALF: 5.6,
  PORTAL_TOP: DECK_Y + 5.9,
} as const;

/** The street-level ticket hall (local x range) and the platform stair heads (local x range). */
export interface StationLayout {
  L: number;
  platformLen: number;
  /** Local x stretches where a street passes under the box (no legs there). */
  gaps: [number, number][];
  hall: [number, number] | null;
  /** Which way the hall's street face looks: -1 = toward -x (west), +1 = toward +x. */
  hallFace: -1 | 1;
}

export interface StationParts {
  model: HeroModel;
  /** See-through glass (window strips, hall curtain walls), one transparent mesh. */
  windows: BufferGeometry;
  /** Points (local) for street-level walkers: gate line, doors, stair foot. */
  hallPoints: { gate: [number, number]; door: [number, number]; stairFoot: [number, number][]; stairTop: [number, number, number][]; outside: [number, number] } | null;
}

const CONCRETE = ["#8e9195", "#878a8e", "#93969a"];
const CONCRETE_DARK = "#6c6f73";
const FIN = "#9a9da1";
const STEEL = "#3d4248";
const ROOF = "#b9bec3";
const SEAM = "#9aa0a6";
const OVERGROUND = "#ee7c0e";
const TFL_BLUE = "#0019a8";
const JOHNSTON = "600 {px}px 'Johnston', 'Gill Sans', 'Gill Sans MT', 'Helvetica Neue', Arial, sans-serif";

function plane(w: number, h: number, x: number, y: number, z: number, ry: number) {
  const g = new PlaneGeometry(w, h);
  g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

export function buildStation(o: StationLayout, name = "Shoreditch High Street"): StationParts {
  const k = new Kit();
  const glass: BufferGeometry[] = [];
  const { L, platformLen } = o;
  const { HW, WALL, SOFFIT, DECK, SILL, HEAD, TOP, PORTAL_HALF, PORTAL_TOP } = BOX;
  const IN = HW - WALL; // inner face of the side walls
  const nBays = Math.max(4, Math.round(L / 6));
  const pitch = L / nBays;
  const x0 = -L / 2;

  // ---- the deck slab and its edge plinth ----
  k.slab("solid", x0, L / 2, SOFFIT, DECK, -HW, HW, CONCRETE_DARK);

  // ---- side walls: per bay, a lower band, the glazing strip, an upper band; fins between bays ----
  for (const s of [-1, 1] as const) {
    const zi = s * IN;
    const zo = s * HW;
    const [za, zb] = s > 0 ? [zi, zo] : [zo, zi];
    for (let b = 0; b < nBays; b++) {
      const a = x0 + b * pitch;
      const c = a + pitch;
      const tone = CONCRETE[(b * 7 + (s > 0 ? 1 : 0)) % CONCRETE.length];
      k.slab("solid", a, c, DECK - 0.01, SILL, za, zb, tone);
      k.slab("solid", a, c, HEAD, TOP, za, zb, tone);
      // window mullions: four lights per bay
      for (let m = 1; m < 4; m++) k.box("metal", 0.07, HEAD - SILL, 0.12, a + (m * pitch) / 4, (SILL + HEAD) / 2, s * (IN + WALL / 2), STEEL);
      // a precast panel joint in each band (a shallow dark line, proud of the face so it never z-fights)
      k.box("solid", 0.05, SILL - DECK - 0.4, 0.03, (a + c) / 2, (DECK + SILL) / 2, s * (HW + 0.015), CONCRETE_DARK);
    }
    glass.push(plane(L - 0.4, HEAD - SILL, 0, (SILL + HEAD) / 2, s * (IN + WALL / 2), s > 0 ? 0 : Math.PI));
    // sill and head ledges
    k.slab("metal", x0, L / 2, SILL - 0.1, SILL + 0.04, s > 0 ? zo - 0.05 : zo - 0.14, s > 0 ? zo + 0.14 : zo + 0.05, "#5d6166");
    k.slab("metal", x0, L / 2, HEAD - 0.06, HEAD + 0.06, s > 0 ? zo - 0.05 : zo - 0.1, s > 0 ? zo + 0.1 : zo + 0.05, "#5d6166");
    // plinth: the deck edge, a darker band proud of the wall
    k.slab("solid", x0 - 0.15, L / 2 + 0.15, SOFFIT - 0.05, DECK + 0.2, s > 0 ? zo : zo - 0.18, s > 0 ? zo + 0.18 : zo, "#64676b");
    // vertical fins between bays: the ribbed look of the box
    for (let b = 0; b <= nBays; b++) {
      const fx = x0 + b * pitch;
      k.slab("solid", fx - 0.22, fx + 0.22, DECK + 0.2, TOP + 0.12, s > 0 ? zo : zo - 0.32, s > 0 ? zo + 0.32 : zo, FIN);
    }
  }

  // ---- end walls with the track portals ----
  for (const e of [-1, 1] as const) {
    const xa = e > 0 ? L / 2 - WALL : x0;
    const xb = xa + WALL;
    for (const s of [-1, 1]) k.slab("solid", xa, xb, DECK - 0.01, TOP, s > 0 ? PORTAL_HALF : -IN, s > 0 ? IN : -PORTAL_HALF, CONCRETE[1]);
    k.slab("solid", xa, xb, PORTAL_TOP, TOP, -PORTAL_HALF, PORTAL_HALF, CONCRETE[0]);
    // portal reveal: a steel frame round the opening
    k.slab("metal", xa - 0.06, xb + 0.06, PORTAL_TOP - 0.25, PORTAL_TOP, -PORTAL_HALF, PORTAL_HALF, STEEL);
    for (const s of [-1, 1]) k.slab("metal", xa - 0.06, xb + 0.06, DECK, PORTAL_TOP, s * PORTAL_HALF - 0.12, s * PORTAL_HALF + 0.12, STEEL);
  }

  // ---- the lightweight roof: standing-seam sheet, fascia, a rooflight strip down the middle ----
  k.slab("solid", x0 - 0.5, L / 2 + 0.5, TOP, TOP + 0.35, -HW - 0.5, HW + 0.5, ROOF);
  for (const s of [-1, 1]) k.slab("metal", x0 - 0.55, L / 2 + 0.55, TOP - 0.1, TOP + 0.5, s > 0 ? HW + 0.5 : -HW - 0.6, s > 0 ? HW + 0.6 : -HW - 0.5, "#a3a9af");
  for (let x = x0 + 0.6; x < L / 2 - 0.3; x += 1.2) {
    k.box("metal", 0.06, 0.07, HW - 2.6, x, TOP + 0.385, -(HW + 2.6) / 2 + 0.05, SEAM);
    k.box("metal", 0.06, 0.07, HW - 2.6, x, TOP + 0.385, (HW + 2.6) / 2 - 0.05, SEAM);
  }
  k.slab("glass", x0 + 2, L / 2 - 2, TOP + 0.35, TOP + 0.95, -2.2, 2.2, "#9db6c4");
  k.slab("metal", x0 + 1.8, L / 2 - 1.8, TOP + 0.95, TOP + 1.02, -2.4, 2.4, "#8f959b");
  for (let x = x0 + 2; x <= L / 2 - 2; x += 4) k.box("metal", 0.08, 0.62, 4.5, x, TOP + 0.66, 0, STEEL);

  // ---- inside: ceiling, roof trusses, light lines ----
  k.slab("solid", x0 + WALL, L / 2 - WALL, TOP - 0.12, TOP - 0.02, -IN, IN, "#dfe2e4");
  for (let b = 1; b < nBays; b++) {
    const fx = x0 + b * pitch;
    k.slab("metal", fx - 0.14, fx + 0.14, TOP - 0.85, TOP - 0.12, -IN, IN, "#4b5157");
  }
  for (const s of [-1, 1]) {
    k.slab("glow", -platformLen / 2 + 2, platformLen / 2 - 2, TOP - 1.0, TOP - 0.9, s * 5.7 - 0.18, s * 5.7 + 0.18, "#fff3d8");
    k.slab("glow", -platformLen / 2 + 2, platformLen / 2 - 2, SILL - 0.12, SILL - 0.06, s > 0 ? IN - 0.12 : -IN, s > 0 ? IN : -IN + 0.12, "#ffe7bf");
  }

  // ---- platforms: slab, white coping, yellow line, furniture, stair wells ----
  const stairX: [number, number] = [-3, 7];
  const PIN = PLATFORM_IN;
  const PT = PLATFORM_TOP;
  for (const s of [-1, 1] as const) {
    const zz = (a: number, b: number): [number, number] => (s > 0 ? [a, b] : [-b, -a]);
    const ends: [number, number][] = [
      [-platformLen / 2 + 0.5, stairX[0]],
      [stairX[1], platformLen / 2 - 0.5],
    ];
    for (const [a, b] of ends) k.slab("solid", a, b, DECK - 0.02, PT, ...zz(PIN, IN + 0.05), "#b4b0a9");
    // beside the stair well the platform narrows to the front strip
    k.slab("solid", stairX[0], stairX[1], DECK - 0.02, PT, ...zz(PIN, 6.0), "#b4b0a9");
    k.slab("solid", stairX[0], stairX[1], DECK - 0.02, PT - 2.6, ...zz(6.0, IN + 0.05), "#2a2c30");
    // the stair going down in the well
    for (let i = 0; i < 9; i++) k.slab("solid", stairX[1] - 0.6 - i * 1.05, stairX[1] - 0.6 - (i + 1) * 1.05 + 0.04, PT - 0.25 - i * 0.26, PT - 0.05 - i * 0.26, ...zz(6.1, IN), "#8c8a86");
    // balustrade round the well (glass panes read as a light rail and posts)
    k.slab("metal", stairX[0], stairX[1], PT + 1.0, PT + 1.07, ...zz(5.95, 6.05), "#c9ced3");
    for (let x = stairX[0]; x <= stairX[1] + 0.01; x += 2.5) k.slab("metal", x - 0.04, x + 0.04, PT, PT + 1.0, ...zz(5.95, 6.05), "#9aa0a6");
    k.slab("glass", stairX[0], stairX[1], PT + 0.1, PT + 0.95, ...zz(5.98, 6.02), "#b9cdd8");
    k.slab("solid", stairX[0] - 0.05, stairX[0] + 0.05, PT, PT + 1.07, ...zz(6.0, IN), "#9aa0a6");
    // coping and safety line
    k.slab("solid", -platformLen / 2 + 0.5, platformLen / 2 - 0.5, PT, PT + 0.012, ...zz(PIN, PIN + 0.32), "#e9e6df");
    k.slab("paint", -platformLen / 2 + 0.5, platformLen / 2 - 0.5, PT, PT + 0.014, ...zz(PIN + 0.55, PIN + 0.72), "#f2c230");
    // benches, bins and help points every 24 m (not at the stairs)
    for (let x = -platformLen / 2 + 14; x < platformLen / 2 - 10; x += 24) {
      if (x > stairX[0] - 3 && x < stairX[1] + 3) continue;
      const bz = s * 6.9;
      k.slab("metal", x - 1.1, x + 1.1, PT + 0.42, PT + 0.48, bz - 0.22, bz + 0.22, "#4a5058");
      k.slab("metal", x - 1.1, x + 1.1, PT + 0.48, PT + 0.9, s > 0 ? bz + 0.18 : bz - 0.22, s > 0 ? bz + 0.22 : bz - 0.18, "#4a5058");
      for (const lx of [-0.9, 0.9]) k.slab("metal", x + lx - 0.04, x + lx + 0.04, PT, PT + 0.45, bz - 0.2, bz + 0.2, "#2d3136");
      k.cyl("solid", 0.22, 0.2, 0.85, 10, [x + 2.2, PT + 0.43, bz], "#22262b");
      k.cyl("glow", 0.06, 0.06, 0.04, 8, [x + 2.2, PT + 0.87, bz], "#7fd36a");
    }
    // platform name boards on the inner wall (upper band) and dot-matrix train indicators hanging from the trusses
    for (let x = -platformLen / 2 + 8; x < platformLen / 2 - 4; x += 18)
      k.sign("shs-plat-name", 4.2, 0.62, [x, HEAD + 0.7, s * (IN - 0.04)], [512, 76], paintNameBoard(name), true, [0, s > 0 ? Math.PI : 0, 0]);
    for (const x of [-30, 20]) {
      const cz = s * 5.4;
      k.slab("metal", x - 0.03, x + 0.03, HEAD + 0.55, TOP - 0.85, cz - 0.03, cz + 0.03, STEEL);
      k.slab("solid", x - 0.09, x + 0.09, HEAD - 0.05, HEAD + 0.55, cz - 0.9, cz + 0.9, "#16181b");
      for (const f of [-1, 1]) k.sign("shs-cis", 1.7, 0.5, [x + f * 0.1, HEAD + 0.25, cz], [256, 76], paintCIS, true, [0, (f * Math.PI) / 2, 0]);
    }
  }

  // ---- big roundels and the station name high on the box, both sides near each end ----
  for (const s of [-1, 1] as const) {
    for (const end of [-1, 1] as const) {
      const rx = end * (L / 2 - 9);
      const z = s * (HW + 0.36);
      k.at(rx, 0, z, s > 0 ? 0 : Math.PI, () => {
        roundelDisc(k, (HEAD + TOP) / 2 + 0.05, 1.15);
      });
      const tx = rx - end * 13.5;
      k.sign("shs-box-name", 19, 1.25, [tx, (HEAD + TOP) / 2 + 0.05, s * (HW + 0.34)], [1024, 68], paintBoxName(name), true, [0, s > 0 ? 0 : Math.PI, 0]);
    }
  }

  // ---- under the box: paired concrete legs with downstand beams, and soffit lights ----
  const blocked = (x: number, pad: number) =>
    o.gaps.some(([a, b]) => x > a - pad && x < b + pad) || (o.hall !== null && x > o.hall[0] - pad && x < o.hall[1] + pad);
  for (let b = 0; b <= nBays; b += 3) {
    const lx = Math.max(x0 + 1.2, Math.min(L / 2 - 1.2, x0 + b * pitch));
    if (blocked(lx, 1.2)) continue;
    for (const s of [-1, 1]) k.rbox("solid", 1.3, SOFFIT, 1.3, lx, SOFFIT / 2, s * 5.6, "#86898d", 0.1);
    k.slab("solid", lx - 0.6, lx + 0.6, SOFFIT - 1.0, SOFFIT, -HW + 0.3, HW - 0.3, "#7d8084");
  }
  for (let x = x0 + 4; x < L / 2 - 2; x += 8) {
    if (o.hall && x > o.hall[0] - 1 && x < o.hall[1] + 1) continue;
    for (const s of [-1, 1]) k.slab("glow", x - 0.5, x + 0.5, SOFFIT - 0.06, SOFFIT - 0.01, s * 3 - 0.15, s * 3 + 0.15, "#ffe9c4");
  }

  // ---- the street-level ticket hall ----
  let hallPoints: StationParts["hallPoints"] = null;
  if (o.hall) {
    const [ha, hb] = o.hall;
    const f = o.hallFace; // street face at x = (f < 0 ? ha : hb)
    const fx = f < 0 ? ha : hb;
    const back = f < 0 ? hb : ha;
    const HZ = HW - 0.6;
    const HTOP = SOFFIT;
    const GL = 4.7; // top of the glazing
    const inward = -f; // +x into the hall when the face looks west
    const X = (d: number) => fx + inward * d; // distance in from the street face
    const span = (d0: number, d1: number): [number, number] => {
      const a = X(d0);
      const b = X(d1);
      return a < b ? [a, b] : [b, a];
    };
    k.slab("solid", Math.min(ha, hb), Math.max(ha, hb), 0, 0.14, -HZ, HZ, "#cfccc5");
    // floor tile grid lines
    for (let d = 1.5; d < Math.abs(hb - ha); d += 1.5) k.slab("solid", ...span(d - 0.02, d + 0.02), 0.14, 0.145, -HZ, HZ, "#b5b1aa");
    // back (east) wall and south wall: dark grey cladding with joints
    k.slab("solid", back - (inward > 0 ? 0.35 : 0), back + (inward > 0 ? 0 : 0.35), 0, HTOP, -HZ, HZ, "#50555c");
    k.slab("solid", Math.min(ha, hb), Math.max(ha, hb), 0, HTOP, HZ - 0.35, HZ, "#50555c");
    for (let d = 2; d < Math.abs(hb - ha); d += 2.4) k.slab("solid", ...span(d - 0.03, d + 0.03), 0.3, HTOP - 0.2, HZ + 0, HZ + 0.03, "#3c4046");
    // the street face and the north face: floor-to-ceiling glazing in a steel grid, a fascia band above
    glass.push(plane(2 * HZ - 0.2, GL - 0.14, fx, (GL + 0.14) / 2, 0, f < 0 ? -Math.PI / 2 : Math.PI / 2));
    const northLen = Math.abs(hb - ha) * 0.62;
    glass.push(plane(northLen, GL - 0.14, X(northLen / 2), (GL + 0.14) / 2, -HZ, Math.PI));
    for (let zz = -HZ; zz <= HZ + 0.01; zz += 1.8) k.slab("metal", fx - 0.07, fx + 0.07, 0.14, GL, zz - 0.05, zz + 0.05, STEEL);
    for (const y of [2.5, GL]) k.slab("metal", fx - 0.08, fx + 0.08, y - 0.06, y + 0.06, -HZ, HZ, STEEL);
    for (let d = 0; d <= northLen + 0.01; d += 1.8) k.slab("metal", ...span(d - 0.05, d + 0.05), 0.14, GL, -HZ - 0.07, -HZ + 0.07, STEEL);
    k.slab("metal", ...span(0, northLen), 2.44, 2.56, -HZ - 0.08, -HZ + 0.08, STEEL);
    // solid cladding on the rest of the north face
    k.slab("solid", ...span(northLen, Math.abs(hb - ha)), 0, HTOP, -HZ, -HZ + 0.35, "#50555c");
    // fascia band over the glazing (street face and north face) with the station name
    k.slab("solid", fx - 0.25, fx + 0.25, GL, HTOP, -HZ - 0.25, HZ, "#24282e");
    k.slab("solid", ...span(-0.25, northLen), GL, HTOP, -HZ - 0.25, -HZ + 0.2, "#24282e");
    k.sign("shs-fascia", 2 * HZ - 2.2, 1.0, [fx - f * 0.27, (GL + HTOP) / 2, 0.6], [1024, 76], paintFascia(name), true, [0, f < 0 ? -Math.PI / 2 : Math.PI / 2, 0]);
    k.sign("shs-fascia", northLen - 2.2, 1.0, [X(northLen / 2 + 0.8), (GL + HTOP) / 2, -HZ - 0.27], [1024, 76], paintFascia(name), true, [0, Math.PI, 0]);
    // fascia roundels at the corner
    k.at(fx - f * 0.35, 0, -HZ + 1.2, f < 0 ? -Math.PI / 2 : Math.PI / 2, () => roundelDisc(k, (GL + HTOP) / 2, 0.62));
    // canopy over the doors
    k.slab("metal", fx - (f < 0 ? 2.4 : -0.1), fx + (f < 0 ? 0.1 : 2.4), 3.35, 3.5, -HZ + 0.6, 2.6, "#2f3439");
    k.slab("glow", fx - (f < 0 ? 2.2 : -0.3), fx + (f < 0 ? -0.3 : 2.2), 3.32, 3.35, -HZ + 1.0, 2.2, "#fff2d6");
    // ceiling with light panels
    k.slab("solid", Math.min(ha, hb), Math.max(ha, hb), HTOP - 0.9, HTOP - 0.8, -HZ, HZ, "#e3e4e2");
    for (let d = 1.6; d < Math.abs(hb - ha) - 1; d += 3.2)
      for (let zz = -HZ + 1.6; zz < HZ - 1; zz += 3.2) k.slab("glow", ...span(d - 0.6, d + 0.6), HTOP - 0.93, HTOP - 0.9, zz - 0.6, zz + 0.6, "#fff6e8");
    // ticket gate line across the hall
    const gd = 5.2;
    for (let i = 0; i < 7; i++) {
      const gz = -HZ + 1.4 + i * 1.15;
      k.rbox("solid", 1.5, 1.02, 0.26, X(gd), 0.65, gz, i === 0 ? "#8a9098" : "#3a3e44", 0.05);
      k.slab("glow", ...span(gd - 0.2, gd + 0.2), 1.16, 1.2, gz - 0.06, gz + 0.06, i % 3 === 2 ? "#ff5a4a" : "#3ad46a");
      k.slab("glow", ...span(gd - 0.75, gd - 0.62), 0.95, 1.08, gz - 0.1, gz + 0.1, "#ffd23a");
      // paddles
      if (i < 6) k.slab("glass", ...span(gd - 0.05, gd + 0.05), 0.45, 1.05, gz + 0.16, gz + 0.5, "#c9d6de");
    }
    k.slab("metal", ...span(gd - 0.04, gd + 0.04), 0.14, 1.0, -HZ + 0.4, -HZ + 1.2, "#7c838a");
    // ticket machines and an Oyster validator along the south wall
    for (const d of [1.8, 3.1]) {
      k.rbox("solid", 1.05, 1.75, 0.6, X(d), 1.0, HZ - 0.65, "#1e3f8f", 0.06);
      k.slab("glow", ...span(d - 0.3, d + 0.3), 1.2, 1.6, HZ - 0.97, HZ - 0.94, "#9fd0ff");
    }
    // stairs up to each platform (and the lift between them), rising away from the gate line
    const sd0 = gd + 2.6;
    const run = Math.abs(hb - ha) - sd0 - 0.6;
    const steps = Math.max(8, Math.floor(run / 0.33));
    const rise = (HTOP - 0.95) / steps;
    const stairFoot: [number, number][] = [];
    const stairTop: [number, number, number][] = [];
    for (const sz of [-3.6, 3.0]) {
      for (let i = 0; i < steps; i++) k.slab("solid", ...span(sd0 + i * (run / steps), sd0 + (i + 1) * (run / steps) + 0.02), 0.14, 0.14 + (i + 1) * rise, sz - 1.0, sz + 1.0, i % 2 ? "#8f8c87" : "#99968f");
      for (const side of [-1, 1]) k.beam("metal", [X(sd0), 1.05, sz + side * 1.05], [X(sd0 + run), 1.05 + steps * rise, sz + side * 1.05], 0.04, "#c0c5ca");
      stairFoot.push([X(sd0 - 0.6), sz]);
      stairTop.push([X(sd0 + run * 0.78), sz, 0.14 + steps * 0.78 * rise]);
    }
    k.slab("glass", ...span(sd0 + 0.2, sd0 + 2.2), 0.14, HTOP - 0.8, -0.6, 1.4, "#a9c0cc");
    k.slab("metal", ...span(sd0 + 0.15, sd0 + 2.25), HTOP - 1.1, HTOP - 0.8, -0.65, 1.45, "#5b6067");
    // roundel totem on the pavement outside
    k.at(fx - f * 2.6, 0, -HZ - 1.6, f < 0 ? -Math.PI / 2 : Math.PI / 2, () => {
      k.cyl("solid", 0.18, 0.22, 0.25, 12, [0, 0.12, 0], "#2b2d31");
      k.cyl("metal", 0.08, 0.09, 4.2, 10, [0, 2.1, 0], "#3a3f45");
      roundelDisc(k, 4.75, 0.7);
    });
    hallPoints = { gate: [X(gd), -0.6], door: [fx - f * 0.6, -1.5], stairFoot, stairTop, outside: [fx - f * 2.2, -HZ - 2.4] };
  }

  const model = k.model("shoreditch-high-street-station", { ao: 0 });
  const merged = mergeGeometries(glass.map((g) => (g.index ? g.toNonIndexed() : g)), false) ?? new BufferGeometry();
  glass.forEach((g) => g.dispose());
  return { model, windows: merged, hallPoints };
}

/** Overground roundel as a solid disc (orange ring, white disc, blue bar with the name) facing +z, both sides. */
export function roundelDisc(k: Kit, y: number, r: number) {
  k.torus("glow", r * 0.82, r * 0.18, 8, 32, [0, y, 0], OVERGROUND);
  k.cylZ("solid", r * 0.66, 0.08, 28, [0, y, 0], "#f4f4f2");
  k.box("glow", r * 2.5, r * 0.44, 0.14, 0, y, 0, TFL_BLUE);
  for (const s of [1, -1])
    k.sign("shs-roundel-bar", r * 2.36, r * 0.38, [0, y, s * 0.08], [512, 80], (c, w, h) => {
      c.fillStyle = TFL_BLUE;
      c.fillRect(0, 0, w, h);
      label(c, "SHOREDITCH HIGH STREET", w / 2, h / 2 + 2, w - 24, 50, "#ffffff", JOHNSTON);
    }, true, [0, s > 0 ? 0 : Math.PI, 0]);
}

function paintNameBoard(name: string) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    c.fillStyle = TFL_BLUE;
    c.fillRect(0, 0, w, h);
    label(c, name, w / 2 + 24, h / 2 + 2, w - 110, 46, "#ffffff", JOHNSTON);
    // a little roundel at the left
    c.save();
    c.translate(36, h / 2);
    c.strokeStyle = OVERGROUND;
    c.lineWidth = 9;
    c.beginPath();
    c.arc(0, 0, 21, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = "#ffffff";
    c.fillRect(-30, -5, 60, 10);
    c.restore();
  };
}

function paintCIS(c: CanvasRenderingContext2D, w: number, h: number) {
  c.fillStyle = "#050505";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#ffae1a";
  c.font = "bold 22px 'Courier New', monospace";
  c.textBaseline = "top";
  c.fillText("1 Highbury & Islington 2min", 8, 8);
  c.fillText("2 West Croydon       6min", 8, 40);
}

function paintBoxName(name: string) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    c.clearRect(0, 0, w, h);
    label(c, name.toUpperCase(), w / 2, h / 2 + 2, w - 20, 56, "#f7f7f5", JOHNSTON);
  };
}

function paintFascia(name: string) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    c.fillStyle = "#24282e";
    c.fillRect(0, 0, w, h);
    label(c, `${name} station`, w / 2 + 40, h / 2 + 2, w - 160, 50, "#ffffff", JOHNSTON);
    c.fillStyle = OVERGROUND;
    c.fillRect(0, h - 8, w, 8);
    c.strokeStyle = OVERGROUND;
    c.lineWidth = 10;
    c.beginPath();
    c.arc(60, h / 2 - 3, 22, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = TFL_BLUE;
    c.fillRect(28, h / 2 - 9, 64, 12);
  };
}
