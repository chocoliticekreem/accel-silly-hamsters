// Module: Agents. Every sim citizen as a little person (shirt = persona colour), played back from day keyframes.
// Each frame we sample every agent at `t` (linear interpolation, hidden inside stores), write the visible ones
// into the shared people meshes, and count who is inside which store (live.occupancy).
// Agents waiting at the same keyframe (a station exit, a door) are stepped a little apart so they don't render
// inside each other; the shift is capped at a few metres, so positions keep their meaning.
// Shop owners (persona "owner", docs/PEOPLE_ECONOMY.md) wear a dark top with an apron band in their shop's colour.
// Click anyone: the nearest drawn person on screen → this frame's slot → the agent → their life card (ui/PersonCard).
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color, Vector3, type Mesh, type MeshStandardMaterial } from "three";
import { createSeparator, obstacles } from "../../sim/crowd";
import { toScene } from "../../sim/geometry";
import { sampleAgent, type PreparedAgent } from "../../sim/interp";
import { nightLevel } from "../../sim/sky";
import { dayOf, hourOf } from "../../sim/time";
import { useDayAgents } from "../../state/data";
import { useEdgeAgents } from "../edgeAgents";
import { personOf, useEconomy } from "../../state/economy";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { LAMP, personaColor, STORE_COLORS } from "../palette";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";

const CAPACITY = obstacles.xs.length;
/** Sim agents are a touch bigger than the background crowd so the sample stands out. */
const SCALE = 2.4;
/** Centre-to-centre spacing between two agents at SCALE. */
const MIN_GAP = 2.2;
/** Cap on how far spacing may move an agent from its keyframe position (m). */
const MAX_PUSH = 3;
const OWNER_TOP = new Color("#262a33");
/** How close (px) a click must land to a person to pick them. */
const PICK_PX = 16;

