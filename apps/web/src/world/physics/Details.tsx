// Small dynamic city details (counts kept low, everything sleeps when still):
//   · litter and plane-tree leaves in the gutters of the bus roads, caught in the slipstream of passing buses
//     (and, less, cars) and the odd gust of wind; they skitter, flip, and settle against kerbs and railings
//   · a football in a pocket park, passed between two kids who run it down; bounces off the railings
//   · wheelie bins on the junction corners where crashes happen: a crash knocks them over, the council rights them
// Bins are exported for Crashes.tsx (binsNear / toppleBin / resetBins).
import { useRapier } from "@react-three/rapier";
import { useEffect, useMemo } from "react";
import { BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3, type Mesh } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { toScene } from "../../sim/geometry";
import type { InfillPlan } from "../../sim/infill";
import { polyline, newPoint } from "../../sim/polyline";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { engine, G, groups, type RigidBody } from "./engine";
import { streetDirAt, type Junction } from "./schedule";
import { trafficVehicles } from "./traffic";

const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const m4 = new Matrix4();
const v3 = new Vector3();
const s3 = new Vector3();
const zero = { x: 0, y: 0, z: 0 };

// ---------- bins (shared with Crashes) ----------

interface Bin {
  body: RigidBody;
  home: { x: number; z: number; yaw: number };
}
const BIN = { hx: 0.29, hy: 0.53, hz: 0.36 };
let bins: Bin[] = [];

/** Indices of bins within r metres of a scene point. */
export function binsNear(x: number, z: number, r: number): number[] {
  const out: number[] = [];
  bins.forEach((b, i) => {
    if (Math.hypot(b.home.x - x, b.home.z - z) < r) out.push(i);
  });
  return out;
}

/** Knock bin i over, away from (fromX, fromZ). snap: lay it straight on its side. */
export function toppleBin(i: number, fromX: number, fromZ: number, snap: boolean) {
  const b = bins[i];
  if (!b) return;
  const t = b.body.translation();
  v3.set(t.x - fromX, 0, t.z - fromZ).normalize();
  if (snap) {
    const axis = s3.set(v3.z, 0, -v3.x);
    q.setFromAxisAngle(axis, Math.PI / 2);
    b.body.setTranslation({ x: t.x + v3.x * 0.5, y: BIN.hz, z: t.z + v3.z * 0.5 }, true);
    b.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    b.body.sleep();
    return;
  }
  // a shove high up (flying debris / a wing mirror): over it goes, lid flapping
  const k = 55 + Math.random() * 30;
  b.body.applyImpulseAtPoint({ x: v3.x * k, y: 8, z: v3.z * k }, { x: t.x, y: t.y + BIN.hy * 1.7, z: t.z }, true);
}

/** Right the bins (after the tow: the council's been round). */
export function resetBins(ids: number[]) {
  for (const i of ids) {
    const b = bins[i];
    if (!b) continue;
    q.setFromAxisAngle(UP, b.home.yaw);
    b.body.setTranslation({ x: b.home.x, y: 0.01, z: b.home.z }, false);
    b.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, false);
    b.body.setLinvel(zero, false);
    b.body.setAngvel(zero, false);
    b.body.sleep();
  }
}

/** Two bins per crash junction, on opposite corners, on the pavement just past the crossing street's kerb. */
function binSpots(js: Junction[]) {
  const out: { x: number; z: number; yaw: number }[] = [];
  for (const j of js) {
    const [s1, s2] = j.streets;
    if (!s2) continue;
    const d = streetDirAt(s1, j.x, j.z);
    for (const s of [1, -1]) {
      const x = j.x + d.dx * (s2.width / 2 + 2.6) * s + d.dz * (s1.width / 2 + 0.7) * s;
      const z = j.z + d.dz * (s2.width / 2 + 2.6) * s - d.dx * (s1.width / 2 + 0.7) * s;
      const [sx, sz] = toScene(x, z);
      out.push({ x: sx, z: sz, yaw: Math.atan2(d.dx, -d.dz) });
    }
  }
  return out;
}

// ---------- litter ----------

interface Litter {
  body: RigidBody;
  home: { x: number; z: number };
  scale: Vector3;
  color: Color;
}

const LITTER_COLORS = ["#b8642b", "#c98a2e", "#8f5a2a", "#a3783d", "#efece4", "#e9e2cf", "#d23b33", "#3a6fb5"].map((c) => new Color(c));

