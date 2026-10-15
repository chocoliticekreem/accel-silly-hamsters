// Module: Streets. Each street polyline segment becomes a flat asphalt strip with a dashed centre line,
// plus zebra crossings where two streets meet. Pure geometry, built once.
import { useMemo } from "react";
import { BoxGeometry, Object3D, type InstancedMesh } from "three";
import type { Street } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { useWorld } from "../context";
import { GROUND } from "../palette";

interface Seg {
  x: number;
  z: number;
  len: number;
  width: number;
  angle: number;
}

function segments(streets: Street[]): Seg[] {
  const out: Seg[] = [];
  for (const s of streets)
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = toScene(...s.points[i]);
      const [bx, bz] = toScene(...s.points[i + 1]);
      out.push({ x: (ax + bx) / 2, z: (az + bz) / 2, len: Math.hypot(bx - ax, bz - az), width: s.width, angle: Math.atan2(bx - ax, bz - az) });
    }
  return out;
}

const DASH = 4;
const GAP = 5;

function fill(mesh: InstancedMesh | null, mats: Object3D[]) {
  if (!mesh) return;
  mats.forEach((o, i) => mesh.setMatrixAt(i, o.matrix));
  mesh.count = mats.length;
  mesh.instanceMatrix.needsUpdate = true;
}

export default function Streets() {
  const { map } = useWorld();
  const { roads, dashes, zebras } = useMemo(() => {
    const segs = segments(map.streets);
    const mk = (x: number, y: number, z: number, sx: number, sz: number, rot: number) => {
      const o = new Object3D();
      o.position.set(x, y, z);
      o.rotation.y = rot;
      o.scale.set(sx, 1, sz);
      o.updateMatrix();
      return o;
    };
    const roads = segs.map((s) => mk(s.x, 0.05, s.z, s.width, s.len, s.angle));
    const dashes: Object3D[] = [];
    for (const s of segs) {
      const n = Math.floor(s.len / (DASH + GAP));
      for (let i = 0; i < n; i++) {
        const k = -s.len / 2 + (i + 0.5) * (DASH + GAP);
        dashes.push(mk(s.x + Math.sin(s.angle) * k, 0.12, s.z + Math.cos(s.angle) * k, 0.35, DASH, s.angle));
      }
    }
    // zebra crossings near each intersection of axis-aligned streets
    const zebras: Object3D[] = [];
    const vs = segs.filter((s) => Math.abs(Math.sin(s.angle)) < 0.01);
    const hs = segs.filter((s) => Math.abs(Math.cos(s.angle)) < 0.01);
    for (const v of vs)
      for (const h of hs) {
        const x = v.x;
        const z = h.z;
        for (const dir of [-1, 1]) {
          const off = h.width / 2 + 3;
          for (let i = -2; i <= 2; i++) zebras.push(mk(x + i * (v.width / 5.5), 0.12, z + dir * off, v.width / 12, 3, 0));
          const offV = v.width / 2 + 3;
          for (let i = -2; i <= 2; i++) zebras.push(mk(x + dir * offV, 0.12, z + i * (h.width / 5.5), 3, h.width / 12, 0));
        }
      }
    return { roads, dashes, zebras };
  }, [map]);

  const box = useMemo(() => new BoxGeometry(1, 0.1, 1), []);

  return (
    <group name="streets">
      <instancedMesh args={[box, undefined, roads.length]} receiveShadow ref={(m) => fill(m, roads)}>
        <meshStandardMaterial color={GROUND.asphalt} roughness={0.9} />
      </instancedMesh>
      <instancedMesh args={[box, undefined, Math.max(1, dashes.length)]} ref={(m) => fill(m, dashes)}>
        <meshStandardMaterial color={GROUND.marking} roughness={0.8} />
      </instancedMesh>
      <instancedMesh args={[box, undefined, Math.max(1, zebras.length)]} ref={(m) => fill(m, zebras)}>
        <meshStandardMaterial color={GROUND.marking} roughness={0.8} />
      </instancedMesh>
    </group>
  );
}
