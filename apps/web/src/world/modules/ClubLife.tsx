// Module: ClubLife. The nightlife around every club and landmark (world/clubs.ts): a lit name sign and neon trim that
// pulse with the bass on open nights, a glowing entrance, a roped queue that builds from 21:15 and peaks around
// midnight (longest Thu–Sat), two door staff, and the spill-out at close (the crowd heading for takeaways and the
// Night Tube). A club shut by a licence review gets a roller shutter and a "Closed by licensing" notice.
// XOYO is drawn in the surroundings (dark brick warehouse on Cowper St, sawtooth roof, lit XOYO sign) when the map
// doesn't carry it; it is decoration only there (no sim data).
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Gavel } from "lucide-react";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { AdditiveBlending, Color, type Group, type MeshBasicMaterial, type MeshStandardMaterial } from "three";
import { useIncidents, type Incident } from "../../api/incidents";
import { licenceClosure } from "../../sim/incidents";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { beat, isClubNight, localFrame, nightOf, queueLength, toWorld, venueNight, venues, type Venue } from "../clubs";
import { useWorld } from "../context";
import { textTexture } from "../incidents/vehicles";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { glowTexture } from "../textures";
import "../../ui/safety.css";

const SCALE = 2;
const CAP = 600;
const BLACK = new Color("#15161a");
const CLUB_SHIRTS = ["#a463ff", "#ff4fd8", "#4fd8ff", "#ffe14f", "#ff6b6b", "#f2f2f2", "#2fae6a"].map((c) => new Color(c));
const NEON = ["#e04fd0", "#4fd8ff", "#a463ff", "#ffb84f"];

const frame = (v: Venue) => localFrame(v.b, v.nx, v.nz);

