// Dev-only gallery for the procedural hero models (not part of the app build): /hero-gallery.html
//   ?set=vehicles|landmarks|street|people   a row of one kind
//   ?m=<catalog name>                       one model, close up
//   &night=1  night lighting   &t=<seconds> freeze the people clock   &yaw=<deg> &pitch=<rad> &zoom=<x>
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Matrix4 } from "three";
import { heroGroup } from "../world/hero";
import {
  HAIR_COLORS,
  HERO_CATALOG,
  heroModel,
  heroTris,
  PERSON_KINDS,
  PERSON_PALETTES,
  peopleMesh,
  peopleUniforms,
  setPerson,
  SKIN_TONES,
  type Anim,
} from "../world/models";
import { setHeroNight } from "../world/models/materials";

const q = new URLSearchParams(location.search);
const night = q.get("night") === "1";
const set = q.get("set") ?? "vehicles";
const single = q.get("m");
const yaw = (Number(q.get("yaw") ?? 35) * Math.PI) / 180;
const pitch = Number(q.get("pitch") ?? 0.32);
const zoom = Number(q.get("zoom") ?? 1);

function Frame({ w, h, cx = 0 }: { w: number; h: number; cx?: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const d = Math.max(w * 0.95, h * 1.9) / zoom + 2;
    camera.position.set(cx + Math.sin(yaw) * d * Math.cos(pitch), h * 0.45 + d * Math.sin(pitch), Math.cos(yaw) * d * Math.cos(pitch));
    camera.lookAt(cx, h * 0.4, 0);
    camera.updateProjectionMatrix();
  }, [camera, w, h, cx]);
  return null;
}

function Models() {
  const items = useMemo(() => {
    const names = single ? [single] : Object.keys(HERO_CATALOG).filter((n) => HERO_CATALOG[n].kind === set.replace(/s$/, ""));
    let x = 0;
    return names.map((n) => {
      const m = heroModel(n);
      const w = m.size[0];
      const it = { n, x: x + w / 2, w, m, obj: heroGroup(n) };
      x += w + Math.max(2, w * 0.3);
      console.log(`${n}: ${m.size.join(" x ")} m, ${heroTris(m)} tris, nodes: ${m.nodes.map((k) => k.name).join(",")}`);
      return it;
    });
  }, []);
  const last = items[items.length - 1];
  const total = last ? last.x + last.w / 2 : 1;
  const h = Math.max(...items.map((i) => i.m.size[1]));
  useFrame((s) => {
    for (const it of items)
      it.obj.traverse((o) => {
        if (o.name.startsWith("lamp")) o.visible = Math.sin(s.clock.elapsedTime * 10 + (o.name.includes("R") ? Math.PI : 0)) > -0.2;
      });
  });
  return (
    <>
      <Frame w={total} h={h} cx={total / 2} />
      {items.map((it) => (
        <primitive key={it.n} object={it.obj} position={[it.x, 0, 0]} />
      ))}
    </>
  );
}

const ANIMS: Anim[] = ["idle", "walk", "run", "dance"];

function People() {
  const uniforms = useMemo(() => peopleUniforms(), []);
  const meshes = useMemo(
    () =>
      PERSON_KINDS.map((k, i) => {
        const mesh = peopleMesh(k, ANIMS.length, uniforms);
        ANIMS.forEach((a, j) => {
          const m = new Matrix4().makeTranslation(i * 1.1 - 3.85, 0, -j * 1.8);
          setPerson(mesh, j, m, {
            anim: a,
            phase: i * 0.7,
            top: PERSON_PALETTES[k].top[j % PERSON_PALETTES[k].top.length],
            bottom: PERSON_PALETTES[k].bottom[j % PERSON_PALETTES[k].bottom.length],
            skin: SKIN_TONES[(i + j) % SKIN_TONES.length],
            hair: HAIR_COLORS[(i * 3 + j) % HAIR_COLORS.length],
          });
        });
        console.log(`${k}: ${mesh.geometry.getAttribute("position").count / 3} tris`);
        return mesh;
      }),
    [uniforms],
  );
  const t = q.get("t");
  useFrame((_, dt) => {
    uniforms.uTime.value = t ? Number(t) : uniforms.uTime.value + dt;
  });
  return (
    <>
      <Frame w={7} h={2.4} cx={0} />
      {meshes.map((m) => (
        <primitive key={m.name} object={m} />
      ))}
    </>
  );
}

function Scene() {
  useEffect(() => setHeroNight(night ? 1 : 0), []);
  return (
    <>
      <color attach="background" args={[night ? "#0b1020" : "#cfd8e0"]} />
      <hemisphereLight args={[night ? "#334" : "#eef4ff", night ? "#111" : "#8a8270", night ? 0.25 : 1.1]} />
      <directionalLight
        position={[40, 80, 50]}
        intensity={night ? 0.15 : 2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-120}
        shadow-camera-right={120}
        shadow-camera-top={120}
        shadow-camera-bottom={-120}
      />
      <mesh rotation-x={-Math.PI / 2} receiveShadow position={[0, -0.01, 0]}>
        <planeGeometry args={[2000, 2000]} />
        <meshStandardMaterial color={night ? "#1a1d24" : "#9a978f"} />
      </mesh>
      {set === "people" && !single ? <People /> : <Models />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <Canvas shadows camera={{ fov: 35, near: 0.1, far: 3000 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
    <Scene />
  </Canvas>,
);
