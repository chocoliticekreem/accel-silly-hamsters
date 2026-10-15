// Flat ground geometry for the real city (land, pavements, carriageways, markings, ballast) and the "painter" layering
// that keeps it free of z-fighting at any distance.
//
// Ground layers are all (nearly) coplanar, so instead of separating them by height they are drawn first, in a fixed
// order (renderOrder), without writing depth: each layer simply paints over the previous one (base → land → paving →
// asphalt → markings), like a map. A final colourless pass writes the ground's depth so everything standing on it
// (buildings, people, cars) is depth-tested as usual. Within one mesh, later triangles paint over earlier ones.
import { BufferAttribute, BufferGeometry, Color, MeshStandardMaterial, ShapeUtils, Vector2 } from "three";
import type { P } from "./data";

// All between -1 and 0: after a basement pit (Landmarks, renderOrder -3) and its punch plane (-1), so the pit shows
// through the street only inside its opening, and before everything else (0).
export const LAYER = {
  base: -0.95,
  land: -0.9,
  paving: -0.85,
  asphalt: -0.8,
  islands: -0.78,
  ballast: -0.76,
  markings: -0.7,
  depth: -0.5,
} as const;

/** A material for one painter layer (vertex coloured, no depth write). */
export function layerMaterial(roughness = 0.95): MeshStandardMaterial {
  return new MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0, depthWrite: false });
}

