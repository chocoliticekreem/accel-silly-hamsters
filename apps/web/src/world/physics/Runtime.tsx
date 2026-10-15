// The physics runtime: one Rapier world for the city, stepped on a fixed 60 Hz clock that follows the sim
// (paused with it, hurried a little at 10×, not stepped at all at 100× where things snap to rest).
// Systems hook in through engine.pre / engine.post; static colliders cover the ground, every map building,
// the infill blocks and the pocket-park railings. Lazy-loaded by PhysicsLayer (this file pulls in the WASM).
import { useFrame } from "@react-three/fiber";
import { Physics, useRapier } from "@react-three/rapier";
import { useEffect, useMemo } from "react";
import { toScene } from "../../sim/geometry";
import { planInfill, type InfillPlan } from "../../sim/infill";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { activeCrashes, clearCrash, crashAt, triggerCrash } from "./crash";
import Crashes from "./Crashes";
import Cranes from "./Cranes";
import Details from "./Details";
import { engine, G, groups, MAX_SUBSTEPS, PHYS_RATE, STEP } from "./engine";
import { junctions } from "./schedule";
import { trafficVehicles } from "./traffic";

export default function PhysicsRuntime() {
  const { map } = useWorld();
  const plan = useMemo(() => planInfill(map), [map]);
  const js = useMemo(() => junctions(map), [map]);
  return (
    <Physics paused timeStep={STEP} colliders={false} interpolate={false} numSolverIterations={6} gravity={[0, -9.81, 0]}>
      <Driver />
      <StaticWorld plan={plan} />
      <Crashes junctions={js} />
      <Details plan={plan} junctions={js} />
      <Cranes />
    </Physics>
  );
}

/** Steps the world. Runs after every city module's useFrame (mounted last), so Traffic's poses are fresh. */
function Driver() {
  const { world, rapier, step } = useRapier();

  useEffect(() => {
    engine.world = world;
    engine.rapier = rapier;
    window.__physics = { engine, stats: engine.stats, crashes: activeCrashes, crash: crashAt, triggerCrash, clearCrash, vehicles: trafficVehicles };
    return () => {
      engine.world = null;
      engine.rapier = null;
      delete window.__physics;
    };
  }, [world, rapier]);

  useFrame((_, delta) => {
    const { playing, speed } = useSim.getState();
    const rate = PHYS_RATE[speed];
    engine.paused = !playing;
    engine.snap = playing && rate === 0;
    const dt = playing ? Math.min(Math.min(delta, 0.1) * rate, MAX_SUBSTEPS * STEP) : 0;
    engine.dt = dt;
    engine.frameDt = delta;
    for (const f of engine.pre) f(dt);
    const s = engine.stats;
    if (dt > 0) {
      const t0 = performance.now();
      step(dt);
      const ms = performance.now() - t0;
      s.stepMs = ms;
      s.stepMsAvg += (ms - s.stepMsAvg) * 0.05;
      s.stepMsMax = Math.max(s.stepMsMax * 0.995, ms);
    }
    for (const f of engine.post) f(dt);
    if (++s.substeps % 30 === 0) {
      s.bodies = world.bodies.len();
      s.colliders = world.colliders.len();
      let awake = 0;
      world.forEachActiveRigidBody(() => awake++);
      s.awake = awake;
    }
  });
  return null;
}

/** Fixed colliders: ground slab (roads and pavements are flush with it), buildings, infill blocks, park railings. */
function StaticWorld({ plan }: { plan: InfillPlan }) {
  const { world, rapier } = useRapier();
  const { map } = useWorld();

  useEffect(() => {
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    const grp = groups(G.STATIC, 0xffff);
    const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, friction = 0.8) =>
      world.createCollider(rapier.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(friction).setRestitution(0.1).setCollisionGroups(grp), body);
    const [cx, cz] = toScene((map.bounds.minX + map.bounds.maxX) / 2, (map.bounds.minZ + map.bounds.maxZ) / 2);
    box(cx, -1, cz, 3000, 1, 3000, 0.9);
    for (const b of map.buildings) {
      const [x, z] = toScene(b.x, b.z);
      box(x, b.h / 2, z, b.w / 2, b.h / 2, b.d / 2);
    }
    for (const p of plan.plots) {
      const [x, z] = toScene(p.x, p.z);
      if (p.h > 0) box(x, p.h / 2, z, (p.w - 0.3) / 2, p.h / 2, (p.d - 0.3) / 2);
      else if (p.kind === "park") {
        // railings: 1.1 m fences round the square (balls bounce off them, litter piles against them)
        box(x, 0.55, z - p.d / 2 + 0.2, p.w / 2, 0.55, 0.05);
        box(x, 0.55, z + p.d / 2 - 0.2, p.w / 2, 0.55, 0.05);
        box(x + p.w / 2 - 0.2, 0.55, z, 0.05, 0.55, p.d / 2);
        box(x - p.w / 2 + 0.2, 0.55, z, 0.05, 0.55, p.d / 2);
      }
    }
    return () => {
      try {
        world.removeRigidBody(body);
      } catch {
        // world already freed with the <Physics> provider
      }
    };
  }, [world, rapier, map, plan]);
  return null;
}
