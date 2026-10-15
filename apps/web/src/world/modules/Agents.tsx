// Module: Agents. Every citizen as a little capsule coloured by persona, played back from day keyframes.
// One InstancedMesh; each frame we sample every agent at `t` (linear interpolation, hidden inside stores),
// pack the visible ones into the instance buffer and count who is inside which store (live.occupancy).
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { CapsuleGeometry, Color, DynamicDrawUsage, MeshStandardMaterial, Object3D, type InstancedMesh } from "three";
import { toScene } from "../../sim/geometry";
import { sampleAgent } from "../../sim/interp";
import { nightLevel } from "../../sim/sky";
import { dayOf, hourOf } from "../../sim/time";
import { useDayAgents } from "../../state/data";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { personaColor } from "../palette";

const CAPACITY = 4000;
const SCALE = 2; // cartoon scale: readable from the default camera

export default function Agents() {
  const { run, live } = useWorld();
  const day = useSim((s) => dayOf(s.t));
  const agents = useDayAgents(run, day);
  const mesh = useRef<InstancedMesh>(null);

  const { geo, mat } = useMemo(
    () => ({
      geo: new CapsuleGeometry(0.55, 1.1, 4, 8).translate(0, 1.1, 0),
      mat: new MeshStandardMaterial({ roughness: 0.7, emissive: "#ffffff", emissiveIntensity: 0 }),
    }),
    [],
  );
  const colors = useMemo(() => agents.map((a) => new Color(personaColor(a.persona))), [agents]);
  const o = useMemo(() => new Object3D(), []);

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const t = useSim.getState().t;
    const bob = clock.elapsedTime * 9;
    // a faint self-glow at night so people stay readable against dark streets
    mat.emissiveIntensity = 0.28 * nightLevel(hourOf(t));
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
      o.position.set(x, s.moving ? Math.abs(Math.sin(bob + i)) * 0.35 : 0, z);
      o.rotation.set(0, s.heading, s.moving ? Math.sin(bob + i) * 0.12 : 0);
      o.scale.setScalar(SCALE);
      o.updateMatrix();
      m.setMatrixAt(n, o.matrix);
      m.setColorAt(n, colors[i]);
      n++;
    }
    m.count = n;
    live.onStreet = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={(m) => {
        mesh.current = m;
        if (m) {
          m.instanceMatrix.setUsage(DynamicDrawUsage);
          m.setColorAt(0, new Color()); // allocate instanceColor
          m.count = 0;
        }
      }}
      args={[geo, mat, CAPACITY]}
      castShadow
      frustumCulled={false}
      name="agents"
    />
  );
}
