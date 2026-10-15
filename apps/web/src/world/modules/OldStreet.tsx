// Module: OldStreet (decorative). Old Street station on the Northern line, under Silicon Roundabout: the roundabout's
// ring road and paved island, and the street-level entrances (OSM subway_entrance positions, sim/london.ts), each a
// stairwell going down behind railings with a red-ringed Underground roundel totem. People walk up to the stairs
// and go down, and others come up and walk off into the city. A floating label names the station so it can be found.
// Uses the map's own "Old Street" station entry point when the backend's map includes it (resolveLandmarks).
// Pedestrian motion runs in real seconds, busier in the rush hours (sim clock).
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color } from "three";
import { rng } from "../../mock/rng";
import { toScene } from "../../sim/geometry";
import { ARTERIALS, OLD_STREET, OLD_STREET_ENTRANCES, resolveLandmarks, ROUNDABOUT } from "../../sim/london";
import { polyDist } from "../../sim/surroundings";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { GROUND } from "../palette";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { Roundel } from "../Station";

const STAIR_W = 3;
const STAIR_L = 7;
const PER_ENTRANCE = 9;
const PERIOD = 16; // s: one person's walk + stairs cycle

/** Push a point off any carriageway (arterials and the ring) onto the pavement. */
function onPavement(x: number, z: number): [number, number] {
  let px = x;
  let pz = z;
  for (let pass = 0; pass < 4; pass++) {
    const dr = Math.hypot(px - ROUNDABOUT.x, pz - ROUNDABOUT.z);
    const ring = Math.abs(dr - ROUNDABOUT.r);
    if (ring < ROUNDABOUT.width / 2 + 3) {
      const k = (dr > ROUNDABOUT.r ? ROUNDABOUT.r + ROUNDABOUT.width / 2 + 3.5 : ROUNDABOUT.r - ROUNDABOUT.width / 2 - 3.5) / (dr || 1);
      px = ROUNDABOUT.x + (px - ROUNDABOUT.x) * k;
      pz = ROUNDABOUT.z + (pz - ROUNDABOUT.z) * k;
    }
    for (const ar of ARTERIALS) {
      const d = polyDist(px, pz, ar.points);
      if (d >= ar.width / 2 + 3) continue;
      // step away from the nearest point of the road
      let best = { x: px, z: pz, d: Infinity };
      for (let i = 0; i < ar.points.length - 1; i++) {
        const [ax, az] = ar.points[i];
        const [bx, bz] = ar.points[i + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
        const cx = ax + dx * t;
        const cz = az + dz * t;
        const dd = Math.hypot(px - cx, pz - cz);
        if (dd < best.d) best = { x: cx, z: cz, d: dd };
      }
      const nx = (px - best.x) / (best.d || 1);
      const nz = (pz - best.z) / (best.d || 1);
      px = best.x + nx * (ar.width / 2 + 3.5);
      pz = best.z + nz * (ar.width / 2 + 3.5);
    }
  }
  return [px, pz];
}

export default function OldStreet() {
  const { map } = useWorld();
  const site = useMemo(() => {
    const lm = resolveLandmarks(map).find((l) => l.key === "oldstreet");
    // if the backend's map moves the station, move everything with it
    const dx = (lm?.x ?? OLD_STREET.x) - OLD_STREET.x;
    const dz = (lm?.z ?? OLD_STREET.z) - OLD_STREET.z;
    const ring = { ...ROUNDABOUT, x: ROUNDABOUT.x + dx, z: ROUNDABOUT.z + dz };
    const r = rng(1890);
    const entrances = OLD_STREET_ENTRANCES.map((e) => {
      const [x, z] = onPavement(e.x + dx, e.z + dz);
      // stairs run away from the roundabout centre (down toward the ticket hall under it): heading in contract coords
      const ax = x - ring.x;
      const az = z - ring.z;
      const len = Math.hypot(ax, az) || 1;
      return { name: e.name, x, z, ux: ax / len, uz: az / len };
    });
    const walkers = entrances.flatMap((e, ei) =>
      Array.from({ length: PER_ENTRANCE }, (_, k) => {
        const a = r() * Math.PI * 2;
        const far = 18 + r() * 26;
        const [fx, fz] = onPavement(e.x + e.ux * 6 + Math.cos(a) * far, e.z + e.uz * 6 + Math.sin(a) * far);
        return { ei, down: k % 2 === 0, phase: r() * PERIOD, fx, fz, speed: 1.2 + r() * 0.5, shirt: new Color().setHSL(r(), 0.55, 0.5), trousers: TROUSERS[Math.floor(r() * TROUSERS.length)], skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)] };
      }),
    );
    return { ring, entrances, walkers, inMap: lm ? map.bounds.minX <= lm.x && lm.x <= map.bounds.maxX && map.bounds.minZ <= lm.z && lm.z <= map.bounds.maxZ : false };
  }, [map]);

  const people = useMemo(() => createPeople(site.walkers.length, { emissive: 0.08 }), [site]);
  useEffect(() => () => people.dispose(), [people]);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    const h = hourOf(useSim.getState().t);
    // the Northern line shuts ~00:30–05:30 (except the Night Tube, Fri/Sat); quiet late, busy in the rush hours
    const share = h < 0.5 || h >= 5.5 ? (h >= 7 && h < 10) || (h >= 16.5 && h < 19.5) ? 1 : h >= 22 || h < 0.5 ? 0.35 : 0.65 : 0.12;
    let n = 0;
    site.walkers.forEach((w, i) => {
      if (i % PER_ENTRANCE >= Math.ceil(PER_ENTRANCE * share)) return;
      const e = site.entrances[w.ei];
      const cyc = ((time * w.speed * 0.7 + w.phase) % PERIOD) / PERIOD; // 0..1
      // walk phase (0..0.7) on the pavement between the far point and the stair head; stairs (0.7..1)
      const top: [number, number] = [e.x - e.ux * (STAIR_L / 2), e.z - e.uz * (STAIR_L / 2)];
      let x: number;
      let z: number;
      let y = 0;
      let hx: number;
      let hz: number;
      let moving = true;
      const k = w.down ? cyc : 1 - cyc; // going down: street → stairs; coming up: stairs → street
      if (k < 0.7) {
        const t = k / 0.7;
        x = w.fx + (top[0] - w.fx) * t;
        z = w.fz + (top[1] - w.fz) * t;
        hx = top[0] - w.fx;
        hz = top[1] - w.fz;
      } else {
        const t = (k - 0.7) / 0.3;
        x = top[0] + e.ux * STAIR_L * t;
        z = top[1] + e.uz * STAIR_L * t;
        y = -t * 4.2;
        hx = e.ux;
        hz = e.uz;
      }
      if (!w.down) {
        hx = -hx;
        hz = -hz;
      }
      if (y < -3.6) moving = false;
      if (y < -3.6) return;
      const [sx, sz] = toScene(x, z);
      people.set(n++, sx, y, sz, Math.atan2(hx, -hz), time * 7 + i, moving, 1.8, w.shirt, w.trousers, w.skin);
    });
    people.commit(n);
  });

  const [cx, cz] = toScene(site.ring.x, site.ring.z);
  return (
    <group name="old-street">
      {/* the roundabout: ring road round a paved island (when the map doesn't already have it) */}
      {!site.inMap && (
        <group position={[cx, 0, cz]}>
          <mesh rotation-x={-Math.PI / 2} position-y={0.05}>
            <ringGeometry args={[site.ring.r - site.ring.width / 2, site.ring.r + site.ring.width / 2, 48]} />
            <meshStandardMaterial color={GROUND.asphalt} roughness={0.9} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position-y={0.08}>
            <circleGeometry args={[site.ring.r - site.ring.width / 2, 40]} />
            <meshStandardMaterial color="#c9c3b6" roughness={0.95} />
          </mesh>
        </group>
      )}
      {site.entrances.map((e) => {
        const [x, z] = toScene(e.x, e.z);
        const rot = Math.atan2(e.ux, -e.uz); // local +z down the stairs
        return (
          <group key={e.name} position={[x, 0, z]} rotation-y={rot}>
            {/* the stairwell: a dark opening with steps glimpsed inside */}
            <mesh position-y={0.11}>
              <boxGeometry args={[STAIR_W, 0.02, STAIR_L]} />
              <meshStandardMaterial color="#141519" roughness={1} />
            </mesh>
            {Array.from({ length: 6 }, (_, k) => (
              <mesh key={k} position={[0, 0.125, -STAIR_L / 2 + 0.6 + k * 0.9]}>
                <boxGeometry args={[STAIR_W - 0.3, 0.01, 0.12]} />
                <meshStandardMaterial color="#4a4d55" />
              </mesh>
            ))}
            {/* railings on three sides */}
            {[-1, 1].map((side) => (
              <mesh key={side} position={[side * (STAIR_W / 2 + 0.1), 0.55, 0]}>
                <boxGeometry args={[0.08, 1.1, STAIR_L]} />
                <meshStandardMaterial color="#202226" roughness={0.5} metalness={0.4} />
              </mesh>
            ))}
            <mesh position={[0, 0.55, STAIR_L / 2 + 0.1]}>
              <boxGeometry args={[STAIR_W + 0.3, 1.1, 0.08]} />
              <meshStandardMaterial color="#202226" roughness={0.5} metalness={0.4} />
            </mesh>
            {/* Underground roundel totem at the head of the stairs */}
            <group position={[STAIR_W / 2 + 0.9, 0, -STAIR_L / 2]} rotation-y={Math.PI / 2}>
              <mesh position-y={1.6}>
                <boxGeometry args={[0.3, 3.2, 0.3]} />
                <meshStandardMaterial color="#2b2f36" />
              </mesh>
              <Roundel y={3.9} scale={0.42} ring="#dc241f" />
            </group>
          </group>
        );
      })}
      <primitive object={people.group} name="old-street-people" />
      <Html position={[cx, 34, cz]} center distanceFactor={160} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="map-label">Old Street · Northern line</div>
      </Html>
    </group>
  );
}
