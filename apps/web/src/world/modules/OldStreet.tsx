// Module: OldStreet (decorative). Old Street station and Silicon Roundabout as they are today: the gyratory is
// gone, its north-west arm is a public space (the "peninsula" + the Promenade of Light) with the new station
// entrance pavilion (glazed hall, big timber-soffit canopy, roof garden, escalators down to the ticket hall),
// the sunken St Agnes Well walk with shop units and the tunnel into the concourse, Exit 4's stair and the
// Exit 2 stair house, two-way traffic through two signalled junctions (buses, cabs, cars; red lights,
// queues, bus stop dwell, pedestrian phase), the big digital screens, the White Collar Factory with its
// rooftop running track, and people flowing in and out of every entrance on the sim clock (rush hours
// busy, night quiet). Geometry from OpenStreetMap: public/areas/oldstreet.json (scripts/fetch-oldstreet.py).
//
// Holes in the ground: the sunken walk, the escalator well and the Exit 2 stair are drawn first (renderOrder -2,
// like everything in this module), then a depth-only "cap" over each opening (renderOrder -1) so the city's
// ground plane, drawn after, can't paint over them. Draw calls: ~6 kit slots + signs + screens + glass + cap +
// light pools + signal lamps + people (3) + traffic (≈5).
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rng } from "../../mock/rng";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { heroMaterials, setHeroNight } from "../models/materials";
import type { Slot } from "../models/kit";
import { screenQuad, Screens } from "../oldstreet/atlas";
import { buildOldStreet, type Built, type Route, type V3 } from "../oldstreet/build";
import { loadOldStreet, type OldStreetData } from "../oldstreet/data";
import { CYCLE_LEN, JunctionTraffic, pedPhase, signalState } from "../oldstreet/traffic";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";

const noRaycast = () => null;

/** Share of the station crowd out at hour h (0..1): rush hours full, night a trickle. */
function crowdShare(h: number) {
  if (h < 0.5) return 0.18;
  if (h < 5.5) return 0.03;
  if (h < 7) return 0.15 + ((h - 5.5) / 1.5) * 0.6;
  if (h < 9.5) return 1;
  if (h < 10.5) return 1 - (h - 9.5) * 0.45;
  if (h < 16.5) return 0.5;
  if (h < 19) return 1;
  if (h < 23) return 0.55 - ((h - 19) / 4) * 0.3;
  return 0.22;
}
const trafficShare = (h: number) => (h < 5.5 ? 0.25 : h < 7 ? 0.6 : h < 20 ? 1 : h < 23.5 ? 0.7 : 0.4);

function poolTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.45, "rgba(255,255,255,0.45)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Position at distance d along a route (scene-local), with direction. */
function along(pts: V3[], d: number, out: { x: number; y: number; z: number; dx: number; dz: number }) {
  let rem = d;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (rem <= l || i === pts.length - 1) {
      const t = l ? Math.min(1, rem / l) : 0;
      out.x = a[0] + (b[0] - a[0]) * t;
      out.y = a[1] + (b[1] - a[1]) * t;
      out.z = a[2] + (b[2] - a[2]) * t;
      out.dx = b[0] - a[0];
      out.dz = b[2] - a[2];
      return out;
    }
    rem -= l;
  }
  return out;
}

interface Walker {
  entry: number; // -1 = stroller
  route: number;
  inbound: boolean;
  period: number;
  phase: number;
  speed: number;
  gate: number; // active if gate < share
  shirt: Color;
  trousers: Color;
  skin: Color;
  scale: number;
}

