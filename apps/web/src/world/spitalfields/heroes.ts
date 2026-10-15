// The Spitalfields hero models, built from primitives into shared kits (one merged mesh per material):
//  - Christ Church Spitalfields (Hawksmoor, 1714-29): Tuscan portico, the broad west tower and its 62 m broach spire,
//    the stone nave with two tiers of round-headed windows and a clerestory. White Portland stone, floodlit at night.
//  - Old Spitalfields Market (Horner, 1887-93): the iron-and-glass hall roof over the stalls, green ironwork.
//  - Liverpool Street station: the 1875 trainshed's glazed spans, the Gothic clock tower and Liverpool Street range.
//  - The Old Truman Brewery: the 49 m brick chimney with TRUMAN down it, and the bridge over Brick Lane.
//  - Brick Lane: the Banglatown gateway arch and the Jamme Masjid's steel minaret.
// Everything is placed from the OSM outlines (public/areas/spitalfields.json) in contract coords → toScene.
import { BoxGeometry, CylinderGeometry, ExtrudeGeometry, Shape, TorusGeometry } from "three";
import { toScene } from "../../sim/geometry";
import type { SignAtlas } from "./atlas";
import { Kit, Quads } from "./kit";

export type Ring = [number, number][];

export interface HeroKits {
  /** Brick, iron, slate: plain vertex colours. */
  solid: Kit;
  /** Christ Church's Portland stone (floodlit at night). */
  stone: Kit;
  /** Roof glazing (transparent). */
  glass: Kit;
  /** Night-only light: windows, lanterns, neon (unlit, shown with the night level). */
  glow: Kit;
  /** Textured signs (atlas). */
  signs: Quads;
}

const STONE = "#ece8de";
const STONE_D = "#dcd6c8";
const LEAD = "#6c7278";
const WIN = "#2a3039";
const WARM = "#ffcd85";
const IRON = "#2e4a3b"; // market ironwork green
const STATION_IRON = "#3c4b5c";
const STOCK = "#b8a07a"; // yellow stock brick
const BRICK = "#8a4632";

function bbox(r: Ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of r) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

export function inRing(x: number, z: number, r: Ring) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[i];
    const [bx, bz] = r[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
}

/** Triangular-section prism along local x (a pitched roof): `len` long, `halfW` half-span, `rise` high, base at y0. */
function gable(k: Kit, len: number, halfW: number, rise: number, x: number, y0: number, z: number, hex: string) {
  const s = new Shape();
  s.moveTo(-halfW, 0);
  s.lineTo(halfW, 0);
  s.lineTo(0, rise);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2).rotateY(Math.PI / 2).translate(x, y0, z);
  k.add(g, hex);
}

/** Kit heading (radians about +y) whose local +x points along the CONTRACT direction (dx east, dz north). */
export const headingOf = (dx: number, dz: number) => Math.atan2(dz, dx);

// ------------------------------------------------------------------------------------------------------------
// Christ Church Spitalfields
// ------------------------------------------------------------------------------------------------------------

