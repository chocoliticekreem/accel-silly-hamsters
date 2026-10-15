// Hero model kit: collect many small primitives, each tagged with a material slot and a flat colour, and bake
// them into ONE vertex-coloured BufferGeometry per slot. A whole hero model then costs one draw call per slot
// (and instances for free). Animatable sub-parts (wheels, doors, lamps, a crane jib) are built as separate
// "nodes" in the same way, in their own local frame around a pivot.
//
// Conventions for every model in world/models: metres, y up, ground at y = 0, the model's FRONT faces +z
// (vehicle nose, building street face), left is +x (UK nearside / kerb side for vehicles).
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  IcosahedronGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  type Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type V3 = readonly [number, number, number];

/**
 * Material slots. Every slot is vertex-coloured (material colour stays white), so a model needs at most one
 * material per slot: solid = matte (brick, plastic, fabric, tyres), paint = glossy car/bus paint, metal = chrome
 * and steel, glass = windows (glow warm at night), glow = self-lit (lamps, neon, signs), brick = solid with a
 * tiling brick texture (world-space UVs, 1 tile = 1 m).
 */
export type Slot = "solid" | "paint" | "metal" | "glass" | "glow" | "brick";
export const SLOTS: Slot[] = ["solid", "paint", "metal", "glass", "glow", "brick"];

export type SlotGeos = Partial<Record<Slot, BufferGeometry>>;

/** A text/artwork plane drawn on a canvas at runtime (see materials.ts). Geometry carries uvs 0..1. */
export interface SignSpec {
  geo: BufferGeometry;
  /** Canvas size in px. Keep ≤ 1024. */
  w: number;
  h: number;
  draw: (c: CanvasRenderingContext2D, w: number, h: number) => void;
  /** Self-lit (signs) or lit by the scene (murals, posters). */
  glow: boolean;
  key: string;
}

/** An animatable sub-part: geometry is in the node's own frame; place it at `pivot` (model space). */
export interface HeroNode {
  name: string;
  pivot: V3;
  parts: SlotGeos;
}

export interface HeroModel {
  name: string;
  parts: SlotGeos;
  nodes: HeroNode[];
  signs: SignSpec[];
  /** Bounding size [x width, y height, z length] in metres. */
  size: V3;
}

const _m = new Matrix4();
const _f = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _up = new Vector3(0, 1, 0);
const _d = new Vector3();

interface Piece {
  slot: Slot;
  geo: BufferGeometry;
}

export class Kit {
  private pieces: Piece[] = [];
  private frame = new Matrix4();
  readonly signs: SignSpec[] = [];
  readonly nodes: HeroNode[] = [];

