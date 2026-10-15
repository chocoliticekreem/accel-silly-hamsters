// OSM footprints arrive as axis-aligned bounding boxes, and neighbouring boxes overlap, so walls
// (with their windows) ran through each other. resolveOverlaps trims each overlap once, at map load:
// the less important / smaller box is cut back along the axis that loses the least area. Shops, clubs
// and the station are never cut (their facades carry data); a box that would become a sliver is dropped.
import type { Building, Street } from "../api/contract";
import { frontage } from "./geometry";

/** Pavement kept between a shop's facade and the carriageway (door staff, queues, the door glow stand there). */
export const MIN_PAVEMENT = 1.8;

/**
 * Metres from the box centre (b.x, b.z), along the unit normal (nx, nz) toward its street (contract coords), to the
 * nearest kerb: the first point on that ray inside any street's carriageway (centre line ± width / 2). Infinity when
 * the ray meets no street within 60 m.
 */
export function kerbDistance(b: Pick<Building, "x" | "z">, nx: number, nz: number, streets: Street[]): number {
  const near: [number, number, number, number, number][] = [];
  for (const s of streets)
    for (let i = 1; i < s.points.length; i++) {
      const [ax, az] = s.points[i - 1];
      const [bx, bz] = s.points[i];
      if (Math.max(ax, bx) < b.x - 70 || Math.min(ax, bx) > b.x + 70 || Math.max(az, bz) < b.z - 70 || Math.min(az, bz) > b.z + 70) continue;
      near.push([ax, az, bx, bz, s.width / 2]);
    }
  for (let t = 0; t <= 60; t += 0.25) {
    const x = b.x + nx * t;
    const z = b.z + nz * t;
    for (const [ax, az, bx, bz, hw] of near) {
      const dx = bx - ax;
      const dz = bz - az;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * k - x, az + dz * k - z) < hw) return t;
    }
  }
  return Infinity;
}

/**
 * Shop and club boxes must stand on their building, not on the road: a box whose street-facing side reaches into
 * the carriageway (or leaves less than MIN_PAVEMENT of pavement) is cut back from that side, keeping its back wall;
 * one too shallow to cut (under 4 m left) is moved back whole for the rest.
 */
export function clearCarriageways(buildings: Building[], streets: Street[]): Building[] {
  if (!streets.length) return buildings;
  return buildings.map((b) => {
    if (b.kind !== "store" && b.kind !== "club") return b;
    const f = frontage(b, streets);
    const half = f.nx !== 0 ? b.w / 2 : b.d / 2;
    const over = half + MIN_PAVEMENT - kerbDistance(b, f.nx, f.nz, streets);
    if (!(over > 0.05)) return b;
    const depth = half * 2;
    const keep = Math.max(4, depth - over);
    const cut = depth - keep; // shrunk from the front
    const shift = Math.max(0, over - cut); // and moved back by what shrinking can't take
    const move = cut / 2 + shift;
    const m = { ...b, x: b.x - f.nx * move, z: b.z - f.nz * move };
    if (f.nx !== 0) m.w = keep;
    else m.d = keep;
    return m;
  });
}

/** Gap left between trimmed boxes so faces are never coplanar (no z-fighting). */
const GAP = 0.15;
const MIN_SIDE = 3;

const fixedKind = (b: Building) => b.kind === "store" || b.kind === "club" || b.kind === "station";

const lo = (c: number, s: number) => c - s / 2;
const hi = (c: number, s: number) => c + s / 2;

function overlap1(ac: number, as: number, bc: number, bs: number) {
  return Math.max(0, Math.min(hi(ac, as), hi(bc, bs)) - Math.max(lo(ac, as), lo(bc, bs)));
}

export function overlapArea(a: Building, b: Building): number {
  return overlap1(a.x, a.w, b.x, b.w) * overlap1(a.z, a.d, b.z, b.d);
}

/** Cut `m` (mutable) out of `k` (kept) along x or z, whichever keeps more of m. Returns false if m vanishes. */
function cut(m: Building, k: Building): boolean {
  const options: Building[] = [];
  // shrink m on x: keep its part left or right of k
  const leftX = [lo(m.x, m.w), lo(k.x, k.w) - GAP];
  const rightX = [hi(k.x, k.w) + GAP, hi(m.x, m.w)];
  const leftZ = [lo(m.z, m.d), lo(k.z, k.d) - GAP];
  const rightZ = [hi(k.z, k.d) + GAP, hi(m.z, m.d)];
  for (const [a, c] of [leftX, rightX]) if (c - a >= MIN_SIDE) options.push({ ...m, x: (a + c) / 2, w: c - a });
  for (const [a, c] of [leftZ, rightZ]) if (c - a >= MIN_SIDE) options.push({ ...m, z: (a + c) / 2, d: c - a });
  if (!options.length) return false;
  const best = options.reduce((p, q) => (q.w * q.d > p.w * p.d ? q : p));
  m.x = best.x;
  m.z = best.z;
  m.w = best.w;
  m.d = best.d;
  return true;
}

export function resolveOverlaps(buildings: Building[]): Building[] {
  const out = buildings.map((b) => ({ ...b }));
  const dropped = new Set<number>();
  // important / bigger boxes first: they keep their footprint, later ones are trimmed against them
  const order = out.map((_, i) => i).sort((i, j) => Number(fixedKind(out[j])) - Number(fixedKind(out[i])) || out[j].w * out[j].d - out[i].w * out[i].d);
  const placed: number[] = [];
  for (const i of order) {
    const m = out[i];
    let alive = true;
    // a few passes: trimming against one neighbour can push into another
    for (let pass = 0; pass < 4 && alive; pass++) {
      let clean = true;
      for (const j of placed) {
        if (overlapArea(m, out[j]) <= 1e-6) continue;
        clean = false;
        if (fixedKind(m) && fixedKind(out[j])) continue; // two data buildings: leave as is
        if (fixedKind(m)) {
          // shouldn't happen given the order, but never cut a shop: cut the other one
          if (!cut(out[j], m)) dropped.add(j);
        } else if (!cut(m, out[j])) {
          alive = false;
          break;
        }
      }
      if (clean) break;
    }
    if (alive) placed.push(i);
    else dropped.add(i);
  }
  return out.filter((_, i) => !dropped.has(i));
}

/**
 * Generic boxes must not stand inside a hero landmark: `skip` ids (the landmark's own host buildings) are dropped,
 * and any other box overlapping a keep-out rect (contract x0..x1, z0..z1) is cut back with the same rule as
 * resolveOverlaps (keep the larger side), or dropped when only a sliver would remain.
 */
export function clearKeepouts(buildings: Building[], rects: { x0: number; x1: number; z0: number; z1: number }[], skip: Set<string>): Building[] {
  const out: Building[] = [];
  for (const b of buildings) {
    if (skip.has(b.id)) continue;
    const m = { ...b };
    let alive = true;
    for (let pass = 0; pass < 3 && alive; pass++) {
      let clean = true;
      for (const r of rects) {
        const k: Building = { ...m, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 };
        if (overlapArea(m, k) <= 1e-6) continue;
        clean = false;
        if (!cut(m, k)) {
          alive = false;
          break;
        }
      }
      if (clean) break;
    }
    if (alive) out.push(m);
  }
  return out;
}
