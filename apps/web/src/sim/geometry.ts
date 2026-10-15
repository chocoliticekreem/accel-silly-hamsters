// Map geometry shared by the 3D world and the mock generator.
// Contract coordinates are x = east, z = north. Three.js looks down -z by default, so the scene uses
// sceneZ = -z (north is "up the screen" from the default camera). Convert ONLY through toScene.
import type { Building, Street } from "../api/contract";

export function toScene(x: number, z: number): [number, number] {
  return [x, -z];
}

export interface Frontage {
  street: Street;
  /** Unit vector (contract coords) from the building centre toward its street. */
  nx: number;
  nz: number;
  /** Centre of the street-facing facade. */
  facadeX: number;
  facadeZ: number;
  /** Point on the sidewalk in front of the door. */
  doorX: number;
  doorZ: number;
}

function closestOnSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): [number, number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const k = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  const cx = ax + dx * k;
  const cz = az + dz * k;
  return [cx, cz, Math.hypot(px - cx, pz - cz)];
}

/** Closest point on a street polyline to (x, z), and its distance. */
export function closestOnStreet(street: Street, x: number, z: number): [number, number, number] {
  let best: [number, number, number] = [x, z, Infinity];
  for (let i = 0; i < street.points.length - 1; i++) {
    const [ax, az] = street.points[i];
    const [bx, bz] = street.points[i + 1];
    const c = closestOnSegment(x, z, ax, az, bx, bz);
    if (c[2] < best[2]) best = c;
  }
  return best;
}

/** Which street a building faces, where its facade is and where its door meets the sidewalk. */
export function frontage(b: Building, streets: Street[]): Frontage {
  let street = streets[0];
  let best: [number, number, number] = [b.x, b.z, Infinity];
  for (const s of streets) {
    // distance from the footprint edge, not the centre, so wide buildings pick the street they touch
    const c = closestOnStreet(s, b.x, b.z);
    const along = Math.abs(c[0] - b.x) > Math.abs(c[1] - b.z) ? b.w / 2 : b.d / 2;
    const d = c[2] - along;
    if (d < best[2]) {
      best = [c[0], c[1], d];
      street = s;
    }
  }
  const [cx, cz] = best;
  // snap the facing direction to the dominant axis (buildings are axis-aligned boxes)
  const vx = cx - b.x;
  const vz = cz - b.z;
  const horizontal = Math.abs(vx) >= Math.abs(vz);
  const nx = horizontal ? Math.sign(vx) || 1 : 0;
  const nz = horizontal ? 0 : Math.sign(vz) || 1;
  const facadeX = b.x + (nx * b.w) / 2;
  const facadeZ = b.z + (nz * b.d) / 2;
  const sidewalk = street.width / 2 + 2;
  const doorX = horizontal ? cx - nx * sidewalk : b.x;
  const doorZ = horizontal ? b.z : cz - nz * sidewalk;
  return { street, nx, nz, facadeX, facadeZ, doorX, doorZ };
}
