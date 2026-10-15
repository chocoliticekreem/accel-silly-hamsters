// Module: Ground. A soft grass apron beyond the map, the pavement slab inside the bounds, and a few cartoon trees.
import { useMemo } from "react";
import { Object3D } from "three";
import { toScene } from "../../sim/geometry";
import { useWorld } from "../context";
import { GROUND } from "../palette";

const TREES = 90;

export default function Ground() {
  const { map } = useWorld();
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const [cx, cz] = toScene((minX + maxX) / 2, (minZ + maxZ) / 2);

  // trees on the grass apron around the map edge (deterministic ring)
  const trees = useMemo(() => {
    const o = new Object3D();
    const out: { matrix: Object3D["matrix"] }[] = [];
    for (let i = 0; i < TREES; i++) {
      const a = (i / TREES) * Math.PI * 2;
      const r = Math.max(w, d) / 2 + 28 + ((i * 37) % 23);
      const x = cx + Math.cos(a) * r * (1 + 0.05 * Math.sin(i));
      const z = cz + Math.sin(a) * r;
      const s = 0.8 + ((i * 53) % 10) / 15;
      o.position.set(x, 8 * s, z);
      o.scale.setScalar(s);
      o.updateMatrix();
      out.push({ matrix: o.matrix.clone() });
    }
    return out;
  }, [w, d, cx, cz]);

  return (
    <group name="ground">
      <mesh rotation-x={-Math.PI / 2} position={[cx, -0.2, cz]} receiveShadow>
        <planeGeometry args={[w * 4, d * 4]} />
        <meshStandardMaterial color={GROUND.grass} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[w + 16, d + 16]} />
        <meshStandardMaterial color={GROUND.pavement} roughness={0.95} />
      </mesh>
      <instancedMesh args={[undefined, undefined, trees.length]} castShadow ref={(m) => {
          if (!m) return;
          trees.forEach((t, i) => m.setMatrixAt(i, t.matrix));
          m.instanceMatrix.needsUpdate = true;
        }}>
        <coneGeometry args={[6, 16, 7]} />
        <meshStandardMaterial color="#5f7d64" flatShading roughness={1} />
      </instancedMesh>
    </group>
  );
}
