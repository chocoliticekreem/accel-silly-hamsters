// Module: Agents. Every sim citizen as a little person (shirt = persona colour), played back from day keyframes.
// Each frame we sample every agent at `t` (linear interpolation, hidden inside stores), write the visible ones
// into the shared people meshes, and count who is inside which store (live.occupancy).
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, type MeshStandardMaterial } from "three";
import { toScene } from "../../sim/geometry";
import { sampleAgent } from "../../sim/interp";
import { nightLevel } from "../../sim/sky";
import { dayOf, hourOf } from "../../sim/time";
import { useDayAgents } from "../../state/data";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { personaColor } from "../palette";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";

const CAPACITY = 4000;
/** Sim agents are a touch bigger than the background crowd so the sample stands out. */
const SCALE = 2.7;

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

  const looks = useMemo(
    () =>
      agents.map((a) => {
        const h = hash(a.id.split("~")[0]);
        return { shirt: new Color(personaColor(a.persona)), trousers: TROUSERS[h % TROUSERS.length], skin: SKIN_TONES[(h >> 3) % SKIN_TONES.length], stride: (h % 628) / 100 };
      }),
    [agents],
  );

  useFrame(({ clock }) => {
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
      const look = looks[i];
      const phase = time * 8 + look.stride;
      // sampleAgent's heading is in contract coords (atan2(dx, dz)); the scene flips z
      people.set(n, x, s.moving ? Math.abs(Math.sin(phase)) * 0.08 : 0, z, Math.PI - s.heading, phase, s.moving, SCALE, look.shirt, look.trousers, look.skin);
      n++;
    }
    people.commit(n);
    live.onStreet = n;
  });

  return <primitive object={people.group} name="agents" />;
}
