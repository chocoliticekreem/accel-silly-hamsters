// Module: Agents. Every sim citizen as a little person (shirt = persona colour), played back from day keyframes.
// Each frame we sample every agent at `t` (linear interpolation, hidden inside stores), write the visible ones
// into the shared people meshes, and count who is inside which store (live.occupancy).
// Agents waiting at the same keyframe (a station exit, a door) are stepped a little apart so they don't render
// inside each other; the shift is capped at a few metres, so positions keep their meaning.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, type MeshStandardMaterial } from "three";
import { createSeparator, obstacles } from "../../sim/crowd";
import { toScene } from "../../sim/geometry";
import { sampleAgent } from "../../sim/interp";
import { nightLevel } from "../../sim/sky";
import { dayOf, hourOf } from "../../sim/time";
import { useDayAgents } from "../../state/data";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { personaColor } from "../palette";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";

const CAPACITY = obstacles.xs.length;
/** Sim agents are a touch bigger than the background crowd so the sample stands out. */
const SCALE = 2.4;
/** Centre-to-centre spacing between two agents at SCALE. */
const MIN_GAP = 2.2;
/** Cap on how far spacing may move an agent from its keyframe position (m). */
const MAX_PUSH = 3;

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
  const { run, live } = useWorld();
  const day = useSim((s) => dayOf(s.t));
  const agents = useDayAgents(run, day);
  const people = useMemo(() => createPeople(CAPACITY, { emissive: 0.1 }), []);
  useEffect(() => () => people.dispose(), [people]);
  const placed = useMemo<Placed>(() => ({ heading: new Float32Array(CAPACITY), phase: new Float32Array(CAPACITY), moving: new Uint8Array(CAPACITY), who: new Int32Array(CAPACITY) }), []);
  const sep = useMemo(() => createSeparator(CAPACITY), []);
  useEffect(
    () => () => {
      obstacles.n = 0;
    },
    [],
  );

  const looks = useMemo(
    () =>
      agents.map((a) => {
        const h = hash(a.id.split("~")[0]);
        return { shirt: new Color(personaColor(a.persona)), trousers: TROUSERS[h % TROUSERS.length], skin: SKIN_TONES[(h >> 3) % SKIN_TONES.length], stride: (h % 628) / 100 };
      }),
    [agents],
  );

  // per-agent side-step (scene metres), kept across frames and eased so agents glide apart instead of jumping
  const offsets = useMemo(() => ({ x: new Float32Array(agents.length), z: new Float32Array(agents.length), baseX: new Float32Array(CAPACITY), baseZ: new Float32Array(CAPACITY) }), [agents]);

  useFrame(({ clock }, delta) => {
    const t = useSim.getState().t;
    const time = clock.elapsedTime;
    // a faint self-glow at night so people stay readable against dark streets
    const mat = (people.group.children[0] as unknown as { material: MeshStandardMaterial }).material;
    mat.emissiveIntensity = 0.1 + 0.3 * nightLevel(hourOf(t));
    live.occupancy.clear();
    let n = 0;
    for (let i = 0; i < agents.length && n < CAPACITY; i++) {
      const a = agents[i];
      if (t < a.t0 || t > a.t1) continue;
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
      people.set(q, obstacles.xs[q], moving ? Math.abs(Math.sin(phase)) * 0.08 : 0, obstacles.zs[q], placed.heading[q], phase, moving, SCALE, look.shirt, look.trousers, look.skin);
    }
    people.commit(n);
    live.onStreet = n;
  });

  return <primitive object={people.group} name="agents" />;
}
