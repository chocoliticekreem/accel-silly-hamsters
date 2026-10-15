// Moving things along a street polyline: distance along → position + heading, with a lane offset.
// Used by the decorative layers (traffic, background footfall, street trees). Contract coords (x east, z north).

export interface Polyline {
  /** Total length in metres. */
  length: number;
  /** Writes the point `s` metres along (clamped) into `out`; `lateral` shifts it to the right of travel. */
  at(s: number, lateral: number, out: PathPoint): PathPoint;
}

export interface PathPoint {
  x: number;
  z: number;
  /** Unit direction of travel. */
  dx: number;
  dz: number;
}

export const newPoint = (): PathPoint => ({ x: 0, z: 0, dx: 0, dz: 1 });

export function polyline(points: [number, number][]): Polyline {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const length = cum[cum.length - 1];
  return {
    length,
    at(s, lateral, out) {
      const d = Math.max(0, Math.min(length, s));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const [ax, az] = points[i - 1];
      const [bx, bz] = points[i];
      const seg = cum[i] - cum[i - 1] || 1;
      const k = (d - cum[i - 1]) / seg;
      const dx = (bx - ax) / seg;
      const dz = (bz - az) / seg;
      out.dx = dx;
      out.dz = dz;
      // right-hand normal of (dx, dz) in x-east/z-north coords is (dz, -dx)
      out.x = ax + (bx - ax) * k + dz * lateral;
      out.z = az + (bz - az) * k - dx * lateral;
      return out;
    },
  };
}

/**
 * Back-and-forth travel: distance `d` along an endless trip maps to a position on a path of `length`,
 * going out and back. Returns [s, forward].
 */
export function pingPong(d: number, length: number): [number, boolean] {
  if (length <= 0) return [0, true];
  const m = ((d % (2 * length)) + 2 * length) % (2 * length);
  return m <= length ? [m, true] : [2 * length - m, false];
}
