// Module: Ground. The city floor: a pavement-grey plane out past the horizon (the Surroundings module builds London
// on it; the fog fades it into the sky) and the lighter pavement slab inside the map bounds.
// (Was: a grass apron with a ring of trees, which read as an empty field once you looked past the map edge.)
import { toScene } from "../../sim/geometry";
import { useWorld } from "../context";
import { GROUND } from "../palette";

export default function Ground() {
  const { map } = useWorld();
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const [cx, cz] = toScene((minX + maxX) / 2, (minZ + maxZ) / 2);

  return (
    <group name="ground">
      <mesh rotation-x={-Math.PI / 2} position={[cx, -0.2, cz]} receiveShadow>
        {/* reaches well past the fog's far plane so there is never an edge */}
        <planeGeometry args={[14000, 14000]} />
        <meshStandardMaterial color={GROUND.city} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[w + 16, d + 16]} />
        <meshStandardMaterial color={GROUND.pavement} roughness={0.95} />
      </mesh>
    </group>
  );
}
