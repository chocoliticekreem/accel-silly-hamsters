// Module: Construction (decorative only). Turns the Goodsyard void into a live building site: tower cranes that lift
// steel, bricks, concrete skips and window panels from the laydown area or a delivery lorry up to the deck of a
// concrete-frame building that grows a storey at a time over the run, scaffolding and netting on its top floors,
// a gang in hi-vis on site during working hours, flatbed deliveries through the gate, floodlights at dusk and red
// aviation lights blinking at night. Idle cranes weather-vane with the wind.
// Day/hour state (working hours, deliveries, storeys) comes from the sim clock (sim/construction.ts); motion within
// a lift runs in real time so it reads the same at 1×/10×/100×. Above 1× lorries snap to their state.
// Draw calls: a merged crane-mast mesh, one slewing unit per crane, and instanced everything else (~25 total).
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rng, seedOf } from "../../mock/rng";
import {
  angleDelta,
  approach,
  approachAngle,
  buildProgress,
  columnFrac,
  cranePose,
  CYCLE_S,
  deckHeight,
  deliveryAt,
  FLOOR_H,
  LEVELS,
  LOAD_KINDS,
  newPendulum,
  planSite,
  roofFrac,
  siteState,
  slabCount,
  SLAB_T,
  stepPendulum,
  windAngle,
  workersPresent,
  type CraneJob,
  type CranePose,
  type LoadKind,
  type P2,
  type SiteLayout,
} from "../../sim/construction";
import { polyline, newPoint, type Polyline } from "../../sim/polyline";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";

const noRaycast = () => null;
const S = (p: P2): [number, number] => [p.x, -p.z];

const YELLOW = "#e8b32a";
const YELLOW_DK = "#c48f17";
const CONCRETE = "#b9b6ae";
const SLING = 2.2;
const WORKERS = 26;
const WORKER_SCALE = 1.5;
const LORRY_SPEED = 11;

// ---------------------------------------------------------------- geometry helpers

function tint(g: BufferGeometry, color: string): BufferGeometry {
  const c = new Color(color);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new BufferAttribute(a, 3));
  return g;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string) => tint(new BoxGeometry(w, h, d).translate(x, y, z), color);

const UP = new Vector3(0, 1, 0);
const SIDE = new Vector3(1, 0, 0);
/** A square-section member from a to b. */
function member(a: [number, number, number], b: [number, number, number], t: number, color: string): BufferGeometry {
  const va = new Vector3(...a);
  const vb = new Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new BoxGeometry(t, t, len);
  const dir = vb.clone().sub(va).normalize();
  const m = new Matrix4().lookAt(va, vb, Math.abs(dir.dot(UP)) > 0.99 ? SIDE : UP);
  m.setPosition(va.add(vb).multiplyScalar(0.5));
  return tint(g.applyMatrix4(m), color);
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

/** Lattice mast, origin at the foot. */
function mastParts(h: number): BufferGeometry[] {
  const a = 0.95;
  const sec = 2.5;
  const out: BufferGeometry[] = [box(6, 0.8, 6, 0, 0.4, 0, "#8f8c85")];
  const corners: [number, number][] = [
    [-a, -a],
    [a, -a],
    [a, a],
    [-a, a],
  ];
  for (const [x, z] of corners) out.push(member([x, 0.8, z], [x, h, z], 0.22, YELLOW));
  let flip = false;
  for (let y = 0.8; y < h - 0.1; y += sec) {
    const y2 = Math.min(h, y + sec);
    for (let f = 0; f < 4; f++) {
      const [x1, z1] = corners[f];
      const [x2, z2] = corners[(f + 1) % 4];
      out.push(member([x1, y, z1], [x2, y, z2], 0.1, YELLOW));
      out.push(flip ? member([x1, y, z1], [x2, y2, z2], 0.09, YELLOW) : member([x2, y, z2], [x1, y2, z1], 0.09, YELLOW));
    }
    flip = !flip;
  }
  // cab access platform at the top
  out.push(box(3, 0.12, 3, 0, h - 0.4, 0, "#5d5d5d"));
  return out;
}

/** Slewing unit: turntable, cat-head, jib, counter-jib with weights and winch, pendants, cab. Origin at mast top, jib along +x. */
function slewingGeo(jib: number): { geo: BufferGeometry; lights: [number, number, number][] } {
  const out: BufferGeometry[] = [];
  const cj = Math.round(jib * 0.32);
  out.push(box(2.4, 0.8, 2.4, 0, 0.4, 0, YELLOW_DK));
  // cat-head
  const apex: [number, number, number] = [0, 7.2, 0];
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ])
    out.push(member([x, 0.8, z], apex, 0.22, YELLOW));
  // jib: triangular lattice, two bottom chords (the trolley runs on them) and a top chord
  const b = 0.85;
  const yb = 0.9;
  const topAt = (x: number): number => 2.7 - (0.9 * (x - 1.2)) / (jib - 1.2);
  out.push(member([1.2, yb, -b], [jib, yb, -b], 0.2, YELLOW));
  out.push(member([1.2, yb, b], [jib, yb, b], 0.2, YELLOW));
  out.push(member([1.2, topAt(1.2), 0], [jib, topAt(jib), 0], 0.2, YELLOW));
  for (let x = 1.2; x < jib - 0.1; x += 2.5) {
    const xm = Math.min(jib, x + 1.25);
    const x2 = Math.min(jib, x + 2.5);
    for (const z of [-b, b]) {
      out.push(member([x, yb, z], [xm, topAt(xm), 0], 0.1, YELLOW));
      out.push(member([xm, topAt(xm), 0], [x2, yb, z], 0.1, YELLOW));
    }
    out.push(member([x, yb, -b], [x, yb, b], 0.1, YELLOW));
  }
  out.push(box(0.3, 1.9, 1.9, jib, 1.6, 0, YELLOW));
  // counter-jib: flat frame with walkway, ballast slabs at the tail and the hoist winch
  const c = 1.1;
  out.push(member([-1.2, 1, -c], [-cj, 1, -c], 0.24, YELLOW));
  out.push(member([-1.2, 1, c], [-cj, 1, c], 0.24, YELLOW));
  for (let x = -1.2; x > -cj; x -= 2) out.push(member([x, 1, -c], [x, 1, c], 0.12, YELLOW));
  out.push(box(cj - 1.2, 0.08, 2.0, -(cj + 1.2) / 2, 1.12, 0, "#6c6c6c"));
  for (const z of [-c, c]) out.push(member([-1.2, 2.1, z], [-cj, 2.1, z], 0.05, YELLOW));
  for (let k = 0; k < 4; k++) out.push(box(0.7, 3.2, 2.5, -cj + 0.5 + k * 0.78, 0.2, 0, k % 2 ? "#a19e96" : "#8f8c85"));
  out.push(box(1.8, 1.3, 1.6, -cj + 5.5, 1.75, 0, "#4f5d6b"));
  // pendants (tie bars) from the cat-head
  out.push(member(apex, [jib * 0.62, topAt(jib * 0.62), 0], 0.08, "#3a3a3a"));
  out.push(member(apex, [jib * 0.3, topAt(jib * 0.3), 0], 0.08, "#3a3a3a"));
  for (const z of [-c, c]) out.push(member(apex, [-cj + 1, 1.1, z], 0.08, "#3a3a3a"));
  // operator cab on the slewing ring, hung to one side
  out.push(box(1.9, 2.1, 1.8, 1.2, 0.1, 2.1, "#eeeae0"));
  out.push(box(0.1, 1.1, 1.5, 2.16, 0.4, 2.1, "#22303a"));
  out.push(box(1.6, 0.9, 0.1, 1.2, 0.4, 3.01, "#22303a"));
  return {
    geo: merge(out),
    lights: [
      [apex[0], apex[1] + 0.35, apex[2]],
      [jib, 2.7, 0],
      [-cj + 0.5, 2.0, 0],
    ],
  };
}

