// Real building footprints → merged three.js geometry (walls with window layout, flat roofs with parapets, gabled /
// hipped / pyramidal / skillion roofs where OSM tags them). Pure: no React, no scene. Scene frame (x east, z south).
//
// Merging: buildings are grouped into square chunks (frustum culling still works, a few dozen draw calls for the whole
// city); each building's vertex range is recorded so a single building can be hidden later (a hero model or an open
// interior replacing it) by collapsing its vertices, without rebuilding anything.
import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2 } from "three";
import type { P, RealBuilding } from "./data";

export const CHUNK = 450;

/** Growable typed arrays for one merged mesh. */
export class MeshBuilder {
  pos = new Float32Array(1 << 14);
  nor = new Float32Array(1 << 14);
  col = new Float32Array(1 << 14);
  win = new Float32Array(1 << 15);
  idx = new Uint32Array(1 << 14);
  nv = 0;
  ni = 0;
  private grow<T extends Float32Array | Uint32Array>(a: T, need: number): T {
    if (need <= a.length) return a;
    let n = a.length;
    while (n < need) n *= 2;
    const b = new (a.constructor as { new (n: number): T })(n);
    b.set(a);
    return b;
  }
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Color, u: number, v: number, s: number, rows: number) {
    const i = this.nv++;
    this.pos = this.grow(this.pos, this.nv * 3);
    this.nor = this.grow(this.nor, this.nv * 3);
    this.col = this.grow(this.col, this.nv * 3);
    this.win = this.grow(this.win, this.nv * 4);
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.nor[i * 3] = nx;
    this.nor[i * 3 + 1] = ny;
    this.nor[i * 3 + 2] = nz;
    this.col[i * 3] = c.r;
    this.col[i * 3 + 1] = c.g;
    this.col[i * 3 + 2] = c.b;
    this.win[i * 4] = u;
    this.win[i * 4 + 1] = v;
    this.win[i * 4 + 2] = s;
    this.win[i * 4 + 3] = rows;
    return i;
  }
  /** Triangle whose front face points along (nx, ny, nz) (winding fixed up from the positions). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number) {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    this.idx = this.grow(this.idx, this.ni + 3);
    const flip = cx * nx + cy * ny + cz * nz < 0;
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = flip ? c : b;
    this.idx[this.ni++] = flip ? b : c;
  }
  /** Trimmed copies of the arrays (each with its own buffer, so they can be transferred out of a worker). */
  arrays() {
    return {
      pos: this.pos.slice(0, this.nv * 3),
      nor: this.nor.slice(0, this.nv * 3),
      col: this.col.slice(0, this.nv * 3),
      win: this.win.slice(0, this.nv * 4),
      idx: this.idx.slice(0, this.ni),
    };
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(this.pos.slice(0, this.nv * 3), 3));
    g.setAttribute("normal", new BufferAttribute(this.nor.slice(0, this.nv * 3), 3));
    g.setAttribute("color", new BufferAttribute(this.col.slice(0, this.nv * 3), 3));
    g.setAttribute("aWin", new BufferAttribute(this.win.slice(0, this.nv * 4), 4));
    g.setIndex(new BufferAttribute(this.idx.slice(0, this.ni), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- appearance
const BRICK = ["#9c8462", "#8f7656", "#a88d66", "#87543f", "#7b4836", "#94604a", "#b49c76", "#6e4434", "#a1866a", "#c9bea6"];
const OFFICE = ["#c8c1b2", "#a9adb0", "#8ea0b0", "#6f8191", "#d5d0c5", "#5d646b", "#b7b1a4", "#9aa6ae"];
const INDUSTRIAL = ["#7a4536", "#6f6660", "#84503d", "#5d5450", "#8b5a45"];
const MATERIAL_COLOUR: Record<string, string[]> = {
  brick: ["#9c8462", "#87543f", "#7b4836", "#a88d66"],
  stone: ["#cfc6b2", "#bfb59f"],
  sandstone: ["#c9b48a"],
  limestone: ["#d8d0bd"],
  concrete: ["#a7a39a", "#9a978f"],
  glass: ["#7f97ab", "#6c8497", "#8aa3b6"],
  metal: ["#8d939a", "#757b82"],
  steel: ["#8d939a"],
  wood: ["#8a6a4a"],
  plaster: ["#e0d9c9", "#d6cdb8"],
  render: ["#e2dccd", "#d9d2c0"],
};
// type codes (bake-city.mjs TYPES)
const T = { yes: 0, house: 1, terrace: 2, residential: 3, apartments: 4, commercial: 5, office: 6, retail: 7, industrial: 8, warehouse: 9, church: 10, school: 11, university: 12, hotel: 13, station: 14, roof: 17, garage: 18, shed: 19, construction: 20, kiosk: 26 };

export const STYLE = { brick: 0, office: 1, glass: 2, industrial: 3, viaduct: 5, shop: 8 } as const;

export interface Look {
  wall: Color;
  roof: Color;
  style: number;
  /** Width of one window cell (m) and floor height. */
  cell: number;
  floorH: number;
}

const pick = (a: string[], k: number) => a[Math.floor(k * a.length) % a.length];

export function lookOf(b: RealBuilding, materials: string[]): Look {
  const k = hashStr(b.id);
  const mat = materials[b.material] ?? "";
  const tall = b.h >= 24;
  let style: number = STYLE.brick;
  let palette = BRICK;
  if (mat === "glass") (style = STYLE.glass), (palette = MATERIAL_COLOUR.glass);
  else if (mat === "metal" || mat === "steel" || mat === "concrete") (style = STYLE.office), (palette = MATERIAL_COLOUR[mat]);
  else if (mat && MATERIAL_COLOUR[mat]) (style = mat === "brick" ? STYLE.brick : STYLE.office), (palette = MATERIAL_COLOUR[mat]);
  else if (b.type === T.industrial || b.type === T.warehouse) (style = STYLE.industrial), (palette = INDUSTRIAL);
  else if (b.type === T.office || b.type === T.hotel || b.type === T.university || tall) {
    style = b.h > 40 && k < 0.6 ? STYLE.glass : STYLE.office;
    palette = style === STYLE.glass ? MATERIAL_COLOUR.glass : OFFICE;
  } else if (b.type === T.commercial && b.h > 15) (style = STYLE.office), (palette = OFFICE);
  const wall = new Color(b.wall ? `#${b.wall}` : pick(palette, k));
  // a little variety between neighbours
  wall.multiplyScalar(0.92 + hashStr(b.id + "v") * 0.16);
  const shop = !b.outer && !b.part && b.h < 22 && (b.type === T.retail || b.type === T.commercial || (b.type === T.yes && k < 0.4));
  if (shop && style !== STYLE.glass) style += STYLE.shop;
  // roofs: the imagery colour (satellite roofs read dark: lift them), else a slate / felt grey
  const roof = new Color(b.roofColour ? `#${b.roofColour}` : b.roof ? "#5d6168" : "#7b7d80");
  if (b.roofColour) {
    const hsl = { h: 0, s: 0, l: 0 };
    roof.getHSL(hsl);
    roof.setHSL(hsl.h, Math.min(0.35, hsl.s * 0.8), Math.min(0.72, 0.1 + hsl.l * 1.05));
  }
  const cell = style % 8 === STYLE.glass ? 1.6 : style % 8 === STYLE.office ? 1.9 : style % 8 === STYLE.industrial ? 3.4 : 2.7;
  const roofSpace = b.roof ? b.roofH : 0;
  const lv = b.levels > 0 ? b.levels : 0;
  const floorH = lv ? Math.min(4.6, Math.max(2.7, (b.h - roofSpace) / lv)) : style % 8 === STYLE.brick ? 3.2 : 3.6;
  return { wall, roof, style, cell, floorH };
}

// ---------------------------------------------------------------- roofs
interface Plane {
  /** height = c + gx * x + gz * z (above the eave) */
  c: number;
  gx: number;
  gz: number;
}
const planeAt = (p: Plane, x: number, z: number) => p.c + p.gx * x + p.gz * z;

/** Oriented bounding box of the outer ring: centre, long axis unit vector, half length / half width. */
function obb(r: P[]) {
  let best = { area: Infinity, cx: 0, cz: 0, ux: 1, uz: 0, L: 0, W: 0 };
  for (let i = 0; i < r.length; i++) {
    const j = (i + 1) % r.length;
    const dx = r[j][0] - r[i][0];
    const dz = r[j][1] - r[i][1];
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const ux = dx / len;
    const uz = dz / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of r) {
      const a = x * ux + z * uz;
      const b = -x * uz + z * ux;
      if (a < a0) a0 = a;
      if (a > a1) a1 = a;
      if (b < b0) b0 = b;
      if (b > b1) b1 = b;
    }
    const area = (a1 - a0) * (b1 - b0);
    if (area < best.area) {
      const ca = (a0 + a1) / 2;
      const cb = (b0 + b1) / 2;
      const long = a1 - a0 >= b1 - b0;
      best = {
        area,
        cx: ca * ux - cb * uz,
        cz: ca * uz + cb * ux,
        ux: long ? ux : -uz,
        uz: long ? uz : ux,
        L: Math.max(a1 - a0, b1 - b0) / 2,
        W: Math.min(a1 - a0, b1 - b0) / 2,
      };
    }
  }
  return best;
}

/** Roof planes (min of them = the roof surface) for OSM roof:shape codes; null = flat. */
function roofPlanes(b: RealBuilding): Plane[] | null {
  const shape = b.roof; // 0 flat 1 gabled 2 hipped 3 pyramidal 4 skillion 5 dome 6 round 7 mansard 8 gambrel 9 onion 10 half-hipped 11 saltbox
  if (!shape || b.rings.length > 1 || b.roofH < 0.4) return null;
  const o = obb(b.rings[0]);
  if (o.W < 1) return null;
  const rh = b.roofH;
  const plane = (c0: number, ax: number, az: number, slope: number): Plane => ({
    // h = rh * (c0 + slope * ((x - cx) * ax + (z - cz) * az))
    c: rh * (c0 - slope * (o.cx * ax + o.cz * az)),
    gx: rh * slope * ax,
    gz: rh * slope * az,
  });
  const wx = -o.uz;
  const wz = o.ux;
  const gable = [plane(1, wx, wz, -1 / o.W), plane(1, wx, wz, 1 / o.W)];
  const hipEnds = [plane(o.L / o.W, o.ux, o.uz, -1 / o.W), plane(o.L / o.W, o.ux, o.uz, 1 / o.W)];
  switch (shape) {
    case 1:
    case 6:
    case 8:
    case 11:
      return gable;
    case 2:
    case 7:
    case 10:
      return [...gable, ...hipEnds];
    case 3:
    case 5:
    case 9:
      return [plane(1, o.ux, o.uz, -1 / o.L), plane(1, o.ux, o.uz, 1 / o.L), ...gable];
    case 4:
      return [plane(0.5, wx, wz, -0.5 / o.W)];
    default:
      return null;
  }
}

const roofAt = (planes: Plane[], x: number, z: number) => {
  let m = Infinity;
  for (const p of planes) m = Math.min(m, planeAt(p, x, z));
  return Math.max(0, m);
};

/** Sutherland–Hodgman: keep the part of ring r where f(x, z) <= 0 (f linear). */
function clipHalf(r: P[], f: (x: number, z: number) => number): P[] {
  const out: P[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    const fa = f(a[0], a[1]);
    const fb = f(b[0], b[1]);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function triangulate(outer: P[], holes: P[][]): number[][] {
  const v = (r: P[]) => r.map(([x, z]) => new Vector2(x, z));
  try {
    return ShapeUtils.triangulateShape(v(outer), holes.map(v));
  } catch {
    return [];
  }
}

/** Inward offset of a CCW ring by d (miter, clamped). */
function inset(r: P[], d: number): P[] {
  const n = r.length;
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = r[(i - 1 + n) % n];
    const b = r[i];
    const c = r[(i + 1) % n];
    let d1x = b[0] - a[0], d1z = b[1] - a[1];
    let d2x = c[0] - b[0], d2z = c[1] - b[1];
    const l1 = Math.hypot(d1x, d1z) || 1;
    const l2 = Math.hypot(d2x, d2z) || 1;
    d1x /= l1; d1z /= l1; d2x /= l2; d2z /= l2;
    // inward normals of a CCW ring: (-dz, dx)
    const n1x = -d1z, n1z = d1x, n2x = -d2z, n2z = d2x;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) (mx = n1x), (mz = n1z);
    else (mx /= ml), (mz /= ml);
    const cos = Math.max(0.35, mx * n1x + mz * n1z);
    out.push([b[0] + (mx * d) / cos, b[1] + (mz * d) / cos]);
  }
  return out;
}

// ---------------------------------------------------------------- one building
const UP: [number, number, number] = [0, 1, 0];

/** Appends one building to the builder. Returns nothing; the caller records the vertex range. */
export function addBuilding(mb: MeshBuilder, b: RealBuilding, look: Look, opts: { parapet: boolean }) {
  const seed = hashStr(b.id) * 0.98;
  const style = look.style + seed;
  // tiny per-building lift so roofs of touching buildings at the same height never share a plane
  const lift = hashStr(b.id + "h") * 0.06;
  const planes = roofPlanes(b);
  const eave = (planes ? b.h - b.roofH : b.h) + lift;
  const y0 = b.minH;
  const small = b.area < 18 || b.type === T.roof || b.type === T.garage || b.type === T.shed || b.type === T.kiosk;
  const rows = small ? 0 : Math.max(0, Math.floor((eave - 0.3) / look.floorH));
  const parapet = !planes && opts.parapet && !small && eave - y0 > 4.5 && b.area > 35 && b.rings.length === 1 ? 0.75 : 0;
  const wallTop = eave + parapet;

  // walls
  for (const r of b.rings) {
    const n = r.length;
    for (let i = 0; i < n; i++) {
      const a = r[i];
      const c = r[(i + 1) % n];
      const dx = c[0] - a[0];
      const dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = dz / len;
      const nz = -dx / len;
      const cells = Math.floor(len / look.cell);
      // break points along the edge where the roof profile kinks (pitched roofs)
      const ts = [0, 1];
      if (planes)
        for (let p = 0; p < planes.length; p++)
          for (let q2 = p + 1; q2 < planes.length; q2++) {
            const fa = planeAt(planes[p], a[0], a[1]) - planeAt(planes[q2], a[0], a[1]);
            const fb = planeAt(planes[p], c[0], c[1]) - planeAt(planes[q2], c[0], c[1]);
            if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) ts.push(fa / (fa - fb));
          }
      ts.sort((x, y) => x - y);
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k];
        const t1 = ts[k + 1];
        if (t1 - t0 < 1e-4) continue;
        const ax = a[0] + dx * t0, az = a[1] + dz * t0;
        const bx = a[0] + dx * t1, bz = a[1] + dz * t1;
        const ha = planes ? eave + roofAt(planes, ax, az) : wallTop;
        const hb = planes ? eave + roofAt(planes, bx, bz) : wallTop;
        const ua = cells ? cells * t0 : 0;
        const ub = cells ? cells * t1 : 0;
        const fh = look.floorH;
        const v0 = mb.vert(ax, y0, az, nx, 0, nz, look.wall, ua, y0 / fh, style, rows);
        const v1 = mb.vert(bx, y0, bz, nx, 0, nz, look.wall, ub, y0 / fh, style, rows);
        const v2 = mb.vert(bx, hb, bz, nx, 0, nz, look.wall, ub, hb / fh, style, rows);
        const v3 = mb.vert(ax, ha, az, nx, 0, nz, look.wall, ua, ha / fh, style, rows);
        mb.tri(v0, v1, v2, nx, 0, nz);
        mb.tri(v0, v2, v3, nx, 0, nz);
      }
    }
  }

  // roof
  if (planes) {
    const outer = b.rings[0];
    for (let p = 0; p < planes.length; p++) {
      let region = outer;
      for (let q2 = 0; q2 < planes.length && region.length >= 3; q2++) {
        if (q2 === p) continue;
        const P1 = planes[p];
        const P2 = planes[q2];
        // keep where P1 <= P2
        region = clipHalf(region, (x, z) => planeAt(P1, x, z) - planeAt(P2, x, z));
      }
      if (region.length < 3) continue;
      const pl = planes[p];
      const nl = Math.hypot(pl.gx, 1, pl.gz);
      const nx = -pl.gx / nl;
      const ny = 1 / nl;
      const nz = -pl.gz / nl;
      const base = region.map(([x, z]) => mb.vert(x, eave + Math.max(0, planeAt(pl, x, z)), z, nx, ny, nz, look.roof, 0, 0, style, 0));
      for (const [i0, i1, i2] of triangulate(region, [])) mb.tri(base[i0], base[i1], base[i2], nx, ny, nz);
    }
    return;
  }
  const top = b.rings.map((r) => r.map(([x, z]) => mb.vert(x, eave, z, 0, 1, 0, look.roof, 0, 0, style, 0)));
  const flat = top.flat();
  for (const [i0, i1, i2] of triangulate(b.rings[0], b.rings.slice(1))) mb.tri(flat[i0], flat[i1], flat[i2], ...UP);
  if (!parapet) return;
  // parapet: inner face and coping
  const r = b.rings[0];
  const inn = inset(r, 0.3);
  const coping = look.wall.clone().multiplyScalar(0.85);
  const n = r.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = inn[j][0] - inn[i][0];
    const dz = inn[j][1] - inn[i][1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    // facing into the roof
    const nx = -dz / len;
    const nz = dx / len;
    const a0 = mb.vert(inn[i][0], eave, inn[i][1], nx, 0, nz, coping, 0, 0, style, 0);
    const a1 = mb.vert(inn[j][0], eave, inn[j][1], nx, 0, nz, coping, 0, 0, style, 0);
    const a2 = mb.vert(inn[j][0], wallTop, inn[j][1], nx, 0, nz, coping, 0, 0, style, 0);
    const a3 = mb.vert(inn[i][0], wallTop, inn[i][1], nx, 0, nz, coping, 0, 0, style, 0);
    mb.tri(a0, a1, a2, nx, 0, nz);
    mb.tri(a0, a2, a3, nx, 0, nz);
    const c0 = mb.vert(r[i][0], wallTop, r[i][1], 0, 1, 0, coping, 0, 0, style, 0);
    const c1 = mb.vert(r[j][0], wallTop, r[j][1], 0, 1, 0, coping, 0, 0, style, 0);
    const c2 = mb.vert(inn[j][0], wallTop, inn[j][1], 0, 1, 0, coping, 0, 0, style, 0);
    const c3 = mb.vert(inn[i][0], wallTop, inn[i][1], 0, 1, 0, coping, 0, 0, style, 0);
    mb.tri(c0, c1, c2, ...UP);
    mb.tri(c0, c2, c3, ...UP);
  }
}

/** A vertical wall quad from pa to pb (bottoms ya0 / yb0, tops ya1 / yb1); v = height in metres (viaduct arches). */
export function addQuad(
  mb: MeshBuilder,
  pa: P,
  pb: P,
  ya0: number,
  yb0: number,
  ya1: number,
  yb1: number,
  n: [number, number, number],
  c: Color,
  u0: number,
  u1: number,
  style: number,
  rows: number,
) {
  const v0 = mb.vert(pa[0], ya0, pa[1], n[0], n[1], n[2], c, u0, ya0, style, rows);
  const v1 = mb.vert(pb[0], yb0, pb[1], n[0], n[1], n[2], c, u1, yb0, style, rows);
  const v2 = mb.vert(pb[0], yb1, pb[1], n[0], n[1], n[2], c, u1, yb1, style, rows);
  const v3 = mb.vert(pa[0], ya1, pa[1], n[0], n[1], n[2], c, u0, ya1, style, rows);
  mb.tri(v0, v1, v2, n[0], n[1], n[2]);
  mb.tri(v0, v2, v3, n[0], n[1], n[2]);
}
