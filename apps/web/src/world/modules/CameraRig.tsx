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
import { camFromUrl, flyRequest } from "../flyTo";

type Controls = ComponentRef<typeof OrbitControls>;

interface Shared {
  leader: number | null;
  position: Vector3;
  target: Vector3;
}
const groups = new Map<string, Shared>();
let rigSeq = 0;

// From the north-east looking south-west over Hoxton, Shoreditch and Old Street (the playable focus), with the
// Overground viaduct curving through and the City of London skyline behind.
const HOME_POS = new Vector3(150, 330, -700);
const HOME_TARGET = new Vector3(-380, 0, -260);
const SMALL_HOME_POS = new Vector3(190, 105, -230);
const SMALL_HOME_TARGET = new Vector3(-10, 0, 20);
const FOCUS_DIST = 150;
/** Angle from straight down when focusing a store (radians); ~32°. */
const FOCUS_POLAR = 0.55;

export default function CameraRig() {
  const { map, cameraGroup } = useWorld();
  const camera = useThree((s) => s.camera);
  const [controls, setControls] = useState<Controls | null>(null);
  const id = useMemo(() => ++rigSeq, []);
  const shared = useMemo(() => {
    if (!groups.has(cameraGroup)) {
      const url = camFromUrl();
      // the focus shot needs the 1.5 km real map; the small mock map keeps the close-up of its centre
      const b = map.bounds;
      const focus = b.minX <= -380 && b.maxZ >= 260;
      const home = focus ? { p: HOME_POS, t: HOME_TARGET } : { p: SMALL_HOME_POS, t: SMALL_HOME_TARGET };
      groups.set(cameraGroup, { leader: null, position: url ? new Vector3(...url.position) : home.p.clone(), target: url ? new Vector3(...url.target) : home.t.clone() });
    }
    return groups.get(cameraGroup)!;
  }, [cameraGroup, map]);
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
    // keep the user's compass direction but come in steeply, so a small shop between tall offices stays in view
    const off = camera.position.clone().sub(controls.target);
    const azimuth = Math.atan2(off.x, off.z);
    const dir = new Vector3(Math.sin(FOCUS_POLAR) * Math.sin(azimuth), Math.cos(FOCUS_POLAR), Math.sin(FOCUS_POLAR) * Math.cos(azimuth));
    fly.current = { target, position: target.clone().add(dir.multiplyScalar(FOCUS_DIST)), k: 0 };
    shared.leader = id;
  }, [selected, controls, map, camera, id, shared]);

  const flySeq = useRef(0);
  useFrame((_, delta) => {
    if (!controls) return;
    // fly to a landmark (world/flyTo): keep the compass direction, come in at a readable angle
    const req = flyRequest.current;
    if (req && req.seq !== flySeq.current && (shared.leader === null || shared.leader === id)) {
      flySeq.current = req.seq;
      const [x, z] = toScene(req.x, req.z);
      const target = new Vector3(x, req.y ?? 0, z);
      const off = camera.position.clone().sub(controls.target);
      const azimuth = Math.atan2(off.x, off.z);
      const polar = 0.95;
      const dir = new Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth));
      fly.current = { target, position: target.clone().add(dir.multiplyScalar(req.dist)), k: 0 };
      shared.leader = id;
    }
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
      maxDistance={1500}
      maxPolarAngle={Math.PI * 0.44}
      onStart={() => {
        shared.leader = id;
        fly.current = null;
      }}
    />
  );
}
