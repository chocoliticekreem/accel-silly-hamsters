// Which part of a shop's street-facing facade is actually open to the street.
// OSM footprints arrive as axis-aligned bounding boxes, and neighbouring boxes overlap: a neighbour whose box
// reaches further toward the street covers part of this shop's facade. Anything we hang on that stretch (lit glass,
// awning, OPEN sign) would sit inside the neighbour's wall and glow through it. So: project every other footprint
// that pokes out past the facade plane onto the facade, and keep the uncovered spans.
// Contract coords (x east, z north). Spans are in the shop's local facade axis u (metres from the facade centre,
// along the tangent (-nz, nx): the same axis as local +x of a group rotated to face (nx, nz), see Stores).
import type { Building } from "../api/contract";

export interface Span {
  from: number;
  to: number;
}

/** How far in front of the facade a neighbour must not reach (the awning's depth plus a little). */
export const AWNING_REACH = 2.8;
/** A neighbour must poke out past the facade by more than this to count (flush terraces don't). */
const FLUSH = 0.05;

/**
 * Uncovered spans of building `b`'s facade facing (nx, nz) (one of the four axis directions), widest first.
 * `others` may include `b` itself (it is skipped by id).
 */
export function facadeFreeSpans(b: Building, nx: number, nz: number, others: readonly Building[], reach = AWNING_REACH): Span[] {
  const horizontal = nx !== 0;
  const half = (horizontal ? b.d : b.w) / 2;
  // facade plane (along the normal axis) and the strip in front of it
  const plane = horizontal ? b.x + (nx * b.w) / 2 : b.z + (nz * b.d) / 2;
  const sign = horizontal ? nx : nz;
  const centre = horizontal ? b.z : b.x;
  // local u = tangent · (p - centre); tangent = (-nz, nx), so u = nx·(z - cz) for E/W facades, -nz·(x - cx) for N/S
  const uSign = horizontal ? nx : -nz;

  const covered: Span[] = [];
  for (const o of others) {
    if (o.id === b.id) continue;
    // o's extent along the normal axis, measured outward from the facade plane
    const oLo = horizontal ? o.x - o.w / 2 : o.z - o.d / 2;
    const oHi = horizontal ? o.x + o.w / 2 : o.z + o.d / 2;
    const out0 = sign > 0 ? oLo - plane : plane - oHi;
    const out1 = sign > 0 ? oHi - plane : plane - oLo;
    if (out1 <= FLUSH || out0 >= reach) continue;
    // o's extent along the facade
    const tLo = (horizontal ? o.z - o.d / 2 : o.x - o.w / 2) - centre;
    const tHi = (horizontal ? o.z + o.d / 2 : o.x + o.w / 2) - centre;
    const a = Math.max(-half, Math.min(uSign * tLo, uSign * tHi));
    const c = Math.min(half, Math.max(uSign * tLo, uSign * tHi));
    if (c > a) covered.push({ from: a, to: c });
  }
  covered.sort((p, q) => p.from - q.from);
  const free: Span[] = [];
  let cur = -half;
  for (const c of covered) {
    if (c.from > cur) free.push({ from: cur, to: c.from });
    cur = Math.max(cur, c.to);
  }
  if (cur < half) free.push({ from: cur, to: half });
  return free.sort((p, q) => q.to - q.from - (p.to - p.from));
}

/** Where the shop window goes: the widest free span, shrunk by `margin` each side; null if under `minWidth`. */
export function shopfrontSpan(b: Building, nx: number, nz: number, others: readonly Building[], margin = 0.4, minWidth = 2.2): { centre: number; width: number } | null {
  const best = facadeFreeSpans(b, nx, nz, others)[0];
  if (!best) return null;
  const width = best.to - best.from - margin * 2;
  if (width < minWidth) return null;
  return { centre: (best.from + best.to) / 2, width };
}
