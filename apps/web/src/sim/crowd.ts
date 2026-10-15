// Crowd spacing for the people layers: keep figures on the pavement and out of each other.
//  - pavementPath: a route along street centre lines walked on the pavement (kerb = width/2, then an inset),
//    with corners and width changes blended so walkers glide round instead of jumping.
//  - createSeparator: one greedy pass over a spatial hash that steps each person clear of everyone placed
//    before them (O(n) per frame, no allocation). Earlier entries can be fixed obstacles that never move.
//  - obstacles: the sim agents' scene positions this frame, so the background crowd steps around them too.
import type { PathPoint } from "./polyline";

/** Pavement band beyond the kerb (metres): people walk 1–4 m out from the carriageway edge. */
export const PAVEMENT_INSET_MIN = 1;
export const PAVEMENT_INSET_MAX = 4;
/** Metres over which a corner (or a change of street width) is rounded off. */
const CORNER_BLEND = 6;

export interface PavementPath {
  length: number;
  /**
   * The point `s` metres along, on the `side` (+1 right of travel, -1 left) pavement, `inset` metres beyond the
   * kerb of whatever street that stretch is. Writes position and unit direction into `out`.
   */
  at(s: number, side: number, inset: number, out: PathPoint): PathPoint;
}

/** `widths[i]` is the carriageway width of the segment points[i] → points[i + 1]. */
export function pavementPath(points: [number, number][], widths: number[]): PavementPath {
  const m = Math.max(1, points.length - 1);
  const cum = new Float64Array(m + 1);
  const dx = new Float64Array(m);
  const dz = new Float64Array(m);
  const half = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = points[i];
    const b = points[Math.min(i + 1, points.length - 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum[i + 1] = cum[i] + len;
    dx[i] = len > 1e-9 ? (b[0] - a[0]) / len : 0;
    dz[i] = len > 1e-9 ? (b[1] - a[1]) / len : 1;
    half[i] = (widths[i] ?? 8) / 2;
  }
  const length = cum[m];
  const segLen = (i: number) => cum[i + 1] - cum[i];
  // blend radius at the start vertex of segment i (shared with the end of i - 1)
  const blendAt = (i: number) => Math.min(CORNER_BLEND, segLen(i - 1) / 2, segLen(i) / 2);

  // offset point on segment i's line (extrapolated past its ends when blending)
  let px = 0;
  let pz = 0;
  const onSeg = (i: number, d: number, side: number, inset: number) => {
    const k = d - cum[i];
    const off = side * (half[i] + inset);
    // right-hand normal of (dx, dz) in x-east/z-north coords is (dz, -dx)
    px = points[i][0] + dx[i] * k + dz[i] * off;
    pz = points[i][1] + dz[i] * k - dx[i] * off;
  };

  return {
    length,
    at(s, side, inset, out) {
      const d = Math.max(0, Math.min(length, s));
      let i = 0;
      while (i < m - 1 && cum[i + 1] < d) i++;
      onSeg(i, d, side, inset);
      let x = px;
      let z = pz;
      let ux = dx[i];
      let uz = dz[i];
      let j = -1;
      let w = 1; // weight of segment i
      if (i > 0 && d - cum[i] < blendAt(i)) {
        j = i - 1;
        w = 0.5 + (0.5 * (d - cum[i])) / (blendAt(i) || 1);
      } else if (i < m - 1 && cum[i + 1] - d < blendAt(i + 1)) {
        j = i + 1;
        w = 0.5 + (0.5 * (cum[i + 1] - d)) / (blendAt(i + 1) || 1);
      }
      if (j >= 0) {
        onSeg(j, d, side, inset);
        x = x * w + px * (1 - w);
        z = z * w + pz * (1 - w);
        ux = ux * w + dx[j] * (1 - w);
        uz = uz * w + dz[j] * (1 - w);
        const n = Math.hypot(ux, uz) || 1;
        ux /= n;
        uz /= n;
      }
      out.x = x;
      out.z = z;
      out.dx = ux;
      out.dz = uz;
      return out;
    },
  };
}

export interface Separator {
  /**
   * Moves people apart in place. Entries [0, fixed) are obstacles: they never move but others avoid them.
   * Every later entry is pushed (in order) until it is `minDist` from everyone before it, moving at most
   * `maxPush` metres from where it was asked to be. Returns how many entries were moved.
   */
  separate(xs: Float32Array, zs: Float32Array, n: number, minDist: number, opts?: { fixed?: number; maxPush?: number }): number;
}

export function createSeparator(capacity: number): Separator {
  let size = 1024;
  while (size < capacity * 2) size *= 2;
  const mask = size - 1;
  const head = new Int32Array(size);
  const next = new Int32Array(capacity);
  const seen = new Int32Array(capacity);
  let stamp = 0;
  const bucket = (cx: number, cz: number) => (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & mask;
  // per-frame state shared by the helpers below (no closures allocated per call)
  let xs: Float32Array = new Float32Array(0);
  let zs: Float32Array = new Float32Array(0);
  let gap = 1;
  let inv = 1;
  let pushX = 0;
  let pushZ = 0;

  /** Sum of the pushes needed to clear (x, z) of everyone already placed; returns how many it overlaps. */
  const overlaps = (x: number, z: number, self: number) => {
    stamp++;
    pushX = 0;
    pushZ = 0;
    let hits = 0;
    const cx = Math.floor(x * inv);
    const cz = Math.floor(z * inv);
    for (let ox = -1; ox <= 1; ox++)
      for (let oz = -1; oz <= 1; oz++)
        for (let j = head[bucket(cx + ox, cz + oz)]; j >= 0; j = next[j]) {
          if (seen[j] === stamp) continue; // hash collisions can list a person twice
          seen[j] = stamp;
          const ex = x - xs[j];
          const ez = z - zs[j];
          const d2 = ex * ex + ez * ez;
          if (d2 >= gap * gap) continue;
          hits++;
          const d = Math.sqrt(d2);
          if (d < 1e-6) {
            // exactly on top: a fixed, per-person direction (golden angle) so it is stable frame to frame
            const a = self * 2.399963;
            pushX += Math.cos(a) * gap;
            pushZ += Math.sin(a) * gap;
          } else {
            pushX += (ex / d) * (gap - d);
            pushZ += (ez / d) * (gap - d);
          }
        }
    return hits;
  };

  const insert = (i: number) => {
    const b = bucket(Math.floor(xs[i] * inv), Math.floor(zs[i] * inv));
    next[i] = head[b];
    head[b] = i;
  };

  return {
    separate(px, pz, n, minDist, opts = {}) {
      xs = px;
      zs = pz;
      gap = minDist;
      inv = 1 / minDist;
      const count = Math.min(n, capacity);
      const fixed = Math.min(opts.fixed ?? 0, count);
      const maxPush = opts.maxPush ?? Infinity;
      head.fill(-1);
      seen.fill(0);
      stamp = 0;
      let moved = 0;
      for (let i = 0; i < count; i++) {
        if (i < fixed) {
          insert(i);
          continue;
        }
        const x0 = xs[i];
        const z0 = zs[i];
        let x = x0;
        let z = z0;
        // relax: step out of every overlap at once, a few times (almost always done after one step)
        let clear = false;
        for (let pass = 0; pass < 4 && !clear; pass++) {
          if (overlaps(x, z, i) === 0) clear = true;
          else {
            x += pushX;
            z += pushZ;
          }
        }
        if (!clear && overlaps(x, z, i) > 0) {
          // pinched between several people: take the nearest free spot on rings around where they wanted to be
          search: for (let ring = 1; ring <= 3; ring++)
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * Math.PI * 2 + i * 0.7;
              const cx = x0 + Math.cos(a) * gap * ring * 0.75;
              const cz = z0 + Math.sin(a) * gap * ring * 0.75;
              if (overlaps(cx, cz, i) === 0) {
                x = cx;
                z = cz;
                break search;
              }
            }
        }
        const mx = x - x0;
        const mz = z - z0;
        const dist = Math.hypot(mx, mz);
        if (dist > maxPush) {
          x = x0 + (mx / dist) * maxPush;
          z = z0 + (mz / dist) * maxPush;
        }
        if (dist > 0) moved++;
        xs[i] = x;
        zs[i] = z;
        insert(i);
      }
      return moved;
    },
  };
}

/** Scene positions of the sim agents drawn this frame (written by Agents, read by Footfall as obstacles). */
export const obstacles = { xs: new Float32Array(4000), zs: new Float32Array(4000), n: 0 };