function Scene({ data }: { data: OldStreetData }) {
  const [cx, cz] = data.centre;
  const origin: [number, number, number] = [cx, 0, -cz];

  const built = useMemo<Built>(() => buildOldStreet(data), [data]);

  const stat = useMemo(() => {
    const root = new Group();
    root.name = "old-street-static";
    const mats = heroMaterials();
    for (const [slot, geo] of Object.entries(built.parts) as [Slot, BufferGeometry][]) {
      const m = new Mesh(geo, mats[slot]);
      m.name = `old-street:${slot}`;
      m.castShadow = slot !== "glow" && slot !== "glass";
      m.receiveShadow = true;
      m.renderOrder = -2;
      m.raycast = noRaycast;
      root.add(m);
    }
    if (built.signs) {
      // a fresh Mesh per memo call (StrictMode builds this twice; an Object3D can only have one parent)
      const signs = new Mesh(built.signs.geometry, built.signs.material);
      signs.name = "old-street-signs";
      signs.renderOrder = -2;
      signs.raycast = noRaycast;
      root.add(signs);
    }
    // the pavilion's glazing: see-through
    const glassMat = new MeshStandardMaterial({ color: "#cfe2e6", roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide });
    const glass = new Mesh(built.glass, glassMat);
    glass.name = "old-street-glazing";
    glass.raycast = noRaycast;
    root.add(glass);
    // depth-only caps over the openings in the ground
    const capMat = new MeshBasicMaterial({ colorWrite: false });
    const cap = new Mesh(built.cap, capMat);
    cap.name = "old-street-ground-cap";
    cap.renderOrder = -1;
    cap.raycast = noRaycast;
    root.add(cap);
    // light pools (night)
    const poolMat = new MeshBasicMaterial({ map: poolTexture(), color: "#ffcf8f", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    const pools = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, built.pools.length);
    const o = new Object3D();
    built.pools.forEach((p, i) => {
      o.position.set(p.x, p.y + 0.01, p.z);
      o.scale.set(p.r * 2, 1, p.r * 2);
      o.updateMatrix();
      pools.setMatrixAt(i, o.matrix);
    });
    pools.name = "old-street-light-pools";
    pools.raycast = noRaycast;
    pools.frustumCulled = false;
    root.add(pools);
    // signal lamps: red / amber / green per head
    const lamps = new InstancedMesh(new SphereGeometry(0.12, 8, 6), new MeshBasicMaterial({ toneMapped: false }), built.heads.length * 3);
    const q = new Quaternion();
    built.heads.forEach((h, i) => {
      q.setFromAxisAngle(new Vector3(0, 1, 0), h.ry);
      [0.33, 0, -0.33].forEach((dy, j) => {
        const off = new Vector3(0, dy, 0.05).applyQuaternion(q);
        lamps.setMatrixAt(i * 3 + j, new Matrix4().makeTranslation(h.pos[0] + off.x, h.pos[1] + off.y, h.pos[2] + off.z));
        lamps.setColorAt(i * 3 + j, new Color("#111"));
      });
    });
    lamps.name = "old-street-signal-lamps";
    lamps.raycast = noRaycast;
    root.add(lamps);
    // screens
    const screens = new Screens(built.screens.length);
    const sg = mergeGeometries(built.screens.map((s, i) => screenQuad(screens, i, s.w, s.h, s.m)), false)!;
    const smat = screens.material();
    const scr = new Mesh(sg, smat);
    scr.name = "old-street-screens";
    scr.renderOrder = -2;
    scr.raycast = noRaycast;
    root.add(scr);
    return { root, pools, poolMat, lamps, screens, smat, glassMat, capMat };
  }, [built]);

  const traffic = useMemo(() => {
    const t = new JunctionTraffic(built.lanes, 34);
    for (const m of t.meshes) {
      m.renderOrder = -2;
      m.raycast = noRaycast;
    }
    return t;
  }, [built]);

  // people: station walkers, strollers, crossers
  const crowd = useMemo(() => {
    const r = rng(1890);
    const walkers: Walker[] = [];
    const look = () => ({
      shirt: new Color().setHSL(r(), 0.35 + r() * 0.3, 0.25 + r() * 0.35),
      trousers: TROUSERS[Math.floor(r() * TROUSERS.length)],
      skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)],
      scale: 1.65 + r() * 0.3,
    });
    const PER = [30, 30, 22, 26, 14, 26];
    built.routes.in.forEach((_, e) => {
      for (let i = 0; i < PER[e]; i++)
        walkers.push({ entry: e, route: e, inbound: i % 2 === 0, period: 40 + r() * 40, phase: r() * 200, speed: 1.15 + r() * 0.4, gate: r(), ...look() });
    });
    built.strolls.forEach((_, s) => {
      for (let i = 0; i < 12; i++) walkers.push({ entry: -1, route: s, inbound: i % 2 === 0, period: 90 + r() * 60, phase: r() * 300, speed: 1.0 + r() * 0.4, gate: r() * 0.9, ...look() });
    });
    const crossers = built.crossings.flatMap((_c, ci) =>
      Array.from({ length: 4 }, (_, j) => ({ ci, fromA: j % 2 === 0, lag: r() * 0.25, side: (r() - 0.5) * 2.4, wait: r() * 1.5, gate: r(), ...look() })),
    );
    const people = createPeople(walkers.length + crossers.length, { emissive: 0.08 });
    people.group.traverse((o) => {
      o.renderOrder = -2;
      o.frustumCulled = false;
    });
    return { walkers, crossers, people };
  }, [built]);

  useEffect(
    () => () => {
      traffic.dispose();
      crowd.people.dispose();
      stat.root.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      stat.screens.texture.dispose();
    },
    [traffic, crowd, stat],
  );

  const tmp = { x: 0, y: 0, z: 0, dx: 1, dz: 0 };
  const red = new Color("#ff2a1a");
  const amber = new Color("#ffae00");
  const green = new Color("#1dff86");
  const off = new Color("#151515");

  useFrame(({ clock }, dt) => {
    const time = clock.elapsedTime;
    const h = hourOf(useSim.getState().t);
    const night = nightLevel(h);
    setHeroNight(night);
    stat.poolMat.opacity = 0.55 * night;
    stat.pools.visible = night > 0.02;
    stat.screens.update(time);
    // signals
    const tc = time % CYCLE_LEN;
    built.heads.forEach((hd, i) => {
      const s = signalState(hd.group, tc);
      stat.lamps.setColorAt(i * 3, s === "r" ? red : off);
      stat.lamps.setColorAt(i * 3 + 1, s === "a" ? amber : off);
      stat.lamps.setColorAt(i * 3 + 2, s === "g" ? green : off);
    });
    if (stat.lamps.instanceColor) stat.lamps.instanceColor.needsUpdate = true;
    // traffic
    traffic.update(dt, tc, Math.round(34 * trafficShare(h)));
    // people
    const share = crowdShare(h);
    const P = crowd.people;
    let n = 0;
    const ox = origin[0];
    const oz = origin[2];
    for (const w of crowd.walkers) {
      if (w.gate > share) continue;
      const cyc = Math.floor((time + w.phase) / w.period);
      const d = (((time + w.phase) % w.period) / w.period) * w.period * w.speed;
      let pts: V3[];
      let len: number;
      if (w.entry >= 0) {
        const origins = built.routes.origins[w.entry];
        const o = origins[(cyc * 7 + Math.floor(w.phase)) % origins.length];
        const rt: Route = built.routes.in[w.entry];
        pts = [o, ...rt.pts];
        len = rt.len + Math.hypot(rt.pts[0][0] - o[0], rt.pts[0][2] - o[2]);
      } else {
        const rt = built.strolls[w.route];
        pts = rt.pts;
        len = rt.len;
      }
      if (d > len) continue;
      const inbound = w.inbound !== (cyc % 2 === 1 && w.entry < 0);
      along(pts, inbound ? d : len - d, tmp);
      let dx = tmp.dx;
      let dz = tmp.dz;
      if (!inbound) {
        dx = -dx;
        dz = -dz;
      }
      P.set(n++, tmp.x + ox, tmp.y, tmp.z + oz, Math.atan2(dx, dz), time * 7 + w.phase, true, w.scale, w.shirt, w.trousers, w.skin);
    }
    // crossers: wait at the kerb, walk over in the pedestrian phase
    const pp = pedPhase(tc);
    for (const c of crowd.crossers) {
      if (c.gate > Math.min(1, share * 1.2)) continue;
      const cr = built.crossings[c.ci];
      const flip = Math.floor(time / CYCLE_LEN) % 2 === 1;
      const a = c.fromA !== flip ? cr.a : cr.b;
      const b = c.fromA !== flip ? cr.b : cr.a;
      const t = pp < 0 ? 0 : Math.max(0, Math.min(1, (pp - c.lag) / (1 - c.lag - 0.05)));
      const moving = t > 0 && t < 1;
      const ux = b[0] - a[0];
      const uz = b[2] - a[2];
      const l = Math.hypot(ux, uz) || 1;
      // wait back from the kerb (spread along it), walk over, then step clear on the far side
      const back = t <= 0 ? -(0.4 + c.wait) : t >= 1 ? 0.4 + c.wait : 0;
      const x = a[0] + ux * t + (ux / l) * back + (-uz / l) * c.side;
      const z = a[2] + uz * t + (uz / l) * back + (ux / l) * c.side;
      const hd = Math.atan2(ux, uz);
      P.set(n++, x + ox, a[1], z + oz, hd, time * 7 + c.side * 10, moving, c.scale, c.shirt, c.trousers, c.skin);
    }
    P.commit(n);
    // night glow on the crowd material
    const torso = P.meshes.torso?.material as MeshStandardMaterial | undefined;
    if (torso && "emissiveIntensity" in torso) torso.emissiveIntensity = 0.08 + 0.25 * night;
  });

  return (
    <>
      <group position={origin} name="old-street">
        <primitive object={stat.root} />
        {traffic.meshes.map((m) => (
          <primitive key={m.name} object={m} />
        ))}
        <Html position={built.label} center distanceFactor={320} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="map-label">Old Street · Northern line</div>
        </Html>
      </group>
      <primitive object={crowd.people.group} name="old-street-people" />
    </>
  );
}

export default function OldStreet() {
  const [data, setData] = useState<OldStreetData | null>(null);
  useEffect(() => {
    let live = true;
    loadOldStreet()
      .then((d) => live && setData(d))
      .catch((e) => console.warn("OldStreet: no area data", e));
    return () => {
      live = false;
    };
  }, []);
  return data ? <Scene data={data} /> : null;
}