  /** Run fn with a local frame (translate, then rotate about Y) stacked on the current one. */
  at(x: number, y: number, z: number, ry: number, fn: () => void) {
    const saved = this.frame.clone();
    _f.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(1, 1, 1));
    this.frame.multiply(_f);
    fn();
    this.frame.copy(saved);
  }

  /** Mirror everything fn adds across x = 0 (adds both sides). */
  mirrorX(fn: (side: 1 | -1) => void) {
    fn(1);
    const saved = this.frame.clone();
    this.frame.multiply(_f.makeScale(-1, 1, 1));
    fn(-1);
    this.frame.copy(saved);
  }

  addQ(slot: Slot, geo: BufferGeometry, color: string, pos: V3, q: Quaternion, scale: V3 = [1, 1, 1]) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
    _m.compose(_p.set(pos[0], pos[1], pos[2]), q, _s.set(scale[0], scale[1], scale[2]));
    _m.premultiply(this.frame);
    g.applyMatrix4(_m);
    if (_m.determinant() < 0) flipWinding(g);
    const n = g.getAttribute("position").count;
    const arr = new Float32Array(n * 3);
    _c.set(color);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = _c.r;
      arr[i * 3 + 1] = _c.g;
      arr[i * 3 + 2] = _c.b;
    }
    g.setAttribute("color", new BufferAttribute(arr, 3));
    this.pieces.push({ slot, geo: g });
  }

  add(slot: Slot, geo: BufferGeometry, color: string, pos: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) {
    _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
    this.addQ(slot, geo, color, pos, _q, scale);
  }

  /** Box by centre and size, optional rotation. */
  box(slot: Slot, w: number, h: number, d: number, x: number, y: number, z: number, color: string, rot: V3 = [0, 0, 0]) {
    this.add(slot, new BoxGeometry(w, h, d), color, [x, y, z], rot);
  }

  /** Axis-aligned box by extents. */
  slab(slot: Slot, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string) {
    this.add(slot, new BoxGeometry(x1 - x0, y1 - y0, z1 - z0), color, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
  }

  /** Box with rounded (bevelled) edges: the cheap trick that makes low poly read as "modelled". */
  rbox(slot: Slot, w: number, h: number, d: number, x: number, y: number, z: number, color: string, r = 0.08, seg = 2, rot: V3 = [0, 0, 0]) {
    const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
    this.add(slot, new RoundedBoxGeometry(w, h, d, seg, Math.max(rr, 1e-3)), color, [x, y, z], rot);
  }

  cyl(slot: Slot, rt: number, rb: number, h: number, seg: number, pos: V3, color: string, rot: V3 = [0, 0, 0], scale?: V3) {
    this.add(slot, new CylinderGeometry(rt, rb, h, seg), color, pos, rot, scale);
  }

  /** Cylinder lying along x (wheels, axles, railings). */
  cylX(slot: Slot, r: number, len: number, seg: number, pos: V3, color: string) {
    this.add(slot, new CylinderGeometry(r, r, len, seg), color, pos, [0, 0, Math.PI / 2]);
  }

  /** Cylinder lying along z. */
  cylZ(slot: Slot, r: number, len: number, seg: number, pos: V3, color: string) {
    this.add(slot, new CylinderGeometry(r, r, len, seg), color, pos, [Math.PI / 2, 0, 0]);
  }

  cone(slot: Slot, r: number, h: number, seg: number, pos: V3, color: string, rot: V3 = [0, 0, 0]) {
    this.add(slot, new ConeGeometry(r, h, seg), color, pos, rot);
  }

  sphere(slot: Slot, r: number, ws: number, hs: number, pos: V3, color: string, scale?: V3) {
    this.add(slot, new SphereGeometry(r, ws, hs), color, pos, [0, 0, 0], scale);
  }

  dome(slot: Slot, r: number, ws: number, hs: number, pos: V3, color: string, scale?: V3) {
    this.add(slot, new SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI / 2), color, pos, [0, 0, 0], scale);
  }

  blob(slot: Slot, r: number, detail: number, pos: V3, color: string, scale?: V3) {
    this.add(slot, new IcosahedronGeometry(r, detail), color, pos, [0, 0, 0], scale);
  }

  torus(slot: Slot, r: number, tube: number, rs: number, ts: number, pos: V3, color: string, rot: V3 = [0, 0, 0], arc = Math.PI * 2) {
    this.add(slot, new TorusGeometry(r, tube, rs, ts, arc), color, pos, rot);
  }

  /** Flat disc/ring facing +z (signs) unless rotated. */
  ring(slot: Slot, inner: number, outer: number, seg: number, pos: V3, color: string, rot: V3 = [0, 0, 0]) {
    this.add(slot, new RingGeometry(inner, outer, seg), color, pos, rot);
  }

  /** Shape in the xy plane extruded `depth` along +z from z = 0 (then placed). */
  extrude(slot: Slot, shape: Shape, depth: number, pos: V3, color: string, rot: V3 = [0, 0, 0], curveSegments = 8) {
    this.add(slot, new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments }), color, pos, rot);
  }

  /** Round beam from a to b. */
  beam(slot: Slot, a: V3, b: V3, r: number, color: string, seg = 6) {
    _d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _d.length();
    const q = new Quaternion().setFromUnitVectors(_up, _d.normalize());
    this.addQ(slot, new CylinderGeometry(r, r, len, seg), color, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], q);
  }

  /** Square-section bar from a to b (lattice members, railings). */
  bar(slot: Slot, a: V3, b: V3, t: number, color: string) {
    _d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _d.length();
    const q = new Quaternion().setFromUnitVectors(_up, _d.normalize());
    this.addQ(slot, new BoxGeometry(t, len, t), color, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], q);
  }

  /** Canvas-drawn plane facing +z (in the current frame, then `rot`). */
  sign(key: string, w: number, h: number, pos: V3, px: [number, number], draw: SignSpec["draw"], glow = true, rot: V3 = [0, 0, 0]) {
    const g = new PlaneGeometry(w, h);
    _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
    _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(1, 1, 1)).premultiply(this.frame);
    g.applyMatrix4(_m);
    this.signs.push({ key, geo: g, w: px[0], h: px[1], draw, glow });
  }

  /** Build an animatable node: fn draws in the node's own frame (origin = pivot). */
  node(name: string, pivot: V3, fn: (k: Kit) => void) {
    const k = new Kit();
    fn(k);
    _p.set(pivot[0], pivot[1], pivot[2]).applyMatrix4(this.frame);
    this.nodes.push({ name, pivot: [_p.x, _p.y, _p.z], parts: k.bake() });
  }

  /** Merge the pieces into one geometry per slot (and clear the kit). */
  bake(opts: { ao?: number } = {}): SlotGeos {
    const out: SlotGeos = {};
    for (const slot of SLOTS) {
      const list = this.pieces.filter((p) => p.slot === slot).map((p) => p.geo);
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      if (opts.ao) groundAO(merged, opts.ao);
      if (slot === "brick") worldUV(merged, 1);
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      out[slot] = merged;
    }
    this.pieces = [];
    return out;
  }

  /** Finish a model: bake + bounding size. */
  model(name: string, opts: { ao?: number } = {}): HeroModel {
    const parts = this.bake(opts);
    const box = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
    const grow = (g: BufferGeometry | undefined, off: V3 = [0, 0, 0]) => {
      if (!g) return;
      g.computeBoundingBox();
      const b = g.boundingBox!;
      box.min.min(_p.set(b.min.x + off[0], b.min.y + off[1], b.min.z + off[2]));
      box.max.max(_p.set(b.max.x + off[0], b.max.y + off[1], b.max.z + off[2]));
    };
    for (const g of Object.values(parts)) grow(g);
    for (const n of this.nodes) for (const g of Object.values(n.parts)) grow(g, n.pivot);
    const size: V3 = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].map((v) => +v.toFixed(2)) as unknown as V3;
    return { name, parts, nodes: this.nodes.splice(0), signs: this.signs.splice(0), size };
  }
}

