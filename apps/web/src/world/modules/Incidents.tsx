// Module: Incidents. The scene of each public-safety incident while the response is on it (docs/INCIDENTS.md):
// blue-and-white police tape around serious ones, officers in hi-vis (people.ts figures) once the car arrives,
// paramedics by the ambulance, collisions (two stopped cars with hazards, a little steam, traffic queued behind),
// and a small calm label ("Police called · fight outside XOYO"). Non-graphic by design: no injuries, no violence,
// no blame; the people involved are neutral, anonymous figures standing apart.
// Also the Safety layer (toggle in the toolbar): incident density so far this run, as a soft heat on the ground.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CarFront, ShieldAlert, Siren } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, Color, SRGBColorSpace, type MeshBasicMaterial } from "three";
import type { CityMap } from "../../api/contract";
import { useIncidents, type Incident } from "../../api/incidents";
import { callLabel, densityGrid, fightPhase } from "../../sim/incidents";
import { useEconomy } from "../../state/economy";
import { useSafety } from "../../state/safety";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { useResponses, streetHeading, type Response } from "../incidents/routes";
import { PlainCar, Placed, Smoke, tapeTexture } from "../incidents/vehicles";
import { createPeople, SKIN_TONES } from "../people";
import "../../ui/safety.css";

const HI_VIS = new Color("#d6f23a");
const UNIFORM = new Color("#1b2233");
const PARAMEDIC = new Color("#2f8a52");
const NEUTRAL = new Color("#8b919c");
const NEUTRAL_LEGS = new Color("#3a3f4b");
const SCALE = 2;
const CAP = 160;

/** On-scene geometry for one incident: centre, street direction (unit along a, across n) in contract coords. */
interface Scene {
  r: Response;
  h: number;
  ax: number;
  az: number;
  nx: number;
  nz: number;
}

function sceneOf(map: CityMap, r: Response): Scene {
  const i = r.incident;
  const h = streetHeading(map.streets.find((s) => s.id === i.streetId), i.x, i.z);
  return { r, h, ax: Math.sin(h), az: Math.cos(h), nx: Math.cos(h), nz: -Math.sin(h) };
}

/** Cordon size (along × across the street, m), or null when the scene isn't taped off. */
function cordon(i: Incident): [number, number] | null {
  if (i.kind === "collision") return [20, 12];
  if (i.severity >= 3) return [24, 14];
  if (i.severity >= 2 || i.effects.streetClosedMin) return [14, 10];
  return null;
}

function Tape({ len, x, z, rot }: { len: number; x: number; z: number; rot: number }) {
  const tex = useMemo(() => {
    const t = tapeTexture().clone();
    t.repeat.set(Math.max(1, Math.round(len / 3)), 1);
    t.needsUpdate = true;
    return t;
  }, [len]);
  return (
    <mesh position={[x, 0.95, z]} rotation-y={rot}>
      <boxGeometry args={[len, 0.14, 0.02]} />
      <meshStandardMaterial map={tex} roughness={0.6} emissive="#ffffff" emissiveMap={tex} emissiveIntensity={0.25} />
    </mesh>
  );
}

function Cordon({ s }: { s: Scene }) {
  const i = s.r.incident;
  const size = cordon(i)!;
  const [L, W] = size;
  // local frame: rotate so local x = across, local z = along the street
  const corners: [number, number][] = [
    [-W / 2, -L / 2],
    [W / 2, -L / 2],
    [W / 2, L / 2],
    [-W / 2, L / 2],
  ];
  return (
    <group position={[i.x, 0, -i.z]} rotation-y={Math.PI - s.h}>
      {corners.map(([x, z], k) => (
        <mesh key={k} position={[x, 0.5, z]}>
          <cylinderGeometry args={[0.07, 0.09, 1, 6]} />
          <meshStandardMaterial color="#d9dde5" />
        </mesh>
      ))}
      <Tape len={W} x={0} z={-L / 2} rot={0} />
      <Tape len={W} x={0} z={L / 2} rot={0} />
      <Tape len={L} x={-W / 2} z={0} rot={Math.PI / 2} />
      <Tape len={L} x={W / 2} z={0} rot={Math.PI / 2} />
    </group>
  );
}

