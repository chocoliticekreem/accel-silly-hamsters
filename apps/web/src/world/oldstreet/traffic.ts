// Junction traffic for Old Street: Routemasters, black cabs, cars and vans on the real (OSM) lanes through the
// two signalled junctions, stopping at red, queueing behind each other, buses dwelling at the stop. One
// BatchedMesh per material slot carries every vehicle model (≈5 draw calls for all of them).
import { BatchedMesh, Matrix4, Quaternion, Vector3, type Material } from "three";
import { rng } from "../../mock/rng";
import { flatten, SLOTS, type Slot, type SlotGeos } from "../models/kit";
import { heroMaterials } from "../models/materials";
import { blackCab, deliveryVan, routemaster } from "../models/vehicles";
import type { LaneInfo } from "./build";

/** Signal cycle (s): Old Street arms, City Road northbound, City Road southbound, then all-red for pedestrians. */
export const CYCLE = [
  { group: 0, green: 22 },
  { group: 1, green: 20 },
  { group: 2, green: 18 },
];
const AMBER = 3;
export const PED = 10;
export const CYCLE_LEN = CYCLE.reduce((a, c) => a + c.green + AMBER, 0) + PED;

/** 'g' | 'a' | 'r' for a signal group at cycle time tc. */
export function signalState(group: number, tc: number): "g" | "a" | "r" {
  let t = 0;
  for (const c of CYCLE) {
    if (tc < t + c.green) return c.group === group ? "g" : "r";
    if (tc < t + c.green + AMBER) return c.group === group ? "a" : "r";
    t += c.green + AMBER;
  }
  return "r";
}
/** Pedestrian green (all vehicle signals red). Returns progress 0..1 through the walk phase, or -1. */
export function pedPhase(tc: number): number {
  const t0 = CYCLE_LEN - PED;
  return tc >= t0 ? (tc - t0) / PED : -1;
}

interface Kind {
  geos: SlotGeos;
  len: number;
  vmax: number;
  bus: boolean;
}

interface Vehicle {
  kind: number;
  lane: number;
  s: number;
  v: number;
  dwell: number;
  served: boolean;
  on: boolean;
  ids: Partial<Record<Slot, number>>;
  x: number;
  z: number;
  dx: number;
  dz: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const UP = new Vector3(0, 1, 0);

export class JunctionTraffic {
  readonly meshes: BatchedMesh[] = [];
  private vs: Vehicle[] = [];
  private kinds: Kind[];
  private r = rng(7007);

  constructor(private lanes: LaneInfo[], capacity = 30) {
    this.kinds = [
      { geos: flatten(routemaster()), len: 11.2, vmax: 8, bus: true },
      { geos: flatten(blackCab()), len: 4.6, vmax: 10, bus: false },
      { geos: flatten(blackCab("#b9bec4")), len: 4.6, vmax: 10.5, bus: false },
      { geos: flatten(blackCab("#7d1b24")), len: 4.6, vmax: 10.5, bus: false },
      { geos: flatten(deliveryVan()), len: 5.4, vmax: 9, bus: false },
    ];
    const mats = heroMaterials();
    const geoIds = new Map<string, number>();
    const slotMesh = new Map<Slot, BatchedMesh>();
    for (const slot of SLOTS) {
      let verts = 0;
      for (const k of this.kinds) if (k.geos[slot]) verts += k.geos[slot]!.getAttribute("position").count;
      if (!verts) continue;
      const bm = new BatchedMesh(capacity, verts, 0, mats[slot] as Material);
      bm.name = `old-street-traffic:${slot}`;
      bm.castShadow = slot !== "glow" && slot !== "glass";
      bm.receiveShadow = true;
      this.kinds.forEach((k, ki) => {
        const g = k.geos[slot];
        if (!g) return;
        if (g.getAttribute("uv")) g.deleteAttribute("uv");
        geoIds.set(`${slot}:${ki}`, bm.addGeometry(g));
      });
      slotMesh.set(slot, bm);
      this.meshes.push(bm);
    }
    // a fleet: ~25 % buses, then cabs, cars, vans
    for (let i = 0; i < capacity; i++) {
      const roll = this.r();
      const kind = roll < 0.22 ? 0 : roll < 0.55 ? 1 : roll < 0.75 ? 2 : roll < 0.88 ? 3 : 4;
      const ids: Partial<Record<Slot, number>> = {};
      for (const [slot, bm] of slotMesh) {
        const gid = geoIds.get(`${slot}:${kind}`);
        if (gid === undefined) continue;
        const id = bm.addInstance(gid);
        bm.setVisibleAt(id, false);
        ids[slot] = id;
      }
      const lane = Math.floor(this.r() * lanes.length);
      this.vs.push({ kind, lane, s: this.r() * lanes[lane].len, v: 6, dwell: 0, served: false, on: true, ids, x: 0, z: 0, dx: 1, dz: 0 });
    }
    // spread out the starting fleet so nothing overlaps on frame one (then place them)
    this.vs.sort((a, b) => a.lane - b.lane || a.s - b.s);
    for (let i = 1; i < this.vs.length; i++) {
      const a = this.vs[i - 1];
      const b = this.vs[i];
      if (a.lane === b.lane && b.s - a.s < 16) b.s = Math.min(this.lanes[b.lane].len, a.s + 16);
    }
    for (const v of this.vs) this.place(v);
  }

