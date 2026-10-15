// Module: StreetLights. Lamp posts along both pavements of every street; heads glow at night.
// Two instanced meshes (posts, heads): two draw calls for the whole city.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Object3D, type InstancedMesh, type MeshStandardMaterial } from "three";
import { closestOnStreet, toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { LAMP } from "../palette";

const SPACING = 34;
const POST_H = 6;

export default function StreetLights() {
  const { map } = useWorld();
  const head = useRef<MeshStandardMaterial>(null);

  const spots = useMemo(() => {
    const out: [number, number][] = [];
    for (const s of map.streets)
      for (let i = 0; i < s.points.length - 1; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        const off = s.width / 2 + 1.2;
        for (let d = SPACING / 2; d < len; d += SPACING) {
          const x = ax + ux * d;
          const z = az + uz * d;
          const side = (Math.floor(d / SPACING) % 2) * 2 - 1; // alternate sides
          const lx = x - uz * off * side;
          const lz = z + ux * off * side;
          // skip junctions (lamp would stand in another street) and lamps inside a building footprint
          const inStreet = map.streets.some((o) => o !== s && closestOnStreet(o, lx, lz)[2] < o.width / 2 + 1);
          const inBuilding = map.buildings.some((b) => Math.abs(lx - b.x) < b.w / 2 && Math.abs(lz - b.z) < b.d / 2);
          if (inStreet || inBuilding) continue;
          out.push(toScene(lx, lz));
        }
      }
    return out;
  }, [map]);

  const setup = (m: InstancedMesh | null, y: number) => {
    if (!m) return;
    const o = new Object3D();
    spots.forEach(([x, z], i) => {
      o.position.set(x, y, z);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  };

  useFrame(() => {
    const n = nightLevel(hourOf(useSim.getState().t));
    if (head.current) head.current.emissiveIntensity = n * 2.2;
  });

  if (!spots.length) return null;
  return (
    <group name="street-lights">
      <instancedMesh args={[undefined, undefined, spots.length]} ref={(m) => setup(m, POST_H / 2)} castShadow>
        <cylinderGeometry args={[0.15, 0.2, POST_H, 6]} />
        <meshStandardMaterial color="#3d4452" roughness={0.6} />
      </instancedMesh>
      <instancedMesh args={[undefined, undefined, spots.length]} ref={(m) => setup(m, POST_H + 0.3)}>
        <sphereGeometry args={[0.55, 10, 8]} />
        <meshStandardMaterial ref={head} color="#fff4d6" emissive={LAMP} emissiveIntensity={0} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
