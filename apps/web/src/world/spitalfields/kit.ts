// A tiny geometry kit for building merged, vertex-coloured models in place: set a local frame (scene position +
// heading), add painted primitives in that frame, and merge everything into one BufferGeometry per material.
// Textured quads (signs, murals) go into a separate builder that keeps UVs.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Matrix4,
  ShapeUtils,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { merge, paint } from "../propModels";
import type { UvRect } from "./atlas";

export class Kit {
  parts: BufferGeometry[] = [];
  private m = new Matrix4();

  /** Local frame: origin at scene (x, y, z); local +x points along heading `rot` (radians about +y). */
  frame(x: number, z: number, rot = 0, y = 0) {
    this.m.makeRotationY(rot).setPosition(x, y, z);
    return this;
  }

  add(g: BufferGeometry, hex: string) {
    paint(g, hex);
    g.applyMatrix4(this.m);
    this.parts.push(g);
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, hex: string, ry = 0) {
    const g = new BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    return this.add(g.translate(x, y, z), hex);
  }

  /** Box from its base (y = bottom). */
  block(w: number, h: number, d: number, x: number, y0: number, z: number, hex: string, ry = 0) {
    return this.box(w, h, d, x, y0 + h / 2, z, hex, ry);
  }

  cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, hex: string, seg = 10) {
    return this.add(new CylinderGeometry(rt, rb, h, seg).translate(x, y, z), hex);
  }

  cone(r: number, h: number, x: number, y0: number, z: number, hex: string, seg = 8, rotY = 0) {
    const g = new ConeGeometry(r, h, seg);
    if (rotY) g.rotateY(rotY);
    return this.add(g.translate(x, y0 + h / 2, z), hex);
  }

  ball(r: number, x: number, y: number, z: number, hex: string, seg = 8) {
    return this.add(new SphereGeometry(r, seg, Math.max(4, seg / 2)).translate(x, y, z), hex);
  }

  /** Half ring (an arch) in the local x-y plane, centred at (x, y, z), radius r, tube t. `axisZ` turns it to the z-y plane. */
  arch(r: number, t: number, x: number, y: number, z: number, hex: string, axisZ = false, seg = 16) {
    const g = new TorusGeometry(r, t, 5, seg, Math.PI);
    if (axisZ) g.rotateY(Math.PI / 2);
    return this.add(g.translate(x, y, z), hex);
  }

  /** Flat-topped extrusion of a contract-coords ring (already converted to scene by the caller) from y0 to y1. */
  prism(ring: [number, number][], y0: number, y1: number, hex: string) {
    const g = prismGeometry(ring, y0, y1);
    if (g) this.add(g, hex);
    return this;
  }

  build(): BufferGeometry | null {
    if (!this.parts.length) return null;
    const out = merge(this.parts);
    this.parts = [];
    out.computeBoundingSphere();
    return out;
  }
}

/** Vertical prism over a scene-space (x, z) ring: walls + top cap. Non-indexed with normals. */
export function prismGeometry(ring: [number, number][], y0: number, y1: number): BufferGeometry | null {
  if (ring.length < 3) return null;
  const pos: number[] = [];
  const nor: number[] = [];
  // orient the ring counter-clockwise seen from above (+y): in (x, -z) that's CCW in standard maths terms
  const pts = ring.map(([x, z]) => new Vector2(x, -z));
  if (ShapeUtils.isClockWise(pts)) pts.reverse();
  const tris = ShapeUtils.triangulateShape(pts, []);
  for (const t of tris)
    for (const k of t) {
      pos.push(pts[k].x, y1, -pts[k].y);
      nor.push(0, 1, 0);
    }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ax = a.x;
    const az = -a.y;
    const bx = b.x;
    const bz = -b.y;
    // outward normal of a CCW (in x, -z) ring
    const nx = b.y - a.y;
    const nz = b.x - a.x;
    const l = Math.hypot(nx, nz) || 1;
    const quad = [ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az];
    pos.push(...quad);
    for (let k = 0; k < 6; k++) nor.push(nx / l, 0, nz / l);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  fixWinding(g);
  return g;
}

/** Makes every triangle's winding agree with its stored normal (so front faces face out). */
function fixWinding(g: BufferGeometry) {
  const p = g.getAttribute("position") as BufferAttribute;
  const n = g.getAttribute("normal") as BufferAttribute;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const nn = new Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    nn.fromBufferAttribute(n, i);
    const face = b.clone().sub(a).cross(c.clone().sub(a));
    if (face.dot(nn) < 0) {
      // swap b and c
      for (const attr of [p, n]) {
        const bx = attr.getX(i + 1);
        const by = attr.getY(i + 1);
        const bz = attr.getZ(i + 1);
        attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
        attr.setXYZ(i + 2, bx, by, bz);
      }
    }
  }
}

/** Flat polygon (scene-space ring) at height y, facing up, painted. */
export function flatPolygon(ring: [number, number][], y: number, hex: string): BufferGeometry | null {
  if (ring.length < 3) return null;
  const pts = ring.map(([x, z]) => new Vector2(x, -z));
  if (ShapeUtils.isClockWise(pts)) pts.reverse();
  const tris = ShapeUtils.triangulateShape(pts, []);
  if (!tris.length) return null;
  const pos: number[] = [];
  const nor: number[] = [];
  for (const t of tris)
    for (const k of t) {
      pos.push(pts[k].x, y, -pts[k].y);
      nor.push(0, 1, 0);
    }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  fixWinding(g);
  return paint(g, hex);
}

/** Textured upright quads (signs, murals), merged into one geometry with UVs. */
export class Quads {
  private pos: number[] = [];
  private nor: number[] = [];
  private uvs: number[] = [];

  /**
   * A quad centred at scene (x, y, z) facing horizontal scene direction (nx, nz), w × h metres, showing `r`.
   * `rotate` turns the image a quarter (for vertical lettering read top to bottom).
   */
  add(x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, r: UvRect) {
    const rx = nz;
    const rz = -nx; // right = up × normal
    const hw = w / 2;
    const hh = h / 2;
    const bl = [x - rx * hw, y - hh, z - rz * hw];
    const br = [x + rx * hw, y - hh, z + rz * hw];
    const tr = [x + rx * hw, y + hh, z + rz * hw];
    const tl = [x - rx * hw, y + hh, z - rz * hw];
    const [u0, v0, u1, v1] = r;
    const verts = [bl, br, tr, bl, tr, tl];
    const tex = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
    for (const v of verts) {
      this.pos.push(v[0], v[1], v[2]);
      this.nor.push(nx, 0, nz);
    }
    this.uvs.push(...tex);
  }

  build(): BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute("uv", new BufferAttribute(new Float32Array(this.uvs), 2));
    g.computeBoundingSphere();
    return g;
  }
}
