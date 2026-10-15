// Module: Surroundings (decorative). The rest of London from the map edge to the horizon, so the City skyline stands
// on a continuous city instead of a field: every street that leaves the map runs on into a street network, blocks of
// terraces and offices line it (taller toward the City, low brick to the north and east), parks, the Thames, street
// lights and a trickle of traffic on the main roads. Planned in sim/surroundings.ts; low detail, instanced
// (a handful of draw calls for ~8k buildings), never clickable. The fog (Sky) blends it into the sky.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, Color, IcosahedronGeometry, MeshStandardMaterial, Object3D, type BufferGeometry, type InstancedMesh, type Material } from "three";
import type { CityMap } from "../../api/contract";
import { rng } from "../../mock/rng";
import { THAMES } from "../../sim/london";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { planSurroundings, type BlockStyle, type Road } from "../../sim/surroundings";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { cityMaterial } from "../cityMaterial";
import { useWorld } from "../context";
import { GROUND } from "../palette";

const noRaycast = () => null;

const STYLE_COLORS: Record<BlockStyle, string[]> = {
  brick: ["#94573f", "#8a4b3a", "#a2654b", "#7f4636"],
  stock: ["#b49a72", "#a88f6a", "#bfa77f"],
  warehouse: ["#7a4536", "#6f6660", "#84503d"],
  office: ["#9fb0c4", "#b9b2a6", "#a8adb3", "#8f9aa6"],
  glass: ["#7f97ad", "#8aa4b8", "#6f8799", "#9db1c2"],
  concrete: ["#a9a69e", "#9c9a94", "#b3afa6"],
};

/** Lamps along main roads out to here (m from the map centre); beyond, the fog hides them anyway. */
const LAMP_REACH = 1700;
const LAMP_EVERY = 38;
/** Ambient cars on the main roads. */
const CARS = 260;

interface Inst {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rot: number;
  color?: Color;
}

