// OSM footprints arrive as axis-aligned bounding boxes, and neighbouring boxes overlap, so walls
// (with their windows) ran through each other. resolveOverlaps trims each overlap once, at map load:
// the less important / smaller box is cut back along the axis that loses the least area. Shops, clubs
// and the station are never cut (their facades carry data); a box that would become a sliver is dropped.
import type { Building } from "../api/contract";

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