function Collision({ s }: { s: Scene }) {
  const i = s.r.incident;
  const h = s.h;
  const crossH = h + Math.PI / 2 + 0.35;
  const colors = useMemo(() => {
    const pool = ["#c8ced6", "#7a3e3e", "#2f4a6b", "#5a6b5c", "#e6e2d8"];
    const k = i.id.length + Math.round(i.t);
    return [pool[k % pool.length], pool[(k + 2) % pool.length]];
  }, [i]);
  // queued traffic behind it, both directions on the main street
  const queue = [-1, 1].flatMap((dir) => [0, 1, 2].map((q) => ({ dir, q })));
  return (
    <group name={`collision-${i.id}`}>
      <Placed x={i.x} z={i.z} heading={h + 0.2}>
        <PlainCar color={colors[0]} crumple={1} hazards />
      </Placed>
      <Placed x={i.x + s.ax * 3.6 + s.nx * 1.4} z={i.z + s.az * 3.6 + s.nz * 1.4} heading={crossH}>
        <PlainCar color={colors[1]} crumple={0.8} hazards />
      </Placed>
      {i.severity >= 2 && (
        <group position={[i.x + s.ax * 2, 0, -(i.z + s.az * 2)]}>
          <Smoke />
        </group>
      )}
      {queue.map(({ dir, q }) => {
        const back = 16 + q * 7;
        const lane = 2.2 * dir;
        return (
          <Placed key={`${dir}${q}`} x={i.x - s.ax * back * dir - s.nx * lane} z={i.z - s.az * back * dir - s.nz * lane} heading={dir > 0 ? h : h + Math.PI}>
            <PlainCar color={["#3b4252", "#8a96a8", "#1d1f24"][q]} />
          </Placed>
        );
      })}
    </group>
  );
}

function Label({ i }: { i: Incident }) {
  const Icon = i.kind === "collision" ? CarFront : i.response.police ? Siren : ShieldAlert;
  return (
    <Html position={[i.x, 9, -i.z]} center distanceFactor={260} zIndexRange={[9, 0]} style={{ pointerEvents: "none" }}>
      <div className="map-label map-label-incident">
        <Icon size={14} />
        {callLabel(i)}
      </div>
    </Html>
  );
}

function OnScene({ s }: { s: Scene }) {
  const i = s.r.incident;
  const taped = !!cordon(i);
  const tapeUp = useSim((st) => st.t >= i.t + s.r.policeArrive && st.t < i.t + Math.max(i.effects.streetClosedMin ?? 0, i.response.durationMin * 0.85));
  return (
    <group name={`incident-${i.id}`}>
      {taped && tapeUp && <Cordon s={s} />}
      {i.kind === "collision" && <Collision s={s} />}
      <Label i={i} />
    </group>
  );
}

function Window({ s }: { s: Scene }) {
  const i = s.r.incident;
  const on = useSim((st) => st.t >= i.t && st.t < i.t + i.response.durationMin);
  return on ? <OnScene s={s} /> : null;
}

