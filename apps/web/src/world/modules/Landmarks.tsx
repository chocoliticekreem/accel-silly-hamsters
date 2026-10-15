// Module: Landmarks. Multi-floor cutaway interiors for XOYO, Encode Hub, art'otel Hoxton and Boxpark, plus a beacon
// over every place you can go inside (those four and the clubs).
// - Enter (Go-to bar, a beacon, or clicking the building): the exterior shell is hidden (a faint wireframe ghost
//   stays), the floors are drawn from world/landmarks/floors: one merged vertex-colour mesh for the furniture and one
//   for the glow per floor, people as one instanced crowd. Floors above the selected one are hidden, the selected one
//   gets a lit slab-edge outline, the ones below stay dim. XOYO's club is a real basement: a pit is cut into the
//   ground while it is the selected floor.
// - Occupancy: XOYO's club = the sim's live occupancy for the store when the run has it; otherwise each floor's
//   time-of-day curve over the sim clock (busy at night for clubs and bars, daytime for Encode).
// - Exit (Esc, the bar's Exit, "Back outside" on XOYO's store card) restores the exterior and the camera shot.
import { Html } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  Vector3,
  type Mesh,
  type Object3D,
} from "three";
import type { Building } from "../../api/contract";
import { frontage, toScene } from "../../sim/geometry";
import { weekdayIndex } from "../../sim/storeState";
import { dayOf, hourOf } from "../../sim/time";
import { useSafety } from "../../state/safety";
import { useSim } from "../../state/store";
import { useTravel } from "../../state/travel";
import { beat, localFrame, queueLength, toWorld, venueNight, type LocalFrame } from "../clubs";
import { useWorld } from "../context";
import { flyTo } from "../flyTo";
import { groundY } from "../ground";
import { enterable, enterPlace } from "../landmarks/actions";
import { buildFloors, FLOOR_H, interiorSize, PERSON_SCALE, SIT_DROP, SLAB, type FloorPlan, type Slot } from "../landmarks/floors";
import { placesFor, type Place } from "../landmarks/places";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { ClubFit } from "./Interiors";

const CAP = 700;
const LAMP = "#ffc857";
const SHIRTS = ["#a463ff", "#ff4fd8", "#4fd8ff", "#ffe14f", "#ff6b6b", "#f2f2f2", "#2fae6a", "#3d7fe0", "#f08a2c", "#57e3a4"].map((c) => new Color(c));
const STAFF = new Color("#20242c");
const BLACK = new Color("#15161a");

/** The shot before entering, to fly back to on exit (shared across remounts, e.g. switching interiors). */
let savedShot: { pos: Vector3; target: Vector3 } | null = null;

export default function Landmarks() {
  const { map, interactive } = useWorld();
  const places = useMemo(() => placesFor(map), [map]);
  const openKey = useTravel((s) => (s.interiorOpen ? s.focusPlace : null));
  useSync(places, interactive);
  const open = places.find((p) => p.key === openKey && p.interior && p.foot);
  return (
    <group name="landmarks">
      {places.filter(enterable).map((p) => (p.key === openKey ? null : <Beacon key={p.key} place={p} interactive={interactive} />))}
      {interactive && places.filter((p) => p.interior && !p.storeId && p.foot && p.key !== openKey).map((p) => <PickBox key={p.key} place={p} />)}
      {open && <Interior key={open.key} place={open} />}
    </group>
  );
}

/** Keeps the travel slice in step with the store selection and the Interiors module's "Look inside" state. */
function useSync(places: Place[], interactive: boolean) {
  const insideId = useSafety((s) => s.insideId);
  const selected = useSim((s) => s.selectedStoreId);
  useEffect(() => {
    if (!interactive) return;
    const t = useTravel.getState();
    const p = insideId ? places.find((x) => x.interior && x.storeId === insideId) : undefined;
    if (p && !(t.interiorOpen && t.focusPlace === p.key)) enterPlace(p);
    else if (!p && t.interiorOpen && t.storeId) t.exit(); // closed from the store card, or another venue opened
  }, [insideId, places, interactive]);
  useEffect(() => {
    if (!interactive || !selected) return;
    const t = useTravel.getState();
    if (t.interiorOpen && t.storeId !== selected) t.exit();
  }, [selected, interactive]);
}