/** XOYO's exterior: a dark brick warehouse with a sawtooth roof (only when the map doesn't carry XOYO). */
function XoyoBuilding({ v }: { v: Venue }) {
  const f = frame(v);
  const teeth = 4;
  return (
    <group position={[f.x, 0, f.z]} rotation-y={f.rot} name="xoyo-building">
      <mesh position-y={v.b.h / 2} castShadow receiveShadow>
        <boxGeometry args={[f.width, v.b.h, f.depth]} />
        <meshStandardMaterial color="#4b2d25" roughness={0.92} />
      </mesh>
      {/* sawtooth roof */}
      {Array.from({ length: teeth }, (_, k) => (
        <mesh key={k} position={[-f.width / 2 + (f.width / teeth) * (k + 0.5), v.b.h + 1.2, 0]} rotation-z={0.42} castShadow>
          <boxGeometry args={[f.width / teeth + 0.6, 0.35, f.depth]} />
          <meshStandardMaterial color="#3a2420" roughness={0.9} />
        </mesh>
      ))}
      {/* blocked-up brick arches on the front */}
      {[-0.32, -0.11, 0.11, 0.32].map((k) => (
        <mesh key={k} position={[k * f.width, 3.2, f.depth / 2 + 0.05]}>
          <boxGeometry args={[f.width * 0.13, 4.2, 0.1]} />
          <meshStandardMaterial color="#2a1a17" roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

function VenueDressing({ v, signMat, neonMats, doorMat, poolMat, shutter, notice }: {
  v: Venue;
  signMat: RefObject<MeshStandardMaterial | null>;
  neonMats: RefObject<(MeshStandardMaterial | null)[]>;
  doorMat: RefObject<MeshStandardMaterial | null>;
  poolMat: RefObject<MeshBasicMaterial | null>;
  shutter: RefObject<Group | null>;
  notice: boolean;
}) {
  const f = frame(v);
  const xoyo = v.key === "xoyo";
  const sign = useMemo(() => textTexture(v.name.toUpperCase(), { fg: "#ffffff", bg: xoyo ? "#0b0b0d" : undefined, w: 512, h: 96 }), [v.name, xoyo]);
  const signW = Math.min(f.width * 0.7, xoyo ? 14 : 4 + v.name.length * 0.9);
  const h = v.b.h;
  const doorW = 3.2;
  const neon = (i: number) => (m: MeshStandardMaterial | null) => {
    neonMats.current[i] = m;
  };
  return (
    <group position={[f.x, 0, f.z]} rotation-y={f.rot}>
      {/* name sign above the door */}
      <mesh position={[0, Math.min(h - 1.6, 6.2), f.depth / 2 + 0.25]}>
        <planeGeometry args={[signW, signW * (96 / 512) * 1.4]} />
        <meshStandardMaterial ref={signMat} map={sign} emissiveMap={sign} emissive="#ffffff" emissiveIntensity={0.2} transparent={!xoyo} toneMapped={false} />
      </mesh>
      {/* neon trim: two uprights and a roofline tube */}
      <mesh position={[-f.width / 2 + 0.3, h / 2, f.depth / 2 + 0.2]}>
        <boxGeometry args={[0.18, h * 0.92, 0.18]} />
        <meshStandardMaterial ref={neon(0)} color={NEON[0]} emissive={NEON[0]} emissiveIntensity={0.1} toneMapped={false} />
      </mesh>
      <mesh position={[f.width / 2 - 0.3, h / 2, f.depth / 2 + 0.2]}>
        <boxGeometry args={[0.18, h * 0.92, 0.18]} />
        <meshStandardMaterial ref={neon(1)} color={NEON[1]} emissive={NEON[1]} emissiveIntensity={0.1} toneMapped={false} />
      </mesh>
      <mesh position={[0, h + 0.65, f.depth / 2 + 0.3]}>
        <boxGeometry args={[f.width * 0.98, 0.18, 0.18]} />
        <meshStandardMaterial ref={neon(2)} color={NEON[2]} emissive={NEON[2]} emissiveIntensity={0.1} toneMapped={false} />
      </mesh>
      {/* entrance: lit doorway */}
      <mesh position={[0, 1.6, f.depth / 2 + 0.12]}>
        <boxGeometry args={[doorW, 3.2, 0.1]} />
        <meshStandardMaterial ref={doorMat} color="#1a1420" emissive="#ff9d5c" emissiveIntensity={0} toneMapped={false} />
      </mesh>
      {/* glow on the pavement */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.17, f.depth / 2 + 4]} renderOrder={2}>
        <planeGeometry args={[14, 9]} />
        <meshBasicMaterial ref={poolMat} map={glowTexture()} color="#d36bff" transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* queue rope: posts and a red rope along the facade */}
      {[2.4, 6, 9.6, 13.2].filter((x) => x < f.width / 2 + 6).map((x) => (
        <mesh key={x} position={[x, 0.5, f.depth / 2 + 3.4]}>
          <cylinderGeometry args={[0.06, 0.1, 1, 8]} />
          <meshStandardMaterial color="#c9a54a" metalness={0.6} roughness={0.3} />
        </mesh>
      ))}
      <mesh position={[Math.min(13.2, f.width / 2 + 6) / 2 + 1.2, 0.85, f.depth / 2 + 3.4]}>
        <boxGeometry args={[Math.min(13.2, f.width / 2 + 6) - 2.4, 0.06, 0.06]} />
        <meshStandardMaterial color="#9e1b32" roughness={0.5} />
      </mesh>
      {/* closed by licensing: roller shutter over the doors */}
      <group ref={shutter} visible={false} position={[0, 1.7, f.depth / 2 + 0.22]}>
        <mesh>
          <boxGeometry args={[doorW + 1.2, 3.5, 0.08]} />
          <meshStandardMaterial color="#8a919c" roughness={0.6} metalness={0.4} />
        </mesh>
        <mesh position={[0, 0.2, 0.06]}>
          <planeGeometry args={[1.4, 1]} />
          <meshStandardMaterial color="#f4f1ea" />
        </mesh>
      </group>
      {notice && (
        <Html position={[0, h + 5, f.depth / 2]} center distanceFactor={260} zIndexRange={[9, 0]} style={{ pointerEvents: "none" }}>
          <div className="map-label map-label-licence">
            <Gavel size={14} />
            Closed by licensing · licence review
          </div>
        </Html>
      )}
    </group>
  );
}

function useVenueFx(v: Venue, closedBy: (t: number) => Incident | null) {
  const signMat = useRef<MeshStandardMaterial>(null);
  const neonMats = useRef<(MeshStandardMaterial | null)[]>([]);
  const doorMat = useRef<MeshStandardMaterial>(null);
  const poolMat = useRef<MeshBasicMaterial>(null);
  const shutter = useRef<Group>(null);
  const { stores } = useWorld();
  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const n = venueNight(v, v.storeId ? stores?.[v.storeId] : undefined, t);
    const night = nightLevel(hourOf(t));
    const kick = beat(clock.elapsedTime);
    const live = n.open && v.club;
    if (signMat.current) signMat.current.emissiveIntensity = n.open || night > 0.3 ? (live ? 1.6 + kick * 0.8 : 1.1) * (0.4 + night) : 0.15;
    neonMats.current.forEach((m, i) => {
      if (!m) return;
      // bass pulse: uprights kick on the beat, the roofline breathes
      m.emissiveIntensity = live ? (i < 2 ? 0.6 + kick * 5 : 1.4 + Math.sin(clock.elapsedTime * 1.3) * 0.6) * (0.5 + night) : 0.08;
    });
    if (doorMat.current) doorMat.current.emissiveIntensity = n.open ? 1.4 + kick * 0.6 : 0;
    if (poolMat.current) poolMat.current.opacity = n.open ? (0.35 + kick * 0.25) * night : 0;
    if (shutter.current) shutter.current.visible = !!closedBy(t);
  });
  return { signMat, neonMats, doorMat, poolMat, shutter };
}

function VenueView({ v, incidents }: { v: Venue; incidents: Incident[] }) {
  const closedBy = useMemo(() => (t: number) => (v.storeId ? licenceClosure(incidents, v.storeId, nightOf(t)) : null), [incidents, v.storeId]);
  const fx = useVenueFx(v, closedBy);
  // the notice is an Html overlay: mount it only while a closure is in force (boolean selector)
  const notice = useSim((s) => !!closedBy(s.t));
  return (
    <>
      {v.key === "xoyo" && <XoyoBuilding v={v} />}
      <VenueDressing v={v} {...fx} notice={notice} />
    </>
  );
}

/** Queues, door staff and spill-out for every venue, in one set of instanced people. */
function useCrowds(list: Venue[], incidents: Incident[]) {
  const { stores } = useWorld();
  const people = useMemo(() => createPeople(CAP, { emissive: 0.14 }), []);
  useEffect(() => () => people.dispose(), [people]);
  const frames = useMemo(() => list.map(frame), [list]);
  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const time = clock.elapsedTime;
    let n = 0;
    const put = (f: ReturnType<typeof frame>, lx: number, lz: number, face: number, moving: boolean, k: number, shirt: Color, legs: Color) => {
      if (n >= CAP) return;
      const [x, z] = toWorld(f, lx, lz);
      const phase = time * 7 + k;
      people.set(n++, x, moving ? Math.abs(Math.sin(phase)) * 0.06 : 0, z, f.rot + face, phase, moving, SCALE, shirt, legs, SKIN_TONES[(k * 7) % SKIN_TONES.length]);
    };
    list.forEach((v, vi) => {
      const f = frames[vi];
      const night = venueNight(v, v.storeId ? stores?.[v.storeId] : undefined, t);
      if (!v.club || night.openT == null || night.closeT == null) return;
      const front = f.depth / 2;
      // door staff: from 45 min before opening until 20 min after close
      if (t >= night.openT - 45 && t < night.closeT + 20) {
        put(f, -2.3, front + 1.4, 0, false, 1, BLACK, BLACK);
        put(f, 2.3, front + 1.4, 0, false, 2, BLACK, BLACK);
      }
      // the queue, behind the rope, facing the door
      const q = queueLength(night, t, isClubNight(nightOf(t)) ? 16 : 5);
      for (let k = 0; k < q; k++) {
        const shuffle = Math.sin(time * 0.6 + k * 1.7) * 0.15;
        put(f, 3.2 + k * 1.5 + shuffle, front + 2.5 + (k % 2) * 0.5, -Math.PI / 2, false, 100 + k, CLUB_SHIRTS[k % CLUB_SHIRTS.length], TROUSERS[k % TROUSERS.length]);
      }
      // spill-out: at close, or when a serious incident empties the club early
      const early = v.storeId ? incidents.find((i) => i.nearStoreId === v.storeId && i.severity >= 3 && t >= i.t && t < i.t + 30) : undefined;
      const start = early ? early.t : night.closeT;
      const k = (t - start) / 30;
      if (k >= 0 && k < 1) {
        const crowd = early ? 26 : isClubNight(nightOf(t)) ? 30 : 12;
        for (let p = 0; p < crowd; p++) {
          const dir = p % 2 ? 1 : -1;
          const dist = k * (14 + (p % 7) * 6) + (p % 3);
          const lane = front + 3 + (p % 5) * 1.1;
          put(f, dir * (1 + dist), lane, (dir * Math.PI) / 2, true, 300 + p, CLUB_SHIRTS[(p + 3) % CLUB_SHIRTS.length], TROUSERS[p % TROUSERS.length]);
        }
      }
    });
    people.commit(n);
  });
  return people;
}

export default function ClubLife() {
  const { map, run } = useWorld();
  const incidents = useIncidents(run).data ?? [];
  const list = useMemo(() => venues(map), [map]);
  const people = useCrowds(list, incidents);
  return (
    <group name="club-life">
      {list.map((v) => (
        <VenueView key={v.key} v={v} incidents={incidents} />
      ))}
      <primitive object={people.group} />
    </group>
  );
}