function trolleyGeo(): BufferGeometry {
  return merge([box(1.7, 0.45, 2.0, 0, 0.55, 0, YELLOW_DK), box(0.5, 0.35, 0.9, 0, 0.18, 0, "#3a3a3a")]);
}

/** Hook block, origin at the hook (where slings hang). */
function hookGeo(): BufferGeometry {
  return merge([box(0.85, 0.9, 0.5, 0, 0.95, 0, YELLOW), box(0.9, 0.16, 0.55, 0, 1.45, 0, "#2b2b2b"), box(0.16, 0.5, 0.16, 0, 0.3, 0, "#333")]);
}

/** Four slings from the hook to the corners of a 1×1 load top (scaled per load). */
function slingGeo(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const [x, z] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ])
    parts.push(member([0, 0, 0], [x, -1, z], 0.04, "#d0a020"));
  return merge(parts);
}

const LOAD_SIZE: Record<LoadKind, { w: number; d: number; h: number }> = {
  beams: { w: 8, d: 1.1, h: 0.75 },
  bricks: { w: 2.6, d: 1.0, h: 1.05 },
  skip: { w: 1.8, d: 1.8, h: 1.5 },
  panels: { w: 3.2, d: 1.2, h: 2.4 },
};

function loadGeo(kind: LoadKind): BufferGeometry {
  const p: BufferGeometry[] = [];
  if (kind === "beams") {
    for (const z of [-0.36, 0, 0.36]) p.push(box(8, 0.36, 0.3, 0, 0.18, z, "#7c3a26"));
    for (const z of [-0.18, 0.18]) p.push(box(8, 0.36, 0.3, 0, 0.55, z, "#86442e"));
  } else if (kind === "bricks") {
    for (const x of [-0.66, 0.66]) {
      p.push(box(1.2, 0.15, 1.0, x, 0.075, 0, "#b08a55"));
      p.push(box(1.1, 0.88, 0.95, x, 0.15 + 0.44, 0, "#a8553a"));
      p.push(box(1.12, 0.06, 0.97, x, 0.75, 0, "#e9e4d8"));
    }
  } else if (kind === "skip") {
    p.push(tint(new CylinderGeometry(0.85, 0.5, 1.4, 10).translate(0, 0.7, 0), "#8a8a85"));
    p.push(box(1.9, 0.14, 0.18, 0, 1.4, 0.8, YELLOW));
    p.push(box(1.9, 0.14, 0.18, 0, 1.4, -0.8, YELLOW));
    p.push(box(0.3, 0.3, 0.3, 0, 0.1, 0, "#3a3a3a"));
  } else {
    p.push(box(3.2, 0.15, 1.2, 0, 0.075, 0, "#3b3f45"));
    for (const z of [-0.2, 0.2]) {
      const g = box(3.0, 2.2, 0.08, 0, 1.25, 0, "#8fb3c8");
      g.rotateX(z < 0 ? 0.08 : -0.08).translate(0, 0, z);
      p.push(g);
    }
    p.push(box(0.12, 2.3, 0.6, -1.55, 1.25, 0, "#3b3f45"));
    p.push(box(0.12, 2.3, 0.6, 1.55, 1.25, 0, "#3b3f45"));
  }
  return merge(p);
}

