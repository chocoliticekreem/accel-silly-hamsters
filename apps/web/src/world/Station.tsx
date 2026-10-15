// Shoreditch High Street station: an elevated London Overground station on its viaduct. Street level: brick piers
// and a glazed ticket hall in the middle; up top: two side platforms either side of the tracks under a long flat
// roof on columns, open-sided so you can see the trains (world/modules/Overground) pull in. Overground roundels at
// the entrance. Drawn by the Buildings module for the map's `kind: "station"` building; local +x = long axis.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { MeshStandardMaterial } from "three";
import type { Building, CityMap, Street } from "../api/contract";
import { toScene } from "../sim/geometry";
import { DECK_Y, overgroundRoute, routeAt, TRACK_OFFSET } from "../sim/overground";
import { nightLevel } from "../sim/sky";
import { hourOf } from "../sim/time";
import { useSim } from "../state/store";

export const PLATFORM_TOP = DECK_Y + 1.05;
/** Platform edge and back, measured from the track centreline. */
export const PLATFORM_IN = TRACK_OFFSET + 1.6;
export const PLATFORM_OUT = TRACK_OFFSET + 5.4;
const BRICK = "#7a4a3a";
const OVERGROUND_ORANGE = "#ee7c0e";

export function Roundel({ y = 0, scale = 1, ring = OVERGROUND_ORANGE }: { y?: number; scale?: number; ring?: string }) {
  return (
    <group position-y={y} scale={scale}>
      <mesh>
        <torusGeometry args={[2.2, 0.55, 10, 28]} />
        <meshStandardMaterial color={ring} emissive={ring} emissiveIntensity={0.4} />
      </mesh>
      <mesh rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[1.7, 1.7, 0.2, 24]} />
        <meshStandardMaterial color="#f4f4f4" emissive="#ffffff" emissiveIntensity={0.15} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} position-z={0}>
        <boxGeometry args={[6, 0.42, 1.1]} />
        <meshStandardMaterial color="#0019a8" emissive="#3048ff" emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

/** Stretches of the station's long axis (local s, metres from its centre) where a street passes underneath. */
export function streetGaps(b: Building, streets: readonly Street[]): [number, number][] {
  const alongX = b.w >= b.d;
  const L = alongX ? b.w : b.d;
  const out: [number, number][] = [];
  for (const st of streets)
    for (let i = 0; i < st.points.length - 1; i++) {
      const [ax, az] = st.points[i];
      const [bx, bz] = st.points[i + 1];
      // where the segment crosses the station's centreline
      const [pa, pb, qa, qb, c] = alongX ? [az, bz, ax, bx, b.z] : [ax, bx, az, bz, b.x];
      if ((pa - c) * (pb - c) > 0 || pa === pb) continue;
      const k = (c - pa) / (pb - pa);
      const q = qa + (qb - qa) * k - (alongX ? b.x : b.z);
      if (Math.abs(q) > L / 2 + st.width) continue;
      // a street crossing at an angle needs a wider opening
      const slant = Math.abs(pb - pa) / (Math.hypot(pb - pa, qb - qa) || 1);
      const half = st.width / 2 / Math.max(0.35, slant) + 1.5;
      out.push([q - half, q + half]);
    }
  return out;
}