function flipWinding(g: BufferGeometry) {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  for (let i = 0; i < pos.count; i += 3) {
    for (const a of [pos, nor]) {
      if (!a) continue;
      const x = a.getX(i + 1), y = a.getY(i + 1), z = a.getZ(i + 1);
      a.setXYZ(i + 1, a.getX(i + 2), a.getY(i + 2), a.getZ(i + 2));
      a.setXYZ(i + 2, x, y, z);
    }
  }
}

/** Cheap baked ambient occlusion: darken vertices near the ground (contact shadow feel). */
export function groundAO(g: BufferGeometry, height: number, strength = 0.35) {
  const pos = g.getAttribute("position");
  const col = g.getAttribute("color");
  if (!col) return;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / height));
    const k = 1 - strength * (1 - t * t * (3 - 2 * t));
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
}

/** Triplanar-ish world-space UVs per triangle (dominant normal axis), `tile` metres per texture repeat. */
export function worldUV(g: BufferGeometry, tile: number) {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 3) {
    let nx = 0, ny = 0, nz = 0;
    for (let j = 0; j < 3; j++) {
      nx += Math.abs(nor.getX(i + j));
      ny += Math.abs(nor.getY(i + j));
      nz += Math.abs(nor.getZ(i + j));
    }
    for (let j = 0; j < 3; j++) {
      const x = pos.getX(i + j), y = pos.getY(i + j), z = pos.getZ(i + j);
      let u: number, v: number;
      if (ny >= nx && ny >= nz) [u, v] = [x, z];
      else if (nx >= nz) [u, v] = [z, y];
      else [u, v] = [x, y];
      uv[(i + j) * 2] = u / tile;
      uv[(i + j) * 2 + 1] = v / tile;
    }
  }
  g.setAttribute("uv", new BufferAttribute(uv, 2));
}

/** Recolour every vertex of a baked geometry (e.g. a white-painted van in a fleet colour). */
export function repaint(g: BufferGeometry, hex: string) {
  const col = g.getAttribute("color");
  _c.set(hex);
  for (let i = 0; i < col.count; i++) col.setXYZ(i, _c.r, _c.g, _c.b);
  col.needsUpdate = true;
}

/** Bake a model (nodes in their rest pose) into plain slot geometries, for instancing a whole model as one. */
export function flatten(m: HeroModel): SlotGeos {
  const out: SlotGeos = {};
  for (const slot of SLOTS) {
    const list: BufferGeometry[] = [];
    if (m.parts[slot]) list.push(m.parts[slot]!.clone());
    for (const n of m.nodes) if (n.parts[slot]) list.push(n.parts[slot]!.clone().translate(n.pivot[0], n.pivot[1], n.pivot[2]));
    if (!list.length) continue;
    const uvs = list.some((g) => g.getAttribute("uv"));
    if (!uvs) list.forEach((g) => g.getAttribute("uv") && g.deleteAttribute("uv"));
    out[slot] = mergeGeometries(list, false) ?? undefined;
    list.forEach((g) => g.dispose());
  }
  return out;
}
