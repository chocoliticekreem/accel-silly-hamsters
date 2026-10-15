// Optional renderer for a CraneLoad: hoist rope (anchor → hook), a striped hook block, four slings to the load's
// top corners, and the load itself (a pallet of bricks, a bundle of steel beams or a precast panel).
// Reads the load's pose every frame; draw your own instead if the crane module wants a different look.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { HOOK_HALF, type CraneLoad } from "./craneLoad";

export type Cargo = "bricks" | "beams" | "panel";

const noRaycast = () => null;
const v0 = new Vector3();
const v1 = new Vector3();
const vc = new Vector3();
const Y = new Vector3(0, 1, 0);

/** Stretch a unit-length, Y-aligned cylinder mesh between two points. */
function span(m: Mesh, a: Vector3, b: Vector3) {
  v0.subVectors(b, a);
  const len = v0.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  if (len > 1e-6) m.quaternion.setFromUnitVectors(Y, v0.divideScalar(len));
  m.scale.set(1, Math.max(len, 1e-3), 1);
}

export function CraneHoist({ load, cargo = "bricks" }: { load: CraneLoad; cargo?: Cargo }) {
  const rope = useRef<Mesh>(null);
  const hook = useRef<Group>(null);
  const body = useRef<Group>(null);
  const slings = useRef<(Mesh | null)[]>([]);
  const [w, h, d] = load.size;

  const res = useMemo(() => {
    const line = new CylinderGeometry(0.035, 0.035, 1, 5);
    const steel = new MeshStandardMaterial({ color: "#2d2f33", roughness: 0.5, metalness: 0.6 });
    const yellow = new MeshStandardMaterial({ color: "#f2b705", roughness: 0.6 });
    const black = new MeshStandardMaterial({ color: "#151515", roughness: 0.7 });
    const pallet = new MeshStandardMaterial({ color: "#a07a4a", roughness: 0.95 });
    const cargoMat = new MeshStandardMaterial({
      color: cargo === "bricks" ? "#9c4a32" : cargo === "beams" ? "#5d6670" : "#c9c4b8",
      roughness: cargo === "beams" ? 0.45 : 0.9,
      metalness: cargo === "beams" ? 0.5 : 0,
    });
    return { line, steel, yellow, black, pallet, cargoMat, unit: new BoxGeometry(1, 1, 1) };
  }, [cargo]);

  useFrame(() => {
    if (rope.current) span(rope.current, load.anchor, v1.copy(load.hook).setY(load.hook.y + HOOK_HALF));
    hook.current?.position.copy(load.hook);
    if (body.current) {
      body.current.position.copy(load.position);
      body.current.quaternion.copy(load.quaternion);
    }
    // slings: hook bottom → the load's four top corners (in world space)
    const bottom = v1.copy(load.hook).setY(load.hook.y - HOOK_HALF);
    const corners = [
      [-w / 2.4, d / 2.4],
      [w / 2.4, d / 2.4],
      [w / 2.4, -d / 2.4],
      [-w / 2.4, -d / 2.4],
    ];
    corners.forEach(([cx, cz], i) => {
      const m = slings.current[i];
      if (!m) return;
      span(m, bottom, vc.set(cx, h / 2, cz).applyQuaternion(load.quaternion).add(load.position));
    });
  });

  const box = (key: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: MeshStandardMaterial) => (
    <mesh key={key} geometry={res.unit} material={mat} position={[x, y, z]} scale={[sx, sy, sz]} castShadow raycast={noRaycast} />
  );

  return (
    <group name="crane-hoist">
      <mesh ref={rope} geometry={res.line} material={res.steel} raycast={noRaycast} />
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => void (slings.current[i] = m)} geometry={res.line} material={res.steel} raycast={noRaycast} />
      ))}
      <group ref={hook}>
        {box("hb", 0, 0.12, 0, 0.7, HOOK_HALF * 1.3, 0.45, res.yellow)}
        {box("hs", 0, 0.12, 0, 0.72, 0.1, 0.47, res.black)}
        {box("hk", 0, -HOOK_HALF + 0.08, 0, 0.12, 0.3, 0.12, res.steel)}
      </group>
      <group ref={body}>
        {cargo === "bricks" && (
          <>
            {box("p", 0, -h / 2 + 0.07, 0, w, 0.14, d, res.pallet)}
            {box("c", 0, 0.07, 0, w * 0.96, h - 0.14, d * 0.96, res.cargoMat)}
          </>
        )}
        {cargo === "beams" &&
          [-1, 0, 1].map((k) => (
            <group key={k}>
              {box(`f${k}`, (k * w) / 3.2, 0, 0, w / 4, h, d, res.cargoMat)}
            </group>
          ))}
        {cargo === "panel" && box("pn", 0, 0, 0, w, h, d, res.cargoMat)}
      </group>
    </group>
  );
}
