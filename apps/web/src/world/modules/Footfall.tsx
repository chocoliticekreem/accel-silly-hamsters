// Module: Footfall (background crowd). The sim's coloured agents are a sample: per the backend's demand data
// (data/processed/demand.json) one sim agent stands for ~48 real arrivals. This layer draws the rest of those people
// as small neutral walkers on the pavements, so the street density follows the sim (live.onStreet) at real-world scale.
// They are drawn, never counted: KPIs come only from the sim.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { CapsuleGeometry, Color, DynamicDrawUsage, MeshStandardMaterial, Object3D, type InstancedMesh } from "three";
import { rng } from "../../mock/rng";
import { toScene } from "../../sim/geometry";
import { newPoint, pingPong, polyline, type Polyline } from "../../sim/polyline";
import { useWorld } from "../context";

/** Real people per sim agent (demand.json notes: "1 sim agent ~ 48 real arrivals"). */
export const PEOPLE_PER_AGENT = 48;
/** Hard cap on drawn walkers (GPU budget). */
const MAX_WALKERS = 1600;
/** Floor so the city never looks dead while the sim has nobody between trips. */
const MIN_WALKERS = 60;

const TONES = ["#9aa3b2", "#b7aea3", "#7f8794", "#a59a8e", "#c4c9d1", "#6f7784", "#b8a693"];

interface Walker {
  path: Polyline;
  side: number;
  speed: number;
  phase: number;
  color: Color;
}

const o = new Object3D();
const p = newPoint();

export default function Footfall() {
  const { map, live } = useWorld();
  const mesh = useRef<InstancedMesh>(null);
  const shown = useRef(MIN_WALKERS);

  const walkers = useMemo(() => {
    const r = rng(11);
    const paths = map.streets.map((s) => ({ s, path: polyline(s.points) })).filter((x) => x.path.length > 20);
    const total = paths.reduce((a, x) => a + x.path.length, 0) || 1;
    const out: Walker[] = [];
    for (let i = 0; i < MAX_WALKERS; i++) {
      // pick streets in proportion to length, so long high streets carry more people
      let k = r() * total;
      const pick = paths.find((x) => (k -= x.path.length) <= 0) ?? paths[0];
      out.push({
        path: pick.path,
        side: (r() < 0.5 ? -1 : 1) * (pick.s.width / 2 + 1.2 + r() * 1.2),
        speed: 1.0 + r() * 0.6,
        phase: r() * pick.path.length * 2,
        color: new Color(TONES[Math.floor(r() * TONES.length)]),
      });
    }
    return out;
  }, [map]);

  const { geo, mat } = useMemo(
    () => ({ geo: new CapsuleGeometry(0.42, 0.9, 3, 6).translate(0, 0.9, 0), mat: new MeshStandardMaterial({ roughness: 0.85 }) }),
    [],
  );

  useFrame(({ clock }, delta) => {
    const m = mesh.current;
    if (!m) return;
    // ease toward the data-driven target so the crowd swells and thins instead of popping
    const target = Math.min(MAX_WALKERS, Math.max(MIN_WALKERS, live.onStreet * PEOPLE_PER_AGENT));
    shown.current += (target - shown.current) * Math.min(1, delta * 1.5);
    const n = Math.round(shown.current);
    const time = clock.elapsedTime;
    for (let i = 0; i < n; i++) {
      const w = walkers[i];
      const [s, forward] = pingPong(w.phase + time * w.speed, w.path.length);
      w.path.at(s, w.side, p);
      const [x, z] = toScene(p.x, p.z);
      const dir = forward ? 1 : -1;
      o.position.set(x, Math.abs(Math.sin(time * 8 + i)) * 0.12, z);
      o.rotation.set(0, Math.atan2(p.dx * dir, -p.dz * dir), 0);
      o.scale.setScalar(1.5);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, w.color);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={(m) => {
        mesh.current = m;
        if (m) {
          m.instanceMatrix.setUsage(DynamicDrawUsage);
          m.setColorAt(0, new Color());
          m.count = 0;
        }
      }}
      args={[geo, mat, MAX_WALKERS]}
      frustumCulled={false}
      name="footfall"
    />
  );
}
