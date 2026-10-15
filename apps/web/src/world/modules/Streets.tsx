// Module: Streets. Each street polyline segment becomes a flat asphalt strip with a dashed centre line, plus zebra
// crossings where two (grid) streets meet. Overlapping OSM ways are layered by road class and fully-covered pieces
// skipped (sim/roadLayers.ts), so dual carriageways and junction links never z-fight or paint dashes across a
// junction. Pure geometry, built once.
import { useMemo } from "react";
import { BoxGeometry, CylinderGeometry, Object3D, type InstancedMesh } from "three";
import type { Street } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { MARKING_LIFT, ROAD_TOP, roadLayout } from "../../sim/roadLayers";
import { useWorld } from "../context";
import { GROUND } from "../palette";

const THICK = 0.1;

function fill(mesh: InstancedMesh | null, mats: Object3D[]) {
  if (!mesh) return;
  mats.forEach((o, i) => mesh.setMatrixAt(i, o.matrix));
  mesh.count = mats.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

const mk = (x: number, y: number, z: number, sx: number, sz: number, rot: number) => {
  const o = new Object3D();
  o.position.set(x, y, z);
  o.rotation.y = rot;
  o.scale.set(sx, 1, sz);
  o.updateMatrix();
  return o;
};

/** Zebra crossings where an axis-aligned north-south street meets an east-west one (the mock's grid). */
function zebrasFor(streets: Street[]): Object3D[] {
  const segs = streets.flatMap((s) =>
    s.points.slice(0, -1).map((p, i) => {
      const [ax, az] = toScene(...p);
      const [bx, bz] = toScene(...s.points[i + 1]);
      return { x: (ax + bx) / 2, z: (az + bz) / 2, width: s.width, angle: Math.atan2(bx - ax, bz - az) };
    }),
  );
  const y = ROAD_TOP[2] + MARKING_LIFT;
  const out: Object3D[] = [];
  const vs = segs.filter((s) => Math.abs(Math.sin(s.angle)) < 0.01);
  const hs = segs.filter((s) => Math.abs(Math.cos(s.angle)) < 0.01);
  for (const v of vs)
    for (const h of hs) {
      const x = v.x;
      const z = h.z;
      for (const dir of [-1, 1]) {
        const off = h.width / 2 + 3;
        for (let i = -2; i <= 2; i++) out.push(mk(x + i * (v.width / 5.5), y, z + dir * off, v.width / 12, 3, 0));
        const offV = v.width / 2 + 3;
        for (let i = -2; i <= 2; i++) out.push(mk(x + dir * offV, y, z + i * (h.width / 5.5), 3, h.width / 12, 0));
      }
    }
  return out;
}

export default function Streets() {
  const { map } = useWorld();
  const { roads, dashes, zebras, joints } = useMemo(() => {
    const layout = roadLayout(map.streets);
    const roads = layout.pieces.map((p) => {
      const [ax, az] = toScene(p.ax, p.az);
      const [bx, bz] = toScene(p.bx, p.bz);
      return mk((ax + bx) / 2, p.top - THICK / 2, (az + bz) / 2, p.width, Math.hypot(bx - ax, bz - az), Math.atan2(bx - ax, bz - az));
    });
    const dashes = layout.dashes.map((d) => {
      const [x, z] = toScene(d.x, d.z);
      return mk(x, d.top - THICK / 2, z, 0.35, 4, Math.atan2(d.dx, -d.dz));
    });
    const joints = layout.joints.map((j) => {
      const [x, z] = toScene(j.x, j.z);
      return mk(x, j.top - THICK / 2, z, j.r, j.r, 0);
    });
    return { roads, dashes, zebras: zebrasFor(map.streets), joints };
  }, [map]);

  const box = useMemo(() => new BoxGeometry(1, THICK, 1), []);
  const disc = useMemo(() => new CylinderGeometry(1, 1, THICK, 20), []);

  return (
    <group name="streets">
      <instancedMesh args={[box, undefined, Math.max(1, roads.length)]} receiveShadow ref={(m) => fill(m, roads)}>
        <meshStandardMaterial color={GROUND.asphalt} roughness={0.9} />
      </instancedMesh>
      <instancedMesh args={[disc, undefined, Math.max(1, joints.length)]} receiveShadow ref={(m) => fill(m, joints)}>
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