/** Figures at every active scene: officers once a car is there, paramedics by the ambulance, people involved apart. */
function useFigures(scenes: Scene[]) {
  const people = useMemo(() => createPeople(CAP, { emissive: 0.12 }), []);
  useEffect(() => () => people.dispose(), [people]);
  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    let n = 0;
    const put = (s: Scene, along: number, across: number, face: number, shirt: Color, legs: Color, k: number) => {
      if (n >= CAP) return;
      const x = s.r.incident.x + s.ax * along + s.nx * across;
      const z = s.r.incident.z + s.az * along + s.nz * across;
      // a little idle sway so the scene reads as alive
      const sway = Math.sin(clock.elapsedTime * 0.8 + k) * 0.05;
      people.set(n++, x, 0, -z, Math.PI - (s.h + face) + sway, 0, false, SCALE, shirt, legs, SKIN_TONES[k % SKIN_TONES.length]);
    };
    for (const s of scenes) {
      const i = s.r.incident;
      if (t < i.t || t >= i.t + i.response.durationMin) continue;
      const since = t - i.t;
      const police = i.response.police && since >= s.r.policeArrive;
      const cars = i.kind === "chase" ? 2 : i.severity >= 2 ? 2 : 1;
      // the people involved: two apart at a fight (officers between them), one reporting a theft or noise
      if (i.kind === "fight" && fightPhase(i, t) === "outside") {
        put(s, -3.2, 0.5, 0, NEUTRAL, NEUTRAL_LEGS, 1);
        put(s, 3.4, -0.4, Math.PI, NEUTRAL, NEUTRAL_LEGS, 2);
      }
      if ((i.kind === "theft" || i.kind === "antisocial") && police) put(s, 1.2, 2.2, -Math.PI / 2, NEUTRAL, NEUTRAL_LEGS, 3);
      if (police) {
        const spots: [number, number, number][] = [
          [-1.2, 0.6, 0],
          [1.4, -0.4, Math.PI],
          [-0.2, 2.4, -Math.PI / 2],
          [0.4, -2.6, Math.PI / 2],
        ];
        spots.slice(0, cars * 2).forEach(([a, c, f], k) => put(s, a, c, f, HI_VIS, UNIFORM, 10 + k));
      }
      if (i.response.ambulance && since >= s.r.ambulanceArrive) {
        put(s, -5, -3, Math.PI / 2, PARAMEDIC, PARAMEDIC, 20);
        put(s, -6.2, -1.8, Math.PI / 2, PARAMEDIC, PARAMEDIC, 21);
      }
    }
    people.commit(n);
  });
  return people;
}

/** The Safety layer: incident density so far this run (severity-weighted), as a soft heat over the ground. */
function SafetyHeat({ incidents, map }: { incidents: Incident[]; map: CityMap }) {
  // one ground layer at a time: another heatmap switched on hides this one
  const heat = useSafety((s) => s.heat);
  const other = useEconomy((s) => s.heatmap);
  const on = heat && !other;
  // recount once per sim hour
  const hour = useSim((s) => Math.floor(s.t / 60));
  const past = useMemo(() => incidents.filter((i) => i.t <= (hour + 1) * 60), [incidents, hour]);
  const n = 64;
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, []);
  const mat = useRef<MeshBasicMaterial>(null);
  useEffect(() => {
    const g = densityGrid(past, map.bounds, n, 34);
    const ctx = (tex.image as HTMLCanvasElement).getContext("2d")!;
    const img = ctx.createImageData(n, n);
    for (let gz = 0; gz < n; gz++)
      for (let gx = 0; gx < n; gx++) {
        const v = g[gz * n + gx];
        const p = ((n - 1 - gz) * n + gx) * 4; // canvas row 0 = north
        // calm amber → coral, never alarm red
        img.data[p] = 255;
        img.data[p + 1] = Math.round(200 - 110 * v);
        img.data[p + 2] = Math.round(90 - 40 * v);
        img.data[p + 3] = Math.round(Math.min(1, v * 1.4) * 190);
      }
    ctx.putImageData(img, 0, 0);
    tex.needsUpdate = true;
  }, [past, map, tex]);
  if (!on) return null;
  const b = map.bounds;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[(b.minX + b.maxX) / 2, 0.3, -(b.minZ + b.maxZ) / 2]} renderOrder={4}>
      <planeGeometry args={[b.maxX - b.minX, b.maxZ - b.minZ]} />
      <meshBasicMaterial ref={mat} map={tex} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

export default function Incidents() {
  const { map, run } = useWorld();
  const incidents = useIncidents(run).data;
  const responses = useResponses(map, incidents);
  const scenes = useMemo(() => responses.map((r) => sceneOf(map, r)), [responses, map]);
  const people = useFigures(scenes);
  return (
    <group name="incidents">
      {scenes.map((s) => (
        <Window key={s.r.incident.id} s={s} />
      ))}
      <primitive object={people.group} />
      {incidents && <SafetyHeat incidents={incidents} map={map} />}
    </group>
  );
}