/** Flatbed lorry, origin on the ground at its middle, facing +x. Bed top at y = 1.4. */
function lorryGeo(): BufferGeometry {
  const p: BufferGeometry[] = [
    box(9.6, 0.45, 2.1, 0, 0.9, 0, "#222"),
    box(1.9, 2.4, 2.45, 4.0, 1.95, 0, "#2c5aa0"),
    box(0.06, 0.95, 2.2, 4.97, 2.5, 0, "#1d2730"),
    box(1.95, 0.25, 2.5, 4.0, 3.2, 0, "#e6e1d6"),
    box(7.2, 0.27, 2.45, -0.9, 1.27, 0, "#7a6a55"),
    box(0.16, 1.3, 2.4, 2.75, 2.05, 0, "#555"),
    box(0.3, 0.3, 2.3, 5.0, 0.8, 0, "#888"),
  ];
  for (const x of [3.8, -2.2, -3.5])
    for (const z of [-1.05, 1.05]) p.push(tint(new CylinderGeometry(0.52, 0.52, 0.38, 12).rotateX(Math.PI / 2).translate(x, 0.52, z), "#151515"));
  return merge(p);
}

// ---------------------------------------------------------------- instancing helper

const m4 = new Matrix4();
const q = new Quaternion();
const v3 = new Vector3();
const s3 = new Vector3();
const yAxis = new Vector3(0, 1, 0);
const down = new Vector3(0, -1, 0);

