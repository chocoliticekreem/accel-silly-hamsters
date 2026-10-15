// Module: Interiors. "Look inside" a building (store card button, or click a club or landmark): the shell is hidden
// and a cutaway interior is drawn in its place, low walls and all, while the camera dives in.
// Clubs: a dancefloor whose tiles pulse with the bass, a DJ booth with lasers on open nights, a bar with staff, a
// cloakroom by the door, and dancers moving in time. Cafés, restaurants and bars: tables with seated customers.
// Shops and takeaways: a counter with people at it. The number of people inside = live.occupancy for that store,
// i.e. the sim agents whose visit is in progress (they're hidden on the street meanwhile), so the inside matches
// the data. A venue incident (docs/INCIDENTS.md) starts here: the two involved square up on the dancefloor, a ring
// opens around them, door staff move in and walk them out; police then attend outside (Incidents/Police modules).
// Non-graphic: no contact is shown.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { AdditiveBlending, Color, MeshBasicMaterial, MeshStandardMaterial, Vector3, type Group, type Object3D } from "three";
import type { Store } from "../../api/contract";
import { useIncidents, type Incident } from "../../api/incidents";
import { frontage } from "../../sim/geometry";
import { fightPhase } from "../../sim/incidents";
import { useSafety } from "../../state/safety";
import { useSim } from "../../state/store";
import { beat, LANDMARK_NAMES, localFrame, toWorld, venueNight, type LocalFrame } from "../clubs";
import { useWorld } from "../context";
import { fightRing, lerp2, planFor, type InteriorPlan, type Slot } from "../interiors/layout";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { STORE_COLORS } from "../palette";

const SCALE = 2;
const CAP = 220;
const WALL_H = 3;
const BLACK = new Color("#15161a");
const NEUTRAL = new Color("#8b919c");
const STAFF = new Color("#20242c");
const SHIRTS = ["#a463ff", "#ff4fd8", "#4fd8ff", "#ffe14f", "#ff6b6b", "#f2f2f2", "#2fae6a", "#3d7fe0", "#f08a2c"].map((c) => new Color(c));
const TILE_COLORS = ["#ff4fd8", "#4fd8ff", "#a463ff", "#ffe14f"].map((c) => new Color(c));

/** Notable = clubs and named landmarks: clicking one opens the interior straight away. */
const notable = (s: Store) => s.type === "club" || LANDMARK_NAMES.test(s.name);

function useAutoOpen() {
  const { map, interactive } = useWorld();
  const selected = useSim((s) => s.selectedStoreId);
  useEffect(() => {
    if (!interactive) return;
    const s = map.stores.find((x) => x.id === selected);
    const safety = useSafety.getState();
    if (s && notable(s)) safety.setInside(s.id);
    else if (!selected || (safety.insideId && safety.insideId !== selected)) safety.setInside(null);
  }, [selected, map, interactive]);
}

/** Hides the store's shell (the clickable box) while its interior is open. */
function useHideShell(storeId: string) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const g = scene.getObjectByName(`store-${storeId}`);
    const shell = g?.children[0] as Object3D | undefined;
    const hidden: Object3D[] = [];
    if (shell?.visible) {
      shell.visible = false;
      hidden.push(shell);
    }
    return () => hidden.forEach((o) => (o.visible = true));
  }, [scene, storeId]);
}

/** Eases the camera in close once the selection fly-to has settled. */
function useDiveIn(f: LocalFrame) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3; update: () => void } | null;
  const fly = useRef<{ k: number; wait: number; target: Vector3; pos: Vector3 } | null>(null);
  useEffect(() => {
    const target = new Vector3(f.x, 0, f.z);
    fly.current = { k: 0, wait: 0.75, target, pos: new Vector3() };
  }, [f]);
  useFrame((_, dt) => {
    const fl = fly.current;
    if (!fl || !controls) return;
    if (fl.wait > 0) {
      fl.wait -= dt;
      if (fl.wait <= 0) {
        // keep the compass direction, come in to ~60 m at a steep angle so the cutaway reads
        const off = camera.position.clone().sub(controls.target);
        const az = Math.atan2(off.x, off.z);
        const polar = 0.72;
        fl.pos.set(fl.target.x + Math.sin(polar) * Math.sin(az) * 62, Math.cos(polar) * 62, fl.target.z + Math.sin(polar) * Math.cos(az) * 62);
      }
      return;
    }
    fl.k = Math.min(1, fl.k + dt * 1.4);
    controls.target.lerp(fl.target, 0.12);
    camera.position.lerp(fl.pos, 0.12);
    controls.update();
    if (fl.k >= 1) fly.current = null;
  });
}

