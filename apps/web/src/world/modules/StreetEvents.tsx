// Module: StreetEvents. What owners react to (docs/OWNER_ACTIONS.md), drawn on the street while it's happening:
// roadworks = an orange-and-white barrier pen, cones and a small digger on the affected street (outside its shops),
// heavy traffic = a faint red tint over the road. Club nights and events only show in the city feed.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Construction } from "lucide-react";
import { useMemo, useRef } from "react";
import { CanvasTexture, MeshBasicMaterial, RepeatWrapping, SRGBColorSpace, type Group, type Texture } from "three";
import type { CityMap, Street, StreetEvent } from "../../api/contract";
import { frontage, toScene } from "../../sim/geometry";
import { useStreetEvents } from "../../state/data";
import { useSim } from "../../state/store";
import { useWorld } from "../context";

const ORANGE = "#f07f1e";
const DIGGER = "#f2b630";

let stripes: Texture | null = null;
/** Orange and white diagonal stripes for barrier boards. */
function stripeTexture(): Texture {
  if (stripes) return stripes;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f1ea";
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = ORANGE;
  for (let x = -16; x < 64; x += 16) {
    g.beginPath();
    g.moveTo(x, 16);
    g.lineTo(x + 8, 0);
    g.lineTo(x + 16, 0);
    g.lineTo(x + 8, 16);
    g.fill();
  }
  stripes = new CanvasTexture(c);
  stripes.wrapS = stripes.wrapT = RepeatWrapping;
  stripes.colorSpace = SRGBColorSpace;
  return stripes;
}

interface Site {
  /** Scene position of the pit centre and the street direction (rotation about y, local z = along the street). */
  x: number;
  z: number;
  angle: number;
  /** Pit size: along the street, across the street. */
  len: number;
  wide: number;
  main: boolean;
}

/** Closest point on a polyline (contract coords) with the direction of its segment. */
function onStreet(street: Street, x: number, z: number): { x: number; z: number; ax: number; az: number; bx: number; bz: number } {
  let best = { d: Infinity, x, z, ax: 0, az: 0, bx: 1, bz: 0 };
  for (let i = 0; i < street.points.length - 1; i++) {
    const [ax, az] = street.points[i];
    const [bx, bz] = street.points[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const cx = ax + dx * k;
    const cz = az + dz * k;
    const d = Math.hypot(x - cx, z - cz);
    if (d < best.d) best = { d, x: cx, z: cz, ax, az, bx, bz };
  }
  return best;
}

/** The polyline's halfway point (contract coords). */
function midpoint(street: Street): [number, number] {
  const p = street.points;
  let total = 0;
  for (let i = 0; i < p.length - 1; i++) total += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  let left = total / 2;
  for (let i = 0; i < p.length - 1; i++) {
    const l = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    if (left <= l) {
      const k = l ? left / l : 0;
      return [p[i][0] + (p[i + 1][0] - p[i][0]) * k, p[i][1] + (p[i + 1][1] - p[i][1]) * k];
    }
    left -= l;
  }
  return p[0];
}

/** Works pits: one outside each shop on the street (the "roadworks outside" the owners talk about), else mid-street. */
function sites(map: CityMap, street: Street): Site[] {
  const doors = map.stores.flatMap((s) => {
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (!b || s.type === "club") return [];
    const f = frontage(b, map.streets);
    return f.street.id === street.id ? [[f.doorX, f.doorZ] as [number, number]] : [];
  });
  const points = doors.length ? doors : [midpoint(street)];
  const picked: [number, number][] = [];
  for (const p of points) if (picked.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 30) && picked.length < 5) picked.push(p);
  return picked.map(([px, pz], i) => {
    const c = onStreet(street, px, pz);
    const [sx, sz] = toScene(c.x, c.z);
    const [ax, az] = toScene(c.ax, c.az);
    const [bx, bz] = toScene(c.bx, c.bz);
    const angle = Math.atan2(bx - ax, bz - az);
    // put the pit on the shop's side of the road
    const [dx, dz] = toScene(px, pz);
    const side = Math.sign((dx - sx) * Math.cos(angle) - (dz - sz) * Math.sin(angle)) || 1;
    const wide = Math.max(3, street.width / 2 - 0.6);
    const off = side * (street.width / 4);
    return { x: sx + Math.cos(angle) * off, z: sz - Math.sin(angle) * off, angle, len: 12, wide, main: i === 0 };
  });
}

