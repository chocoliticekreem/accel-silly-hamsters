// Runtime side of craneLoad.ts: every registered CraneLoad becomes three Rapier bodies:
//   anchor (kinematic, follows the trolley) ──rope joint (max length = rope out)── hook block (dynamic)
//   hook block ──spherical joint (sling)── load (dynamic box, real mass)
// A double pendulum: slew the jib and the hook lags, the load lags the hook and twists on its sling.
// The load collides with the ground and buildings only, so it can be landed. 100× / settle() → hang straight down.
import { useRapier } from "@react-three/rapier";
import { useEffect } from "react";
import { craneLoads, HOOK_HALF, type CraneLoadImpl } from "./craneLoad";
import { engine, G, groups, type ImpulseJoint, type RigidBody, removeBody, removeJoint } from "./engine";

interface Rig {
  anchor: RigidBody;
  hook: RigidBody;
  load: RigidBody;
  rope: ImpulseJoint;
  ropeVersion: number;
}

const HOOK_MASS = 280;

export default function Cranes() {
  const { world, rapier } = useRapier();

  useEffect(() => {
    const rigs = new Map<CraneLoadImpl, Rig>();
    const grp = groups(G.CRANE, G.STATIC);

    const ropeJoint = (l: CraneLoadImpl, a: RigidBody, h: RigidBody) =>
      world.createImpulseJoint(rapier.JointData.rope(l.ropeLength, { x: 0, y: 0, z: 0 }, { x: 0, y: HOOK_HALF, z: 0 }), a, h, true);

    const build = (l: CraneLoadImpl): Rig => {
      l.restPose();
      const anchor = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(l.anchor.x, l.anchor.y, l.anchor.z));
      const hook = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic().setTranslation(l.hook.x, l.hook.y, l.hook.z).setLinearDamping(0.05).setAngularDamping(2).setCanSleep(true),
      );
      world.createCollider(rapier.ColliderDesc.cuboid(0.35, HOOK_HALF, 0.22).setMass(HOOK_MASS).setCollisionGroups(grp), hook);
      const [w, h, d] = l.size;
      const q = l.quaternion;
      const load = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(l.position.x, l.position.y, l.position.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setLinearDamping(0.04)
          .setAngularDamping(0.35)
          .setCanSleep(true),
      );
      world.createCollider(rapier.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setMass(l.mass).setFriction(0.8).setCollisionGroups(grp), load);
      world.createImpulseJoint(rapier.JointData.spherical({ x: 0, y: -HOOK_HALF, z: 0 }, { x: 0, y: h / 2 + l.sling, z: 0 }), hook, load, true);
      const rope = ropeJoint(l, anchor, hook);
      l.physical = true;
      return { anchor, hook, load, rope, ropeVersion: l.ropeVersion };
    };

    const drop = (l: CraneLoadImpl, r: Rig) => {
      try {
        removeBody(world, r.load);
        removeBody(world, r.hook);
        removeBody(world, r.anchor);
      } catch {
        // world freed
      }
      rigs.delete(l);
      l.physical = false;
      l.settle();
    };

    const zero = { x: 0, y: 0, z: 0 };
    const pre = () => {
      for (const l of craneLoads) if (!rigs.has(l) && !l.disposed) rigs.set(l, build(l));
      for (const [l, r] of rigs) {
        if (l.disposed) {
          drop(l, r);
          continue;
        }
        r.anchor.setNextKinematicTranslation({ x: l.anchor.x, y: l.anchor.y, z: l.anchor.z });
        if (r.ropeVersion !== l.ropeVersion) {
          removeJoint(world, r.rope);
          r.rope = ropeJoint(l, r.anchor, r.hook);
          r.ropeVersion = l.ropeVersion;
          r.hook.wakeUp();
        }
        if (engine.snap || l.settleRequested) {
          l.restPose();
          r.anchor.setTranslation({ x: l.anchor.x, y: l.anchor.y, z: l.anchor.z }, true);
          r.hook.setTranslation({ x: l.hook.x, y: l.hook.y, z: l.hook.z }, true);
          r.load.setTranslation({ x: l.position.x, y: l.position.y, z: l.position.z }, true);
          const q = l.quaternion;
          r.load.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
          for (const b of [r.hook, r.load]) {
            b.setLinvel(zero, false);
            b.setAngvel(zero, false);
          }
        } else if (engine.dt > 0) {
          // the trolley moving drags the hook: make sure a sleeping rig notices
          const a = r.anchor.translation();
          if (Math.abs(a.x - l.anchor.x) + Math.abs(a.y - l.anchor.y) + Math.abs(a.z - l.anchor.z) > 1e-3) r.hook.wakeUp();
        }
      }
    };
    const post = () => {
      for (const [l, r] of rigs) {
        const h = r.hook.translation();
        l.hook.set(h.x, h.y, h.z);
        const p = r.load.translation();
        l.position.set(p.x, p.y, p.z);
        const q = r.load.rotation();
        l.quaternion.set(q.x, q.y, q.z, q.w);
      }
    };
    engine.pre.add(pre);
    engine.post.add(post);
    return () => {
      engine.pre.delete(pre);
      engine.post.delete(post);
      for (const [l, r] of [...rigs]) drop(l, r);
    };
  }, [world, rapier]);
  return null;
}
