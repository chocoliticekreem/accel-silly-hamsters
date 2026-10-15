// A tiny procedural mesh builder: axis-aligned (optionally yawed) boxes with per-vertex colour appended into one
// indexed buffer, so a whole furnished floor is a single draw call with a shared vertex-colour material.
import { BufferGeometry, Color, Float32BufferAttribute, Uint32BufferAttribute } from "three";

const cache = new Map<string, Color>();
const col = (c: string) => {
  let v = cache.get(c);
  if (!v) cache.set(c, (v = new Color(c)));
  return v;
};

// face normals and corner signs (u, v) for the 6 faces of a unit box
const FACES: { n: [number, number, number]; c: [number, number, number][] }[] = [
  { n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

export class Builder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  /** Box with its base centre at (x, y, z): w along x, h up, d along z, turned `yaw` about its own centre. */
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, yaw = 0): this {
    const c = col(color);
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const cy = y + h / 2;
    for (const f of FACES) {
      const base = this.pos.length / 3;
      const nx = f.n[0] * cs + f.n[2] * sn;
      const nz = -f.n[0] * sn + f.n[2] * cs;
      for (const [sx, sy, sz] of f.c) {
        const lx = (sx * w) / 2;
        const lz = (sz * d) / 2;
        this.pos.push(x + lx * cs + lz * sn, cy + (sy * h) / 2, z - lx * sn + lz * cs);
        this.nor.push(nx, f.n[1], nz);
        this.col.push(c.r, c.g, c.b);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  /** Flat panel standing on the floor, facing +z before `yaw` (a screen, a painting). */
  panel(x: number, y: number, z: number, w: number, h: number, color: string, yaw = 0): this {
    return this.box(x, y, z, w, h, 0.08, color, yaw);
  }

  get empty() {
    return this.idx.length === 0;
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    g.setIndex(new Uint32BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
