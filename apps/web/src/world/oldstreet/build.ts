// Static geometry for the Old Street area, all baked into a handful of merged meshes:
//  - the raised public space (the old gyratory's north-west peninsula + the Promenade of Light), kerbed,
//    paved, with planters, plane trees, benches, cycle hire, lamps and bollards;
//  - the new station entrance pavilion: glazed hall under a big timber-soffit canopy with a roof garden,
//    and an escalator well down to the ticket hall you can see through the glass;
//  - the sunken St Agnes Well walk (the old subway ramp) with shop units and the tunnel mouth into the
//    concourse, the Exit 4 stair and the Exit 2 stair house, lift houses;
//  - two big double-sided digital advertising screens;
//  - traffic signals, crossings and stop lines on the junction, bus shelters;
//  - the White Collar Factory (concrete-framed tower with its rooftop running track) on its campus.
// Holes in the ground (pit, escalator well, Exit 2 stair) use a depth "cap": see OldStreet.tsx.
// Scene-local frame: X = x - cx, Z = -(z - cz) (contract → scene, origin at the station node).
import { BoxGeometry, BufferGeometry, Matrix4, Quaternion, Shape, ShapeGeometry, Vector2, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rng } from "../../mock/rng";
import { Kit, type SignSpec, type SlotGeos } from "../models/kit";
import { drawBusStop, drawCycleDock, drawPlaneTree, drawRoundelPost } from "../models/street";
import { Atlas, SIGNS } from "./atlas";
import { CONCOURSE_Y, PIT_Y, PLAZA_Y, type OldStreetData, type XZ } from "./data";

export type V3 = [number, number, number];

export interface Route {
  /** Scene-local points (x, y, z). Walked from [0] to the end; the end is out of sight (underground). */
  pts: V3[];
  len: number;
}

export interface LaneInfo {
  name: string;
  pts: V3[]; // scene-local, offset to the left lane
  cum: number[];
  len: number;
  stops: { s: number; group: number }[];
  busStop?: number;
}

export interface Crossing {
  a: V3;
  b: V3;
  group: number; // signal group of the road it crosses (-1 = uncontrolled)
}

export interface SignalHead {
  pos: V3; // lamp stack centre
  ry: number;
  group: number;
}

export interface Built {
  parts: SlotGeos;
  signs: ReturnType<Atlas["mesh"]>;
  glass: BufferGeometry;
  cap: BufferGeometry;
  screens: { m: Matrix4; w: number; h: number }[];
  pools: { x: number; z: number; r: number; y: number }[];
  heads: SignalHead[];
  lanes: LaneInfo[];
  crossings: Crossing[];
  /** Station entry routes (in = walk along, out = walk reversed). */
  routes: { in: Route[]; origins: V3[][] };
  strolls: Route[];
  label: V3;
}

// ---------------------------------------------------------------- geometry helpers

const routeOf = (pts: V3[]): Route => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  return { pts, len };
};

function signedArea(p: Vector2[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return a / 2;
}

function pointInPoly(x: number, z: number, poly: XZ[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
}

/** Nearest point on a polyline (2D, contract) → [x, z, dist, tx, tz]. */
function nearestOn(pts: XZ[], x: number, z: number) {
  let best = [0, 0, Infinity, 1, 0];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best[2]) {
      const l = Math.sqrt(l2);
      best = [px, pz, d, dx / l, dz / l];
    }
  }
  return best;
}

// ---------------------------------------------------------------- the build