export function christChurch(k: HeroKits, ring: Ring) {
  const b = bbox(ring);
  const [sx, sz] = toScene(b.minX, (b.maxZ + b.minZ + 3.3) / 2);
  const s = k.stone.frame(sx, sz, 0);
  const g = k.glow.frame(sx, sz, 0);
  const so = k.solid.frame(sx, sz, 0);
  const L = b.maxX - 4 - b.minX; // west face → east wall (vestries stick out 4 m beyond)

  // --- portico: steps, four Tuscan columns, entablature with the arched centre bay
  s.block(5.4, 0.35, 15, 2.2, 0, 0, STONE_D);
  s.block(5.0, 0.35, 14.4, 2.4, 0.35, 0, STONE_D);
  s.block(4.6, 0.35, 13.8, 2.6, 0.7, 0, STONE_D);
  for (const z of [-5.1, -1.9, 1.9, 5.1]) {
    s.cyl(0.46, 0.55, 7.6, 1.6, 1.05 + 3.8, z, STONE, 12);
    s.block(1.3, 0.4, 1.3, 1.6, 1.05, z, STONE_D); // base
    s.block(1.3, 0.35, 1.3, 1.6, 8.65, z, STONE_D); // capital
  }
  s.block(4.6, 1.5, 13.8, 2.5, 9.0, 0, STONE);
  s.block(5.0, 0.4, 14.4, 2.5, 10.5, 0, STONE_D);
  // the centre bay's semicircular arch rising through the entablature, with a pediment-like attic over it
  s.block(4.6, 2.4, 5.6, 2.5, 10.9, 0, STONE);
  s.arch(1.6, 0.32, 0.15, 9.0, 0, STONE_D, true, 12);
  s.block(5.0, 0.35, 6.0, 2.5, 13.3, 0, STONE_D);
  so.block(0.1, 4.4, 2.2, 4.35, 1.05, 0, "#3a2b22"); // west door
  so.block(0.1, 2.6, 1.6, 4.35, 6.4, -4, WIN);
  so.block(0.1, 2.6, 1.6, 4.35, 6.4, 4, WIN);

  // --- the west tower: broad base, the Venetian stage, belfry, broach spire
  s.block(8, 24, 15.2, 8.5, 0, 0, STONE);
  s.block(8.6, 0.6, 15.8, 8.5, 24, 0, STONE_D);
  s.block(8.4, 0.5, 15.6, 8.5, 14.2, 0, STONE_D); // string course
  // great arched west window and side niches
  so.block(0.1, 6.5, 3, 4.45, 15.2, 0, WIN);
  g.block(0.08, 6.3, 2.8, 4.4, 15.3, 0, WARM);
  so.arch(1.5, 0.2, 4.43, 21.7, 0, WIN, true, 10);
  for (const z of [-5.2, 5.2]) so.block(0.1, 4.5, 1.6, 4.45, 16, z, WIN);
  s.block(6.4, 9.4, 10, 8.5, 24.6, 0, STONE);
  s.block(7.0, 0.5, 10.6, 8.5, 34, 0, STONE_D);
  for (const [nx, nz, w] of [[-1, 0, 10], [1, 0, 10], [0, -1, 6.4], [0, 1, 6.4]] as const) {
    // arched openings on every face of the middle stage
    const px = 8.5 + nx * 3.22;
    const pz = nz * 5.02;
    if (nx) {
      so.block(0.08, 5, 2.2, px, 27, pz, WIN);
      g.block(0.06, 4.8, 2.0, px + nx * 0.03, 27.1, pz, WARM);
    } else so.block(Math.min(2.2, w), 5, 0.08, px, 27, pz, WIN);
  }
  s.block(5.6, 6.5, 5.6, 8.5, 34.5, 0, STONE);
  s.block(6.2, 0.5, 6.2, 8.5, 41, 0, STONE_D);
  for (const [nx, nz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    const px = 8.5 + nx * 2.82;
    const pz = nz * 2.82;
    so.block(nx ? 0.08 : 1.8, 3.8, nx ? 1.8 : 0.08, px, 36, pz, "#3b3f45"); // louvres
    for (let i = 0; i < 5; i++) so.block(nx ? 0.12 : 1.8, 0.08, nx ? 1.8 : 0.12, px, 36.4 + i * 0.7, pz, STONE_D);
  }
  for (const cx of [-2.6, 2.6]) for (const cz of [-2.6, 2.6]) s.cone(0.42, 3.4, 8.5 + cx, 41.5, cz, STONE, 4, Math.PI / 4);
  s.cone(3.05, 21, 8.5, 41.5, 0, STONE, 8, Math.PI / 8);
  for (const [nx, nz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    s.block(nx ? 1.2 : 1.0, 1.8, nx ? 1.0 : 1.2, 8.5 + nx * 2.4, 42, nz * 2.4, STONE); // lucarnes
    so.block(nx ? 0.06 : 0.6, 1.0, nx ? 0.6 : 0.06, 8.5 + nx * 3.02, 42.3, nz * 3.02, WIN);
  }
  s.ball(0.28, 8.5, 62.6, 0, STONE_D);
  so.cyl(0.05, 0.05, 1.6, 8.5, 63.5, 0, "#3a3a3a", 4);

  // --- the nave: aisles, clerestory, lead roof, two tiers of round-headed windows
  const nx0 = 12.5;
  const nLen = L - nx0;
  const ncx = nx0 + nLen / 2;
  s.block(nLen, 14, 23.2, ncx, 0, 0, STONE);
  s.block(nLen + 0.6, 0.8, 23.8, ncx, 14, 0, STONE_D);
  for (const side of [-1, 1]) s.block(nLen, 0.9, 0.35, ncx, 14.8, side * 11.55, STONE);
  s.block(nLen - 1, 5, 13, ncx + 0.5, 14, 0, STONE);
  s.block(nLen - 0.6, 0.5, 13.4, ncx + 0.5, 19, 0, STONE_D);
  gable(k.solid.frame(sx, sz, 0), nLen - 1, 6.9, 2.6, ncx + 0.5, 19.5, 0, LEAD);
  k.solid.frame(sx, sz, 0);
  for (let x = nx0 + 3.5; x < L - 3; x += 5.4)
    for (const side of [-1, 1]) {
      const z = side * 11.62;
      so.block(1.3, 2.4, 0.1, x, 2.6, z, WIN);
      so.block(1.8, 5.4, 0.1, x, 6.6, z, WIN);
      so.arch(0.9, 0.12, x, 12.0, z, STONE_D, false, 8);
      g.block(1.6, 5.2, 0.06, x, 6.7, z + side * 0.04, WARM);
      g.block(1.1, 2.2, 0.06, x, 2.7, z + side * 0.04, WARM);
      so.block(1.4, 1.5, 0.1, x, 16.2, side * 6.55, WIN); // clerestory
      g.block(1.2, 1.3, 0.06, x, 16.3, side * 6.6, WARM);
    }
  // east end: Venetian window and the two vestries
  so.block(0.1, 7, 4.2, L + 0.02, 4, 0, WIN);
  g.block(0.06, 6.8, 4.0, L + 0.06, 4.1, 0, WARM);
  for (const side of [-1, 1]) s.block(4, 9, 4.5, L + 2, 0, side * 8.2, STONE);
  // south porch onto the churchyard
  s.block(11, 8, 3.3, 34.9, 0, 13.3, STONE);
  s.block(11.6, 0.5, 3.8, 34.9, 8, 13.3, STONE_D);
  so.block(2.2, 3.6, 0.1, 34.9, 0.4, 15.0, "#3a2b22");
}

// ------------------------------------------------------------------------------------------------------------
// Old Spitalfields Market hall roof
// ------------------------------------------------------------------------------------------------------------

export interface MarketLayout {
  /** Scene centre and frame: local x runs north-south (the spans), local z across (scene +x). */
  cx: number;
  cz: number;
  len: number;
  width: number;
  spans: number;
  roofY: number;
}

export function marketHall(k: HeroKits, ring: Ring, atlas: SignAtlas): MarketLayout {
  const b = bbox(ring);
  const [cx, cz] = toScene((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
  const len = b.maxZ - b.minZ - 1.2;
  const width = b.maxX - b.minX - 1.2;
  const spans = 6;
  const sw = width / spans;
  const roofY = 10.5;
  const rot = Math.PI / 2; // local +x → scene -z (north), local +z → scene +x (east)
  const so = k.solid.frame(cx, cz, rot);
  const gl = k.glass.frame(cx, cz, rot);
  const g = k.glow.frame(cx, cz, rot);
  for (let i = 0; i <= spans; i++) {
    const z = -width / 2 + i * sw;
    for (let x = -len / 2; x <= len / 2 + 0.01; x += len / 8) {
      so.cyl(0.2, 0.26, roofY, x, roofY / 2, z, IRON, 8);
      so.block(0.7, 0.5, 0.7, x, roofY - 0.5, z, IRON);
    }
    so.block(len, 0.7, 0.5, 0, roofY, z, IRON); // eaves girder
  }
  for (let i = 0; i < spans; i++) {
    const z = -width / 2 + (i + 0.5) * sw;
    gable(k.glass.frame(cx, cz, rot), len, sw / 2, 4.2, 0, roofY + 0.7, z, "#cfe2ea");
    gl.frame(cx, cz, rot);
    so.block(len, 0.45, 0.45, 0, roofY + 4.9, z, IRON); // ridge
    // a raised lantern light along the ridge
    so.block(len - 2, 0.5, 1.2, 0, roofY + 4.95, z, "#45604f");
    // light iron trusses: two rafters and a tie rod at every column line
    const rise = 4.2;
    const half = sw / 2;
    const slope = Math.atan2(rise, half);
    const rl = Math.hypot(rise, half);
    for (let x = -len / 2; x <= len / 2 + 0.01; x += len / 8)
      for (const e of [-1, 1]) {
        so.add(new BoxGeometry(0.2, 0.28, rl).rotateX(e * slope).translate(x, roofY + 0.7 + rise / 2, z + (e * half) / 2), IRON);
        so.block(0.08, 0.08, sw, x, roofY + 0.75, z, IRON);
      }
    // strings of warm bulbs under the ridge
    for (let x = -len / 2 + 2; x < len / 2; x += 3.2) g.block(0.25, 0.25, 0.25, x, roofY - 0.4, z, WARM);
  }
  k.glass.frame(0, 0, 0);
  k.glow.frame(0, 0, 0);
  k.solid.frame(0, 0, 0);
  // the market's name over the Commercial Street entrance (the Horner range's east face)
  const [ex, ez] = toScene(-8.7, -396);
  k.signs.add(ex, 8.8, ez, 1, 0, 17, 1.6, atlas.market);
  const [wx, wz] = toScene(-8.7, -425);
  k.signs.add(wx, 8.8, wz, 1, 0, 12, 1.15, atlas.market);
  return { cx, cz, len, width, spans, roofY };
}

// ------------------------------------------------------------------------------------------------------------
// Liverpool Street station
// ------------------------------------------------------------------------------------------------------------

export function liverpoolStreet(k: HeroKits, ring: Ring, atlas: SignAtlas) {
  // the trainshed's axis: parallel to its long east wall, north → south
  const n0: [number, number] = [(-496.5 + -401.1) / 2, (-392.2 + -425) / 2];
  const ux = -0.34;
  const uz = -0.94;
  const vx = uz; // across, toward the west side
  const vz = -ux;
  const rot = headingOf(ux, uz);
  const at = (u: number, v: number): [number, number] => [n0[0] + ux * u + vx * v, n0[1] + uz * u + vz * v];
  const spans = 4;
  const half = 47;
  const sw = (2 * half) / spans;
  const springY = 12;
  const [ox, oz] = toScene(...n0);
  const so = k.solid.frame(ox, oz, rot);
  // local +z is scene (sin rot, cos rot): flip the across-axis sign so v > 0 stays on the west side
  const lz = [Math.sin(rot), Math.cos(rot)];
  const vScene = [vx, -vz];
  const flip = lz[0] * vScene[0] + lz[1] * vScene[1] >= 0 ? 1 : -1;
  for (let i = 0; i < spans; i++) {
    const v = -half + (i + 0.5) * sw;
    let u0 = -1;
    let u1 = -1;
    for (let u = 0; u < 280; u += 2) {
      const [x, z] = at(u, v);
      if (inRing(x, z, ring)) {
        if (u0 < 0) u0 = u;
        u1 = u;
      }
    }
    if (u0 < 0) continue;
    u0 += 3;
    u1 -= 3;
    const len = u1 - u0;
    const mid = (u0 + u1) / 2;
    const z = v * flip;
    const r = sw / 2;
    const vault = new CylinderGeometry(r, r, len, 18, 1, true, 0, Math.PI).rotateZ(Math.PI / 2).scale(1, 0.72, 1).translate(mid, springY, z);
    k.glass.frame(ox, oz, rot).add(vault, "#c9dbe6");
    // ribs every 9 m, a solid band (the roof's slated outer strips) along each side of the glazing
    for (let u = u0; u <= u1 + 0.01; u += 9) {
      const rib = new TorusGeometry(r, 0.22, 4, 18, Math.PI).rotateY(Math.PI / 2).scale(1, 0.72, 1).translate(u, springY, z);
      so.add(rib, STATION_IRON);
    }
    for (const e of [-1, 1]) {
      const strip = new CylinderGeometry(r + 0.05, r + 0.05, len, 3, 1, true, e < 0 ? 0 : Math.PI * 0.72, Math.PI * 0.28)
        .rotateZ(Math.PI / 2)
        .scale(1, 0.72, 1)
        .translate(mid, springY, z);
      so.add(strip, "#59606a");
    }
    // columns and girders on the span lines
    for (const e of [-1, 1]) {
      const zl = z + (e * sw) / 2;
      so.block(len, 0.8, 0.5, mid, springY - 0.8, zl, STATION_IRON);
      for (let u = u0; u <= u1 + 0.01; u += 9) so.cyl(0.25, 0.32, springY - 0.8, u, (springY - 0.8) / 2, zl, STATION_IRON, 8);
    }
  }
  // the long side walls in yellow stock brick
  for (const e of [-1, 1]) {
    let u0 = -1;
    let u1 = -1;
    for (let u = 0; u < 280; u += 2) {
      const [x, z] = at(u, e * (half - 1));
      if (inRing(x, z, ring)) {
        if (u0 < 0) u0 = u;
        u1 = u;
      }
    }
    if (u0 < 0) continue;
    so.block(u1 - u0, springY, 1.2, (u0 + u1) / 2, 0, e * half * flip, STOCK);
  }
  k.glass.frame(0, 0, 0);

  // the Gothic range on Liverpool Street and its clock tower (south-west corner)
  const a: [number, number] = [-523, -621];
  const bpt: [number, number] = [-556, -610];
  const dx = bpt[0] - a[0];
  const dz = bpt[1] - a[1];
  const l = Math.hypot(dx, dz);
  const [mx, mz] = toScene((a[0] + bpt[0]) / 2, (a[1] + bpt[1]) / 2);
  const rr = headingOf(dx / l, dz / l);
  const f = k.solid.frame(mx, mz, rr);
  // local +z points either to the street (south) or into the station: find the street side
  const lzS = [Math.sin(rr), Math.cos(rr)]; // local +z in scene
  const street = lzS[1] > 0 ? 1 : -1; // scene +z is south
  f.block(l, 16, 9, 0, 0, 0, STOCK);
  f.block(l + 0.4, 0.6, 9.4, 0, 16, 0, "#d9cfb8");
  f.block(l + 0.2, 0.4, 9.2, 0, 5.2, 0, "#d9cfb8");
  for (let i = 0; i < 5; i++) {
    const x = -l / 2 + 3.5 + i * ((l - 7) / 4);
    f.cone(2.6, 4.5, x, 16.4, 0, STOCK, 4, Math.PI / 4); // gablets
    for (const y of [6.3, 10.6]) f.block(1.3, 3.2, 0.1, x, y, street * 4.52, WIN);
    k.glow.frame(mx, mz, rr).block(1.1, 3.0, 0.06, x, 6.4, street * 4.56, WARM);
  }
  f.block(5, 4.6, 0.1, 0, 0, street * 4.52, "#2a2a30"); // entrance
  const [tx, tz] = toScene(-563, -620);
  const t = k.solid.frame(tx, tz, rr);
  t.block(7, 30, 7, 0, 0, 0, STOCK);
  for (const y of [8, 16, 24]) t.block(7.4, 0.5, 7.4, 0, y, 0, "#d9cfb8");
  t.block(7.6, 2.2, 7.6, 0, 30, 0, "#d9cfb8");
  t.cone(5.3, 9, 0, 32.2, 0, "#55606a", 4, Math.PI / 4);
  t.cyl(0.06, 0.06, 2.4, 0, 42.2, 0, "#2a2a2a", 4);
  k.glow.frame(0, 0, 0);
  k.solid.frame(0, 0, 0);
  // clock faces on all four sides, the station's name over the entrance
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const c = Math.cos(rr);
    const s = Math.sin(rr);
    // local (nx, nz) → scene direction
    const ex = nx * c + nz * s;
    const ez = -nx * s + nz * c;
    k.signs.add(tx + ex * 3.56, 26.5, tz + ez * 3.56, ex, ez, 3.2, 3.2, atlas.clock);
  }
  const fx = Math.sin(rr) * street;
  const fz = Math.cos(rr) * street;
  k.signs.add(mx + fx * 4.57, 4.0 + 1.2, mz + fz * 4.57, fx, fz, 14, 1.3, atlas.station);
}

// ------------------------------------------------------------------------------------------------------------
// The Old Truman Brewery: chimney and Brick Lane bridge
// ------------------------------------------------------------------------------------------------------------

export function trumanBrewery(k: HeroKits, atlas: SignAtlas, chimney: [number, number], bridge: { x: number; z: number; dx: number; dz: number; span: number }) {
  const [cx, cz] = toScene(...chimney);
  const so = k.solid.frame(cx, cz, 0);
  const H = 49;
  so.add(new CylinderGeometry(1.55, 2.25, H, 4, 1).rotateY(Math.PI / 4).translate(0, H / 2, 0), BRICK);
  so.add(new CylinderGeometry(2.45, 2.55, 3, 4, 1).rotateY(Math.PI / 4).translate(0, 1.5, 0), "#6e3424"); // plinth
  so.add(new CylinderGeometry(1.75, 1.6, 1.4, 4, 1).rotateY(Math.PI / 4).translate(0, H - 0.4, 0), "#3a2620"); // cap
  so.add(new CylinderGeometry(1.7, 1.65, 0.5, 4, 1).rotateY(Math.PI / 4).translate(0, H - 4, 0), "#5a2c20");
  // aircraft warning light on top (glows at night)
  k.glow.frame(cx, cz, 0).ball(0.25, 0, H + 0.4, 0, "#ff2a2a", 6);
  k.glow.frame(0, 0, 0);
  // TRUMAN down the west and south faces (Brick Lane and the yard)
  const hw = (y: number) => (2.25 - (0.7 * y) / H) * Math.SQRT1_2 + 0.06;
  for (const [nx, nz] of [[-1, 0], [0, 1]] as const) k.signs.add(cx + nx * hw(25), 32, cz + nz * hw(25), nx, nz, 1.5, 10, atlas.vertical);

  // the enclosed bridge between the brewery buildings across Brick Lane
  const [bx, bz] = toScene(bridge.x, bridge.z);
  const rr = headingOf(bridge.dx, bridge.dz);
  const b = k.solid.frame(bx, bz, rr);
  b.block(bridge.span, 0.5, 3.2, 0, 6.2, 0, "#25292d");
  b.block(bridge.span, 0.6, 3.2, 0, 9.0, 0, "#25292d");
  for (let x = -bridge.span / 2; x <= bridge.span / 2 + 0.01; x += bridge.span / 4) b.block(0.25, 2.4, 3.2, x, 6.6, 0, "#25292d");
  k.glass.frame(bx, bz, rr).block(bridge.span, 2.4, 3.0, 0, 6.6, 0, "#a9c4cf");
  k.glow.frame(bx, bz, rr).block(bridge.span - 0.6, 0.15, 3.05, 0, 8.75, 0, WARM);
  k.glass.frame(0, 0, 0);
  k.glow.frame(0, 0, 0);
  k.solid.frame(0, 0, 0);
  const sx = Math.sin(rr);
  const sz = Math.cos(rr);
  for (const e of [-1, 1]) k.signs.add(bx + sx * e * 1.62, 9.95, bz + sz * e * 1.62, sx * e, sz * e, Math.min(11, bridge.span - 1), 1.05, atlas.truman);
}

// ------------------------------------------------------------------------------------------------------------
// Brick Lane: Banglatown arch and the Jamme Masjid minaret
// ------------------------------------------------------------------------------------------------------------

export function banglaArch(k: HeroKits, atlas: SignAtlas, at: { x: number; z: number; dx: number; dz: number; span: number }) {
  const [x, z] = toScene(at.x, at.z);
  const rr = headingOf(at.dx, at.dz); // local +x along the street, local z across it
  const so = k.solid.frame(x, z, rr);
  const half = at.span / 2;
  const GREEN = "#0f7a3c";
  const RED = "#d42a2a";
  for (const e of [-1, 1]) {
    so.cyl(0.32, 0.4, 6, 0, 3, e * half, GREEN, 10);
    so.cyl(0.42, 0.42, 0.35, 0, 1.2, e * half, RED, 10);
    so.cyl(0.42, 0.42, 0.35, 0, 4.6, e * half, RED, 10);
    so.block(1.1, 0.5, 1.1, 0, 0, e * half, "#1d1f22");
  }
  // the arch: a green tube with a red inner rib, springing from the columns
  so.add(new TorusGeometry(half, 0.28, 6, 28, Math.PI).rotateY(Math.PI / 2).scale(1, 0.62, 1).translate(0, 6, 0), GREEN);
  so.add(new TorusGeometry(half - 0.7, 0.16, 5, 28, Math.PI).rotateY(Math.PI / 2).scale(1, 0.6, 1).translate(0, 6, 0), RED);
  // flag-motif crown: green panel, red disc
  so.block(0.2, 2.3, 3.6, 0, 6 + half * 0.62 - 0.2, 0, GREEN);
  so.add(new CylinderGeometry(0.8, 0.8, 0.3, 20).rotateZ(Math.PI / 2).translate(0, 6 + half * 0.62 + 0.95, 0), RED);
  const sx = Math.cos(rr);
  const sz = -Math.sin(rr);
  for (const e of [-1, 1]) k.signs.add(x + sx * e * 0.2, 7.0, z + sz * e * 0.2, sx * e, sz * e, 7.5, 0.75, atlas.bangla);
  so.block(0.15, 0.85, 7.8, 0, 6.6, 0, "#0b3d20");
  k.glow.frame(x, z, rr);
  k.glow.add(new TorusGeometry(half, 0.12, 4, 28, Math.PI).rotateY(Math.PI / 2).scale(1, 0.62, 1).translate(0.32, 6, 0), "#7dffa8");
  k.glow.add(new TorusGeometry(half, 0.12, 4, 28, Math.PI).rotateY(Math.PI / 2).scale(1, 0.62, 1).translate(-0.32, 6, 0), "#7dffa8");
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI;
    k.glow.ball(0.14, 0, 6 + Math.sin(a) * half * 0.62, Math.cos(a) * half, "#fff0b0", 5);
  }
  k.glow.frame(0, 0, 0);
  k.solid.frame(0, 0, 0);
}

export function minaret(k: HeroKits, at: [number, number]) {
  const [x, z] = toScene(...at);
  const so = k.solid.frame(x, z, 0);
  const STEEL = "#c6ccd2";
  so.cyl(0.85, 1.0, 22, 0, 11, 0, STEEL, 16);
  for (const y of [5, 10, 15, 20]) so.cyl(1.02, 1.02, 0.25, 0, y, 0, "#9aa2aa", 16);
  so.cyl(1.25, 0.9, 1.2, 0, 22.6, 0, STEEL, 16); // balcony
  so.cyl(0.55, 0.75, 3.2, 0, 24.8, 0, STEEL, 16);
  so.cone(0.6, 1.8, 0, 26.4, 0, STEEL, 16);
  so.cyl(0.04, 0.04, 1.2, 0, 28.6, 0, "#d9b44a", 4);
  so.ball(0.18, 0, 29.3, 0, "#d9b44a", 6);
  const g = k.glow.frame(x, z, 0);
  g.cyl(1.04, 1.04, 0.3, 0, 22.0, 0, "#7dffb0", 16);
  for (const y of [6, 12, 18]) g.cyl(1.03, 1.03, 0.12, 0, y, 0, "#c8fff0", 16);
  k.glow.frame(0, 0, 0);
  k.solid.frame(0, 0, 0);
}