// ---------------------------------------------------------------- beacons

const beamMat = () =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uColor: { value: new Color(LAMP) }, uPulse: { value: 1 } },
    vertexShader: "varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 uColor; uniform float uPulse; varying float vY; void main(){ float a = pow(clamp(1.0 - vY, 0.0, 1.0), 1.6) * 0.32 * clamp(uPulse, 0.0, 2.0); gl_FragColor = vec4(uColor * a, a); }",
  });

function Beacon({ place, interactive }: { place: Place; interactive: boolean }) {
  const [x, z] = toScene(place.x, place.z);
  const r = place.foot ? Math.max(place.foot.w, place.foot.d) / 2 + 3 : 10;
  const club = !place.interior;
  const color = club ? "#c78bff" : LAMP;
  const mats = useMemo(() => {
    const beam = beamMat();
    beam.uniforms.uColor.value.set(color);
    const ring = new MeshBasicMaterial({ color, transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide });
    return { beam, ring };
  }, [color]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  const ring = useRef<Mesh>(null);
  const seed = useMemo(() => (place.x * 13.1 + place.z * 7.7) % 6.28, [place]);
  useFrame(({ clock }) => {
    const k = (clock.elapsedTime * 0.6 + seed) % 1;
    if (ring.current) {
      ring.current.scale.setScalar(0.6 + k * 0.9);
      mats.ring.opacity = 0.7 * (1 - k);
    }
    mats.beam.uniforms.uPulse.value = 0.8 + 0.2 * Math.sin(clock.elapsedTime * 2 + seed);
  });
  const go = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    enterPlace(place);
  };
  const H = club ? 45 : 70;
  const gy = groundY(x, z);
  return (
    <group position={[x, gy, z]} name={`beacon-${place.key}`}>
      <mesh position-y={H / 2} material={mats.beam} renderOrder={5} raycast={() => null}>
        <cylinderGeometry args={[2.2, 3.2, H, 20, 1, true]} />
      </mesh>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.35} material={mats.ring} renderOrder={5} raycast={() => null}>
        <ringGeometry args={[r * 0.82, r, 48]} />
      </mesh>
      {interactive && (
        <mesh position-y={H * 0.5} onClick={go} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
          <cylinderGeometry args={[3.5, 3.5, H, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      <Html position={[0, H + 4, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: interactive ? "auto" : "none" }}>
        <button className={`beacon-label ${club ? "club" : ""}`} onClick={() => enterPlace(place)}>
          Enter {place.name}
        </button>
      </Html>
    </group>
  );
}

/** An invisible box over a landmark's host building so clicking the building goes inside. */
function PickBox({ place }: { place: Place }) {
  const f = place.foot!;
  const [x, z] = toScene(f.x, f.z);
  return (
    <mesh
      position={[x, f.h / 2, z]}
      onClick={(e) => {
        e.stopPropagation();
        enterPlace(place);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <boxGeometry args={[f.w + 1, f.h + 1, f.d + 1]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------- interior

/** Vertex-colour material whose vertex colours also glow a little (`selfLit`), so interiors read at night. */
function vcMaterial(selfLit: number, tint = "#ffffff") {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, color: tint });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor.rgb * ${selfLit.toFixed(3)};`);
  };
  m.customProgramCacheKey = () => `landmark-vc-${selfLit}`;
  return m;
}

function useHideExterior(place: Place, f: LocalFrame) {
  const scene = useThree((s) => s.scene);
  const { map } = useWorld();
  useEffect(() => {
    const hidden: Object3D[] = [];
    const hide = (o: Object3D | undefined) => {
      if (o && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    };
    if (place.storeId) hide(scene.getObjectByName(`store-${place.storeId}`));
    // the host building and any neighbour the (larger) interior overlaps
    const c = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].map(([sx, sz]) => toWorld(f, (sx * f.width) / 2, (sz * f.depth) / 2));
    const x0 = Math.min(...c.map((p) => p[0])) + 0.5;
    const x1 = Math.max(...c.map((p) => p[0])) - 0.5;
    const z0 = Math.min(...c.map((p) => p[1])) + 0.5;
    const z1 = Math.max(...c.map((p) => p[1])) - 0.5;
    const byPos = new Map<string, Building>();
    for (const b of map.buildings) {
      const [sx, sz] = toScene(b.x, b.z);
      byPos.set(`${sx.toFixed(2)},${sz.toFixed(2)}`, b);
    }
    scene.getObjectByName("buildings")?.children.forEach((o) => {
      const b = byPos.get(`${o.position.x.toFixed(2)},${o.position.z.toFixed(2)}`);
      if (!b) return;
      const [sx, sz] = toScene(b.x, b.z);
      const hit = b.id === place.host?.id || (sx + b.w / 2 > x0 && sx - b.w / 2 < x1 && sz + b.d / 2 > z0 && sz - b.d / 2 < z1);
      if (hit) hide(o);
    });
    // exterior hero models other modules may draw for this landmark
    const names = [`landmark-${place.key}`, `model-${place.key}`, `${place.key}-exterior`];
    scene.traverse((o) => {
      if (names.includes(o.name)) hidden.push(o);
    });
    hidden.forEach((o) => (o.visible = false));
    return () => hidden.forEach((o) => (o.visible = true));
  }, [scene, map, place, f]);
}

function Interior({ place }: { place: Place }) {
  const { map, stores, live } = useWorld();
  const key = place.interior!;
  const foot = place.foot!;
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3 } | null;

  const f = useMemo<LocalFrame>(() => {
    const b = { id: place.key, kind: "office", x: foot.x, z: foot.z, w: foot.w, d: foot.d, h: foot.h } as Building;
    const fr = frontage(b, map.streets);
    const lf = localFrame(b, fr.nx, fr.nz);
    const [w, d] = interiorSize(key, lf.width, lf.depth);
    return { ...lf, width: w, depth: d };
  }, [place, foot, map, key]);
  const base = useMemo(() => groundY(f.x, f.z), [f]);
  const floors = useMemo(() => buildFloors(key, f.width, f.depth), [key, f]);
  const floor = useTravel((s) => Math.min(s.floor, floors.length - 1));
  const basement = floors[0].y < 0;

  const res = useMemo(() => {
    const geos = floors.map((fl) => ({ solid: fl.solid.geometry(), glow: fl.glow.empty ? null : fl.glow.geometry() }));
    const mats = {
      lit: vcMaterial(0.22),
      dim: vcMaterial(0.03, "#5a6070"),
      glow: new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      glowDim: new MeshBasicMaterial({ vertexColors: true, color: "#3a3f4a", toneMapped: false }),
      screen: new MeshBasicMaterial({ color: "#57e3a4", toneMapped: false }),
      outline: new MeshBasicMaterial({ color: LAMP, toneMapped: false }),
      ghost: new LineBasicMaterial({ color: "#9fb6c8", transparent: true, opacity: 0.28, depthWrite: false }),
      pit: new MeshStandardMaterial({ color: "#151319", roughness: 1, side: BackSide }),
      punch: new MeshBasicMaterial({ colorWrite: false }),
    };
    const ghost = new EdgesGeometry(new BoxGeometry(foot.w, foot.h, foot.d));
    return { geos, mats, ghost };
  }, [floors, foot]);
  useEffect(
    () => () => {
      res.geos.forEach((g) => {
        g.solid.dispose();
        g.glow?.dispose();
      });
      Object.values(res.mats).forEach((m) => m.dispose());
      res.ghost.dispose();
    },
    [res],
  );

  useHideExterior(place, f);

  // remember the shot before going in; fly back to it on a real exit (not when switching interiors)
  useEffect(() => {
    if (!savedShot && controls) savedShot = { pos: camera.position.clone(), target: controls.target.clone() };
    return () => {
      if (useTravel.getState().interiorOpen || !savedShot) return;
      const s = savedShot;
      savedShot = null;
      flyTo(s.target.x, -s.target.z, 0, s.target.y, { position: [s.pos.x, s.pos.y, s.pos.z] });
    };
  }, [camera, controls]);

  // frame the selected floor: steep enough to see into the cut, close enough to see who's there
  useEffect(() => {
    const fl = floors[floor];
    const dist = Math.max(48, Math.min(95, Math.max(f.width, f.depth) * 1.55 + 14));
    // (re-run once the orbit controls exist: a deep link can open the interior before the camera rig mounts)
    if (controls) flyTo(f.x, -f.z, dist, base + fl.y + 1.2, { polar: 0.72 });
  }, [floor, floors, f, base, controls]);

  // people
  const people = useMemo(() => createPeople(CAP, { emissive: 0.18 }), []);
  useEffect(() => () => people.dispose(), [people]);
  const clubOpen = useRef(false);
  const venue = useMemo(() => ({ key: place.key, storeId: place.storeId ?? null, name: place.name, b: foot, nx: 0, nz: 0, club: true }), [place, foot]);

  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const hour = hourOf(t);
    const wd = weekdayIndex(dayOf(t));
    const time = clock.elapsedTime;
    const sel = Math.min(useTravel.getState().floor, floors.length - 1);
    const result = place.storeId ? stores?.[place.storeId] : undefined;
    const night = key === "xoyo" ? venueNight(venue, result, t) : null;
    clubOpen.current = night ? night.open || (!result && floors[0].busy(hour, wd) > 0.05) : false;
    let n = 0;
    const put = (s: Slot, k: number, y: number, shirt: Color, legs: Color) => {
      if (n >= CAP) return;
      let lx = s.x;
      let lz = s.z;
      let face = s.face;
      let py = y;
      let moving = false;
      let phase = 0;
      if (s.pose === "dance") {
        const kick = beat(time + (k % 5) * 0.03);
        py += kick * 0.25;
        face += Math.sin(time * 2 + k) * 0.35;
        moving = true;
        phase = time * 8.27 + k;
      } else if (s.pose === "walk") {
        const u = Math.sin(time * 0.35 + k * 1.7);
        lx += Math.sin(s.face) * u * 2.2;
        lz += Math.cos(s.face) * u * 2.2;
        if (Math.cos(time * 0.35 + k * 1.7) < 0) face += Math.PI;
        moving = true;
        phase = time * 6 + k;
      } else if (s.pose === "sit") py += SIT_DROP;
      const [wx, wz] = toWorld(f, lx, lz);
      people.set(n++, wx, py, wz, f.rot + face, phase, moving, PERSON_SCALE, shirt, legs, SKIN_TONES[(k * 5) % SKIN_TONES.length]);
    };
    for (let i = 0; i <= sel; i++) {
      const fl = floors[i];
      let count = Math.round(fl.slots.length * fl.busy(hour, wd));
      // XOYO's club: the sim's own count of people inside when the run has the store
      if (fl.club && result) count = Math.min(fl.slots.length, Math.round((live.occupancy.get(place.storeId!) ?? 0) * 1.0));
      const staffOn = fl.club ? clubOpen.current : fl.staffOn(hour, wd) > 0.2;
      if (staffOn) fl.staff.forEach((s, k) => put(s, 500 + k + i * 7, fl.y, k === 0 && fl.club ? BLACK : STAFF, BLACK));
      for (let k = 0; k < count; k++) put(fl.slots[k], k + i * 31, fl.y, SHIRTS[(k + i) % SHIRTS.length], TROUSERS[k % TROUSERS.length]);
    }
    // the queue outside XOYO's door, whatever floor is shown
    const q = floors.find((fl) => fl.queue)?.queue;
    if (q && night) {
      const len = result ? queueLength(night, t, q.length) : Math.round(q.length * floors[0].busy(hour, wd) * 0.8);
      for (let k = 0; k < Math.min(len, q.length); k++) put(q[k], 900 + k, 0, SHIRTS[(k * 3) % SHIRTS.length], TROUSERS[(k + 2) % TROUSERS.length]);
    }
    people.commit(n);
    // the hack hall's screen cycles through slides
    res.mats.screen.color.setHSL(0.42 + 0.12 * Math.sin(time * 0.25), 0.55, 0.42 + 0.08 * Math.sin(time * 1.7));
  });

  const sel = floors[floor];
  const W = f.width;
  const D = f.depth;
  const pitDepth = FLOOR_H + SLAB;
  const [gx, gz] = toScene(foot.x, foot.z);
  return (
    <group name={`landmark-interior-${place.key}`}>
      {/* faint ghost of the exterior shell */}
      <lineSegments geometry={res.ghost} material={res.mats.ghost} position={[gx, base + foot.h / 2, gz]} />
      <group position={[f.x, base, f.z]} rotation-y={f.rot}>
        {floors.map((fl, i) => (
          <FloorView key={i} fl={fl} i={i} sel={floor} geo={res.geos[i]} mats={res.mats} clubOpen={clubOpen} />
        ))}
        {/* slab-edge outline on the selected floor */}
        <group position-y={sel.y - SLAB}>
          {[-1, 1].map((s) => (
            <mesh key={`x${s}`} position={[0, SLAB / 2, (s * (D + 0.9)) / 2]} material={res.mats.outline}>
              <boxGeometry args={[W + 1.1, SLAB + 0.08, 0.2]} />
            </mesh>
          ))}
          {[-1, 1].map((s) => (
            <mesh key={`z${s}`} position={[(s * (W + 0.9)) / 2, SLAB / 2, 0]} material={res.mats.outline}>
              <boxGeometry args={[0.2, SLAB + 0.08, D + 1.1]} />
            </mesh>
          ))}
        </group>
        {/* basement: a pit cut into the street while the club floor is shown (drawn before the ground) */}
        {basement && (
          <>
            <group renderOrder={-3}>
              <mesh position-y={-pitDepth / 2} material={res.mats.pit}>
                <boxGeometry args={[W + 0.8, pitDepth, D + 0.8]} />
              </mesh>
            </group>
            <group renderOrder={-1} visible={floor === 0}>
              <mesh rotation-x={-Math.PI / 2} position-y={0.25} material={res.mats.punch}>
                <planeGeometry args={[W + 0.8, D + 0.8]} />
              </mesh>
            </group>
          </>
        )}
        <pointLight position={[0, sel.y + 3.6, 0]} intensity={key === "xoyo" && floor === 0 ? 40 : 55} distance={Math.max(W, D) * 1.6} color={key === "xoyo" && floor === 0 ? "#c78bff" : "#ffe2b0"} />
      </group>
      <group renderOrder={basement ? -3 : 0}>
        <primitive object={people.group} />
      </group>
    </group>
  );
}

type Mats = { lit: MeshStandardMaterial; dim: MeshStandardMaterial; glow: MeshBasicMaterial; glowDim: MeshBasicMaterial; screen: MeshBasicMaterial };

function FloorView({ fl, i, sel, geo, mats, clubOpen }: { fl: FloorPlan; i: number; sel: number; geo: { solid: ReturnType<FloorPlan["solid"]["geometry"]>; glow: ReturnType<FloorPlan["glow"]["geometry"]> | null }; mats: Mats; clubOpen: RefObject<boolean> }) {
  const lit = i === sel;
  // a basement draws before the ground so the pit shows through the cut street (Interior's punch plane)
  return (
    <group position-y={fl.y} visible={i <= sel} renderOrder={fl.y < 0 ? -3 : 0}>
      <mesh geometry={geo.solid} material={lit ? mats.lit : mats.dim} castShadow={lit} receiveShadow />
      {geo.glow && <mesh geometry={geo.glow} material={lit ? mats.glow : mats.glowDim} />}
      {fl.club && <ClubFit plan={fl.club} open={clubOpen} />}
      {fl.screens?.map((s, k) => (
        <mesh key={k} position={[s.x, s.y + s.h / 2, s.z]} rotation-y={s.yaw} material={lit ? mats.screen : mats.glowDim}>
          <planeGeometry args={[s.w, s.h]} />
        </mesh>
      ))}
    </group>
  );
}
