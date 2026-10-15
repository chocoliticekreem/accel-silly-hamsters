// Road surface layout for the Streets module, without overlaps fighting each other.
// Real OSM ways overlap: dual carriageways drawn as two ways, parallel service roads, short link ways inside a
// junction, the same road split into several ways. Drawn naively every overlap is two coplanar asphalt strips and
// the centre dashes of one road run across the next road's junction. So:
//  - each road class (minor < 8 m, mid < 12 m, major) sits at its own small height: a wider road always draws on
//    top of a narrower one, never in the same plane;
//  - a segment that lies entirely inside a wider (or equal, earlier) street's carriageway isn't drawn at all;
//  - centre dashes stop where they would cross another street's carriageway (junctions), and only roads ≥ 8 m get them.
// Pure; contract coords (x east, z north).
import type { Street } from "../api/contract";

export type RoadClass = 0 | 1 | 2;
export const roadClass = (width: number): RoadClass => (width >= 12 ? 2 : width >= 8 ? 1 : 0);
/** Top of the asphalt for each class (m above the pavement slab at y = 0). */
export const ROAD_TOP: Record<RoadClass, number> = { 0: 0.1, 1: 0.13, 2: 0.16 };
export const MARKING_LIFT = 0.025;

export interface RoadPiece {
  street: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
  top: number;
}

export interface Dash {
  x: number;
  z: number;
  /** Unit direction along the road. */
  dx: number;
  dz: number;
  top: number;
}

interface Seg {
  street: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
}

const CELL = 40;

/** Segment index bucketed by grid cell, for "which streets are near this point". */
function index(streets: readonly Street[]) {
  const segs: Seg[] = [];
  streets.forEach((s, i) => {
    for (let k = 0; k < s.points.length - 1; k++) segs.push({ street: i, ax: s.points[k][0], az: s.points[k][1], bx: s.points[k + 1][0], bz: s.points[k + 1][1], half: s.width / 2 });
  });
  const grid = new Map<string, number[]>();
  segs.forEach((g, n) => {
    const pad = g.half + 2;
    const x0 = Math.floor((Math.min(g.ax, g.bx) - pad) / CELL);
    const x1 = Math.floor((Math.max(g.ax, g.bx) + pad) / CELL);
    const z0 = Math.floor((Math.min(g.az, g.bz) - pad) / CELL);
    const z1 = Math.floor((Math.max(g.az, g.bz) + pad) / CELL);
    for (let i = x0; i <= x1; i++)
      for (let j = z0; j <= z1; j++) {
        const key = `${i},${j}`;
        const list = grid.get(key);
        if (list) list.push(n);
        else grid.set(key, [n]);
      }
  });
  /** Calls fn(segment, distance) for every segment near (x, z). */
  const near = (x: number, z: number, fn: (g: Seg, d: number) => void) => {
    const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return;
    for (const n of list) {
      const g = segs[n];
      const dx = g.bx - g.ax;
      const dz = g.bz - g.az;
      const k = Math.max(0, Math.min(1, ((x - g.ax) * dx + (z - g.az) * dz) / (dx * dx + dz * dz || 1)));
      fn(g, Math.hypot(x - g.ax - dx * k, z - g.az - dz * k));
    }
  };
  return { segs, near };
}

export function roadLayout(streets: readonly Street[], dashLen = 4, dashGap = 5) {
  const { segs, near } = index(streets);
  const width = (i: number) => streets[i].width;
  /** Is (x, z) inside the carriageway of a street that outranks street i (wider, or as wide and listed earlier)? */
  const covered = (i: number, x: number, z: number, margin: number) => {
    let hit = false;
    near(x, z, (g, d) => {
      if (hit || g.street === i) return;
      const w = width(g.street);
      const outranks = w > width(i) || (w === width(i) && g.street < i);
      if (outranks && d < g.half - margin) hit = true;
    });
    return hit;
  };
  /** Is (x, z) on any other street's carriageway (plus `pad`)? */
  const onOther = (i: number, x: number, z: number, pad: number) => {
    let hit = false;
    near(x, z, (g, d) => {
      if (!hit && g.street !== i && d < g.half + pad) hit = true;
    });
    return hit;
  };

  const pieces: RoadPiece[] = [];
  for (const g of segs) {
    const i = g.street;
    const top = ROAD_TOP[roadClass(width(i))];
    const len = Math.hypot(g.bx - g.ax, g.bz - g.az);
    if (len < 0.05) continue;
    // hidden when every sample along it lies inside an outranking carriageway
    const n = Math.max(2, Math.ceil(len / 6));
    let hidden = true;
    for (let k = 0; k <= n && hidden; k++) {
      const t = k / n;
      if (!covered(i, g.ax + (g.bx - g.ax) * t, g.az + (g.bz - g.az) * t, Math.min(1, g.half * 0.25))) hidden = false;
    }
    if (hidden) continue;
    pieces.push({ street: i, ax: g.ax, az: g.az, bx: g.bx, bz: g.bz, width: width(i), top });
  }

  const dashes: Dash[] = [];
  for (const p of pieces) {
    if (p.width < 8) continue;
    const len = Math.hypot(p.bx - p.ax, p.bz - p.az);
    const dx = (p.bx - p.ax) / len;
    const dz = (p.bz - p.az) / len;
    const count = Math.floor(len / (dashLen + dashGap));
    for (let k = 0; k < count; k++) {
      const s = (k + 0.5) * (dashLen + dashGap) + (len - count * (dashLen + dashGap)) / 2;
      const x = p.ax + dx * s;
      const z = p.az + dz * s;
      // stop at junctions: no dash on (or within a metre of) another street's carriageway
      if (onOther(p.street, x - (dx * dashLen) / 2, z - (dz * dashLen) / 2, 1) || onOther(p.street, x + (dx * dashLen) / 2, z + (dz * dashLen) / 2, 1)) continue;
      dashes.push({ x, z, dx, dz, top: p.top + MARKING_LIFT });
    }
  }

  // round joints at polyline vertices (fill the notch where angled segments meet), at the street's own level
  const joints: { x: number; z: number; r: number; top: number }[] = [];
  streets.forEach((s, i) => {
    const top = ROAD_TOP[roadClass(s.width)];
    for (const [x, z] of s.points) if (!covered(i, x, z, 0)) joints.push({ x, z, r: s.width / 2, top });
  });
  return { pieces, dashes, joints };
}