function build(map: CityMap) {
  const plan = planSurroundings(map);
  const r = rng(808);
  const buildings: Inst[] = plan.buildings.map((b) => {
    const pal = STYLE_COLORS[b.style];
    const [x, z] = toScene(b.x, b.z);
    return { x, y: 0, z, sx: b.w, sy: b.h, sz: b.d, rot: 0, color: new Color(pal[Math.floor(r() * pal.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.06) };
  });
  // flat roofs get a parapet-ish cap on terraces: cheap extra silhouette
  const caps: Inst[] = plan.buildings
    .filter((b) => b.style === "brick" || b.style === "stock")
    .map((b) => {
      const [x, z] = toScene(b.x, b.z);
      return { x, y: b.h, z, sx: b.w + 0.4, sy: 0.6, sz: b.d + 0.4, rot: 0 };
    });
  const roadInst = (rd: Road, y: number, widen = 0): Inst => {
    const [ax, az] = toScene(...rd.a);
    const [bx, bz] = toScene(...rd.b);
    const len = Math.hypot(bx - ax, bz - az);
    return { x: (ax + bx) / 2, y, z: (az + bz) / 2, sx: rd.width + widen, sy: 1, sz: len + rd.width * 0.6, rot: Math.atan2(bx - ax, bz - az) };
  };
  // below every map road class (sim/roadLayers ROAD_TOP) so the joins never share a plane
  const roads = plan.roads.map((rd) => roadInst(rd, 0.035));
  // kerbside pavement strips under the main roads read as wide streets from above
  const pavements = plan.roads.filter((rd) => rd.main).map((rd) => roadInst(rd, -0.012, 6));
  // centre dashes on the main roads near the map
  const dashes: Inst[] = [];
  for (const rd of plan.roads) {
    if (!rd.main) continue;
    const len = Math.hypot(rd.b[0] - rd.a[0], rd.b[1] - rd.a[1]);
    const ux = (rd.b[0] - rd.a[0]) / len;
    const uz = (rd.b[1] - rd.a[1]) / len;
    for (let s = 4; s < len; s += 9) {
      const x = rd.a[0] + ux * s;
      const z = rd.a[1] + uz * s;
      if (Math.hypot(x, z) > 900) continue;
      const [sx, sz] = toScene(x, z);
      dashes.push({ x: sx, y: 0.1, z: sz, sx: 0.35, sy: 1, sz: 4, rot: Math.atan2(ux, -uz) });
    }
  }
  const lamps: Inst[] = [];
  for (const rd of plan.roads) {
    if (!rd.main) continue;
    const len = Math.hypot(rd.b[0] - rd.a[0], rd.b[1] - rd.a[1]);
    const ux = (rd.b[0] - rd.a[0]) / len;
    const uz = (rd.b[1] - rd.a[1]) / len;
    for (let s = LAMP_EVERY / 2; s < len; s += LAMP_EVERY)
      for (const side of [-1, 1]) {
        const off = rd.width / 2 + 1.2;
        const x = rd.a[0] + ux * s + uz * off * side;
        const z = rd.a[1] + uz * s - ux * off * side;
        if (Math.hypot(x, z) > LAMP_REACH) continue;
        const [sx, sz] = toScene(x, z);
        lamps.push({ x: sx, y: 0, z: sz, sx: 1, sy: 1, sz: 1, rot: 0 });
      }
  }
  const parks: Inst[] = plan.parks.map((p) => {
    const [x, z] = toScene(p.x, p.z);
    return { x, y: 0.03, z, sx: p.w, sy: 1, sz: p.d, rot: 0 };
  });
  const trees: Inst[] = [];
  for (const p of plan.parks) {
    const n = Math.min(40, Math.max(3, Math.round((p.w * p.d) / 260)));
    for (let k = 0; k < n; k++) {
      const [x, z] = toScene(p.x + (r() - 0.5) * (p.w - 6), p.z + (r() - 0.5) * (p.d - 6));
      const s = 0.8 + r() * 0.7;
      trees.push({ x, y: 0, z, sx: s, sy: s * (0.9 + r() * 0.3), sz: s, rot: r() * Math.PI, color: new Color().setHSL(0.27 + r() * 0.05, 0.3 + r() * 0.12, 0.3 + r() * 0.08) });
    }
  }
  const river: Inst[] = [];
  for (let i = 0; i < THAMES.points.length - 1; i++) {
    const [ax, az] = toScene(...THAMES.points[i]);
    const [bx, bz] = toScene(...THAMES.points[i + 1]);
    river.push({ x: (ax + bx) / 2, y: -0.08, z: (az + bz) / 2, sx: THAMES.width, sy: 1, sz: Math.hypot(bx - ax, bz - az) + THAMES.width * 0.5, rot: Math.atan2(bx - ax, bz - az) });
  }
  // main-road traffic: each car drives one road segment back and forth
  const mains = plan.roads.filter((rd) => rd.main && Math.hypot(...rd.a) < 2000);
  const cars = Array.from({ length: mains.length ? CARS : 0 }, () => {
    const rd = mains[Math.floor(r() * mains.length)];
    return { rd, len: Math.hypot(rd.b[0] - rd.a[0], rd.b[1] - rd.a[1]), phase: r() * 1000, speed: 8 + r() * 6, lane: r() < 0.5 ? -1 : 1, bus: r() < 0.12 };
  });
  return { buildings, caps, roads, pavements, dashes, lamps, parks, trees, river, cars };
}

function Instances({ items, geo, mat, name }: { items: Inst[]; geo: BufferGeometry; mat: Material; name: string }) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new Object3D();
    items.forEach((it, i) => {
      o.position.set(it.x, it.y, it.z);
      o.rotation.set(0, it.rot, 0);
      o.scale.set(it.sx, it.sy, it.sz);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      if (it.color) m.setColorAt(i, it.color);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return <instancedMesh ref={ref} name={name} args={[geo, mat, items.length]} raycast={noRaycast} frustumCulled />;
}

export default function Surroundings() {
  const { map } = useWorld();
  const built = useMemo(() => build(map), [map]);

  const res = useMemo(() => {
    const unitBox = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const flat = new BoxGeometry(1, 0.06, 1);
    return {
      unitBox,
      flat,
      crown: new IcosahedronGeometry(3.2, 0).scale(1, 0.9, 1).translate(0, 6.2, 0),
      lampGeo: new BoxGeometry(0.5, 0.35, 0.5).translate(0, 6.5, 0),
      carGeo: new BoxGeometry(1.8, 1.5, 4.3).translate(0, 0.75, 0),
      building: cityMaterial(),
      cap: new MeshStandardMaterial({ color: "#6f625a", roughness: 1 }),
      road: new MeshStandardMaterial({ color: GROUND.asphalt, roughness: 0.92 }),
      pavement: new MeshStandardMaterial({ color: "#a4a8ae", roughness: 0.95 }),
      dash: new MeshStandardMaterial({ color: GROUND.marking, roughness: 0.8 }),
      park: new MeshStandardMaterial({ color: "#6f9a5c", roughness: 1 }),
      tree: new MeshStandardMaterial({ color: "#ffffff", flatShading: true, roughness: 1 }),
      water: new MeshStandardMaterial({ color: "#3e5a6e", roughness: 0.25, metalness: 0.35 }),
      lamp: new MeshStandardMaterial({ color: "#3a3a3a", emissive: "#ffcf7a", emissiveIntensity: 0, toneMapped: false }),
      car: new MeshStandardMaterial({ color: "#c8ced6", emissive: "#ffe6b0", emissiveIntensity: 0, roughness: 0.4 }),
    };
  }, []);
  useEffect(
    () => () => {
      Object.values(res).forEach((x) => (x as { dispose?: () => void }).dispose?.());
    },
    [res],
  );

  const carsRef = useRef<InstancedMesh>(null);
  const o = useMemo(() => new Object3D(), []);
  const carColors = useMemo(() => ["#c8ced6", "#3b4252", "#8a96a8", "#e6e2d8", "#7a3e3e", "#2f4a6b", "#111111"].map((c) => new Color(c)), []);
  const red = useMemo(() => new Color("#c8281e"), []);

  useEffect(() => {
    const m = carsRef.current;
    if (!m) return;
    built.cars.forEach((c, i) => m.setColorAt(i, c.bus ? red : carColors[i % carColors.length]));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [built, carColors, red]);

  useFrame(({ clock }) => {
    const n = nightLevel(hourOf(useSim.getState().t));
    res.building.uniforms.night.value = n;
    res.lamp.emissiveIntensity = n > 0.15 ? 2.2 * n : 0;
    res.car.emissiveIntensity = 0.5 * n;
    const m = carsRef.current;
    if (!m) return;
    const time = clock.elapsedTime;
    built.cars.forEach((c, i) => {
      // ping-pong along the segment, in the lane on the left of travel (UK)
      const d = (c.phase + time * c.speed) % (2 * c.len);
      const fwd = d < c.len;
      const s = fwd ? d : 2 * c.len - d;
      const ux = (c.rd.b[0] - c.rd.a[0]) / c.len;
      const uz = (c.rd.b[1] - c.rd.a[1]) / c.len;
      const dir = fwd ? 1 : -1;
      const lane = (c.rd.width / 4) * -dir;
      const x = c.rd.a[0] + ux * s + uz * lane;
      const z = c.rd.a[1] + uz * s - ux * lane;
      const [sx, sz] = toScene(x, z);
      o.position.set(sx, 0.05, sz);
      o.rotation.set(0, Math.atan2(ux * dir, -uz * dir), 0);
      o.scale.set(1, c.bus ? 2.8 : 1, c.bus ? 2.5 : 1);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <group name="surroundings">
      <Instances name="surr-pavements" items={built.pavements} geo={res.flat} mat={res.pavement} />
      <Instances name="surr-roads" items={built.roads} geo={res.flat} mat={res.road} />
      <Instances name="surr-dashes" items={built.dashes} geo={res.flat} mat={res.dash} />
      <Instances name="surr-river" items={built.river} geo={res.flat} mat={res.water} />
      <Instances name="surr-parks" items={built.parks} geo={res.flat} mat={res.park} />
      <Instances name="surr-trees" items={built.trees} geo={res.crown} mat={res.tree} />
      <Instances name="surr-buildings" items={built.buildings} geo={res.unitBox} mat={res.building} />
      <Instances name="surr-caps" items={built.caps} geo={res.unitBox} mat={res.cap} />
      <Instances name="surr-lamps" items={built.lamps} geo={res.lampGeo} mat={res.lamp} />
      {built.cars.length > 0 && <instancedMesh ref={carsRef} args={[res.carGeo, res.car, built.cars.length]} raycast={noRaycast} frustumCulled={false} />}
    </group>
  );
}