  private place(v: Vehicle) {
    const ln = this.lanes[v.lane];
    const s = Math.max(0, Math.min(ln.len - 0.01, v.s));
    let i = 1;
    while (i < ln.cum.length - 1 && ln.cum[i] < s) i++;
    const a = ln.pts[i - 1];
    const b = ln.pts[i];
    const seg = ln.cum[i] - ln.cum[i - 1] || 1;
    const t = (s - ln.cum[i - 1]) / seg;
    v.x = a[0] + (b[0] - a[0]) * t;
    v.z = a[2] + (b[2] - a[2]) * t;
    // heading: smooth across the vertex by looking a few metres either way
    const ahead = this.at(ln, s + 3);
    const back = this.at(ln, s - 3);
    const dx = ahead[0] - back[0];
    const dz = ahead[1] - back[1];
    const l = Math.hypot(dx, dz) || 1;
    v.dx = dx / l;
    v.dz = dz / l;
  }

  private at(ln: LaneInfo, s: number): [number, number] {
    const ss = Math.max(0, Math.min(ln.len, s));
    let i = 1;
    while (i < ln.cum.length - 1 && ln.cum[i] < ss) i++;
    const a = ln.pts[i - 1];
    const b = ln.pts[i];
    const t = (ss - ln.cum[i - 1]) / (ln.cum[i] - ln.cum[i - 1] || 1);
    return [a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /** Advance by dt seconds. tc = signal cycle time; active = how many of the fleet run (time of day). */
  update(dt: number, tc: number, active: number) {
    const step = Math.min(dt, 0.1);
    const vs = this.vs;
    for (const v of vs) if (v.on) this.place(v);
    vs.forEach((v, i) => {
      const ln = this.lanes[v.lane];
      const kind = this.kinds[v.kind];
      if (!v.on) {
        if (i >= active) return;
        // (re)spawn at a lane start when it is clear
        const lane = Math.floor(this.r() * this.lanes.length);
        const start = this.lanes[lane].pts[0];
        if (vs.some((o) => o.on && Math.hypot(o.x - start[0], o.z - start[2]) < 18)) return;
        v.lane = lane;
        v.s = 0;
        v.v = kind.vmax * 0.8;
        v.served = false;
        v.dwell = 0;
        v.on = true;
        this.place(v);
        return;
      }
      // target speed: free flow, then the car ahead, a red light, a bus stop
      let target = kind.vmax;
      const front = v.s + kind.len / 2;
      for (const o of vs) {
        if (o === v || !o.on) continue;
        const rx = o.x - v.x;
        const rz = o.z - v.z;
        const ahead = rx * v.dx + rz * v.dz;
        if (ahead <= 0 || ahead > 40) continue;
        const lat = Math.abs(rx * v.dz - rz * v.dx);
        if (lat > 2.1) continue;
        const gap = ahead - (kind.len + this.kinds[o.kind].len) / 2;
        target = Math.min(target, Math.max(0, (gap - 2.2) * 0.8));
      }
      for (const st of ln.stops) {
        const d = st.s - front;
        if (d < -0.5 || d > 45) continue;
        const state = signalState(st.group, tc);
        if (state === "r" || (state === "a" && d > 5)) target = Math.min(target, Math.max(0, (d - 0.5) * 0.7));
        break;
      }
      if (kind.bus && ln.busStop !== undefined && !v.served) {
        const d = ln.busStop - v.s;
        if (d < 30 && d > -1) {
          target = Math.min(target, Math.max(0, d * 0.6));
          if (d < 0.6 && v.v < 0.3) {
            v.dwell += step;
            if (v.dwell > 14) v.served = true;
          }
        }
      }
      const acc = target > v.v ? 1.8 : -5.5;
      v.v = Math.max(0, target > v.v ? Math.min(target, v.v + acc * step) : Math.max(target, v.v + acc * step));
      v.s += v.v * step;
      if (v.s > ln.len) {
        v.on = false;
        v.x = 1e6;
      }
    });
    // write matrices
    for (const v of vs) {
      const visible = v.on;
      for (const [slot, id] of Object.entries(v.ids) as [Slot, number][]) {
        const bm = this.meshes.find((m) => m.name.endsWith(`:${slot}`))!;
        bm.setVisibleAt(id, visible);
        if (!visible) continue;
        _q.setFromAxisAngle(UP, Math.atan2(v.dx, v.dz));
        _m.compose(_p.set(v.x, 0.14, v.z), _q, _s);
        bm.setMatrixAt(id, _m);
      }
    }
  }

  /** Frees GPU buffers; safe to call twice and to keep using afterwards (React StrictMode re-runs effects). */
  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    for (const k of this.kinds) for (const g of Object.values(k.geos)) g?.dispose();
  }
}