function Barrier({ len, x = 0, z = 0, rot = 0 }: { len: number; x?: number; z?: number; rot?: number }) {
  const tex = useMemo(() => {
    const t = stripeTexture().clone();
    t.repeat.set(Math.max(1, Math.round(len / 1.6)), 1);
    t.needsUpdate = true;
    return t;
  }, [len]);
  return (
    <group position={[x, 0, z]} rotation-y={rot}>
      <mesh position-y={0.85} castShadow>
        <boxGeometry args={[len, 0.42, 0.08]} />
        <meshStandardMaterial map={tex} roughness={0.7} />
      </mesh>
      {[-len / 2 + 0.2, len / 2 - 0.2].map((lx) => (
        <mesh key={lx} position={[lx, 0.4, 0]}>
          <boxGeometry args={[0.1, 0.8, 0.5]} />
          <meshStandardMaterial color="#e9e6df" roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

function Cone({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position-y={0.42} castShadow>
        <coneGeometry args={[0.28, 0.8, 12]} />
        <meshStandardMaterial color={ORANGE} roughness={0.6} />
      </mesh>
      <mesh position-y={0.5}>
        <cylinderGeometry args={[0.17, 0.2, 0.14, 12]} />
        <meshStandardMaterial color="#f4f1ea" roughness={0.6} />
      </mesh>
      <mesh position-y={0.03}>
        <boxGeometry args={[0.7, 0.06, 0.7]} />
        <meshStandardMaterial color="#2a2f38" roughness={0.9} />
      </mesh>
    </group>
  );
}

function Digger() {
  const arm = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (arm.current) arm.current.rotation.x = -0.5 + Math.sin(clock.elapsedTime * 0.8) * 0.25;
  });
  return (
    <group position={[0, 0, -1.5]} rotation-y={0.5}>
      {/* tracks */}
      {[-0.9, 0.9].map((x) => (
        <mesh key={x} position={[x, 0.35, 0]} castShadow>
          <boxGeometry args={[0.55, 0.7, 3]} />
          <meshStandardMaterial color="#2b2e33" roughness={0.9} />
        </mesh>
      ))}
      {/* body + cab */}
      <mesh position={[0, 1.15, 0.2]} castShadow>
        <boxGeometry args={[2, 0.9, 2.2]} />
        <meshStandardMaterial color={DIGGER} roughness={0.55} />
      </mesh>
      <mesh position={[-0.35, 2.05, -0.2]} castShadow>
        <boxGeometry args={[1.1, 1, 1.1]} />
        <meshStandardMaterial color="#3b4656" roughness={0.3} metalness={0.2} />
      </mesh>
      {/* boom, stick and bucket */}
      <group ref={arm} position={[0.45, 1.5, 1.1]}>
        <mesh position={[0, 0, 1.2]} castShadow>
          <boxGeometry args={[0.3, 0.3, 2.6]} />
          <meshStandardMaterial color={DIGGER} roughness={0.55} />
        </mesh>
        <mesh position={[0, -0.8, 2.4]} rotation-x={0.6}>
          <boxGeometry args={[0.25, 1.8, 0.25]} />
          <meshStandardMaterial color={DIGGER} roughness={0.55} />
        </mesh>
        <mesh position={[0, -1.6, 2.9]}>
          <boxGeometry args={[0.7, 0.5, 0.5]} />
          <meshStandardMaterial color="#3a3d42" roughness={0.8} />
        </mesh>
      </group>
    </group>
  );
}

function Works({ site, label }: { site: Site; label: string }) {
  const { len, wide } = site;
  return (
    <group position={[site.x, 0, site.z]} rotation-y={site.angle}>
      {/* dug-up road */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.14} receiveShadow>
        <planeGeometry args={[wide - 0.6, len - 0.8]} />
        <meshStandardMaterial color="#6e5a46" roughness={1} />
      </mesh>
      <mesh position={[0.4, 0.2, len / 4]} scale={[1.4, 0.55, 1.1]} castShadow>
        <sphereGeometry args={[1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#7a6148" roughness={1} />
      </mesh>
      <Barrier len={len} x={-wide / 2} rot={Math.PI / 2} />
      <Barrier len={len} x={wide / 2} rot={Math.PI / 2} />
      <Barrier len={wide} z={-len / 2} />
      <Barrier len={wide} z={len / 2} />
      {[-1, 1].flatMap((sz) => [-wide / 2, 0, wide / 2].map((cx) => <Cone key={`${sz}:${cx}`} x={cx} z={sz * (len / 2 + 1.6)} />))}
      {site.main && <Digger />}
      {site.main && (
        <Html position={[0, 6, 0]} center distanceFactor={260} zIndexRange={[9, 0]} style={{ pointerEvents: "none" }}>
          <div className="map-label map-label-works">
            <Construction size={14} />
            {label}
          </div>
        </Html>
      )}
    </group>
  );
}

function Roadworks({ event, street }: { event: StreetEvent; street: Street }) {
  const { map } = useWorld();
  const list = useMemo(() => sites(map, street), [map, street]);
  // a boolean selector: re-renders only when the works start or end
  const active = useSim((s) => s.t >= event.fromT && s.t < event.toT);
  if (!active) return null;
  return (
    <group name={`roadworks-${street.id}`}>
      {list.map((s, i) => (
        <Works key={i} site={s} label={event.label} />
      ))}
    </group>
  );
}

/** Red tint over a street during its heavy-traffic windows; all segments share one material and fade together. */
function Traffic({ street, windows }: { street: Street; windows: [number, number][] }) {
  const mat = useMemo(() => new MeshBasicMaterial({ color: "#ff3b3b", transparent: true, opacity: 0, depthWrite: false, toneMapped: false }), []);
  const segs = useMemo(
    () =>
      street.points.slice(0, -1).map((p, i) => {
        const [ax, az] = toScene(...p);
        const [bx, bz] = toScene(...street.points[i + 1]);
        return { x: (ax + bx) / 2, z: (az + bz) / 2, len: Math.hypot(bx - ax, bz - az), angle: Math.atan2(bx - ax, bz - az) };
      }),
    [street],
  );
  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const on = windows.some(([a, b]) => t >= a && t < b);
    const target = on ? 0.2 + Math.sin(clock.elapsedTime * 2) * 0.04 : 0;
    mat.opacity += (target - mat.opacity) * 0.1;
    mat.visible = mat.opacity > 0.005;
  });
  return (
    <group name={`traffic-${street.id}`}>
      {segs.map((s, i) => (
        <mesh key={i} position={[s.x, 0.16, s.z]} rotation-y={s.angle} renderOrder={1} material={mat}>
          <boxGeometry args={[street.width * 0.92, 0.02, s.len]} />
        </mesh>
      ))}
    </group>
  );
}

const SHOW_TRAFFIC_TINT = false;

export default function StreetEvents() {
  const { map, run } = useWorld();
  const events = useStreetEvents(run).data;
  const streets = useMemo(() => new Map(map.streets.map((s) => [s.id, s])), [map]);
  const works = (events ?? []).filter((e) => e.kind === "roadworks" && e.streetId && streets.has(e.streetId));
  const traffic = useMemo(() => {
    const by = new Map<string, [number, number][]>();
    for (const e of events ?? []) if (e.kind === "heavy_traffic" && e.streetId && streets.has(e.streetId)) by.set(e.streetId, [...(by.get(e.streetId) ?? []), [e.fromT, e.toT]]);
    return [...by.entries()];
  }, [events, streets]);
  return (
    <group name="street-events">
      {works.map((e, i) => (
        <Roadworks key={`${e.streetId}:${e.fromT}:${i}`} event={e} street={streets.get(e.streetId!)!} />
      ))}
      {/* heavy traffic is shown by the traffic itself and the city feed; the red road slab read as a glitch */}
      {SHOW_TRAFFIC_TINT &&
        traffic.map(([id, windows]) => <Traffic key={id} street={streets.get(id)!} windows={windows} />)}
    </group>
  );
}