function Walls({ f, plan, color }: { f: LocalFrame; plan: InteriorPlan; color: string }) {
  const { w, d } = plan;
  const t = 0.4;
  const doorGap = 3.4;
  const side = (w - doorGap) / 2;
  return (
    <>
      <mesh position={[0, 0.1, 0]} receiveShadow>
        <boxGeometry args={[f.width, 0.2, f.depth]} />
        <meshStandardMaterial color="#2b2730" roughness={0.9} />
      </mesh>
      <mesh position={[0, WALL_H / 2, -d / 2 - t / 2]}>
        <boxGeometry args={[w + t * 2, WALL_H, t]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (w / 2 + t / 2), WALL_H / 2, 0]}>
          <boxGeometry args={[t, WALL_H, d]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      ))}
      {/* front wall cut low, with the door gap */}
      {[-1, 1].map((s) => (
        <mesh key={`f${s}`} position={[s * (doorGap / 2 + side / 2), 0.6, d / 2 + t / 2]}>
          <boxGeometry args={[side, 1.2, t]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      ))}
    </>
  );
}

function ClubFit({ plan, open }: { plan: InteriorPlan; open: RefObject<boolean> }) {
  const fl = plan.floor!;
  const cols = Math.max(2, Math.round(fl.w / 1.8));
  const rows = Math.max(2, Math.round(fl.d / 1.8));
  const tiles = useMemo(
    () => Array.from({ length: cols * rows }, () => new MeshStandardMaterial({ color: "#14121a", emissive: "#000000", emissiveIntensity: 1, roughness: 0.3, toneMapped: false })),
    [cols, rows],
  );
  const lasers = useRef<Group>(null);
  const laserMat = useMemo(() => new MeshBasicMaterial({ color: "#5dff7a", transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  useEffect(() => () => tiles.forEach((m) => m.dispose()), [tiles]);
  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    const kick = beat(time);
    const on = open.current;
    const bar = Math.floor((time * 124) / 60 / 4);
    tiles.forEach((m, k) => {
      const c = TILE_COLORS[(k + bar + Math.floor(k / cols)) % TILE_COLORS.length];
      m.emissive.copy(c).multiplyScalar(on ? 0.35 + kick * 1.6 * (((k + bar) % 3) === 0 ? 1 : 0.4) : 0.04);
    });
    if (lasers.current) {
      lasers.current.visible = on;
      lasers.current.rotation.y = Math.sin(time * 0.7) * 0.6;
      laserMat.opacity = 0.25 + kick * 0.55;
      laserMat.color.setHSL((time * 0.05) % 1, 1, 0.6);
    }
  });
  const b = plan.booth!;
  const bar = plan.bar!;
  const ck = plan.cloak!;
  return (
    <>
      {Array.from({ length: cols * rows }, (_, k) => {
        const i = k % cols;
        const j = Math.floor(k / cols);
        return (
          <mesh key={k} position={[fl.x - fl.w / 2 + (i + 0.5) * (fl.w / cols), 0.22, fl.z - fl.d / 2 + (j + 0.5) * (fl.d / rows)]} material={tiles[k]}>
            <boxGeometry args={[fl.w / cols - 0.08, 0.06, fl.d / rows - 0.08]} />
          </mesh>
        );
      })}
      {/* DJ booth with decks */}
      <mesh position={[b.x, 0.6, b.z]}>
        <boxGeometry args={[3.4, 1.2, 1.2]} />
        <meshStandardMaterial color="#1c1a22" roughness={0.5} />
      </mesh>
      {[-0.7, 0.7].map((x) => (
        <mesh key={x} position={[b.x + x, 1.25, b.z]}>
          <cylinderGeometry args={[0.35, 0.35, 0.08, 20]} />
          <meshStandardMaterial color="#0d0d10" emissive="#4fd8ff" emissiveIntensity={0.4} toneMapped={false} />
        </mesh>
      ))}
      {/* lasers fanning out from the booth */}
      <group ref={lasers} position={[b.x, 2.6, b.z]}>
        {[-0.9, -0.45, 0, 0.45, 0.9].map((a) => (
          <mesh key={a} rotation-y={a} position={[Math.sin(a) * 6, 0, Math.cos(a) * 6]} material={laserMat}>
            <boxGeometry args={[0.05, 0.05, 12]} />
          </mesh>
        ))}
      </group>
      {/* bar */}
      <mesh position={[bar.x + 0.4, 0.6, bar.z]}>
        <boxGeometry args={[0.8, 1.2, bar.len]} />
        <meshStandardMaterial color="#3b2a22" roughness={0.6} />
      </mesh>
      <mesh position={[bar.x - 0.9, 1.6, bar.z]}>
        <boxGeometry args={[0.3, 1.6, bar.len * 0.9]} />
        <meshStandardMaterial color="#26222d" emissive="#ffc857" emissiveIntensity={0.35} />
      </mesh>
      {/* cloakroom counter */}
      <mesh position={[ck.x, 0.55, ck.z]}>
        <boxGeometry args={[0.8, 1.1, 2.6]} />
        <meshStandardMaterial color="#4a3b52" roughness={0.6} />
      </mesh>
    </>
  );
}

function SeatedFit({ plan }: { plan: InteriorPlan }) {
  return (
    <>
      {plan.tables!.map((t, k) => (
        <group key={k} position={[t.x, 0, t.z]}>
          <mesh position-y={0.75}>
            <cylinderGeometry args={[0.55, 0.55, 0.06, 16]} />
            <meshStandardMaterial color="#c9a87a" roughness={0.6} />
          </mesh>
          <mesh position-y={0.38}>
            <cylinderGeometry args={[0.06, 0.06, 0.75, 6]} />
            <meshStandardMaterial color="#3a3a3a" />
          </mesh>
        </group>
      ))}
      <CounterFit plan={plan} />
    </>
  );
}

function CounterFit({ plan }: { plan: InteriorPlan }) {
  const bar = plan.bar!;
  return (
    <>
      <mesh position={[bar.x, 0.55, bar.z]}>
        <boxGeometry args={[bar.len, 1.1, 0.8]} />
        <meshStandardMaterial color="#6b4f3a" roughness={0.6} />
      </mesh>
      <mesh position={[bar.x, 1.5, -plan.d / 2 + 0.25]}>
        <boxGeometry args={[bar.len, 1.8, 0.3]} />
        <meshStandardMaterial color="#4b4f5a" emissive="#ffc857" emissiveIntensity={0.15} />
      </mesh>
    </>
  );
}

/** The venue incident playing out inside at t, if any (the first one in its inside/door phase). */
function insideIncident(incidents: Incident[], storeId: string, t: number): { i: Incident; phase: "inside" | "door"; k: number } | null {
  for (const i of incidents) {
    if (i.nearStoreId !== storeId || !i.insideMin) continue;
    const p = fightPhase(i, t);
    if (p === "inside" || p === "door") return { i, phase: p, k: (t - (i.t - i.insideMin)) / i.insideMin };
  }
  return null;
}

function Interior({ store }: { store: Store }) {
  const { map, stores, live, run } = useWorld();
  const incidents = useIncidents(run).data ?? [];
  const b = map.buildings.find((x) => x.id === store.buildingId)!;
  const f = useMemo(() => {
    const fr = frontage(b, map.streets);
    return localFrame(b, fr.nx, fr.nz);
  }, [b, map]);
  const plan = useMemo(() => planFor(store.type, f.width, f.depth), [store.type, f]);
  useHideShell(store.id);
  useDiveIn(f);
  const people = useMemo(() => createPeople(CAP, { emissive: 0.16 }), []);
  useEffect(() => () => people.dispose(), [people]);
  const open = useRef(false);
  const club = plan.kind === "club";
  const venue = useMemo(() => ({ key: store.id, storeId: store.id, name: store.name, b, nx: 0, nz: 0, club }), [store, b, club]);

  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const time = clock.elapsedTime;
    const night = venueNight(venue, stores?.[store.id], t);
    open.current = night.open;
    let inside = live.occupancy.get(store.id) ?? 0;
    // a serious incident clears the club: the floor empties over ten minutes
    const serious = incidents.find((i) => i.nearStoreId === store.id && i.severity >= 3 && t >= i.t && t < i.t + 600);
    if (serious) inside = Math.round(inside * Math.max(0, 1 - (t - serious.t) / 10));
    let n = 0;
    const put = (s: Slot, k: number, shirt: Color, legs: Color, dance: boolean, y = 0) => {
      if (n >= CAP) return;
      const [x, z] = toWorld(f, s.x, s.z);
      const kick = beat(time + (k % 5) * 0.03);
      const phase = dance ? time * 8.27 + k : 0;
      people.set(n++, x, y + (dance ? kick * 0.25 : 0), z, f.rot + s.face + (dance ? Math.sin(time * 2 + k) * 0.3 : 0), phase, dance, SCALE, shirt, legs, SKIN_TONES[(k * 5) % SKIN_TONES.length]);
    };
    // staff: DJ, bar, cloakroom (clubs only while open; shops' counter staff whenever open)
    if (night.open || !club) plan.staff.forEach((s, k) => put(s, 500 + k, k === 0 && club ? BLACK : STAFF, BLACK, false));
    let slots = plan.slots.slice(0, Math.min(inside, plan.slots.length));
    const fight = club ? insideIncident(incidents, store.id, t) : null;
    if (fight && slots.length >= 2) {
      const centre = { x: plan.floor!.x, z: plan.floor!.z };
      slots = fightRing(slots, centre);
      if (fight.phase === "door") {
        // door staff walk the two out
        const dk = Math.max(0, Math.min(1, (t - (fight.i.t - Math.min(2, fight.i.insideMin! / 2))) / Math.min(2, fight.i.insideMin! / 2)));
        slots = slots.map((s, k) => (k < 2 ? { ...lerp2(s, plan.door, dk), face: 0 } : s));
      }
    }
    slots.forEach((s, k) => {
      const involved = !!fight && k < 2;
      const watching = !!fight && !involved && Math.hypot(s.x - plan.floor!.x, s.z - plan.floor!.z) < 6;
      const dance = club && night.open && !involved && !watching;
      const y = plan.kind === "seated" ? -0.45 : 0;
      put(s, k, involved ? NEUTRAL : SHIRTS[k % SHIRTS.length], TROUSERS[k % TROUSERS.length], dance, y);
    });
    // door staff move in from the door to the pair, then walk out with them
    if (fight) {
      const pair = slots.length >= 2 ? slots[0] : { x: 0, z: 0 };
      const k = fight.phase === "inside" ? Math.min(1, fight.k / 0.5) : 1;
      [-1, 1].forEach((sgn, j) => {
        const to = { x: pair.x + sgn * 1.2 + 0.7, z: pair.z + 1.1 };
        const p = lerp2(plan.door, to, k);
        put({ ...p, face: Math.PI }, 600 + j, BLACK, BLACK, false);
      });
    }
    people.commit(n);
  });

  const accent = STORE_COLORS[store.type].body;
  return (
    <group name={`interior-${store.id}`}>
      <group position={[f.x, 0, f.z]} rotation-y={f.rot}>
        <Walls f={f} plan={plan} color={club ? "#3a3150" : accent} />
        {club ? <ClubFit plan={plan} open={open} /> : plan.kind === "seated" ? <SeatedFit plan={plan} /> : <CounterFit plan={plan} />}
        <pointLight position={[0, WALL_H + 1.5, 0]} intensity={club ? 30 : 18} distance={Math.max(f.width, f.depth) * 1.4} color={club ? "#c78bff" : "#ffe2b0"} />
      </group>
      <primitive object={people.group} />
    </group>
  );
}

export default function Interiors() {
  const { map } = useWorld();
  useAutoOpen();
  const id = useSafety((s) => s.insideId);
  const store = map.stores.find((s) => s.id === id && map.buildings.some((b) => b.id === s.buildingId));
  return store ? <Interior key={store.id} store={store} /> : null;
}