/** Gutter spots along the bus roads nearest the middle of the map (where the camera usually is). */
function litterSpots(map: CityMap) {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const p = newPoint();
  const cand: { x: number; z: number; d: number }[] = [];
  for (const s of map.streets) {
    if (s.width < 12) continue;
    const path = polyline(s.points);
    for (let a = 30; a < path.length - 30; a += 55)
      for (const side of [1, -1]) {
        path.at(a, side * (s.width / 2 - 0.7), p);
        if (p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) continue;
        cand.push({ x: p.x, z: p.z, d: Math.hypot(p.x - cx, p.z - cz) });
      }
  }
  cand.sort((a, b) => a.d - b.d);
  const out: typeof cand = [];
  for (const c of cand) if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > 45)) out.push(c);
  return out.slice(0, 6);
}

export default function Details({ plan, junctions }: { plan: InfillPlan; junctions: Junction[] }) {
  const { world, rapier } = useRapier();
  const { map } = useWorld();

  const park = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = map.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const parks = plan.plots.filter((p) => p.kind === "park" && Math.min(p.w, p.d) >= 12);
    parks.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
    return parks[0] ?? null;
  }, [plan, map]);

  const res = useMemo(() => {
    const unit = new BoxGeometry(1, 1, 1);
    const litterMesh = new InstancedMesh(unit, new MeshStandardMaterial({ roughness: 0.9, side: 2 }), 48);
    const binBody = new InstancedMesh(new BoxGeometry(BIN.hx * 2, BIN.hy * 2 - 0.08, BIN.hz * 2).translate(0, BIN.hy - 0.04, 0), new MeshStandardMaterial({ color: "#23402e", roughness: 0.7 }), 24);
    const binLid = new InstancedMesh(new BoxGeometry(BIN.hx * 2 + 0.06, 0.07, BIN.hz * 2 + 0.1).translate(0, BIN.hy * 2 - 0.02, 0.03), new MeshStandardMaterial({ color: "#16291d", roughness: 0.6 }), 24);
    const ball = new InstancedMesh(new SphereGeometry(0.16, 12, 8), new MeshStandardMaterial({ color: "#f4f4f0", roughness: 0.5 }), 1);
    for (const m of [litterMesh, binBody, binLid, ball]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = m !== litterMesh;
      m.receiveShadow = true;
      m.count = 0;
    }
    litterMesh.setColorAt(0, new Color());
    const kids = createPeople(2, { emissive: 0.05 });
    return { litterMesh, binBody, binLid, ball, kids };
  }, []);

  useEffect(
    () => () => {
      for (const m of [res.litterMesh, res.binBody, res.binLid, res.ball] as Mesh[]) {
        m.geometry.dispose();
        (m.material as MeshStandardMaterial).dispose();
      }
      res.kids.dispose();
    },
    [res],
  );

  useEffect(() => {
    const r = rng(23);
    const created: RigidBody[] = [];
    const add = (b: RigidBody) => (created.push(b), b);

    // bins
    bins = binSpots(junctions)
      .slice(0, 24)
      .map((home) => {
        q.setFromAxisAngle(UP, home.yaw);
        const body = add(world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(home.x, 0.01, home.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setSleeping(true).setAngularDamping(0.4)));
        world.createCollider(
          rapier.ColliderDesc.cuboid(BIN.hx, BIN.hy, BIN.hz)
            .setTranslation(0, BIN.hy, 0)
            .setMassProperties(22, { x: 0, y: 0.38, z: 0 }, { x: 2.6, y: 1.4, z: 2.4 }, { x: 0, y: 0, z: 0, w: 1 })
            .setFriction(0.7)
            .setRestitution(0.1)
            .setCollisionGroups(groups(G.PROP, G.STATIC | G.WRECK | G.TRAFFIC | G.PROP)),
          body,
        );
        return { body, home };
      });

    // litter: a few pieces per gutter spot
    const litter: Litter[] = [];
    for (const spot of litterSpots(map)) {
      const [hx, hz] = toScene(spot.x, spot.z);
      for (let k = 0; k < 7 && litter.length < 48; k++) {
        const kind = r();
        const leaf = kind < 0.55;
        const scale = leaf ? new Vector3(0.16, 0.012, 0.12) : kind < 0.85 ? new Vector3(0.21, 0.006, 0.28) : new Vector3(0.07, 0.12, 0.07);
        const color = leaf ? LITTER_COLORS[Math.floor(r() * 4)] : kind < 0.85 ? LITTER_COLORS[4 + Math.floor(r() * 2)] : LITTER_COLORS[6 + Math.floor(r() * 2)];
        const x = hx + (r() - 0.5) * 7;
        const z = hz + (r() - 0.5) * 7;
        q.setFromAxisAngle(UP, r() * Math.PI * 2);
        const body = add(
          world.createRigidBody(
            rapier.RigidBodyDesc.dynamic()
              .setTranslation(x, scale.y / 2 + 0.01, z)
              .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
              // air drag: leaves and paper flutter down rather than drop
              .setLinearDamping(leaf ? 2.6 : kind < 0.85 ? 2 : 0.4)
              .setAngularDamping(leaf ? 1.2 : 0.8)
              .setSleeping(true),
          ),
        );
        world.createCollider(
          rapier.ColliderDesc.cuboid(scale.x / 2, Math.max(scale.y / 2, 0.006), scale.z / 2)
            .setMass(leaf ? 0.004 : kind < 0.85 ? 0.01 : 0.03)
            .setFriction(0.6)
            .setRestitution(0.05)
            .setCollisionGroups(groups(G.LITTER, G.STATIC)),
          body,
        );
        litter.push({ body, home: { x, z }, scale, color });
      }
    }

    // the football
    let ball: RigidBody | null = null;
    const pc = park ? toScene(park.x, park.z) : null;
    if (pc) {
      ball = add(world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(pc[0], 0.12, pc[1]).setLinearDamping(0.2).setAngularDamping(0.6).setCcdEnabled(true)));
      world.createCollider(
        rapier.ColliderDesc.ball(0.11).setMass(0.43).setRestitution(0.62).setFriction(0.7).setCollisionGroups(groups(G.PROP, G.STATIC | G.PROP | G.TRAFFIC | G.WRECK)),
        ball,
      );
    }
    const long = park ? park.w >= park.d : true;
    const half = park ? (long ? park.w : park.d) / 2 - 2.5 : 0;
    const kids = [0, 1].map((i) => {
      const s = i === 0 ? -1 : 1;
      const home = pc ? { x: pc[0] + (long ? s * half * 0.7 : 0), z: pc[1] + (long ? 0 : s * half * 0.7) } : { x: 0, z: 0 };
      return { x: home.x, z: home.z, heading: 0, phase: 0, home, cool: 0, shirt: new Color(i ? "#2f6fd6" : "#e0452f"), trousers: TROUSERS[i * 2], skin: SKIN_TONES[i * 3 + 1] };
    });

    let gust = 2;
    const pre = (dt: number) => {
      if (dt <= 0) return;
      // slipstream: anything big and fast drags the litter along behind it and lifts it
      for (const v of trafficVehicles) {
        if (!v.shown || v.override || v.speed < 2) continue;
        const reach = v.kind === "bus" ? 7 : 3.8;
        const pull = v.kind === "bus" ? 26 : 9;
        const fx = Math.sin(v.heading);
        const fz = Math.cos(v.heading);
        for (const l of litter) {
          const t = l.body.translation();
          const dx = t.x - v.x;
          const dz = t.z - v.z;
          const d = Math.hypot(dx, dz);
          if (d > reach + v.length / 2) continue;
          // strongest just behind the vehicle, in its wake
          const along = dx * fx + dz * fz;
          const wake = along < 0 ? 1 : 0.4;
          const f = Math.pow(Math.max(0, 1 - Math.max(0, d - v.length / 2) / reach), 2) * wake * (v.speed / 8);
          if (f < 0.02) continue;
          const m = l.body.mass();
          const a = pull * f * dt * m;
          const side = (dx * fz - dz * fx) / (d || 1);
          l.body.applyImpulse({ x: fx * a + fz * side * a * 0.3 + (Math.random() - 0.5) * a * 0.6, y: a * (0.35 + Math.random() * 0.5), z: fz * a - fx * side * a * 0.3 + (Math.random() - 0.5) * a * 0.6 }, true);
          l.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * a * 0.02, y: (Math.random() - 0.5) * a * 0.02, z: (Math.random() - 0.5) * a * 0.02 }, true);
        }
      }
      // the odd gust down the street
      if ((gust -= dt) < 0) {
        gust = 3 + Math.random() * 5;
        const gx = Math.random() - 0.5;
        const gz = Math.random() - 0.5;
        for (const l of litter) {
          if (Math.random() < 0.5) continue;
          const m = l.body.mass();
          l.body.applyImpulse({ x: gx * m * 2.2, y: m * Math.random() * 0.8, z: gz * m * 2.2 }, true);
        }
      }
      // keep it local: anything blown far away drifts back to its gutter (unseen, it's a different crisp packet)
      for (const l of litter) {
        const t = l.body.translation();
        if (Math.hypot(t.x - l.home.x, t.z - l.home.z) > 22 || t.y < -1) {
          l.body.setTranslation({ x: l.home.x, y: 0.05, z: l.home.z }, false);
          l.body.setLinvel(zero, false);
          l.body.sleep();
        }
      }
      // football: daytime kickabout
      if (ball && pc && park) {
        const hour = hourOf(useSim.getState().t);
        const day = hour >= 8 && hour < 20;
        const b = ball.translation();
        const bv = ball.linvel();
        // out of the park somehow (over the railings): a passer-by throws it back
        if (Math.abs(b.x - pc[0]) > park.w / 2 + 1 || Math.abs(b.z - pc[1]) > park.d / 2 + 1 || b.y < -1) {
          ball.setTranslation({ x: pc[0], y: 0.3, z: pc[1] }, true);
          ball.setLinvel(zero, true);
        }
        if (!day) return;
        const chaser = Math.hypot(kids[0].x - b.x, kids[0].z - b.z) <= Math.hypot(kids[1].x - b.x, kids[1].z - b.z) ? 0 : 1;
        kids.forEach((k, i) => {
          k.cool -= dt;
          const tx = i === chaser ? b.x : k.home.x + (b.x - pc[0]) * 0.3;
          const tz = i === chaser ? b.z : k.home.z + (b.z - pc[1]) * 0.3;
          const dx = tx - k.x;
          const dz = tz - k.z;
          const d = Math.hypot(dx, dz);
          const speed = i === chaser ? 3.4 : 1.4;
          if (d > 0.45) {
            const step = Math.min(d - 0.4, speed * dt);
            k.x += (dx / d) * step;
            k.z += (dz / d) * step;
            k.heading = Math.atan2(dx, dz);
            k.phase += step * 3.2;
          }
          if (i === chaser && d < 0.75 && k.cool <= 0 && Math.hypot(bv.x, bv.z) < 4) {
            // kick: pass to the other kid, sometimes a lofted one, sometimes a scuff
            k.cool = 1.4;
            const o = kids[1 - i];
            const px = o.x + (Math.random() - 0.5) * 3 - b.x;
            const pz = o.z + (Math.random() - 0.5) * 3 - b.z;
            const pd = Math.hypot(px, pz) || 1;
            const sp = Math.min(13, 3 + pd * 0.85) * (0.8 + Math.random() * 0.4);
            const loft = Math.random() < 0.35 ? 2.5 + Math.random() * 3 : 0.4;
            const m = ball.mass();
            ball.applyImpulse({ x: m * ((px / pd) * sp - bv.x), y: m * loft, z: m * ((pz / pd) * sp - bv.z) }, true);
            ball.applyTorqueImpulse({ x: (Math.random() - 0.5) * 0.004, y: (Math.random() - 0.5) * 0.004, z: (Math.random() - 0.5) * 0.004 }, true);
          }
        });
      }
    };

    const post = () => {
      let n = 0;
      for (const l of litter) {
        const t = l.body.translation();
        const rr = l.body.rotation();
        m4.compose(v3.set(t.x, t.y, t.z), q.set(rr.x, rr.y, rr.z, rr.w), l.scale);
        res.litterMesh.setMatrixAt(n, m4);
        res.litterMesh.setColorAt(n++, l.color);
      }
      res.litterMesh.count = n;
      res.litterMesh.instanceMatrix.needsUpdate = true;
      if (res.litterMesh.instanceColor) res.litterMesh.instanceColor.needsUpdate = true;
      bins.forEach((b, i) => {
        const t = b.body.translation();
        const rr = b.body.rotation();
        m4.compose(v3.set(t.x, t.y, t.z), q.set(rr.x, rr.y, rr.z, rr.w), s3.setScalar(1));
        res.binBody.setMatrixAt(i, m4);
        res.binLid.setMatrixAt(i, m4);
      });
      res.binBody.count = res.binLid.count = bins.length;
      res.binBody.instanceMatrix.needsUpdate = res.binLid.instanceMatrix.needsUpdate = true;
      if (ball) {
        const t = ball.translation();
        const rr = ball.rotation();
        m4.compose(v3.set(t.x, Math.max(t.y, 0.16), t.z), q.set(rr.x, rr.y, rr.z, rr.w), s3.setScalar(1));
        res.ball.setMatrixAt(0, m4);
        res.ball.count = 1;
        res.ball.instanceMatrix.needsUpdate = true;
        const hour = hourOf(useSim.getState().t);
        const day = hour >= 8 && hour < 20;
        kids.forEach((k, i) => res.kids.set(i, k.x, 0, k.z, k.heading, k.phase, !engine.paused && engine.dt > 0, 0.72, k.shirt, k.trousers, k.skin));
        res.kids.commit(day ? 2 : 0);
      }
    };

    engine.pre.add(pre);
    engine.post.add(post);
    return () => {
      engine.pre.delete(pre);
      engine.post.delete(post);
      for (const b of created)
        try {
          world.removeRigidBody(b);
        } catch {
          // freed
        }
      bins = [];
    };
  }, [world, rapier, map, junctions, park, res]);

  return (
    <group name="physics-details">
      <primitive object={res.litterMesh} />
      <primitive object={res.binBody} />
      <primitive object={res.binLid} />
      <primitive object={res.ball} />
      <primitive object={res.kids.group} />
    </group>
  );
}