export class FlatBuilder {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  get nv() {
    return this.pos.length / 3;
  }
  v(x: number, y: number, z: number, c: Color) {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    return this.nv - 1;
  }
  /** Up-facing triangle (scene frame: counter-clockwise seen from above is (a, c, b) when z points south). */
  tri(a: number, b: number, c: number) {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vz = p[c * 3 + 2] - p[a * 3 + 2];
    // y component of (b - a) × (c - a) = uz * vx - ux * vz; must be > 0 to face up
    if (uz * vx - ux * vz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
  quad(a: P, b: P, c: P, d: P, y: number, col: Color) {
    const i0 = this.v(a[0], y, a[1], col);
    const i1 = this.v(b[0], y, b[1], col);
    const i2 = this.v(c[0], y, c[1], col);
    const i3 = this.v(d[0], y, d[1], col);
    this.tri(i0, i1, i2);
    this.tri(i0, i2, i3);
  }
  disc(x: number, z: number, r: number, y: number, col: Color, seg = 10) {
    const c = this.v(x, y, z, col);
    const first = this.nv;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      this.v(x + Math.cos(a) * r, y, z + Math.sin(a) * r, col);
    }
    for (let k = 0; k < seg; k++) this.tri(c, first + k, first + ((k + 1) % seg));
  }
  polygon(rings: P[][], y: number, col: Color) {
    const v = (r: P[]) => r.map(([x, z]) => new Vector2(x, z));
    let faces: number[][] = [];
    try {
      faces = ShapeUtils.triangulateShape(v(rings[0]), rings.slice(1).map(v));
    } catch {
      return;
    }
    const base = this.nv;
    for (const r of rings) for (const [x, z] of r) this.v(x, y, z, col);
    for (const [a, b, c] of faces) this.tri(base + a, base + b, base + c);
  }
  /** Straight strip from a to b, half width hw. */
  strip(a: P, b: P, hw: number, y: number, col: Color) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) return;
    const nx = (-dz / l) * hw;
    const nz = (dx / l) * hw;
    this.quad([a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz], y, col);
  }
  /** Polyline ribbon: a strip per segment and round joins / caps. */
  ribbon(pts: P[], hw: number, y: number, col: Color, caps = true) {
    for (let i = 0; i < pts.length - 1; i++) this.strip(pts[i], pts[i + 1], hw, y, col);
    const seg = hw > 4 ? 12 : 8;
    for (let i = 0; i < pts.length; i++) {
      const end = i === 0 || i === pts.length - 1;
      if (end) {
        if (caps) this.disc(pts[i][0], pts[i][1], hw, y, col, seg);
        continue;
      }
      // joins only where the line actually turns (a straight-through vertex needs no fill)
      const ax = pts[i][0] - pts[i - 1][0], az = pts[i][1] - pts[i - 1][1];
      const bx = pts[i + 1][0] - pts[i][0], bz = pts[i + 1][1] - pts[i][1];
      const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
      if (cos < 0.995) this.disc(pts[i][0], pts[i][1], hw, y, col, seg);
    }
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    const n = new Float32Array(this.pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute("normal", new BufferAttribute(n, 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.nv > 65535 ? new BufferAttribute(new Uint32Array(this.idx), 1) : new BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Point at distance `off` to the left (scene: (dz, -dx) side) of a polyline at each vertex, mitred and clamped. */
export function offsetLine(pts: P[], off: number): P[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const prev = i > 0 ? pts[i - 1] : p;
    const next = i < n - 1 ? pts[i + 1] : p;
    let d1x = p[0] - prev[0], d1z = p[1] - prev[1];
    let d2x = next[0] - p[0], d2z = next[1] - p[1];
    const l1 = Math.hypot(d1x, d1z);
    const l2 = Math.hypot(d2x, d2z);
    if (l1 < 1e-6) (d1x = d2x), (d1z = d2z);
    if (l2 < 1e-6) (d2x = d1x), (d2z = d1z);
    const L1 = Math.hypot(d1x, d1z) || 1;
    const L2 = Math.hypot(d2x, d2z) || 1;
    const n1x = d1z / L1, n1z = -d1x / L1;
    const n2x = d2z / L2, n2z = -d2x / L2;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) {
      mx = n1x;
      mz = n1z;
    } else {
      mx /= ml;
      mz /= ml;
    }
    const cos = Math.max(0.5, mx * n1x + mz * n1z);
    return [p[0] + (mx * off) / cos, p[1] + (mz * off) / cos];
  });
}

/** Uniform grid of segments for "is this point on another road's carriageway?" queries. */
export class SegGrid {
  private cells = new Map<number, number[]>();
  segs: { ax: number; az: number; bx: number; bz: number; hw: number; road: number; dx: number; dz: number }[] = [];
  constructor(private cell = 30) {}
  private key(i: number, j: number) {
    return (i + 5000) * 10000 + (j + 5000);
  }
  add(a: P, b: P, hw: number, road: number) {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const s = { ax: a[0], az: a[1], bx: b[0], bz: b[1], hw, road, dx: (b[0] - a[0]) / l, dz: (b[1] - a[1]) / l };
    const id = this.segs.push(s) - 1;
    const c = this.cell;
    const i0 = Math.floor((Math.min(a[0], b[0]) - hw) / c);
    const i1 = Math.floor((Math.max(a[0], b[0]) + hw) / c);
    const j0 = Math.floor((Math.min(a[1], b[1]) - hw) / c);
    const j1 = Math.floor((Math.max(a[1], b[1]) + hw) / c);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        const list = this.cells.get(k);
        if (list) list.push(id);
        else this.cells.set(k, [id]);
      }
  }
  /**
   * True if (x, z) lies on the carriageway of a road other than `self` that runs across direction (dx, dz)
   * (more than ~25° off it): a junction mouth. Continuations and parallel ways don't count.
   */
  crossing(x: number, z: number, self: number, dx: number, dz: number, margin = 0.1): boolean {
    const list = this.cells.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!list) return false;
    for (const id of list) {
      const s = this.segs[id];
      if (s.road === self) continue;
      if (Math.abs(s.dx * dx + s.dz * dz) > 0.9) continue;
      const ex = s.bx - s.ax;
      const ez = s.bz - s.az;
      const l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / l2));
      const d = Math.hypot(x - s.ax - ex * t, z - s.az - ez * t);
      if (d < s.hw - margin) return true;
    }
    return false;
  }
}

/** Walks a polyline in pieces of at most `step` metres: (a, b, unit direction). */
export function* pieces(pts: P[], step: number): Generator<[P, P, number, number]> {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) continue;
    const n = Math.max(1, Math.ceil(L / step));
    const dx = (bx - ax) / L;
    const dz = (bz - az) / L;
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      yield [[ax + (bx - ax) * t0, az + (bz - az) * t0], [ax + (bx - ax) * t1, az + (bz - az) * t1], dx, dz];
    }
  }
}

/** Dash pattern along a polyline: yields dash segments (dash on, gap off), continuing the phase across vertices. */
export function* dashes(pts: P[], on: number, off: number): Generator<[P, P, number, number]> {
  let phase = off / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) continue;
    const dx = (bx - ax) / L;
    const dz = (bz - az) / L;
    let s = 0;
    while (s < L) {
      const period = on + off;
      const p = phase % period;
      if (p < on) {
        const len = Math.min(on - p, L - s);
        yield [[ax + dx * s, az + dz * s], [ax + dx * (s + len), az + dz * (s + len)], dx, dz];
        s += len;
        phase += len;
      } else {
        const len = Math.min(period - p, L - s);
        s += len;
        phase += len;
      }
    }
  }
}