class Batch {
  mesh: InstancedMesh;
  n = 0;
  cap: number;
  constructor(geo: BufferGeometry, mat: Material, cap: number, shadow: boolean, name: string) {
    this.cap = cap;
    this.mesh = new InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, new Color());
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.raycast = noRaycast;
    this.mesh.name = name;
  }
  /** Position, yaw, scale (and optional colour). */
  put(x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1, color?: Color) {
    if (this.n >= this.cap) return;
    q.setFromAxisAngle(yAxis, rotY);
    m4.compose(v3.set(x, y, z), q, s3.set(sx, sy, sz));
    this.mesh.setMatrixAt(this.n, m4);
    if (color) this.mesh.setColorAt(this.n, color);
    this.n++;
  }
  /** Raw matrix. */
  putMatrix(m: Matrix4, color?: Color) {
    if (this.n >= this.cap) return;
    this.mesh.setMatrixAt(this.n, m);
    if (color) this.mesh.setColorAt(this.n, color);
    this.n++;
  }
  begin() {
    this.n = 0;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

const C = (s: string) => new Color(s);
const COL = {
  slab: C(CONCRETE),
  column: C("#a9a69f"),
  core: C("#9e9b94"),
  ply: C("#c79a5b"),
  tube: C("#8e959c"),
  board: C("#b8925a"),
  plant: C("#8c8f93"),
  hoistMast: C("#c7c2b5"),
  hoistCage: C(YELLOW),
  cabinBlue: C("#3d6fb5"),
  cabinWhite: C("#e6e1d6"),
  window: C("#2a3640"),
  bearer: C("#8a6a45"),
  mast: C("#6a6e73"),
  gate: C("#2f4a3a"),
  barrier: C("#f2c230"),
  rope: C("#1f1f1f"),
};
const VESTS = ["#d8e021", "#f07a1a", "#d8e021", "#e8e83a"].map(C);
const HATS = ["#f4f4f0", "#f4f4f0", "#f2c230", "#f07a1a", "#2d6fd0"].map(C);

// ---------------------------------------------------------------- the module

interface CraneState {
  slew: number;
  radius: number;
  hookY: number;
  synced: boolean;
  pend: ReturnType<typeof newPendulum>;
  px: number;
  pz: number;
  vx: number;
  vz: number;
}

interface Worker {
  x: number;
  z: number;
  tx: number;
  tz: number;
  wait: number;
  heading: number;
  phase: number;
  deck: boolean;
  here: boolean;
  shirt: Color;
  trousers: Color;
  skin: Color;
  hat: Color;
  dx: number;
  dz: number;
}

export default function Construction() {
  const { map } = useWorld();
  const site = useMemo(() => planSite(map), [map]);
  return site ? <Site site={site} /> : null;
}

function Site({ site }: { site: SiteLayout }) {
  const world = useMemo(() => {
    const vc = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
    const plain = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.9 });
    const glass = new MeshStandardMaterial({ color: "#6f8796", roughness: 0.25, metalness: 0.4, emissive: "#ffd9a0", emissiveIntensity: 0 });
    const net = new MeshStandardMaterial({ color: "#3e7a52", roughness: 1, transparent: true, opacity: 0.6, depthWrite: false });
    const lamp = new MeshStandardMaterial({ color: "#fff6dc", emissive: "#fff1c9", emissiveIntensity: 0 });
    const red = new MeshStandardMaterial({ color: "#a01a12", emissive: "#ff2a1a", emissiveIntensity: 0 });
    const pool = new MeshBasicMaterial({ color: "#ffdca0", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false });

    const cranes = site.cranes.map((c) => {
      const [x, z] = S(c);
      const sl = slewingGeo(c.jib);
      const slew = new Mesh(sl.geo, vc);
      slew.position.set(x, c.h, z);
      slew.castShadow = true;
      slew.receiveShadow = true;
      slew.raycast = noRaycast;
      return { spec: c, x, z, slew, lights: sl.lights };
    });
    const mast = new Mesh(
      merge(site.cranes.map((c) => {
        const [x, z] = S(c);
        return merge(mastParts(c.h)).translate(x, 0, z);
      })),
      vc,
    );
    mast.castShadow = true;
    mast.receiveShadow = true;
    mast.raycast = noRaycast;

    const unit = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const batches = {
      site: new Batch(unit, plain, 1400, true, "site"),
      glass: new Batch(unit.clone(), glass, LEVELS + 2, false, "glazing"),
      net: new Batch(unit.clone(), net, 8, false, "netting"),
      trolley: new Batch(trolleyGeo(), vc, 4, true, "trolleys"),
      hook: new Batch(hookGeo(), vc, 4, true, "hooks"),
      cable: new Batch(new BoxGeometry(0.06, 1, 0.06).translate(0, -0.5, 0), plain, 8, false, "cables"),
      sling: new Batch(slingGeo(), vc, 4, false, "slings"),
      avi: new Batch(new SphereGeometry(0.35, 8, 6), red, 12, false, "aviation-lights"),
      lamp: new Batch(new BoxGeometry(1.3, 0.5, 0.5), lamp, 16, false, "floodlights"),
      pool: new Batch(new CircleGeometry(16, 24).rotateX(-Math.PI / 2), pool, 8, false, "light-pools"),
      hat: new Batch(new SphereGeometry(0.2, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), plain, WORKERS, false, "hard-hats"),
      lorry: new Batch(lorryGeo(), vc, 1, true, "lorry"),
      loads: Object.fromEntries(LOAD_KINDS.map((k) => [k, new Batch(loadGeo(k), vc, 40, true, `load-${k}`)])) as Record<LoadKind, Batch>,
    };
    const people = createPeople(WORKERS, { emissive: 0.05 });

    const craneState: CraneState[] = cranes.map((c) => ({
      slew: 0,
      radius: 8,
      hookY: c.spec.h - 5,
      synced: false,
      pend: newPendulum(),
      px: 0,
      pz: 0,
      vx: 0,
      vz: 0,
    }));

    const r = rng(seedOf("site-gang"));
    const [gx, gz] = S({ x: site.gate.x - site.gate.nx * 7, z: site.gate.z - site.gate.nz * 7 });
    const workers: Worker[] = Array.from({ length: WORKERS }, (_, i) => ({
      x: gx,
      z: gz,
      tx: gx,
      tz: gz,
      wait: 0,
      heading: 0,
      phase: r() * 6,
      deck: i % 5 < 2,
      here: false,
      shirt: VESTS[i % VESTS.length],
      trousers: TROUSERS[Math.floor(r() * TROUSERS.length)],
      skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)],
      hat: HATS[Math.floor(r() * HATS.length)],
      dx: 0,
      dz: 0,
    }));

    const inPath = polyline(site.inPath);
    const outPath = polyline(site.outPath);
    return { vc, plain, glass, net, lamp, red, pool, cranes, mast, batches, people, craneState, workers, wr: rng(5), inPath, outPath, gate: [gx, gz] as [number, number] };
  }, [site]);

  useEffect(
    () => () => {
      const w = world;
      w.mast.geometry.dispose();
      w.cranes.forEach((c) => c.slew.geometry.dispose());
      const { loads, ...rest } = w.batches;
      Object.values(rest).forEach((b) => b.dispose());
      Object.values(loads).forEach((b) => b.dispose());
      w.people.dispose();
      [w.vc, w.plain, w.glass, w.net, w.lamp, w.red, w.pool].forEach((m) => m.dispose());
    },
    [world],
  );

  const lorry = useRef<{ leg: "gone" | "in" | "parked" | "out"; s: number; kind: LoadKind; gateOpen: number }>({ leg: "gone", s: 0, kind: "beams", gateOpen: 0 });
  const pt = useMemo(() => newPoint(), []);

  useFrame(({ clock }, delta) => {
    const { t, playing, speed } = useSim.getState();
    const dt = Math.min(0.05, Math.max(0, delta));
    const time = clock.elapsedTime;
    const hour = hourOf(t);
    const night = nightLevel(hour);
    const state = siteState(t);
    const working = state === "work";
    const p = buildProgress(t);
    const slabs = slabCount(p);
    const deck = deckHeight(p);
    const b = world.batches;
    const B = site.building;
    const [bx, bz] = S(B);

    for (const k of Object.values(b)) if (k instanceof Batch) k.begin();
    for (const k of Object.values(b.loads)) k.begin();

    // ---------------- the building
    for (let k = 0; k < slabs; k++) b.site.put(bx, k * FLOOR_H, bz, 0, B.w, SLAB_T, B.d, COL.slab);
    const colsX = Math.max(2, Math.round(B.w / 6.5) + 1);
    const colsZ = Math.max(2, Math.round(B.d / 6.5) + 1);
    for (let k = 1; k <= LEVELS; k++) {
      const f = columnFrac(p, k);
      if (f <= 0) continue;
      const y0 = (k - 1) * FLOOR_H + SLAB_T;
      const h = (FLOOR_H - SLAB_T) * f;
      for (let i = 0; i < colsX; i++)
        for (let j = 0; j < colsZ; j++) {
          if (i > 0 && i < colsX - 1 && j > 0 && j < colsZ - 1 && (i + j) % 2) continue;
          b.site.put(bx - B.w / 2 + 0.5 + (i * (B.w - 1)) / (colsX - 1), y0, bz - B.d / 2 + 0.5 + (j * (B.d - 1)) / (colsZ - 1), 0, 0.55, h, 0.55, COL.column);
        }
      // formwork decking for the next slab going down once the columns are most of the way up
      if (f > 0.75 && slabs < k + 1) b.site.put(bx, k * FLOOR_H - 0.14, bz, 0, B.w, 0.12, B.d, COL.ply);
    }
    if (slabs > 0) {
      const coreH = Math.min(LEVELS * FLOOR_H + 2, deck + FLOOR_H * 1.2);
      b.site.put(bx - B.w * 0.2, 0, bz, 0, 6, coreH, 5, COL.core);
    }
    const rf = roofFrac(p);
    if (rf > 0) b.site.put(bx + B.w * 0.1, deck, bz, 0, B.w * 0.45, 3.2 * rf, B.d * 0.5, COL.plant);
    // finished storeys get their glazing; the top three are still in scaffolding
    for (let k = 1; k <= slabs - 4; k++) b.glass.put(bx, (k - 1) * FLOOR_H + SLAB_T, bz, 0, B.w - 0.1, FLOOR_H - SLAB_T, B.d - 0.1);
    if (slabs > 0) {
      const kLow = Math.max(0, slabs - 4);
      const y0 = kLow * FLOOR_H;
      const y1 = deck + 2;
      const H = y1 - y0;
      const off = 1.3;
      const W2 = B.w / 2 + off;
      const D2 = B.d / 2 + off;
      for (const [len, alongX, cx, cz] of [
        [B.w + off * 2, true, bx, bz - D2],
        [B.w + off * 2, true, bx, bz + D2],
        [B.d + off * 2, false, bx - W2, bz],
        [B.d + off * 2, false, bx + W2, bz],
      ] as const) {
        const rot = alongX ? 0 : Math.PI / 2;
        const n = Math.max(2, Math.round(len / 2.5));
        for (let i = 0; i <= n; i++) {
          const a = -len / 2 + (i * len) / n;
          b.site.put(alongX ? cx + a : cx, y0, alongX ? cz : cz + a, 0, 0.07, H, 0.07, COL.tube);
        }
        for (let y = y0 + 2; y <= y1 + 0.01; y += 2) {
          b.site.put(cx, y, cz, rot, len, 0.06, 0.06, COL.tube);
          b.site.put(alongX ? cx : cx + (cx < bx ? 0.5 : -0.5), y - 0.05, alongX ? cz + (cz < bz ? 0.5 : -0.5) : cz, rot, len, 0.05, 1.0, COL.board);
        }
        // safety netting on the outside face
        b.net.put(alongX ? cx : cx + (cx < bx ? -0.08 : 0.08), y0, alongX ? cz + (cz < bz ? -0.08 : 0.08) : cz, rot, len, H, 0.03);
      }
      // goods hoist on the gate-facing end
      const hx = bx + (site.bay.x > B.x ? 1 : -1) * (B.w / 2 + off + 1.2);
      b.site.put(hx, 0, bz + 3, 0, 0.9, deck + 3, 0.9, COL.hoistMast);
      const cageY = working ? (0.5 - 0.5 * Math.cos(time * 0.25)) * deck : 0;
      b.site.put(hx + (hx > bx ? 1.2 : -1.2), cageY, bz + 3, 0, 1.6, 2.4, 1.8, COL.hoistCage);
    }

    // ---------------- yard: cabins, floodlight masts, laydown bearers, gate
    for (const c of site.cabins) {
      const [x, z] = S(c);
      const rot = c.alongX ? 0 : Math.PI / 2;
      b.site.put(x, 0, z, rot, 6, 2.6, 2.6, COL.cabinBlue);
      b.site.put(x, 2.65, z, rot, 6, 2.6, 2.6, COL.cabinWhite);
      b.site.put(x, 1.0, z, rot, 4.6, 0.9, 2.66, COL.window);
      b.site.put(x, 3.65, z, rot, 4.6, 0.9, 2.66, COL.window);
    }
    const lightsOn = night > 0.28 && hour >= 5.5 && hour < 22;
    for (const l of site.lights) {
      const [x, z] = S(l);
      b.site.put(x, 0, z, 0, 0.3, 12, 0.3, COL.mast);
      const toB = Math.atan2(-(bz - z), bx - x);
      b.lamp.put(x + Math.cos(toB) * 0.5, 12, z - Math.sin(toB) * 0.5, toB + Math.PI / 2);
      b.lamp.put(x + Math.cos(toB) * 0.5, 12.6, z - Math.sin(toB) * 0.5, toB + Math.PI / 2);
      if (lightsOn) b.pool.put(x + Math.cos(toB) * 12, 0.12, z - Math.sin(toB) * 12);
    }
    world.lamp.emissiveIntensity = lightsOn ? 2.2 : 0;
    world.pool.opacity = lightsOn ? 0.16 * Math.min(1, night * 1.3) : 0;
    world.glass.emissiveIntensity = night * 0.12;

    // ---------------- lorry (sim-timed deliveries; drives in real time at 1×, snaps to its state faster than that)
    const d = deliveryAt(t);
    const L = lorry.current;
    const live = playing && speed === 1;
    const want = d ? (d.phase === "depart" ? "out" : "parked") : "gone";
    if (d) L.kind = LOAD_KINDS[d.index % LOAD_KINDS.length];
    if (!live) {
      if (L.leg === "in" || L.leg === "out" || L.leg !== (want === "out" ? "gone" : want)) {
        L.leg = want === "out" ? "gone" : want;
        L.s = 0;
      }
    } else {
      if (want === "parked" && L.leg === "gone") [L.leg, L.s] = ["in", 0];
      if (want !== "parked" && L.leg === "parked") [L.leg, L.s] = ["out", 0];
      if (L.leg === "in") {
        L.s += Math.min(LORRY_SPEED, 1.5 + (world.inPath.length - L.s) * 0.6) * dt;
        if (L.s >= world.inPath.length) [L.leg, L.s] = [want === "parked" ? "parked" : "out", 0];
      } else if (L.leg === "out") {
        L.s += Math.min(LORRY_SPEED, 1.5 + L.s * 0.6) * dt;
        if (L.s >= world.outPath.length) [L.leg, L.s] = ["gone", 0];
      }
    }
    let bed: [number, number, number] | null = null;
    if (L.leg !== "gone") {
      let path: Polyline | null = null;
      if (L.leg === "in") path = world.inPath;
      if (L.leg === "out") path = world.outPath;
      if (path) path.at(L.s, 0, pt);
      else {
        pt.x = site.bay.x;
        pt.z = site.bay.z;
        pt.dx = site.bay.hx;
        pt.dz = site.bay.hz;
      }
      // the lorry's middle trails its front (pt) by half a length
      const [fx, fz] = S(pt);
      const sdx = pt.dx;
      const sdz = -pt.dz;
      const cx = fx - sdx * 5;
      const cz = fz - sdz * 5;
      const rot = Math.atan2(-sdz, sdx);
      b.lorry.put(cx, 0, cz, rot);
      bed = [cx - sdx * 0.9, cz - sdz * 0.9, rot];
      const cargo = L.leg === "out" ? 0 : L.leg === "in" || !d ? 3 : Math.max(0, Math.ceil(3 * (1 - (d.phase === "unload" ? d.p : 0))));
      const sz = LOAD_SIZE[L.kind];
      for (let k = 0; k < cargo; k++) {
        if (L.kind === "beams") b.loads.beams.put(bed[0], 1.4 + k * sz.h, bed[1], rot);
        else {
          const a = (k - 1) * 2.3;
          b.loads[L.kind].put(bed[0] + sdx * a, 1.4, bed[1] + sdz * a, rot + (L.kind === "panels" ? 0 : Math.PI / 2));
        }
      }
    }
    // gate leaves swing open for the lorry
    const gateWant = L.leg === "in" || L.leg === "out" ? 1 : 0;
    L.gateOpen = approach(L.gateOpen, gateWant, dt * 0.8);
    {
      // contract coords: leaves hinge at the ends of the opening and swing inward (away from the street)
      const g = site.gate;
      const half = (g.pieces.length || 1) * 2;
      const [lx, lz] = g.nz !== 0 ? [1, 0] : [0, 1];
      const ang = L.gateOpen * (Math.PI / 2) * 0.95;
      for (const side of [-1, 1]) {
        const hx = g.x + side * half * lx;
        const hz = g.z + side * half * lz;
        const dx = -side * lx * Math.cos(ang) - g.nx * Math.sin(ang);
        const dz = -side * lz * Math.cos(ang) - g.nz * Math.sin(ang);
        const [sx, sz] = S({ x: hx + (dx * half) / 2, z: hz + (dz * half) / 2 });
        b.site.put(sx, 0, sz, Math.atan2(dz, dx), half, 2.6, 0.18, COL.gate);
        const [px, pz] = S({ x: g.x + side * (half + 0.15) * lx, z: g.z + side * (half + 0.15) * lz });
        b.site.put(px, 0, pz, 0, 0.3, 3.0, 0.3, COL.barrier);
      }
    }

    // ---------------- laydown stacks
    const layKinds = LOAD_KINDS;
    site.laydown.forEach((spot, k) => {
      const [x, z] = S(spot);
      const kind = layKinds[k];
      const sz = LOAD_SIZE[kind];
      b.site.put(x, 0, z, 0, sz.w + 0.6, 0.15, sz.d * 2 + 1.6, COL.bearer);
      if (kind === "beams") for (let s = 0; s < 3; s++) b.loads.beams.put(x, 0.15 + s * sz.h, z + 1.4, 0);
      else for (const o of [-1, 1]) b.loads[kind].put(x, 0.15, z + o * (sz.d / 2 + 0.4), 0);
    });

    // ---------------- cranes
    const avOn = night > 0.25;
    const blink = Math.sin(time * 4.2) > -0.2;
    world.red.emissiveIntensity = avOn ? (blink ? 3.2 : 0.15) : 0.05;
    const dropPos = (ci: number, n: number): [number, number] => {
      const rr = rng(seedOf("drop", ci, n));
      return [bx + (rr() - 0.5) * (B.w - 6), bz + (rr() - 0.5) * (B.d - 6)];
    };
    const kindFor = (ci: number, n: number) => LOAD_KINDS[(((n + ci * 2) % 4) + 4) % 4];
    world.cranes.forEach((c, ci) => {
      const st = world.craneState[ci];
      const spec = c.spec;
      const polar = (x: number, z: number): [number, number] => [Math.atan2(-(z - c.z), x - c.x), Math.max(4, Math.min(spec.jib - 1.2, Math.hypot(x - c.x, z - c.z)))];
      const s = time + ci * CYCLE_S * 0.43;
      const n = Math.floor(s / CYCLE_S);
      let kind = kindFor(ci, n);
      let pickXZ: [number, number];
      let pickBase = 0.15;
      if (spec.lorry && L.leg === "parked" && bed) {
        kind = L.kind;
        pickXZ = [bed[0], bed[1]];
        pickBase = 1.4;
      } else if (spec.lorry) {
        const k = LOAD_KINDS.indexOf(kind);
        const [x, z] = S(site.laydown[k]);
        pickXZ = [x, z + (kind === "beams" ? 1.4 : -(LOAD_SIZE[kind].d / 2 + 0.4))];
        pickBase = kind === "beams" ? 0.15 + 3 * LOAD_SIZE.beams.h : 0.15;
      } else {
        pickXZ = S(spec.pick);
      }
      const sz = LOAD_SIZE[kind];
      const [dx, dz] = dropPos(ci, n);
      const [pa, pr] = polar(...pickXZ);
      const [da, dr] = polar(dx, dz);
      const pickY = pickBase + sz.h + SLING;
      const dropY = deck + sz.h + SLING;
      const job: CraneJob = {
        pickA: pa,
        pickR: pr,
        pickY,
        dropA: da,
        dropR: dr,
        dropY,
        clearY: Math.min(spec.h - 3, Math.max(deck + 2.5 + sz.h + SLING + 3, pickY + 4)),
      };
      const pose: CranePose = working
        ? cranePose(job, s - n * CYCLE_S)
        : { slew: windAngle(t) + 0.06 * Math.sin(time * 0.13 + ci * 2), radius: 7, hookY: spec.h - 4.5, loaded: false, delivered: false, stage: "rig" };
      st.slew = approachAngle(st.slew, pose.slew, 1.0 * dt);
      st.radius = approach(st.radius, pose.radius, 15 * dt);
      st.hookY = approach(st.hookY, pose.hookY, 20 * dt);
      const close = Math.abs(angleDelta(st.slew, pose.slew)) < 0.04 && Math.abs(st.radius - pose.radius) < 0.4 && Math.abs(st.hookY - pose.hookY) < 0.4;
      if (!working) st.synced = false;
      // only start carrying loads once the crane has caught up with the cycle (no teleporting loads)
      else if (close && pose.stage === "rig") st.synced = true;
      c.slew.rotation.y = st.slew;

      const cos = Math.cos(st.slew);
      const sin = Math.sin(st.slew);
      const tx = c.x + st.radius * cos;
      const tz = c.z - st.radius * sin;
      const ty = spec.h + 0.2;
      if (dt > 0) {
        const vx = (tx - st.px) / dt;
        const vz = (tz - st.pz) / dt;
        let ax = (vx - st.vx) / dt;
        let az = (vz - st.vz) / dt;
        const am = Math.hypot(ax, az);
        if (am > 6) [ax, az] = [(ax * 6) / am, (az * 6) / am];
        if (st.px !== 0 || st.pz !== 0) stepPendulum(st.pend, ax, az, ty - (st.hookY + 1.5), dt);
        [st.px, st.pz, st.vx, st.vz] = [tx, tz, vx, vz];
      }
      b.trolley.put(tx, spec.h + 0.05, tz, st.slew);
      const hx = tx + st.pend.x;
      const hz = tz + st.pend.z;
      b.hook.put(hx, st.hookY, hz, st.slew);
      // two falls of hoist rope from the trolley sheaves to the hook block
      for (const o of [-0.22, 0.22]) {
        const top = v3.set(tx + o * cos, ty, tz - o * sin);
        const bot = new Vector3(hx + o * 0.6 * cos, st.hookY + 1.5, hz - o * 0.6 * sin);
        const len = top.distanceTo(bot);
        q.setFromUnitVectors(down, bot.sub(top).normalize());
        m4.compose(top, q, s3.set(1, len, 1));
        b.cable.putMatrix(m4, COL.rope);
      }
      const carrying = working && st.synced && pose.loaded;
      if (carrying) {
        const rot = st.slew + (kind === "beams" ? Math.PI / 2 : 0);
        b.sling.put(hx, st.hookY, hz, rot, sz.w * 0.9, SLING, sz.d * 0.9);
        b.loads[kind].put(hx, st.hookY - SLING - sz.h, hz, rot);
      }
      // the last few lifts sit on the deck where the next storey is going up
      if (working && slabs > 0) {
        for (let back = pose.delivered && st.synced ? 0 : 1; back <= 2; back++) {
          const m = n - back;
          const [x, z] = dropPos(ci, m);
          const kk = kindFor(ci, m);
          b.loads[kk].put(x, deck, z, polar(x, z)[0] + (kk === "beams" ? Math.PI / 2 : 0));
        }
      }
      for (const [lx, ly, lz] of c.lights) b.avi.put(c.x + lx * cos + lz * sin, spec.h + ly, c.z - lx * sin + lz * cos);
    });

    // ---------------- the gang
    const present = workersPresent(t, WORKERS);
    const lunch = state === "lunch";
    const ground = site.groundSpots.map(S);
    const cab = S(site.cabins[0]);
    let k = 0;
    world.workers.forEach((w, i) => {
      if (i >= present) {
        w.here = false;
        return;
      }
      const onDeck = w.deck && slabs > 0 && !lunch;
      if (!w.here) {
        w.here = true;
        if (onDeck) {
          w.x = bx + (world.wr() - 0.5) * (B.w - 3);
          w.z = bz + (world.wr() - 0.5) * (B.d - 3);
        } else [w.x, w.z] = world.gate;
        [w.tx, w.tz] = [w.x, w.z];
        w.wait = world.wr() * 2;
      }
      const inside = Math.abs(w.x - bx) < B.w / 2 && Math.abs(w.z - bz) < B.d / 2;
      if (onDeck && !inside) {
        // went up the hoist
        w.x = bx + (world.wr() - 0.5) * (B.w - 3);
        w.z = bz + (world.wr() - 0.5) * (B.d - 3);
        [w.tx, w.tz] = [w.x, w.z];
      } else if (!onDeck && inside && slabs > 0) {
        // came down for lunch / the deck crew knocks off
        [w.x, w.z] = [cab[0] + (world.wr() - 0.5) * 6, cab[1] + 4 + world.wr() * 3];
        [w.tx, w.tz] = [w.x, w.z];
      }
      const ddx = w.tx - w.x;
      const ddz = w.tz - w.z;
      const dist = Math.hypot(ddx, ddz);
      let moving = false;
      if (dist > 0.2) {
        const step = Math.min(dist, 1.3 * dt);
        w.x += (ddx / dist) * step;
        w.z += (ddz / dist) * step;
        w.heading = Math.atan2(ddx, ddz);
        w.phase += dt * 7;
        moving = true;
      } else if ((w.wait -= dt) <= 0) {
        w.wait = 2 + world.wr() * 7;
        if (lunch) [w.tx, w.tz] = [cab[0] + (world.wr() - 0.5) * 8, cab[1] + 4 + world.wr() * 4];
        else if (onDeck) [w.tx, w.tz] = [bx + (world.wr() - 0.5) * (B.w - 3), bz + (world.wr() - 0.5) * (B.d - 3)];
        else {
          const g = ground[Math.floor(world.wr() * ground.length)];
          [w.tx, w.tz] = [g[0] + (world.wr() - 0.5) * 3, g[1] + (world.wr() - 0.5) * 3];
        }
      }
      const y = onDeck ? deck : 0.05;
      world.people.set(k, w.x, y, w.z, w.heading, w.phase, moving, WORKER_SCALE, w.shirt, w.trousers, w.skin);
      b.hat.put(w.x, y + 1.72 * WORKER_SCALE, w.z, 0, WORKER_SCALE, WORKER_SCALE, WORKER_SCALE, w.hat);
      k++;
    });
    world.people.commit(k);

    for (const x of Object.values(b)) if (x instanceof Batch) x.end();
    for (const x of Object.values(b.loads)) x.end();
  });

  return (
    <group name="construction">
      <primitive object={world.mast} />
      {world.cranes.map((c, i) => (
        <primitive key={i} object={c.slew} />
      ))}
      {Object.entries(world.batches).map(([k, v]) => (v instanceof Batch ? <primitive key={k} object={v.mesh} /> : null))}
      {Object.entries(world.batches.loads).map(([k, v]) => (
        <primitive key={`load-${k}`} object={v.mesh} />
      ))}
      <primitive object={world.people.group} />
    </group>
  );
}
