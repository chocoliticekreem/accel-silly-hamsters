// Low-poly meshes for every crowd in the city (ported from hamyway-city's Crowds/meshes.ts).
// Each vertex carries `aPart` so the vertex shader knows which limb it belongs to (for swinging) and which colour
// it takes. Local space: feet at y = 0, facing +z, right hand at -x. No normals: the materials use flat shading.
import { BufferGeometry, Float32BufferAttribute } from "three";

export const PART = { torso: 0, head: 1, legL: 2, legR: 3, armL: 4, armR: 5, hair: 6, bag: 7 } as const;
export const UMBRELLA_PART = { canopy: 0, stick: 1 } as const;
export const DOG_PART = { body: 0, head: 1, legsA: 2, legsB: 3 } as const;

class Tris {
  pos: number[] = [];
  part: number[] = [];
  tri(a: number[], b: number[], c: number[], p: number) {
    this.pos.push(...a, ...b, ...c);
    this.part.push(p, p, p);
  }
  quad(a: number[], b: number[], c: number[], d: number[], p: number) {
    this.tri(a, b, c, p);
    this.tri(a, c, d, p);
  }
  /** Axis-aligned box, outward-facing CCW. `top`/`bottom` optional caps. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, p: number, top = true, bottom = false) {
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], p); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], p); // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], p); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], p); // -x
    if (top) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], p);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], p);
  }
  /** Tapered box: bottom rectangle (bx, bz half sizes) to top rectangle (tx, tz), centred on x = cx, z = cz. */
  taper(cx: number, cz: number, y0: number, y1: number, bx: number, bz: number, tx: number, tz: number, p: number) {
    const b = [[cx - bx, y0, cz + bz], [cx + bx, y0, cz + bz], [cx + bx, y0, cz - bz], [cx - bx, y0, cz - bz]];
    const t = [[cx - tx, y1, cz + tz], [cx + tx, y1, cz + tz], [cx + tx, y1, cz - tz], [cx - tx, y1, cz - tz]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(b[i], b[j], t[j], t[i], p);
    }
    this.quad(t[0], t[1], t[2], t[3], p);
  }
  /** Octahedron (8 tris). */
  octa(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, p: number) {
    const t = [cx, cy + ry, cz];
    const b = [cx, cy - ry, cz];
    const ring = [[cx + rx, cy, cz], [cx, cy, cz + rz], [cx - rx, cy, cz], [cx, cy, cz - rz]];
    for (let i = 0; i < 4; i++) {
      const u = ring[i];
      const v = ring[(i + 1) % 4];
      this.tri(u, t, v, p);
      this.tri(v, b, u, p);
    }
  }
  /** Square pyramid cap, base at y0, apex at y1 (4 tris). */
  pyramid(cx: number, cz: number, r: number, y0: number, y1: number, p: number) {
    const ring = [[cx + r, y0, cz + r], [cx + r, y0, cz - r], [cx - r, y0, cz - r], [cx - r, y0, cz + r]];
    const apex = [cx, y1, cz];
    for (let i = 0; i < 4; i++) this.tri(ring[i], ring[(i + 1) % 4], apex, p);
  }
  geometry() {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("aPart", new Float32BufferAttribute(this.part, 1));
    return g;
  }
}

/** A ~1.75 m person in ~90 triangles: tapered torso (shoulders wider than waist), hips, limbs, head, hair, bag. */
export function personGeometry() {
  const t = new Tris();
  t.box(0.02, 0.16, 0.06, 0.92, -0.075, 0.075, PART.legL, false);
  t.box(-0.16, -0.02, 0.06, 0.92, -0.075, 0.075, PART.legR, false);
  // shoes: part of each leg so they swing with it (coloured like trousers, darkened in the shader by height)
  t.box(0.015, 0.165, 0, 0.07, -0.09, 0.14, PART.legL, true);
  t.box(-0.165, -0.015, 0, 0.07, -0.09, 0.14, PART.legR, true);
  t.taper(0, 0, 0.86, 1.46, 0.18, 0.11, 0.23, 0.12, PART.torso);
  t.box(0.22, 0.31, 0.82, 1.42, -0.055, 0.055, PART.armL, false);
  t.box(-0.31, -0.22, 0.82, 1.42, -0.055, 0.055, PART.armR, false);
  t.box(-0.05, 0.05, 1.44, 1.5, -0.05, 0.05, PART.head, false); // neck
  t.octa(0, 1.62, 0, 0.13, 0.16, 0.14, PART.head);
  t.pyramid(0, -0.025, 0.135, 1.66, 1.8, PART.hair);
  // shoulder bag on the left hip
  t.box(0.2, 0.27, 0.85, 1.08, -0.12, 0.1, PART.bag, true, true);
  return t.geometry();
}

/** Umbrella held in the right hand (arm raised forward): stick + 8-sided canopy. */
export function umbrellaGeometry() {
  const t = new Tris();
  const hx = -0.27;
  const hz = 0.36; // hand
  t.box(hx - 0.02, hx + 0.02, 0.95, 2.2, hz - 0.02, hz + 0.02, UMBRELLA_PART.stick, false);
  const apex = [hx, 2.34, hz];
  const R = 0.74;
  const y = 2.02;
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2;
    t.tri([hx + Math.cos(a0) * R, y, hz + Math.sin(a0) * R], apex, [hx + Math.cos(a1) * R, y, hz + Math.sin(a1) * R], UMBRELLA_PART.canopy);
  }
  return t.geometry();
}

/** A small dog facing +z. */
export function dogGeometry() {
  const t = new Tris();
  t.box(-0.09, 0.09, 0.24, 0.42, -0.28, 0.22, DOG_PART.body, true);
  t.box(-0.07, 0.07, 0.34, 0.5, 0.2, 0.38, DOG_PART.head, true);
  t.box(-0.02, 0.02, 0.36, 0.48, -0.36, -0.26, DOG_PART.body, true); // tail
  // legs: front-left + back-right swing together (A), the other diagonal (B)
  t.box(0.03, 0.08, 0, 0.26, 0.12, 0.17, DOG_PART.legsA, false);
  t.box(-0.08, -0.03, 0, 0.26, -0.24, -0.19, DOG_PART.legsA, false);
  t.box(-0.08, -0.03, 0, 0.26, 0.12, 0.17, DOG_PART.legsB, false);
  t.box(0.03, 0.08, 0, 0.26, -0.24, -0.19, DOG_PART.legsB, false);
  return t.geometry();
}