export function buildOldStreet(data: OldStreetData): Built {
  const [cx, cz] = data.centre;
  /** contract → scene-local */
  const S = (x: number, z: number): [number, number] => [x - cx, -(z - cz)];
  const k = new Kit();
  const atlas = new Atlas(2048);
  const glassParts: BufferGeometry[] = [];
  const capParts: BufferGeometry[] = [];
  const screens: Built["screens"] = [];
  const pools: Built["pools"] = [];
  const r = rng(51525);
  const m4 = new Matrix4();
  const q = new Quaternion();
  const UP = new Vector3(0, 1, 0);

  /** A lit atlas sign w × h, centre (X, y, Z) scene-local, facing local +z after ry. */
  const sign = (spec: [string, number, number, (c: CanvasRenderingContext2D, w: number, h: number) => void], w: number, h: number, X: number, y: number, Z: number, ry: number, both = false) => {
    const cell = atlas.cell(spec[0], spec[1], spec[2], spec[3]);
    atlas.quad(cell, w, h, m4.compose(new Vector3(X, y, Z), q.setFromAxisAngle(UP, ry), new Vector3(1, 1, 1)));
    if (both) atlas.quad(cell, w, h, m4.compose(new Vector3(X, y, Z), q.setFromAxisAngle(UP, ry + Math.PI), new Vector3(1, 1, 1)));
  };
  /** Kit signs (from shared street furniture builders) go into the same atlas. */
  const adoptSigns = (specs: SignSpec[]) => {
    for (const s of specs) {
      const cell = atlas.cell(s.key, s.w, s.h, s.draw);
      const uv = s.geo.getAttribute("uv");
      for (let i = 0; i < uv.count; i++) uv.setXY(i, cell.u0 + uv.getX(i) * (cell.u1 - cell.u0), cell.v0 + uv.getY(i) * (cell.v1 - cell.v0));
      (atlas as unknown as { quads: BufferGeometry[] }).quads.push(s.geo);
    }
    specs.length = 0;
  };

  const shapeOf = (poly: XZ[], holes: XZ[][] = []) => {
    const sh = new Shape(poly.map(([x, z]) => new Vector2(x - cx, z - cz)));
    for (const h of holes) sh.holes.push(new Shape(h.map(([x, z]) => new Vector2(x - cx, z - cz))));
    return sh;
  };
  /** Horizontal slab of a contract polygon between y0 and y1. */
  const slab = (slot: Parameters<Kit["box"]>[0], poly: XZ[], y0: number, y1: number, color: string, holes: XZ[][] = []) =>
    k.extrude(slot, shapeOf(poly, holes), y1 - y0, [0, y0, 0], color, [-Math.PI / 2, 0, 0], 4);
  /** Wall/beam between scene-local points a → b. */
  const wallXZ = (slot: Parameters<Kit["box"]>[0], ax: number, az: number, bx: number, bz: number, y0: number, y1: number, t: number, color: string, out = 0) => {
    const dx = bx - ax;
    const dz = bz - az;
    const l = Math.hypot(dx, dz);
    if (l < 0.05) return;
    // outward offset: to the right of a→b in scene (x, z) = (-dz, dx)/l · -1 … use given sign
    const nx = (dz / l) * out;
    const nz = (-dx / l) * out;
    k.box(slot, l + t * 0.5, y1 - y0, t, (ax + bx) / 2 + nx, (y0 + y1) / 2, (az + bz) / 2 + nz, color, [0, Math.atan2(-dz, dx), 0]);
  };
  const capPoly = (poly: [number, number][], y: number) => {
    // poly in scene-local XZ
    const sh = new Shape(poly.map(([X, Z]) => new Vector2(X, -Z)));
    const g = new ShapeGeometry(sh);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    capParts.push(g);
  };

  /** A sunken space: floor at `floor`, walls from the floor up to the ground on every edge (except `open` edges),
   * a cap at `capY` over its mouth. poly in scene-local XZ. */
  const pit = (poly: [number, number][], floor: number, capY: number, wallColor: string, open: Set<number> = new Set(), floorColor = "#8f8b84") => {
    const v = poly.map(([X, Z]) => new Vector2(X, Z));
    const ccw = signedArea(v) > 0; // in (X, Z) with Z down-screen
    const sh = new Shape(poly.map(([X, Z]) => new Vector2(X, -Z)));
    k.extrude("solid", sh, 0.3, [0, floor - 0.3, 0], floorColor, [-Math.PI / 2, 0, 0], 4);
    for (let i = 0; i < poly.length; i++) {
      if (open.has(i)) continue;
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % poly.length];
      wallXZ("solid", ax, az, bx, bz, floor - 0.3, capY, 0.4, wallColor, ccw ? -0.2 : 0.2);
    }
    capPoly(poly, capY);
  };

  // ============================================================ public space (peninsula + promenade)
  const pav = data.pavilion.map(([x, z]) => S(x, z));
  const pc: [number, number] = [pav.reduce((a, p) => a + p[0], 0) / 4, pav.reduce((a, p) => a + p[1], 0) / 4];
  const e01 = [pav[1][0] - pav[0][0], pav[1][1] - pav[0][1]];
  const e12 = [pav[2][0] - pav[1][0], pav[2][1] - pav[1][1]];
  const long01 = Math.hypot(e01[0], e01[1]) > Math.hypot(e12[0], e12[1]);
  const ex = long01 ? e12 : e01; // short edge → local x
  let pry = Math.atan2(-ex[1], ex[0]);
  if (Math.cos(pry) < 0) pry += Math.PI; // local -z points (contract) north
  const HX = Math.min(Math.hypot(e01[0], e01[1]), Math.hypot(e12[0], e12[1])) / 2;
  const HZ = Math.max(Math.hypot(e01[0], e01[1]), Math.hypot(e12[0], e12[1])) / 2;
  /** pavilion local (lx, lz) → scene-local (X, Z) */
  const PV = (lx: number, lz: number): [number, number] => [pc[0] + lx * Math.cos(pry) + lz * Math.sin(pry), pc[1] - lx * Math.sin(pry) + lz * Math.cos(pry)];
  const PVc = (lx: number, lz: number): XZ => {
    const [X, Z] = PV(lx, lz);
    return [X + cx, cz - Z];
  };
  // escalator well in the pavilion (local rect)
  const WELL = { x0: -6.6, x1: 0.6, z0: -6.4, z1: 6.2 };
  const wellC: XZ[] = [PVc(WELL.x0, WELL.z0), PVc(WELL.x1, WELL.z0), PVc(WELL.x1, WELL.z1), PVc(WELL.x0, WELL.z1)];

  const PAVING = "#bdb7ab";
  slab("solid", data.realm, -0.05, PLAZA_Y, PAVING, [wellC]);
  // paving bands (darker granite strips across the space)
  for (const poly of [data.realm]) {
    let minx = Infinity;
    let maxx = -Infinity;
    for (const [x] of poly) {
      minx = Math.min(minx, x);
      maxx = Math.max(maxx, x);
    }
    for (let x = Math.ceil(minx / 6) * 6; x < maxx; x += 6) {
      // sample a band along z where inside the polygon
      let zs: number[] = [];
      for (let z = 150; z < 330; z += 0.75) if (pointInPoly(x, z, poly) && !pointInPoly(x, z, wellC)) zs.push(z);
      if (zs.length < 3) continue;
      // split into runs
      let start = zs[0];
      for (let i = 1; i <= zs.length; i++) {
        if (i === zs.length || zs[i] - zs[i - 1] > 1) {
          const end = zs[i - 1];
          if (end - start > 2) {
            const [X, Z0] = S(x, start + 0.4);
            const [, Z1] = S(x, end - 0.4);
            k.box("solid", 0.45, 0.01, Math.abs(Z1 - Z0), X, PLAZA_Y + 0.012, (Z0 + Z1) / 2, "#9d978c");
          }
          if (i < zs.length) start = zs[i];
        }
      }
      zs = [];
    }
  }
  // granite kerbs on the road edges, a darker cycle track just inside them
  {
    const poly = data.realm;
    const area = signedArea(poly.map(([x, z]) => new Vector2(x, z)));
    for (let i = 0; i < poly.length; i++) {
      if (!data.realmRoadEdge[i]) continue;
      const [ax0, az0] = poly[i];
      const [bx0, bz0] = poly[(i + 1) % poly.length];
      const l = Math.hypot(bx0 - ax0, bz0 - az0);
      if (l < 0.3) continue;
      const nx = ((area > 0 ? -1 : 1) * (bz0 - az0)) / l; // inward normal (contract)
      const nz = ((area > 0 ? 1 : -1) * (bx0 - ax0)) / l;
      const [ax, az] = S(ax0 + nx * 0.15, az0 + nz * 0.15);
      const [bx, bz] = S(bx0 + nx * 0.15, bz0 + nz * 0.15);
      wallXZ("solid", ax, az, bx, bz, -0.05, PLAZA_Y + 0.012, 0.3, "#d6d2c8");
    }
  }

  // ============================================================ the pavilion
  const PY = PLAZA_Y;
  const GH = 5.6; // glazing height
  const CY0 = 6.0; // canopy underside
  const CY1 = 7.1; // canopy top
  const GX = HX - 1.0; // glazing line
  const GZ = HZ - 1.0;
  const OX = HX + 3.2; // canopy overhang
  const OZ = HZ + 3.4;
  const doors = { n: [-5.4, 0.6] as [number, number], w: [-3.5, 2.5] as [number, number], s: [-1, 5] as [number, number] };
  k.at(pc[0], 0, pc[1], pry, () => {
    // floor inside: polished stone
    k.slab("solid", -GX, GX, PY, PY + 0.02, -GZ, WELL.z0, "#d9d5cc");
    k.slab("solid", WELL.x1, GX, PY, PY + 0.02, WELL.z0, GZ, "#d9d5cc");
    k.slab("solid", -GX, WELL.x0, PY, PY + 0.02, WELL.z0, GZ, "#d9d5cc");
    k.slab("solid", WELL.x0, WELL.x1, PY, PY + 0.02, WELL.z1, GZ, "#d9d5cc");
    // glazing: transparent panes between steel mullions, gaps at the doors
    const glassLocal: { l: number; mm: Matrix4 }[] = [];
    const pane = (x0: number, z0: number, x1: number, z1: number) => {
      const l = Math.hypot(x1 - x0, z1 - z0);
      if (l < 0.1) return;
      const mm = new Matrix4().compose(new Vector3((x0 + x1) / 2, PY + GH / 2, (z0 + z1) / 2), new Quaternion().setFromAxisAngle(UP, Math.atan2(-(z1 - z0), x1 - x0)), new Vector3(1, 1, 1));
      glassLocal.push({ l, mm });
    };
    const face = (ax: number, az: number, bx: number, bz: number, gap?: [number, number]) => {
      const l = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / l;
      const uz = (bz - az) / l;
      const n = Math.round(l / 1.6);
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * l;
        k.box("metal", 0.12, GH, 0.22, ax + ux * t, PY + GH / 2, az + uz * t, "#3a3833", [0, Math.atan2(-uz, ux), 0]);
      }
      // transom
      k.box("metal", l, 0.12, 0.2, (ax + bx) / 2, PY + 3.1, (az + bz) / 2, "#3a3833", [0, Math.atan2(-uz, ux), 0]);
      const seg = (t0: number, t1: number) => pane(ax + ux * t0, az + uz * t0, ax + ux * t1, az + uz * t1);
      if (!gap) seg(0, l);
      else {
        // along-face coordinate of the gap: faces are given so that gap is measured from the face centre
        const g0 = l / 2 + gap[0];
        const g1 = l / 2 + gap[1];
        seg(0, g0);
        seg(g1, l);
        // door frame
        k.box("metal", g1 - g0, 0.25, 0.3, ax + ux * ((g0 + g1) / 2), PY + 3.0, az + uz * ((g0 + g1) / 2), "#2c2b28", [0, Math.atan2(-uz, ux), 0]);
      }
    };
    face(-GX, -GZ, GX, -GZ, doors.n); // north
    face(-GX, GZ, GX, GZ, doors.s); // south
    face(-GX, -GZ, -GX, GZ, doors.w); // west
    face(GX, -GZ, GX, GZ); // east (to the lift core)
    for (const { l, mm } of glassLocal) {
      const g = new BoxGeometry(l, GH, 0.04);
      g.applyMatrix4(mm);
      g.applyMatrix4(new Matrix4().compose(new Vector3(pc[0], 0, pc[1]), new Quaternion().setFromAxisAngle(UP, pry), new Vector3(1, 1, 1)));
      glassParts.push(g);
    }
    // the over-door panes reach only from the transom up: shrink them by re-adding solid dark door leaves
    // (doors stand open: dark thresholds + mats)
    for (const [ax, az, bx] of [
      [doors.n[0], -GZ, doors.n[1], -GZ],
      [doors.s[0], GZ, doors.s[1], GZ],
    ])
      k.slab("solid", ax, bx, PY, PY + 0.03, az - 0.6, az + 0.6, "#2b2a28");
    k.slab("solid", -GX - 0.6, -GX + 0.6, PY, PY + 0.03, doors.w[0], doors.w[1], "#2b2a28");

    // lift + stair core (bronze clad), east side
    k.rbox("paint", 4.2, CY0 - PY, 6.4, GX - 2.6, PY + (CY0 - PY) / 2, 0.5, "#6b5638", 0.08);
    k.box("glass", 1.6, 2.4, 0.06, GX - 2.6, PY + 1.3, 0.5 - 3.24, "#c9d3d6"); // lift door glazing
    k.box("glow", 0.5, 0.12, 0.04, GX - 2.6, PY + 2.75, 0.5 - 3.25, "#ffffff");
    // columns (white steel tubes) at the glazing corners and mid-points, carrying the canopy
    for (const [x, z] of [
      [-GX, -GZ], [GX, -GZ], [-GX, GZ], [GX, GZ], [-GX, 0], [GX, -GZ / 2], [0, -GZ], [0, GZ], [GX, GZ / 2],
    ])
      k.cyl("paint", 0.22, 0.22, CY0 - PY, 12, [x, PY + (CY0 - PY) / 2, z], "#e9e7e2");
    // the canopy: thick roof plate, timber slatted soffit, dark bronze fascia, downlights
    k.slab("solid", -OX, OX, CY0 + 0.15, CY1, -OZ, OZ, "#55504a");
    k.slab("solid", -OX + 0.05, OX - 0.05, CY0, CY0 + 0.15, -OZ + 0.05, OZ - 0.05, "#a8763f");
    for (let x = -OX + 0.4; x < OX - 0.2; x += 0.55) k.box("solid", 0.16, 0.12, OZ * 2 - 0.4, x, CY0 - 0.05, 0, "#c48d52");
    k.slab("paint", -OX - 0.12, OX + 0.12, CY0 - 0.12, CY1 + 0.25, -OZ - 0.12, -OZ, "#4a3d2c");
    k.slab("paint", -OX - 0.12, OX + 0.12, CY0 - 0.12, CY1 + 0.25, OZ, OZ + 0.12, "#4a3d2c");
    k.slab("paint", -OX - 0.12, -OX, CY0 - 0.12, CY1 + 0.25, -OZ, OZ, "#4a3d2c");
    k.slab("paint", OX, OX + 0.12, CY0 - 0.12, CY1 + 0.25, -OZ, OZ, "#4a3d2c");
    for (let x = -OX + 1.6; x < OX - 1; x += 3.2)
      for (let z = -OZ + 1.6; z < OZ - 1; z += 3.2) k.cyl("glow", 0.22, 0.22, 0.04, 10, [x, CY0 - 0.13, z], "#ffe3b8");
    // warm cove light round the soffit edge
    k.slab("glow", -OX + 0.2, OX - 0.2, CY0 - 0.14, CY0 - 0.1, -OZ + 0.2, -OZ + 0.3, "#ffd9a0");
    k.slab("glow", -OX + 0.2, OX - 0.2, CY0 - 0.14, CY0 - 0.1, OZ - 0.3, OZ - 0.2, "#ffd9a0");
    // roof garden: planting beds, gravel paths, a skylight over the well, glass balustrade
    k.slab("solid", -OX + 0.4, OX - 0.4, CY1, CY1 + 0.05, -OZ + 0.4, OZ - 0.4, "#9c9a92");
    const beds: [number, number, number, number][] = [
      [-OX + 0.8, -1.2, -OZ + 0.8, -OZ + 6],
      [1.2, OX - 0.8, -OZ + 0.8, -OZ + 7.5],
      [-OX + 0.8, -8, -2, OZ - 0.8],
      [2.5, OX - 0.8, 1, OZ - 0.8],
      [-6.5, 1.5, 8, OZ - 0.8],
    ];
    for (const [x0, x1, z0, z1] of beds) {
      k.slab("solid", x0, x1, CY1, CY1 + 0.55, z0, z1, "#6f6a61");
      k.slab("solid", x0 + 0.15, x1 - 0.15, CY1 + 0.55, CY1 + 0.6, z0 + 0.15, z1 - 0.15, "#4f3d2a");
      const n = Math.max(2, Math.floor(((x1 - x0) * (z1 - z0)) / 2.2));
      for (let i = 0; i < n; i++) {
        const x = x0 + 0.5 + r() * (x1 - x0 - 1);
        const z = z0 + 0.5 + r() * (z1 - z0 - 1);
        const s = 0.4 + r() * 0.6;
        k.blob("solid", s, 1, [x, CY1 + 0.6 + s * 0.6, z], ["#5d8c3e", "#6a9a46", "#47722f", "#7aa255", "#8a9a3e"][Math.floor(r() * 5)], [1, 0.8, 1]);
      }
    }
    for (const [x, z, s] of [
      [-OX + 3, -OZ + 3, 3],
      [OX - 3, -OZ + 4, 3],
      [-OX + 3, OZ - 4, 4],
      [OX - 3.5, OZ - 3, 2],
    ] as const)
      k.at(x, CY1 + 0.55, z, s, () => drawPlaneTree(k, 70 + s, 4.5));
    // skylight lantern over the escalator well
    k.slab("metal", WELL.x0 + 0.5, WELL.x1 - 0.5, CY1, CY1 + 0.9, WELL.z0 + 1.5, WELL.z1 - 3.5, "#3a3833");
    k.slab("glass", WELL.x0 + 0.6, WELL.x1 - 0.6, CY1 + 0.9, CY1 + 1.0, WELL.z0 + 1.6, WELL.z1 - 3.6, "#d8c9a8");
    // glass balustrade
    for (const [ax, az, bx, bz] of [
      [-OX, -OZ, OX, -OZ],
      [-OX, OZ, OX, OZ],
      [-OX, -OZ, -OX, OZ],
      [OX, -OZ, OX, OZ],
    ]) {
      const l = Math.hypot(bx - ax, bz - az);
      const ry = Math.atan2(-(bz - az), bx - ax);
      k.box("glass", l, 1.1, 0.05, (ax + bx) / 2, CY1 + 0.8, (az + bz) / 2, "#a7bcc4", [0, ry, 0]);
      k.box("metal", l, 0.06, 0.1, (ax + bx) / 2, CY1 + 1.36, (az + bz) / 2, "#3a3833", [0, ry, 0]);
    }

    // ---- escalator well down to the ticket hall
    const W = WELL;
    const D = CONCOURSE_Y;
    // escalators: two (down at x=-5.2, up at x=-3.2) and a fixed stair at x=-0.9, top at z0+0.6, foot at z1-1.8
    const zt = W.z0 + 0.6;
    const zb = W.z1 - 1.8;
    for (const [x, kind] of [
      [-5.2, "esc"],
      [-3.2, "esc"],
      [-1.0, "stair"],
    ] as const) {
      const len = Math.hypot(zb - zt, PY - D);
      const ang = Math.atan2(PY - D, zb - zt);
      // treads (a sloped slab)
      k.box("metal", kind === "esc" ? 1.05 : 1.7, 0.08, len, x, (PY + D) / 2, (zt + zb) / 2, kind === "esc" ? "#5e6166" : "#b7b2a8", [ang, 0, 0]);
      // truss underneath
      k.box("solid", kind === "esc" ? 1.2 : 1.8, 0.7, len, x, (PY + D) / 2 - 0.45, (zt + zb) / 2, "#2b2c2f", [ang, 0, 0]);
      if (kind === "esc")
        for (const sx of [-0.62, 0.62]) {
          k.box("glass", 0.04, 0.9, len, x + sx, (PY + D) / 2 + 0.5, (zt + zb) / 2, "#b9c6c9", [ang, 0, 0]);
          k.box("glow", 0.06, 0.03, len, x + sx, (PY + D) / 2 + 0.05, (zt + zb) / 2, "#f2f7ff", [ang, 0, 0]);
          k.box("solid", 0.1, 0.06, len, x + sx, (PY + D) / 2 + 0.98, (zt + zb) / 2, "#141414", [ang, 0, 0]);
        }
    }
    // well walls (white enamel panels) and the ticket hall floor + gateline at the foot
    const wallC = "#e9e7e1";
    k.slab("solid", W.x0 - 0.3, W.x0, D - 0.3, PY, W.z0, W.z1, wallC);
    k.slab("solid", W.x1, W.x1 + 0.3, D - 0.3, PY, W.z0, W.z1, wallC);
    k.slab("solid", W.x0, W.x1, D - 0.3, PY, W.z0 - 0.3, W.z0, wallC);
    k.slab("solid", W.x0, W.x1, D - 0.3, PY, W.z1, W.z1 + 0.3, wallC);
    k.slab("solid", W.x0, W.x1, D - 0.3, D, W.z0, W.z1, "#cfc8bb");
    for (let i = 0; i < 4; i++) {
      const x = W.x0 + 1 + i * 1.6;
      k.box("metal", 0.25, 1.0, 1.4, x, D + 0.5, W.z1 - 0.9, "#9aa0a6");
      k.box("glow", 0.26, 0.08, 0.3, x, D + 1.02, W.z1 - 0.4, "#7cf28a");
    }
    for (let z = W.z0 + 1; z < W.z1; z += 2.4) k.box("glow", 6.6, 0.04, 0.25, (W.x0 + W.x1) / 2, D + 3.0, z, "#fbfbff");
    k.box("glow", W.x1 - W.x0 - 0.4, 0.5, 0.05, (W.x0 + W.x1) / 2, D + 2.4, W.z1 - 0.02, "#ffffff");
  });
  {
    // cap over the escalator well, signage on the canopy fascia (atlas), roundels on the canopy corners
    capPoly([PV(WELL.x0, WELL.z0), PV(WELL.x1, WELL.z0), PV(WELL.x1, WELL.z1), PV(WELL.x0, WELL.z1)], PLAZA_Y + 0.025);
    const fasciaY = (CY0 + CY1 + 0.1) / 2;
    const faceSign = (lx: number, lz: number, ry: number, w: number, text: string) => {
      const [X, Z] = PV(lx, lz);
      sign(SIGNS.letters(text, 1024, 96), w, w * (96 / 1024), X, fasciaY, Z, pry + ry);
    };
    faceSign(0, -OZ - 0.14, Math.PI, 15, "OLD STREET STATION");
    faceSign(0, OZ + 0.14, 0, 15, "OLD STREET STATION");
    faceSign(-OX - 0.14, 0, -Math.PI / 2, 16, "OLD STREET STATION");
    faceSign(OX + 0.14, 0, Math.PI / 2, 12, "UNDERGROUND · NATIONAL RAIL");
    for (const [lx, lz, ry] of [
      [-OX + 1.1, -OZ - 0.16, Math.PI],
      [OX - 1.1, -OZ - 0.16, Math.PI],
      [-OX + 1.1, OZ + 0.16, 0],
      [OX - 1.1, OZ + 0.16, 0],
    ] as const) {
      const [X, Z] = PV(lx, lz);
      sign(SIGNS.underground(), 1.9, 1.9, X, CY1 + 1.25, Z, pry + ry, true);
    }
    // a roundel "totem" at each pavilion door
    for (const [lx, lz] of [
      [doors.n[1] + 1.5, -OZ + 0.5],
      [-OX + 0.5, doors.w[1] + 1.4],
      [doors.s[1] + 1.5, OZ - 0.5],
    ] as const) {
      const [X, Z] = PV(lx, lz);
      k.at(X, PLAZA_Y, Z, pry, () => drawRoundelPost(k, "Old Street", 3.2));
    }
    pools.push({ x: pc[0], z: pc[1], r: Math.max(OX, OZ) + 4, y: PLAZA_Y + 0.03 });
  }

  // ============================================================ St Agnes Well (sunken walk), Exit 4
  const pitC: XZ[] = [
    [-969.5, 280.75], [-959.0, 282.8], [-947.4, 284.9], [-943.3, 287.2], [-940.6, 290.1], [-938.5, 293.2], [-936.8, 295.6],
    [-934.4, 299.2], [-930.6, 304.6], [-932.6, 306.0], [-936.4, 300.6], [-939.0, 296.9], [-942.7, 292.1], [-945.4, 289.6],
    [-949.1, 287.6], [-965.6, 284.7], [-970.1, 284.0],
  ];
  const pitS = pitC.map(([x, z]) => S(x, z));
  // the tunnel mouth into the concourse is on edge 4 (-940.6,290.1)→(-938.5,293.2); the west end (edge 16) is the stair
  pit(pitS, PIT_Y, 0.2, "#b9b4aa", new Set([4, 16]), "#a39d93");
  {
    // tunnel: a short lit passage heading ESE under the peninsula
    const [ax, az] = S(-940.6, 290.1);
    const [bx, bz] = S(-938.5, 293.2);
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const [tx, tz] = S(-925.3, 287.4);
    const dx = tx - mx;
    const dz = tz - mz;
    const l = Math.hypot(dx, dz);
    const ry = Math.atan2(-dz, dx); // local +x along the tunnel
    k.at(mx, 0, mz, ry, () => {
      const w = 3.6;
      k.slab("solid", 0, l, PIT_Y - 0.3, PIT_Y, -w / 2, w / 2, "#b0aaa0");
      k.slab("solid", 0, l, PIT_Y + 3.0, 0.15, -w / 2 - 0.3, w / 2 + 0.3, "#3a3b3e");
      k.slab("solid", 0, l, PIT_Y - 0.3, PIT_Y + 3.0, -w / 2 - 0.3, -w / 2, "#efece6");
      k.slab("solid", 0, l, PIT_Y - 0.3, PIT_Y + 3.0, w / 2, w / 2 + 0.3, "#efece6");
      k.slab("solid", l, l + 0.3, PIT_Y - 0.3, PIT_Y + 3.0, -w / 2, w / 2, "#efece6");
      for (let x = 1; x < l; x += 2.2) k.box("glow", 0.25, 0.04, w - 0.6, x, PIT_Y + 2.95, 0, "#f5f8ff");
      // lintel with the roundel band over the opening
      k.slab("solid", -0.35, 0.05, PIT_Y + 3.0, 0.2, -w / 2 - 0.6, w / 2 + 0.6, "#2e2f33");
    });
    const [sx, sz] = [mx - (dx / l) * 0.4, mz - (dz / l) * 0.4];
    sign(SIGNS.fascia("Old Street Station · Northern line", 1024, 96), 4.4, 0.42, sx, PIT_Y + 3.35, sz, Math.atan2(-dx, -dz));
    // back wall of the passage: a lit poster wall (the concourse beyond)
    const [ex2, ez2] = [mx + (dx / l) * (l - 0.05), mz + (dz / l) * (l - 0.05)];
    sign(SIGNS.shop("WAY OUT · EXIT 4 / 5 / 6", "#0019a8"), 3.2, 0.6, ex2, PIT_Y + 2.3, ez2, Math.atan2(-dx, -dz));
  }
  // Exit 4 stair (metal, up from the walk to City Road), and the west stair up to the promenade
  const stair = (bot: XZ, top: XZ, width: number, color: string, y0: number, y1: number) => {
    const [ax, az] = S(...bot);
    const [bx, bz] = S(...top);
    const l = Math.hypot(bx - ax, bz - az);
    const n = Math.max(4, Math.round((y1 - y0) / 0.17));
    const ry = Math.atan2(-(bz - az), bx - ax);
    k.at(ax, 0, az, ry, () => {
      for (let i = 0; i < n; i++) {
        const x0 = (i / n) * l;
        k.slab("solid", x0, l, y0, y0 + ((i + 1) / n) * (y1 - y0), -width / 2, width / 2, i % 2 ? color : "#8d8880");
      }
      // nosing lights
      k.box("glow", l, 0.05, 0.05, l / 2, (y0 + y1) / 2 + 0.95, -width / 2 + 0.05, "#fff4dc", [0, 0, Math.atan2(y1 - y0, l)]);
    });
  };
  stair([-935.6, 299.6], [-931.4, 305.5], 2.4, "#6b6e72", PIT_Y, 0);
  stair([-959.5, 283.6], [-969.8, 282.4], 3.4, "#a39d93", PIT_Y, PLAZA_Y);
  // shop units along the south wall of the walk (under the promenade), lit fronts + fascias
  {
    const shops: [string, string][] = [
      ["FLOWERS", "#2f6b3a"],
      ["COFFEE", "#7a4a2a"],
      ["NEWS · SNACKS", "#20356b"],
      ["KEY CUTTING", "#5a2a5e"],
    ];
    const runs: [XZ, XZ][] = [
      [[-959.0, 282.8], [-947.4, 284.9]],
      [[-965.6, 284.7], [-949.1, 287.6]],
    ];
    let si = 0;
    const shopSigns: { name: string; col: string; x: number; ax: number; az: number; ry: number; side: number }[] = [];
    runs.forEach(([a, b], ri) => {
      const [ax, az] = S(...a);
      const [bx, bz] = S(...b);
      const l = Math.hypot(bx - ax, bz - az);
      const ry = Math.atan2(-(bz - az), bx - ax);
      const side = ri === 0 ? -1 : 1; // which side of the wall faces into the walk (local z)
      k.at(ax, 0, az, ry, () => {
        for (let x = 1.2; x + 3.6 < l; x += 4.4) {
          const zf = side * -0.02;
          k.slab("glass", x, x + 3.4, PIT_Y + 0.05, PIT_Y + 2.6, zf - 0.03, zf + 0.03, "#ffd9a0");
          k.slab("metal", x - 0.1, x, PIT_Y, PIT_Y + 3.2, zf - 0.08, zf + 0.08, "#2a2a2a");
          k.slab("metal", x + 3.4, x + 3.5, PIT_Y, PIT_Y + 3.2, zf - 0.08, zf + 0.08, "#2a2a2a");
          const [name, col] = shops[si++ % shops.length];
          shopSigns.push({ name, col, x: x + 1.7, ax, az, ry, side });
        }
      });
    });
    for (const s of shopSigns) {
      const lz = s.side * -0.12;
      const X = s.ax + Math.cos(s.ry) * s.x + Math.sin(s.ry) * lz;
      const Z = s.az - Math.sin(s.ry) * s.x + Math.cos(s.ry) * lz;
      sign(SIGNS.shop(s.name, s.col), 3.2, 0.5, X, PIT_Y + 2.95, Z, s.ry + (s.side > 0 ? Math.PI : 0));
    }
  }
  // railings round the walk's mouth (and both sides of the Exit 4 stair)
  for (let i = 0; i < pitS.length; i++) {
    if (i === 16) continue;
    const [ax, az] = pitS[i];
    const [bx, bz] = pitS[(i + 1) % pitS.length];
    const l = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / l;
    const uz = (bz - az) / l;
    const ry = Math.atan2(-uz, ux);
    const area = signedArea(pitS.map(([X, Z]) => new Vector2(X, Z)));
    const o = area > 0 ? -0.35 : 0.35;
    const ox = uz * o;
    const oz = -ux * o;
    k.box("solid", l, 0.5, 0.35, (ax + bx) / 2 + ox, 0.25, (az + bz) / 2 + oz, "#bcb7ad", [0, ry, 0]);
    k.box("metal", l, 0.05, 0.06, (ax + bx) / 2 + ox, 1.15, (az + bz) / 2 + oz, "#2d3034", [0, ry, 0]);
    for (let t = 0; t <= l; t += 1.4) k.box("metal", 0.05, 0.65, 0.05, ax + ux * t + ox, 0.82, az + uz * t + oz, "#2d3034");
  }
  // Grind's round kiosk at the top of the walk
  {
    const g = data.grind.map(([x, z]) => S(x, z));
    const gx = g.reduce((a, p) => a + p[0], 0) / g.length;
    const gz = g.reduce((a, p) => a + p[1], 0) / g.length;
    const rr = Math.max(...g.map(([X, Z]) => Math.hypot(X - gx, Z - gz)));
    k.cyl("glass", rr - 0.2, rr - 0.2, 3.0, 24, [gx, 1.6, gz], "#ffcf8a");
    k.cyl("solid", rr + 0.4, rr + 0.4, 0.5, 24, [gx, 3.35, gz], "#1d1d1f");
    k.cyl("solid", rr, rr, 0.12, 24, [gx, 0.06, gz], "#8a857c");
    sign(SIGNS.letters("GRIND", 512, 128, "#ffffff"), 2.8, 0.7, gx, 3.35, gz + rr + 0.42, 0);
  }

  // ============================================================ Exit 2 stair house + lift houses
  {
    const h = data.exit2House.map(([x, z]) => S(x, z));
    // rectangle: find bounds in its own frame (axis-aligned enough)
    const xs = h.map((p) => p[0]);
    const zs = h.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const z0 = Math.min(...zs);
    const z1 = Math.max(...zs);
    const zm = (z0 + z1) / 2;
    // the stair drops westward (−X) from the open east end
    pit([[x0 + 0.3, z0 + 0.3], [x1 - 0.2, z0 + 0.3], [x1 - 0.2, z1 - 0.3], [x0 + 0.3, z1 - 0.3]], -4.0, 0.03, "#e9e7e1");
    const n = 22;
    for (let i = 0; i < n; i++) {
      const xa = x1 - 0.2 - ((x1 - x0 - 0.5) * (i + 1)) / n;
      k.slab("solid", x0 + 0.3, xa + (x1 - x0 - 0.5) / n, -4.0, -((i + 1) / n) * 4.0 + 0.0, z0 + 0.3, z1 - 0.3, i % 2 ? "#8d8880" : "#9a958c");
    }
    // enclosure: glass walls on the long sides, a light steel roof, open east end
    for (const z of [z0, z1]) {
      k.box("glass", x1 - x0, 2.6, 0.06, (x0 + x1) / 2, 1.3, z, "#a9c3cf");
      k.box("metal", x1 - x0, 0.1, 0.12, (x0 + x1) / 2, 2.65, z, "#3b3e42");
    }
    k.box("solid", 0.3, 2.7, z1 - z0, x0, 1.35, zm, "#3b3e42");
    k.slab("metal", x0 - 0.3, x1 + 0.8, 2.7, 2.95, z0 - 0.3, z1 + 0.3, "#3b3e42");
    k.slab("glow", x0, x1 + 0.5, 2.66, 2.7, zm - 0.15, zm + 0.15, "#f8f6ef");
    sign(SIGNS.fascia("Old Street · Exit 2", 768, 96), 4.0, 0.5, x1 + 0.82, 2.82, zm, Math.PI / 2);
    k.at(x1 + 1.2, 0, z1 + 0.9, Math.PI / 2, () => drawRoundelPost(k, "Old Street", 3.0));
  }
  for (const lh of data.liftHouses) {
    const h = lh.map(([x, z]) => S(x, z));
    const gx = h.reduce((a, p) => a + p[0], 0) / h.length;
    const gz = h.reduce((a, p) => a + p[1], 0) / h.length;
    const e = [h[1][0] - h[0][0], h[1][1] - h[0][1]];
    const ry = Math.atan2(-e[1], e[0]);
    const w = Math.hypot(e[0], e[1]);
    const d = Math.hypot(h[2][0] - h[1][0], h[2][1] - h[1][1]);
    k.at(gx, PLAZA_Y, gz, ry, () => {
      k.box("paint", w - 0.3, 3.2, d - 0.3, 0, 1.6, 0, "#9fb5ba");
      k.slab("metal", -w / 2, w / 2, 3.2, 3.5, -d / 2, d / 2, "#3a3833");
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box("metal", 0.12, 3.2, 0.12, (x * (w - 0.3)) / 2, 1.6, (z * (d - 0.3)) / 2, "#3a3833");
      k.box("solid", 1.1, 3.0, 0.9, 0, 1.6, 0, "#4b4f55"); // the car
      k.box("glow", 0.9, 0.04, 0.7, 0, 3.12, 0, "#ffffff");
    });
  }

  // ============================================================ street furniture on the public space
  const pavRect = (x: number, z: number, pad: number) => {
    // inside the canopy's footprint (+pad)? (contract coords)
    const [X, Z] = S(x, z);
    const dx = X - pc[0];
    const dz = Z - pc[1];
    const lx = dx * Math.cos(pry) - dz * Math.sin(pry);
    const lz = dx * Math.sin(pry) + dz * Math.cos(pry);
    return Math.abs(lx) < OX + pad && Math.abs(lz) < OZ + pad;
  };
  const nearPit = (x: number, z: number, pad: number) => pitC.some(([px, pz]) => Math.hypot(px - x, pz - z) < pad) || pointInPoly(x, z, pitC);
  const onPlaza = (x: number, z: number) => pointInPoly(x, z, data.realm);
  const free = (x: number, z: number, pad: number) => onPlaza(x, z) && !pavRect(x, z, pad) && !nearPit(x, z, pad + 1.5);

  // trees in raised planters with timber bench tops (peninsula + promenade)
  const treeSpots: XZ[] = [
    [-893, 249], [-889, 260], [-903, 246.5], [-928, 258], [-936, 263.8], [-940.5, 265.2], [-922, 281], [-908, 284.5],
    [-955, 265.6], [-972, 264.5], [-990, 263.5], [-1005, 262.5], [-982, 274.5], [-1000, 271.5], [-960, 276.5],
  ];
  let ti = 0;
  for (const [x, z] of treeSpots) {
    if (!free(x, z, 2.5)) continue;
    const [X, Z] = S(x, z);
    k.cyl("solid", 1.7, 1.75, 0.5, 16, [X, PLAZA_Y + 0.25, Z], "#9a958b");
    k.cyl("solid", 1.75, 1.75, 0.08, 16, [X, PLAZA_Y + 0.52, Z], "#a87b4c");
    k.cyl("solid", 1.2, 1.2, 0.06, 14, [X, PLAZA_Y + 0.55, Z], "#4c3b2a");
    k.at(X, PLAZA_Y + 0.5, Z, ti * 1.3, () => drawPlaneTree(k, 30 + ti, 9 + (ti % 3) * 1.5));
    ti++;
  }
  // cycle hire (OSM docking stations on the space)
  for (const [x, z] of data.cycleHire) {
    if (!onPlaza(x, z)) continue;
    const [X, Z] = S(x, z);
    k.at(X - 5, PLAZA_Y, Z + 1.2, 0, () => drawCycleDock(k, 12));
  }
  // benches
  for (const [x, z, a] of [
    [-946, 270.5, 0.3], [-965, 268, 0.15], [-985, 268.5, 0.15], [-900, 251, 1.0], [-918, 284.5, 0.5], [-895, 270, 1.2],
  ] as const) {
    if (!free(x, z, 1)) continue;
    const [X, Z] = S(x, z);
    k.at(X, PLAZA_Y, Z, a, () => {
      k.box("solid", 2.4, 0.08, 0.55, 0, 0.46, 0, "#a87b4c");
      k.box("solid", 2.4, 0.4, 0.06, 0, 0.75, -0.25, "#a87b4c");
      for (const sx of [-1, 1]) k.box("metal", 0.08, 0.46, 0.5, sx, 0.23, 0, "#2c2f33");
    });
  }
  // lamp columns: round the edges of the public space, inset from the kerb
  const lampAt: [number, number][] = [];
  for (const poly of [data.realm]) {
    const area = signedArea(poly.map(([x, z]) => new Vector2(x, z)));
    let acc = 8;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % poly.length];
      const l = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / l;
      const uz = (bz - az) / l;
      // inward normal (contract)
      const nx = area > 0 ? -uz : uz;
      const nz = area > 0 ? ux : -ux;
      for (let t = acc; t < l; t += 20) {
        const x = ax + ux * t + nx * 1.4;
        const z = az + uz * t + nz * 1.4;
        if (free(x, z, 1) && lampAt.every(([px, pz]) => Math.hypot(px - x, pz - z) > 12)) lampAt.push([x, z]);
        acc = t + 20 - l;
      }
      if (acc > l) acc -= l;
    }
  }
  for (const [x, z] of lampAt) {
    const [X, Z] = S(x, z);
    k.cyl("solid", 0.2, 0.24, 0.3, 10, [X, PLAZA_Y + 0.15, Z], "#2a2c30");
    k.cyl("metal", 0.08, 0.11, 7.5, 10, [X, PLAZA_Y + 3.9, Z], "#3c4046");
    k.cyl("metal", 0.32, 0.18, 0.35, 12, [X, PLAZA_Y + 7.7, Z], "#3c4046");
    k.cyl("glow", 0.26, 0.26, 0.05, 12, [X, PLAZA_Y + 7.5, Z], "#fff1d6");
    pools.push({ x: X, z: Z, r: 11, y: PLAZA_Y + 0.02 });
  }
  // bollards along the peninsula's road edges (anti-ram, stainless)
  {
    const poly = data.realm;
    const area = signedArea(poly.map(([x, z]) => new Vector2(x, z)));
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % poly.length];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 4) continue;
      const ux = (bx - ax) / l;
      const uz = (bz - az) / l;
      const nx = area > 0 ? -uz : uz;
      const nz = area > 0 ? ux : -ux;
      // only edges facing a carriageway, and only round the peninsula itself
      if (!data.realmRoadEdge[i] || !pointInPoly((ax + bx) / 2 + nx * 8, (az + bz) / 2 + nz * 8, data.peninsula)) continue;
      for (let t = 1; t < l - 0.5; t += 1.6) {
        const x = ax + ux * t + nx * 0.6;
        const z = az + uz * t + nz * 0.6;
        if (pavRect(x, z, 0)) continue;
        const [X, Z] = S(x, z);
        k.cyl("metal", 0.1, 0.1, 0.9, 8, [X, PLAZA_Y + 0.45, Z], "#a6abb0");
      }
    }
  }

  // ============================================================ the digital screens
  {
    // two double-sided screens on the peninsula, broadside to the junction's two arms
    const spots: [XZ, number][] = [
      [[-896.5, 243.0], 0], // south tip, facing Old Street W / City Road S
      [[-898.0, 282.5], 0], // north tip, facing City Road N / Old Street E
    ];
    spots.forEach(([[x, z]], i) => {
      const [X, Z] = S(x, z);
      // face toward the junction centre between the two road junctions
      const [jx, jz] = S(i === 0 ? -915 : -880, i === 0 ? 225 : 300);
      const ry = Math.atan2(jx - X, jz - Z); // local +z toward (jx, jz)
      const W = 11;
      const H = W / 4;
      const y = 6.4;
      k.at(X, PLAZA_Y, Z, ry, () => {
        for (const sx of [-W / 2 + 1.2, W / 2 - 1.2]) {
          k.rbox("metal", 0.5, y - H / 2, 0.5, sx, (y - H / 2) / 2, 0, "#2b2e33", 0.05);
          k.cyl("solid", 0.6, 0.7, 0.4, 12, [sx, 0.2, 0], "#55585d");
        }
        k.rbox("solid", W + 0.5, H + 0.5, 0.7, 0, y, 0, "#16171a", 0.08);
        k.box("glow", W + 0.3, 0.05, 0.75, 0, y + H / 2 + 0.22, 0, "#d8e6ff");
      });
      for (const s of [1, -1]) {
        const mm = new Matrix4().compose(new Vector3(X + Math.sin(ry) * 0.37 * s, PLAZA_Y + y, Z + Math.cos(ry) * 0.37 * s), new Quaternion().setFromAxisAngle(UP, ry + (s > 0 ? 0 : Math.PI)), new Vector3(1, 1, 1));
        screens.push({ m: mm, w: W, h: H });
      }
      pools.push({ x: X + Math.sin(ry) * 6, z: Z + Math.cos(ry) * 6, r: 14, y: PLAZA_Y + 0.025 });
    });
  }

  // ============================================================ lanes, signals, crossings, bus stops
  const lanes: LaneInfo[] = [];
  for (const [name, ln] of Object.entries(data.lanes)) {
    const raw = ln.pts;
    // offset to the left of travel (UK)
    const pts: V3[] = raw.map((p, i) => {
      const a = raw[Math.max(0, i - 1)];
      const b = raw[Math.min(raw.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      // left of (dx, dz) in contract (x east, z north) = (-dz, dx)
      const [X, Z] = S(p[0] + (-dz / l) * ln.off, p[1] + (dx / l) * ln.off);
      return [X, 0.14, Z];
    });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    lanes.push({ name, pts, cum, len: cum[cum.length - 1], stops: [] });
  }
  const project = (ln: LaneInfo, X: number, Z: number) => {
    let best = { s: 0, d: Infinity, tx: 1, tz: 0 };
    for (let i = 0; i < ln.pts.length - 1; i++) {
      const a = ln.pts[i];
      const b = ln.pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((X - a[0]) * dx + (Z - a[2]) * dz) / l2));
      const d = Math.hypot(X - (a[0] + dx * t), Z - (a[2] + dz * t));
      if (d < best.d) best = { s: ln.cum[i] + t * Math.sqrt(l2), d, tx: dx / Math.sqrt(l2), tz: dz / Math.sqrt(l2) };
    }
    return best;
  };
  /** Signal group of an approach: 0 = Old Street (both arms), 1 = northbound City Road, 2 = southbound City Road. */
  const groupOf = (x: number, z: number, tx: number, tz: number) => {
    // tx, tz in scene; heading in contract = (tx, -tz)
    const hx = tx;
    const hz = -tz;
    if (x < -903 && hx > 0.3 && z > 225) return 0;
    if (x > -866 && hx < -0.3) return 0;
    return hz > 0 ? 1 : 2;
  };
  const heads: SignalHead[] = [];
  const signalPts: XZ[] = [...data.signals, ...data.crossings.filter((c) => c[2] === "traffic_signals").map((c) => [c[0], c[1]] as XZ)];
  const seen: XZ[] = [];
  for (const [x, z] of signalPts) {
    if (seen.some(([a, b]) => Math.hypot(a - x, b - z) < 2)) continue;
    seen.push([x, z]);
    const [X, Z] = S(x, z);
    let hit: { ln: LaneInfo; s: number; tx: number; tz: number } | null = null;
    for (const ln of lanes) {
      const p = project(ln, X, Z);
      if (p.d < 4.2) {
        const g = groupOf(x, z, p.tx, p.tz);
        if (!ln.stops.some((st) => Math.abs(st.s - (p.s - 2.5)) < 4)) ln.stops.push({ s: p.s - 2.5, group: g });
        if (!hit) hit = { ln, s: p.s, tx: p.tx, tz: p.tz };
      }
    }
    if (!hit) continue;
    const g = groupOf(x, z, hit.tx, hit.tz);
    // pole on the near-side kerb, head facing oncoming traffic
    const lx = hit.tz;
    const lz = -hit.tx; // left of travel in scene = (tz, -tx)
    const off = 5.2;
    const PXx = X + lx * off;
    const PZz = Z + lz * off;
    const ry = Math.atan2(-hit.tx, -hit.tz);
    k.cyl("metal", 0.07, 0.08, 3.4, 8, [PXx, 1.7, PZz], "#2a2c30");
    k.at(PXx, 2.9, PZz, ry, () => {
      k.rbox("solid", 0.36, 1.05, 0.28, 0, 0, 0, "#141517", 0.04);
      k.box("solid", 0.6, 1.25, 0.03, 0, 0, -0.15, "#1d1e21");
      for (const yy of [0.33, 0, -0.33]) k.cyl("solid", 0.15, 0.15, 0.12, 8, [0, yy, 0.18], "#0b0b0c", [Math.PI / 2, 0, 0]);
      // push-button box + green man for pedestrians
      k.box("solid", 0.2, 0.3, 0.12, 0.25, -1.75, -0.05, "#e8c33a");
    });
    heads.push({ pos: [PXx + Math.sin(ry) * 0.2, 2.9, PZz + Math.cos(ry) * 0.2], ry, group: g });
  }
  for (const ln of lanes) ln.stops.sort((a, b) => a.s - b.s);

  // crossings: studs (two broken white lines) across the carriageway + stop lines, for nodes on a lane
  const crossings: Crossing[] = [];
  for (const [x, z, kind] of data.crossings) {
    const [X, Z] = S(x, z);
    let best: { ln: LaneInfo; p: ReturnType<typeof project> } | null = null;
    for (const ln of lanes) {
      const p = project(ln, X, Z);
      if (p.d < 3.5 && (!best || p.d < best.p.d)) best = { ln, p };
    }
    if (!best) continue;
    if (crossings.some((c) => Math.hypot((c.a[0] + c.b[0]) / 2 - X, (c.a[2] + c.b[2]) / 2 - Z) < 4)) continue;
    const { tx, tz } = best.p;
    const nx = tz;
    const nz = -tx;
    const half = 5.5;
    const ry = Math.atan2(-tz, tx);
    k.at(X, 0.165, Z, ry, () => {
      if (kind === "zebra") for (let t = -half; t < half; t += 1.0) k.box("solid", 2.6, 0.012, 0.5, 0, 0, t, "#f1f1ec");
      else
        for (const lx of [-1.4, 1.4])
          for (let t = -half; t < half; t += 0.75) k.box("solid", 0.18, 0.012, 0.35, lx, 0, t, "#f1f1ec");
    });
    const a: V3 = [X + nx * (half + 1), 0.2, Z + nz * (half + 1)];
    const b: V3 = [X - nx * (half + 1), 0.2, Z - nz * (half + 1)];
    crossings.push({ a, b, group: kind === "traffic_signals" ? groupOf(x, z, tx, tz) : -1 });
  }
  // stop lines at each lane stop
  for (const ln of lanes)
    for (const st of ln.stops) {
      const i = ln.cum.findIndex((c) => c > st.s);
      if (i <= 0) continue;
      const a = ln.pts[i - 1];
      const b = ln.pts[i];
      const t = (st.s - ln.cum[i - 1]) / (ln.cum[i] - ln.cum[i - 1]);
      const X = a[0] + (b[0] - a[0]) * t;
      const Z = a[2] + (b[2] - a[2]) * t;
      k.box("solid", 3.4, 0.012, 0.3, X, 0.168, Z, "#f1f1ec", [0, Math.atan2(-(b[2] - a[2]), b[0] - a[0]) + Math.PI / 2, 0]);
    }

  // bus stops: TfL shelters on the pavement, open side to the road (nearest lane, or the OSM road nearby)
  const routesFor = (name: string, bearing: string) =>
    /city road|moorfields|roundabout/i.test(name) || bearing === "N" || bearing === "S" ? ["21", "43", "76", "141", "205", "214", "271"] : ["55", "135", "243", "N55"];
  for (const st of data.busStops) {
    if (Math.hypot(st.x - cx, st.z - cz) > 210) continue;
    let best = { d: Infinity, x: 0, z: 0, tx: 1, tz: 0 };
    for (const ln of Object.values(data.lanes)) {
      const n = nearestOn(ln.pts, st.x, st.z);
      if (n[2] < best.d) best = { d: n[2], x: n[0], z: n[1], tx: n[3], tz: n[4] };
    }
    const [X, Z] = S(st.x, st.z);
    let ry: number;
    if (best.d < 14) {
      const [RX, RZ] = S(best.x, best.z);
      ry = Math.atan2(RX - X, RZ - Z);
    } else {
      ry = st.bearing === "N" ? Math.PI / 2 : st.bearing === "S" ? -Math.PI / 2 : st.bearing === "E" ? Math.PI : 0;
    }
    k.at(X, 0, Z, ry, () => drawBusStop(k, st.name.split(" / ")[0], routesFor(st.name, st.bearing)));
    // stop letter on the flag (atlas)
    const fx = X + Math.cos(ry) * -3.1 + Math.sin(ry) * 0.7;
    const fz = Z - Math.sin(ry) * -3.1 + Math.cos(ry) * 0.7;
    sign(SIGNS.busFlag(st.ref), 0.36, 0.54, fx, 3.65, fz, ry + Math.PI / 2, true);
    k.box("metal", 0.05, 0.6, 0.05, fx, 3.35, fz, "#4a4f55");
    pools.push({ x: X, z: Z, r: 6, y: 0.03 });
    for (const ln of lanes) {
      const p = project(ln, X, Z);
      if (p.d < 9 && ln.busStop === undefined && /cityN|oldE-|oldW-|cityS/.test(ln.name)) ln.busStop = p.s;
    }
  }
  adoptSigns(k.signs);

  // ============================================================ White Collar Factory
  {
    const campus = data.whiteCollar;
    // the low campus blocks (Old Street Yard), brick + steel, 6 storeys
    slab("brick", campus, 0, 21.5, "#8d6e5c");
    slab("solid", campus, 21.5, 22.2, "#6e6a63");
    // tower on the corner of Old Street and City Road (a touch proud of the campus walls)
    const tower: XZ[] = [[-917.6, 205.0], [-919.0, 223.1], [-935.3, 234.3], [-947.4, 234.3], [-947.4, 204.0]];
    const tc: [number, number] = [tower.reduce((a, p) => a + p[0], 0) / tower.length, tower.reduce((a, p) => a + p[1], 0) / tower.length];
    const scale = (f: number): XZ[] => tower.map(([x, z]) => [tc[0] + (x - tc[0]) * f, tc[1] + (z - tc[1]) * f]);
    const FLOORS = 16;
    const FH = 4.3;
    const GROUND = 6.0;
    const top = GROUND + (FLOORS - 1) * FH;
    slab("glass", scale(0.975), 0, GROUND, "#2b3237");
    slab("glass", scale(0.965), GROUND, top, "#3c4850");
    for (let f = 0; f <= FLOORS - 1; f++) {
      const y = f === 0 ? GROUND : GROUND + f * FH;
      slab("solid", scale(1.0), y - 0.55, y, "#c9c4b9"); // exposed concrete slab edge
      // a band of sills
      if (f < FLOORS - 1) slab("solid", scale(0.985), y, y + 0.9, "#b8b3a8");
    }
    // concrete columns round the perimeter
    for (let i = 0; i < tower.length; i++) {
      const [ax, az] = tower[i];
      const [bx, bz] = tower[(i + 1) % tower.length];
      const l = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(l / 6.2));
      for (let j = 0; j <= n; j++) {
        const x = ax + ((bx - ax) * j) / n;
        const z = az + ((bz - az) * j) / n;
        const [X, Z] = S(x, z);
        k.box("solid", 0.75, top, 0.75, X, top / 2, Z, "#cdc8bd");
      }
    }
    // roof: plant screen, rooftop pavilion and the running track
    slab("solid", scale(1.0), top, top + 0.6, "#bdb8ad");
    const [TX, TZ] = S(tc[0] + 1, tc[1]);
    const rr = 5.2;
    const straight = 8;
    const track = (outer: number) => {
      const sh = new Shape();
      sh.moveTo(-straight / 2, -outer);
      sh.lineTo(straight / 2, -outer);
      sh.absarc(straight / 2, 0, outer, -Math.PI / 2, Math.PI / 2, false);
      sh.lineTo(-straight / 2, outer);
      sh.absarc(-straight / 2, 0, outer, Math.PI / 2, (3 * Math.PI) / 2, false);
      return sh;
    };
    const ring = track(rr + 2.4);
    ring.holes.push(track(rr));
    k.at(TX, top + 0.6, TZ, Math.PI / 2 + 0.1, () => {
      k.extrude("solid", ring, 0.06, [0, 0, 0], "#c2523a", [-Math.PI / 2, 0, 0], 16);
      k.extrude("solid", track(rr - 0.05), 0.05, [0, 0, 0], "#6f8f4a", [-Math.PI / 2, 0, 0], 16);
      for (const o of [rr + 0.8, rr + 1.6]) {
        const l = track(o + 0.04);
        l.holes.push(track(o - 0.04));
        k.extrude("solid", l, 0.07, [0, 0, 0], "#f2efe8", [-Math.PI / 2, 0, 0], 16);
      }
    });
    // perimeter balustrade + roof pavilion
    for (let i = 0; i < tower.length; i++) {
      const [ax, az] = S(...tower[i]);
      const [bx, bz] = S(...tower[(i + 1) % tower.length]);
      wallXZ("glass", ax, az, bx, bz, top + 0.6, top + 1.8, 0.06, "#a7bcc4");
    }
    const [PXx, PZz] = S(-944, 230);
    k.box("solid", 6, 3.4, 5, PXx, top + 2.3, PZz, "#c9c4b9");
    k.box("glass", 5.6, 2.4, 5.1, PXx, top + 1.9, PZz, "#ffcf8a");
    // name over the Old Street entrance
    {
      const n = Math.hypot(11.2, 16.3);
      const [NX, NZ] = S(-927.15 + (11.2 / n) * 0.75, 228.7 + (16.3 / n) * 0.75);
      sign(SIGNS.letters("WHITE COLLAR FACTORY", 1024, 96, "#f4f1ea"), 12, 1.1, NX, GROUND - 1.2, NZ, Math.atan2(11.2 / n, -16.3 / n));
    }
  }

  // ============================================================ walking routes (station flows)
  const P3 = (x: number, z: number, y: number): V3 => {
    const [X, Z] = S(x, z);
    return [X, y, Z];
  };
  const PL3 = (lx: number, lz: number, y: number): V3 => {
    const [X, Z] = PV(lx, lz);
    return [X, y, Z];
  };
  const down = (x: number): V3[] => [PL3(x, WELL.z0 + 0.6, PLAZA_Y), PL3(x, WELL.z1 - 1.8, CONCOURSE_Y), PL3(x, WELL.z1 - 0.3, CONCOURSE_Y)];
  const entries: { chain: V3[]; origins: V3[] }[] = [
    {
      // pavilion north doors
      chain: [PL3(-2.4, -GZ - 2.5, PLAZA_Y), PL3(-2.4, -GZ, PLAZA_Y), PL3(-4.2, WELL.z0 - 0.8, PLAZA_Y), ...down(-5.2)],
      origins: [P3(-905, 284, PLAZA_Y), P3(-915, 283.5, PLAZA_Y), P3(-925, 279.5, PLAZA_Y), P3(-899, 279.5, PLAZA_Y), P3(-935, 276.5, PLAZA_Y)],
    },
    {
      // pavilion west doors
      chain: [PL3(-GX - 2.5, -0.5, PLAZA_Y), PL3(-GX, -0.5, PLAZA_Y), PL3(-7.3, WELL.z0 - 0.6, PLAZA_Y), PL3(-5.2, WELL.z0 - 0.6, PLAZA_Y), ...down(-5.2)],
      origins: [P3(-950, 266, PLAZA_Y), P3(-965, 263.5, PLAZA_Y), P3(-980, 262.5, PLAZA_Y), P3(-995, 260, PLAZA_Y), P3(-940, 272, PLAZA_Y), P3(-1003, 266, PLAZA_Y)],
    },
    {
      // pavilion south doors (from the junction tip)
      chain: [PL3(2, GZ + 2.5, PLAZA_Y), PL3(2, GZ, PLAZA_Y), PL3(1.6, WELL.z0 - 0.8, PLAZA_Y), PL3(-3.2, WELL.z0 - 0.8, PLAZA_Y), ...down(-3.2)],
      origins: [P3(-900, 247, PLAZA_Y), P3(-893, 254, PLAZA_Y), P3(-889, 263, PLAZA_Y), P3(-912, 249, PLAZA_Y), P3(-925, 256.5, PLAZA_Y)],
    },
    {
      // Exit 4: down the metal stair, along the walk, into the tunnel
      chain: [P3(-929.6, 308.4, 0.05), P3(-931.4, 305.6, 0.05), P3(-935.6, 299.6, PIT_Y), P3(-937.6, 295.6, PIT_Y), P3(-938.5, 291.8, PIT_Y), P3(-931, 289.4, PIT_Y), P3(-928, 288.3, PIT_Y)],
      origins: [P3(-933.5, 318, 0.05), P3(-938, 333, 0.05), P3(-944, 352, 0.05), P3(-952, 306, 0.05), P3(-966, 298, 0.05), P3(-930, 312, 0.05)],
    },
    {
      // St Agnes Well from the promenade, down the west stair
      chain: [P3(-972, 282.0, PLAZA_Y), P3(-969.6, 282.4, PLAZA_Y), P3(-959.5, 283.6, PIT_Y), P3(-947.6, 286.6, PIT_Y), P3(-941.6, 289.9, PIT_Y), P3(-938.5, 291.8, PIT_Y), P3(-931, 289.4, PIT_Y), P3(-928, 288.3, PIT_Y)],
      origins: [P3(-985, 276, PLAZA_Y), P3(-1000, 273, PLAZA_Y), P3(-1012, 270, PLAZA_Y), P3(-990, 267, PLAZA_Y)],
    },
    {
      // Exit 2 (south-east corner): into the stair house and down
      chain: [P3(-856.5, 232.4, 0.05), P3(-859.6, 232.4, 0.05), P3(-868.4, 232.3, -3.9), P3(-868.6, 232.3, -4.0)],
      origins: [P3(-851, 236.5, 0.05), P3(-842, 238.5, 0.05), P3(-858, 245, 0.05), P3(-852, 254, 0.05), P3(-866, 238.5, 0.05), P3(-873, 240, 0.05)],
    },
  ];
  const routes = { in: entries.map((e) => routeOf(e.chain)), origins: entries.map((e) => e.origins) };
  // through-walkers on the public space
  const strolls = [
    [P3(-1008, 263, PLAZA_Y), P3(-960, 268, PLAZA_Y), P3(-938, 275.5, PLAZA_Y), P3(-918, 281.5, PLAZA_Y), P3(-901, 282, PLAZA_Y), P3(-891, 275.5, PLAZA_Y)],
    [P3(-1008, 259.5, PLAZA_Y), P3(-968, 263.5, PLAZA_Y), P3(-944, 265.5, PLAZA_Y), P3(-930, 260.5, PLAZA_Y), P3(-916, 250.5, PLAZA_Y), P3(-901, 245, PLAZA_Y)],
    [P3(-891, 263, PLAZA_Y), P3(-893.5, 250, PLAZA_Y), P3(-903, 245.5, PLAZA_Y), P3(-925, 257.5, PLAZA_Y), P3(-938, 266, PLAZA_Y)],
  ].map(routeOf);

  const parts = k.bake({ ao: 0 });
  const glass = mergeGeometries(glassParts, false) ?? new BufferGeometry();
  glassParts.forEach((g) => g.dispose());
  const cap = mergeGeometries(capParts, false) ?? new BufferGeometry();
  capParts.forEach((g) => g.dispose());
  const signs = atlas.mesh("old-street-signs");
  return { parts, signs, glass, cap, screens, pools, heads, lanes, crossings, routes, strolls, label: [pc[0], 34, pc[1]] };
}