export function Station({ b, map }: { b: Building; map: CityMap }) {
  const streets = map.streets;
  const alongX = b.w >= b.d;
  // centre the platforms on the tracks, not on the OSM box (the line runs a metre or two off its middle)
  const [x, z] = useMemo(() => {
    const route = overgroundRoute(map);
    if (!route || route.station.id !== b.id) return toScene(b.x, b.z);
    const p = routeAt(route, route.stationS);
    return toScene(alongX ? b.x : p.x, alongX ? p.z : b.z);
  }, [map, b, alongX]);
  const L = alongX ? b.w : b.d;
  const W = Math.max(alongX ? b.d : b.w, PLATFORM_OUT * 2 + 0.6);
  const roofY = Math.max(b.h, DECK_Y + 6.2);
  const hall = useRef<MeshStandardMaterial>(null);
  const lights = useRef<MeshStandardMaterial>(null);

  // streets pass under the station: no piers or hall on them; the hall takes the free stretch nearest the middle
  const { piers, hallAt, hallLen } = useMemo(() => {
    const gaps = streetGaps(b, streets);
    const free = (a: number, c: number) => gaps.every(([g0, g1]) => c <= g0 || a >= g1);
    let best: [number, number] | null = null;
    const want = Math.min(L * 0.34, 40);
    for (let c = 0; c <= L / 2; c += 2)
      for (const sgn of [1, -1]) {
        const m = c * sgn;
        let len = want;
        while (len >= 10 && !free(m - len / 2, m + len / 2)) len -= 2;
        if (len >= 10 && Math.abs(m) + len / 2 <= L / 2 && (!best || len > best[1] + 6)) best = [m, len];
      }
    const [hallAt, hallLen] = best ?? [0, 0];
    const out: number[] = [];
    for (let s = -L / 2 + 2; s <= L / 2 - 2; s += 12) if ((hallLen === 0 || Math.abs(s - hallAt) > hallLen / 2 + 1) && free(s - 1, s + 1)) out.push(s);
    return { piers: out, hallAt, hallLen };
  }, [b, streets, L]);
  const columns = useMemo(() => {
    const out: number[] = [];
    for (let s = -L / 2 + 3; s <= L / 2 - 3; s += 14) out.push(s);
    return out;
  }, [L]);

  useFrame(() => {
    const n = nightLevel(hourOf(useSim.getState().t));
    if (hall.current) hall.current.emissiveIntensity = 0.25 + 1.3 * n;
    if (lights.current) lights.current.emissiveIntensity = 0.2 + 2 * n;
  });

  return (
    <group name="station" position={[x, 0, z]} rotation-y={alongX ? 0 : Math.PI / 2}>
      {/* street level: brick piers carrying the deck, and the glazed ticket hall in the middle */}
      {piers.map((s) => (
        <mesh key={s} position={[s, (DECK_Y - 1) / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.8, DECK_Y - 1, W - 0.4]} />
          <meshStandardMaterial color={BRICK} roughness={0.95} />
        </mesh>
      ))}
      {hallLen > 0 && (
      <mesh position={[hallAt, (DECK_Y - 1) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[hallLen, DECK_Y - 1, W - 1]} />
        <meshStandardMaterial ref={hall} color="#5d7890" emissive="#ffe2b0" emissiveIntensity={0.3} roughness={0.25} metalness={0.3} />
      </mesh>
      )}
      {/* entrance canopies, both sides of the hall */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[hallAt, DECK_Y - 2.2, side * (W / 2 + 1.2)]} visible={hallLen > 0}>
          <boxGeometry args={[Math.max(1, hallLen * 0.9), 0.35, 2.6]} />
          <meshStandardMaterial color="#2b2f36" roughness={0.6} />
        </mesh>
      ))}
      {/* concourse slab the platforms stand on (just below the track bed so they never share a plane) */}
      <mesh position={[0, DECK_Y - 0.65, 0]} receiveShadow castShadow>
        <boxGeometry args={[L, 1, W]} />
        <meshStandardMaterial color="#8f8a84" roughness={0.9} />
      </mesh>
      {/* side platforms with a yellow edge line */}
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[0, (DECK_Y - 0.15 + PLATFORM_TOP) / 2, side * ((PLATFORM_IN + PLATFORM_OUT) / 2)]} receiveShadow>
            <boxGeometry args={[L - 1, PLATFORM_TOP - DECK_Y + 0.15, PLATFORM_OUT - PLATFORM_IN]} />
            <meshStandardMaterial color="#b9b5ae" roughness={0.85} />
          </mesh>
          <mesh position={[0, PLATFORM_TOP + 0.01, side * (PLATFORM_IN + 0.3)]}>
            <boxGeometry args={[L - 1, 0.02, 0.35]} />
            <meshStandardMaterial color="#f2c230" roughness={0.6} />
          </mesh>
          {/* back wall: waist-high parapet with a glazed screen above it */}
          <mesh position={[0, PLATFORM_TOP + 0.6, side * (PLATFORM_OUT + 0.15)]} castShadow>
            <boxGeometry args={[L, 1.2, 0.3]} />
            <meshStandardMaterial color="#6d6a66" roughness={0.9} />
          </mesh>
          {/* roof columns */}
          {columns.map((s) => (
            <mesh key={s} position={[s, (PLATFORM_TOP + roofY) / 2, side * (PLATFORM_OUT - 0.4)]} castShadow>
              <boxGeometry args={[0.35, roofY - PLATFORM_TOP, 0.35]} />
              <meshStandardMaterial color="#3a3f47" roughness={0.6} />
            </mesh>
          ))}
          {/* station name boards along the platform */}
          {columns.slice(0, -1).map((s, i) =>
            i % 2 ? null : (
              <mesh key={`n${s}`} position={[s + 7, PLATFORM_TOP + 2.6, side * (PLATFORM_OUT - 0.45)]}>
                <boxGeometry args={[3, 0.5, 0.08]} />
                <meshStandardMaterial color="#0019a8" emissive="#3048ff" emissiveIntensity={0.3} />
              </mesh>
            ),
          )}
        </group>
      ))}
      {/* the long flat roof, with a strip of lights under it */}
      <mesh position={[0, roofY + 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[L + 2, 0.6, W + 1.4]} />
        <meshStandardMaterial color="#c9ced6" roughness={0.7} />
      </mesh>
      <mesh position={[0, roofY - 0.05, 0]}>
        <boxGeometry args={[L - 2, 0.1, 1.2]} />
        <meshStandardMaterial ref={lights} color="#fff4dc" emissive="#fff1d0" emissiveIntensity={0.3} toneMapped={false} />
      </mesh>
      {/* Overground roundels on posts at both hall entrances */}
      {[-1, 1].map((side) => (
        <group key={side} position={[hallAt + hallLen / 2 - 2, 0, side * (W / 2 + 3)]} rotation-y={side > 0 ? 0 : Math.PI}>
          <mesh position-y={2.8}>
            <cylinderGeometry args={[0.18, 0.18, 5.6, 8]} />
            <meshStandardMaterial color="#4a5260" />
          </mesh>
          <Roundel y={6.4} scale={0.62} />
        </group>
      ))}
    </group>
  );
}
