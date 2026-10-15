// Module: CameraRig. Orbit camera (drag to rotate, right-drag to pan, wheel to zoom), an eased fly-to when a store
// is selected, and camera sharing between views in the same cameraGroup (compare mode): whichever view the user
// last touched leads, the other follows.
import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Vector3 } from "three";
import { toScene } from "../../sim/geometry";
import { useSim } from "../../state/store";
import { useWorld } from "../context";

type Controls = ComponentRef<typeof OrbitControls>;

interface Shared {
  leader: number | null;
  position: Vector3;
  target: Vector3;
}
const groups = new Map<string, Shared>();
let rigSeq = 0;

const HOME_POS = new Vector3(230, 250, 330);
const HOME_TARGET = new Vector3(0, 0, -10);
const FOCUS_DIST = 150;

export default function CameraRig() {
  const { map, cameraGroup } = useWorld();
  const camera = useThree((s) => s.camera);
  const [controls, setControls] = useState<Controls | null>(null);
  const id = useMemo(() => ++rigSeq, []);
  const shared = useMemo(() => {
    if (!groups.has(cameraGroup)) groups.set(cameraGroup, { leader: null, position: HOME_POS.clone(), target: HOME_TARGET.clone() });
    return groups.get(cameraGroup)!;
  }, [cameraGroup]);
  const fly = useRef<{ target: Vector3; position: Vector3; k: number } | null>(null);
  const selected = useSim((s) => s.selectedStoreId);

  // start where the group is (so a compare view opens on the same shot)
  useEffect(() => {
    if (!controls) return;
    camera.position.copy(shared.position);
    controls.target.copy(shared.target);
    controls.update();
  }, [controls, camera, shared]);

  // fly to the selected store, keeping the current viewing angle
  useEffect(() => {
    if (!controls || !selected || shared.leader !== null && shared.leader !== id) return;
    const store = map.stores.find((s) => s.id === selected);
    const b = store && map.buildings.find((x) => x.id === store.buildingId);
    if (!b) return;
    const [x, z] = toScene(b.x, b.z);
    const target = new Vector3(x, 0, z);
    const dir = camera.position.clone().sub(controls.target).normalize();
    fly.current = { target, position: target.clone().add(dir.multiplyScalar(FOCUS_DIST)), k: 0 };
    shared.leader = id;
  }, [selected, controls, map, camera, id, shared]);

  useFrame((_, delta) => {
    if (!controls) return;
    const f = fly.current;
    if (f) {
      f.k = Math.min(1, f.k + delta * 1.6);
      const e = 1 - Math.pow(1 - f.k, 3);
      controls.target.lerp(f.target, e * 0.25);
      camera.position.lerp(f.position, e * 0.25);
      if (f.k >= 1) fly.current = null;
      controls.update();
    }
    if (shared.leader === id || shared.leader === null) {
      shared.position.copy(camera.position);
      shared.target.copy(controls.target);
    } else if (!camera.position.equals(shared.position) || !controls.target.equals(shared.target)) {
      camera.position.copy(shared.position);
      controls.target.copy(shared.target);
      controls.update();
    }
  });

  return (
    <OrbitControls
      ref={setControls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={30}
      maxDistance={900}
      maxPolarAngle={Math.PI * 0.44}
      onStart={() => {
        shared.leader = id;
        fly.current = null;
      }}
    />
  );
}