interface Placed {
  heading: Float32Array;
  phase: Float32Array;
  moving: Uint8Array;
  who: Int32Array;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export default function Agents() {
  const { run, live, map, interactive } = useWorld();
  const day = useSim((s) => dayOf(s.t));
  const agents = useEdgeAgents(useDayAgents(run, day), map);
  const people = useMemo(() => createPeople(CAPACITY, { emissive: 0.1, aprons: true }), []);
  useEffect(() => {
    // pick on torso, head and apron only: limbs are thin and swing
    for (const k of ["legL", "legR", "armL", "armR"] as const) if (people.meshes[k]) people.meshes[k]!.raycast = () => {};
    return () => people.dispose();
  }, [people]);
  const placed = useMemo<Placed>(() => ({ heading: new Float32Array(CAPACITY), phase: new Float32Array(CAPACITY), moving: new Uint8Array(CAPACITY), who: new Int32Array(CAPACITY) }), []);
  const sep = useMemo(() => createSeparator(CAPACITY), []);
  const ring = useRef<Mesh>(null);
  // slot → agent, as of the last frame (what a click hits)
  const shown = useRef<{ agents: PreparedAgent[]; n: number; xs: Float32Array; zs: Float32Array }>({ agents: [], n: 0, xs: new Float32Array(CAPACITY), zs: new Float32Array(CAPACITY) });
  useEffect(
    () => () => {
      obstacles.n = 0;
    },
    [],
  );

  const storeType = useMemo(() => new Map(map.stores.map((s) => [s.id, s.type])), [map]);
  const looks = useMemo(
    () =>
      agents.map((a) => {
        const h = hash(a.id.split("~")[0]);
        const owner = a.persona === "owner";
        const type = owner ? storeType.get(a.visitStores[0] ?? "") : undefined;
        return {
          shirt: owner ? OWNER_TOP : new Color(personaColor(a.persona)),
          apron: owner ? new Color(type ? STORE_COLORS[type].awning : LAMP) : null,
          trousers: TROUSERS[h % TROUSERS.length],
          skin: SKIN_TONES[(h >> 3) % SKIN_TONES.length],
          stride: (h % 628) / 100,
        };
      }),
    [agents, storeType],
  );

  // per-agent side-step (scene metres), kept across frames and eased so agents glide apart instead of jumping
  const offsets = useMemo(() => ({ x: new Float32Array(agents.length), z: new Float32Array(agents.length), baseX: new Float32Array(CAPACITY), baseZ: new Float32Array(CAPACITY) }), [agents]);

  useFrame(({ clock }, delta) => {
    const t = useSim.getState().t;
    const selected = interactive ? useEconomy.getState().personId : null;
    const time = clock.elapsedTime;
    // a faint self-glow at night so people stay readable against dark streets
    const mat = (people.group.children[0] as unknown as { material: MeshStandardMaterial }).material;
    mat.emissiveIntensity = 0.1 + 0.3 * nightLevel(hourOf(t));
    live.occupancy.clear();
    let n = 0;
    let sel = -1;
    for (let i = 0; i < agents.length && n < CAPACITY; i++) {
      const a = agents[i];
      if (t < a.t0 || t > a.t1) continue;
      // the owner behind the counter isn't a customer
      if (a.persona !== "owner")
        for (let k = 0; k < a.visitsIn.length; k++)
          if (t >= a.visitsIn[k] && t < a.visitsOut[k]) {
            const id = a.visitStores[k];
            live.occupancy.set(id, (live.occupancy.get(id) ?? 0) + 1);
          }
      const s = sampleAgent(a, t);
      if (!s.visible) continue;
      const [x, z] = toScene(s.x, s.z);
      offsets.baseX[n] = x;
      offsets.baseZ[n] = z;
      obstacles.xs[n] = x + offsets.x[i];
      obstacles.zs[n] = z + offsets.z[i];
      // sampleAgent's heading is in contract coords (atan2(dx, dz)); the scene flips z
      placed.heading[n] = Math.PI - s.heading;
      placed.phase[n] = time * 8 + looks[i].stride;
      placed.moving[n] = s.moving ? 1 : 0;
      placed.who[n] = i;
      if (selected && sel < 0 && personOf(a.id) === selected) sel = n;
      n++;
    }
    // step apart anyone sharing a spot; the background crowd then avoids these positions (obstacles)
    sep.separate(obstacles.xs, obstacles.zs, n, MIN_GAP, { maxPush: MAX_PUSH });
    obstacles.n = n;
    const ease = Math.min(1, Math.min(delta, 0.1) * 4);
    for (let q = 0; q < n; q++) {
      const i = placed.who[q];
      offsets.x[i] += (obstacles.xs[q] - offsets.baseX[q] - offsets.x[i]) * ease;
      offsets.z[i] += (obstacles.zs[q] - offsets.baseZ[q] - offsets.z[i]) * ease;
      // the crowd avoids where agents are actually drawn
      obstacles.xs[q] = offsets.baseX[q] + offsets.x[i];
      obstacles.zs[q] = offsets.baseZ[q] + offsets.z[i];
      const look = looks[i];
      const phase = placed.phase[q];
      const moving = placed.moving[q] === 1;
      people.set(q, obstacles.xs[q], moving ? Math.abs(Math.sin(phase)) * 0.08 : 0, obstacles.zs[q], placed.heading[q], phase, moving, SCALE, look.shirt, look.trousers, look.skin, look.apron);
    }
    people.commit(n);
    shown.current.agents = agents;
    shown.current.n = n;
    shown.current.xs.set(obstacles.xs.subarray(0, n));
    shown.current.zs.set(obstacles.zs.subarray(0, n));
    live.onStreet = n;
    if (ring.current) {
      ring.current.visible = sel >= 0;
      if (sel >= 0) {
        ring.current.position.set(obstacles.xs[sel], 0.12, obstacles.zs[sel]);
        ring.current.scale.setScalar(1 + Math.sin(time * 5) * 0.08);
      }
    }
  });

  // Click anyone: the nearest person drawn within a few pixels of the click (screen space, so small, moving
  // figures are easy to hit). A pick swallows the click, so the store behind them isn't selected too.
  const { camera, gl } = useThree();
  useEffect(() => {
    if (!interactive) return;
    const el = gl.domElement;
    let down: [number, number] | null = null;
    const v = new Vector3();
    const onDown = (e: PointerEvent) => {
      down = [e.clientX, e.clientY];
    };
    const onClick = (e: MouseEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      // a shop under the pointer wins: the shop card is how owners see their store
      if (useSim.getState().hoveredStoreId) return;
      const { agents: list, n, xs, zs } = shown.current;
      const rect = el.getBoundingClientRect();
      let best = -1;
      let bestD = PICK_PX;
      for (let q = 0; q < n; q++) {
        v.set(xs[q], 1.1 * SCALE, zs[q]).project(camera);
        if (v.z > 1) continue;
        const d = Math.hypot(rect.left + ((v.x + 1) / 2) * rect.width - e.clientX, rect.top + ((1 - v.y) / 2) * rect.height - e.clientY);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      const a = best >= 0 ? list[placed.who[best]] : undefined;
      if (!a) return;
      e.stopPropagation();
      useEconomy.getState().selectPerson(personOf(a.id));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("click", onClick);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("click", onClick);
    };
  }, [interactive, gl, camera, placed]);
  const over = (e: ThreeEvent<PointerEvent>) => {
    if (!interactive) return;
    e.stopPropagation();
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    if (interactive) document.body.style.cursor = "";
  };

  return (
    <>
      <primitive object={people.group} name="agents" onPointerOver={over} onPointerOut={out} />
      <mesh ref={ring} rotation-x={-Math.PI / 2} visible={false} name="agent-selected">
        <ringGeometry args={[1.6, 2.2, 32]} />
        <meshBasicMaterial color={LAMP} transparent opacity={0.9} depthWrite={false} />
      </mesh>
    </>
  );
}
