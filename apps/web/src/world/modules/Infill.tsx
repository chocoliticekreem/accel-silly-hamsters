// Module: Infill (decorative only). Fills the land the real OSM map leaves empty with believable Shoreditch fabric:
// brick terraces and warehouses along street frontages, offices, yards, pocket parks with railings, car parks, a
// Boxpark-style container market and a fenced construction site with cranes on the biggest void (the Goodsyard),
// (Beyond the map edge the Surroundings module takes over with one continuous street network.)
// Pure set dressing: never clickable (raycast disabled), never feeds data. Planning lives in sim/infill.ts.
// Draw calls: buildings are merged per material (window textures need per-building UVs), everything else is instanced.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  type InstancedMesh,
  type Material,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CityMap } from "../../api/contract";
import { rng, type Rng } from "../../mock/rng";
import { toScene } from "../../sim/geometry";
import { planInfill, type Plot } from "../../sim/infill";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { BUILDING_COLORS, GROUND } from "../palette";
import { FLOOR_H, TILE_COLS, TILE_ROWS, WINDOW_W, windowTextures } from "../textures";

const noRaycast = () => null;

/** Wall styles: [wall colour, sash/frame colour or undefined, window-pattern variant]. */
const STYLES = {
  brick: [BUILDING_COLORS.residential, "#efe9df", 40],
  brickDark: ["#86493a", "#efe9df", 41],
  stock: ["#b49a72", "#f2efe6", 42], // London yellow stock brick
  brickWarm: ["#a5664b", "#e9e2d4", 43],
  warehouse: ["#7a4536", "#3a3a3a", 44], // Crittall-style dark industrial frames
  warehouseGrey: ["#6f6660", "#2f2f2f", 45],
  office: [BUILDING_COLORS.office, undefined, 46],
  officeWarm: ["#b9b2a6", undefined, 47],
} as const satisfies Record<string, readonly [string, string | undefined, number]>;
type Style = keyof typeof STYLES;
const RESIDENTIAL: Style[] = ["brick", "brickDark", "stock", "brickWarm", "brick"];

/** Box (centred at origin) whose side-face UVs repeat the window tile by real size; roof/floor sample plain wall. */
function facadeBox(w: number, h: number, d: number): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const tileW = TILE_COLS * WINDOW_W;
  const tileH = TILE_ROWS * FLOOR_H;
  const faceScale = [d, d, 0, 0, w, w]; // +x, -x, +y, -y, +z, -z
  for (let f = 0; f < 6; f++)
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      const s = faceScale[f];
      uv.setXY(i, s ? (uv.getX(i) * s) / tileW : 0.005, s ? (uv.getY(i) * h) / tileH : 0.005);
    }
  return g;
}

interface Inst {
  m: Matrix4;
  c?: Color;
}

/** Collects instance transforms in contract coords. */
class Bag {
  items: Inst[] = [];
  private o = new Object3D();
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0, color?: string | Color) {
    const [px, pz] = toScene(x, z);
    this.o.position.set(px, y, pz);
    this.o.rotation.set(0, rotY, 0);
    this.o.scale.set(sx, sy, sz);
    this.o.updateMatrix();
    this.items.push({ m: this.o.matrix.clone(), c: color === undefined ? undefined : color instanceof Color ? color : new Color(color) });
  }
}

const GROUND_COLORS: Partial<Record<Plot["kind"], string>> = {
  park: "#6f9a5c",
  yard: "#a19d94",
  carpark: GROUND.asphalt,
  plaza: "#c9c1b0",
  market: "#a49e94",
  site: "#8c7a5e",
};
const SHOPFRONTS = ["#2d3a3a", "#5b2d2d", "#2f3d5c", "#333333", "#6b4d2b", "#2f4a35", "#7a2f3f"];
const CAR_COLORS = ["#d9d9d9", "#2b2b2b", "#8a1f1f", "#2d4f8a", "#9aa3ad", "#e8e2cf", "#3e5e3a", "#5a5f66"];
const CONTAINER_COLORS = ["#262626", "#262626", "#303030", "#1f1f1f", "#262626", "#8f2b22", "#2a5d8f", "#c79a2b", "#3e6b45"];
const HOARDING_COLORS = ["#2f4a3a", "#2f4a3a", "#1f2a24", "#e6e1d6", "#2f4a3a", "#d9542b", "#5e3c8f"];

interface Built {
  merged: { geo: BufferGeometry; mat: Material; shadow: boolean }[];
  inst: { name: string; geo: BufferGeometry; mat: MeshStandardMaterial; items: Inst[]; shadow: boolean }[];
  windowMats: { mat: MeshStandardMaterial; office: boolean }[];
  cranes: { x: number; z: number; h: number; jib: number; rot: number }[];
}

function build(map: CityMap): Built {
  const plan = planInfill(map);
  const geoByStyle = new Map<Style, BufferGeometry[]>();
  const roofs: BufferGeometry[] = [];
  const addBuilding = (style: Style, x: number, z: number, w: number, d: number, h: number, y0 = 0) => {
    const [sx, sz] = toScene(x, z);
    const g = facadeBox(w, h, d).translate(sx, y0 + h / 2, sz);
    if (!geoByStyle.has(style)) geoByStyle.set(style, []);
    geoByStyle.get(style)!.push(g);
  };
  const addRoof = (x: number, z: number, w: number, d: number, y: number, hh: number) => {
    const [sx, sz] = toScene(x, z);
    roofs.push(new BoxGeometry(w, hh, d).translate(sx, y + hh / 2, sz));
  };

  const pads = new Bag();
  const shopfronts = new Bag();
  const chimneys = new Bag();
  const trunks = new Bag();
  const crowns = new Bag();
  const benches = new Bag();
  const railings = new Bag();
  const lines = new Bag();
  const carBodies = new Bag();
  const carCabins = new Bag();
  const containers = new Bag();
  const hoardings = new Bag();
  const concrete = new Bag();
  const cabins = new Bag();
  const bins = new Bag();

  const tree = (r: Rng, x: number, z: number, s = 0.8 + r() * 0.5) => {
    trunks.add(x, 0, z, s, s, s);
    crowns.add(x, 0, z, s, s * (0.9 + r() * 0.2), s, r() * Math.PI, new Color().setHSL(0.27 + r() * 0.05, 0.32 + r() * 0.12, 0.33 + r() * 0.08));
  };
  const car = (r: Rng, x: number, z: number, alongX: boolean) => {
    const rot = (alongX ? Math.PI / 2 : 0) + (r() < 0.5 ? Math.PI : 0);
    const c = CAR_COLORS[Math.floor(r() * CAR_COLORS.length)];
    carBodies.add(x, 0, z, 1, 1, 1, rot, c);
    carCabins.add(x, 0, z, 1, 1, 1, rot, c);
  };

  for (const p of plan.plots) {
    const r = rng(p.seed);
    const w = p.w - 0.3;
    const d = p.d - 0.3;
    if (p.kind === "terrace" || p.kind === "warehouse" || p.kind === "office") {
      const style: Style =
        p.kind === "office" ? (r() < 0.6 ? "office" : "officeWarm") : p.kind === "warehouse" ? (r() < 0.65 ? "warehouse" : "warehouseGrey") : RESIDENTIAL[Math.floor(r() * RESIDENTIAL.length)];
      addBuilding(style, p.x, p.z, w, d, p.h);
      if (p.kind === "terrace") {
        addRoof(p.x, p.z, w + 0.4, d + 0.4, p.h, 0.45);
        if (r() < 0.7) chimneys.add(p.x + (r() - 0.5) * w * 0.5, p.h, p.z + (r() - 0.5) * d * 0.5, 1, 1 + r() * 0.6, 1);
        if (p.front && r() < 0.6) shopfronts.add(p.x, 0, p.z, w + 0.3, 1, d + 0.3, 0, SHOPFRONTS[Math.floor(r() * SHOPFRONTS.length)]);
      } else if (p.kind === "warehouse") {
        addRoof(p.x, p.z, w + 0.2, d + 0.2, p.h, 0.7);
        // a rooftop extension or water tank: the converted-warehouse look
        if (w > 8 && d > 8 && r() < 0.5) addBuilding("office", p.x + w * 0.15, p.z, w * 0.45, d * 0.6, 3.5, p.h + 0.7);
        if (p.front && r() < 0.35) shopfronts.add(p.x, 0, p.z, w + 0.3, 1, d + 0.3, 0, SHOPFRONTS[Math.floor(r() * SHOPFRONTS.length)]);
      } else {
        addRoof(p.x + w * 0.12, p.z, w * 0.4, d * 0.4, p.h, 2.4);
        if (p.front && r() < 0.5) shopfronts.add(p.x, 0, p.z, w + 0.3, 1, d + 0.3, 0, "#2b3440");
      }
      continue;
    }

    const pad = GROUND_COLORS[p.kind];
    if (pad) pads.add(p.x, 0, p.z, p.w, 1, p.d, 0, pad);

    if (p.kind === "park") {
      const n = Math.max(1, Math.round((p.w * p.d) / 70));
      for (let k = 0; k < n; k++) tree(r, p.x + (r() - 0.5) * (p.w - 4), p.z + (r() - 0.5) * (p.d - 4));
      // gravel path across the long side, a bench or two, black railings round the square
      const long = p.w >= p.d;
      if (Math.min(p.w, p.d) >= 8) pads.add(p.x, 0.02, p.z, long ? p.w : 2, 1, long ? 2 : p.d, 0, "#cfc4a8");
      for (let k = 0; k < Math.min(3, 1 + Math.floor((p.w * p.d) / 200)); k++)
        benches.add(p.x + (long ? (r() - 0.5) * (p.w - 4) : 1.8), 0, p.z + (long ? 1.8 : (r() - 0.5) * (p.d - 4)), 1, 1, 1, long ? 0 : Math.PI / 2);
      railings.add(p.x, 0, p.z + p.d / 2 - 0.2, p.w - 0.4, 1, 1);
      railings.add(p.x, 0, p.z - p.d / 2 + 0.2, p.w - 0.4, 1, 1);
      railings.add(p.x + p.w / 2 - 0.2, 0, p.z, p.d - 0.4, 1, 1, Math.PI / 2);
      railings.add(p.x - p.w / 2 + 0.2, 0, p.z, p.d - 0.4, 1, 1, Math.PI / 2);
    } else if (p.kind === "carpark") {
      // two rows of bays along the long side with a driving aisle between
      const alongX = p.w >= p.d;
      const len = alongX ? p.w : p.d;
      const across = alongX ? p.d : p.w;
      const bays = Math.floor((len - 2) / 2.6);
      for (const side of [-1, 1]) {
        const off = side * (across / 2 - 2.8);
        if (Math.abs(off) < 2.5) continue;
        for (let k = 0; k <= bays; k++) {
          const a = -len / 2 + 1 + k * 2.6;
          const [lx, lz] = alongX ? [p.x + a, p.z + off] : [p.x + off, p.z + a];
          lines.add(lx, 0, lz, alongX ? 0.12 : 4.6, 1, alongX ? 4.6 : 0.12);
          if (k < bays && r() < 0.72) {
            const [cx, cz] = alongX ? [p.x + a + 1.3, p.z + off] : [p.x + off, p.z + a + 1.3];
            car(r, cx, cz, !alongX);
          }
        }
      }
    } else if (p.kind === "yard") {
      // service yard / mews: bins, the odd van or tree
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++)
        bins.add(p.x + (r() - 0.5) * (p.w - 2), 0, p.z + (r() - 0.5) * (p.d - 2), 1, 1, 1, 0, r() < 0.5 ? "#2f5d3a" : "#4a4f57");
      if (p.w * p.d >= 48 && r() < 0.5) car(r, p.x, p.z, p.w >= p.d);
      else if (r() < 0.6) tree(r, p.x + (r() - 0.5) * (p.w - 3), p.z + (r() - 0.5) * (p.d - 3), 0.7);
    } else if (p.kind === "plaza") {
      tree(r, p.x, p.z);
      benches.add(p.x + 2, 0, p.z, 1, 1, 1);
    } else if (p.kind === "market") {
      // Boxpark: rows of shipping containers, many stacked two high, an aisle down the middle
      const alongX = p.w >= p.d;
      const len = alongX ? p.w : p.d;
      const across = alongX ? p.d : p.w;
      const rows = across >= 14 ? [-1, 1] : [0];
      for (const side of rows) {
        const off = side * (across / 2 - 2);
        for (let a = -len / 2 + 3.2; a <= len / 2 - 3.1; a += 6.3) {
          const [x, z] = alongX ? [p.x + a, p.z + off] : [p.x + off, p.z + a];
          const rot = alongX ? 0 : Math.PI / 2;
          containers.add(x, 0, z, 1, 1, 1, rot, CONTAINER_COLORS[Math.floor(r() * CONTAINER_COLORS.length)]);
          if (r() < 0.6) containers.add(x, 2.6, z, 1, 1, 1, rot, CONTAINER_COLORS[Math.floor(r() * CONTAINER_COLORS.length)]);
        }
      }
      if (rows.length === 2) for (let a = -len / 2 + 6; a < len / 2 - 4; a += 12) benches.add(alongX ? p.x + a : p.x, 0, alongX ? p.z : p.z + a, 1, 1, 1, alongX ? 0 : Math.PI / 2);
    } else if (p.kind === "site") {
      if (p.w >= 24 && p.d >= 24 && r() < 0.75) {
        // a concrete frame going up: core, slabs, corner columns
        const floors = 4 + Math.floor(r() * 9);
        const fw = p.w - 8;
        const fd = p.d - 8;
        const top = floors * 3.6;
        concrete.add(p.x - fw * 0.2, 0, p.z, 6, top + 3, 6);
        for (let f = 1; f <= floors; f++) concrete.add(p.x, f * 3.6 - 0.35, p.z, fw, 0.35, fd);
        for (const [ix, iz] of [
          [-1, -1],
          [-1, 1],
          [1, -1],
          [1, 1],
        ])
          concrete.add(p.x + (ix * (fw - 1)) / 2, 0, p.z + (iz * (fd - 1)) / 2, 0.7, top, 0.7);
      } else {
        // site cabins stacked two high, and material piles
        // most of the site is bare ground; a few plots get a cabin cluster
        const n = r() < 0.3 ? 1 + Math.floor(r() * 2) : 0;
        for (let k = 0; k < n; k++) {
          const x = p.x + (r() - 0.5) * Math.max(0, p.w - 8);
          const z = p.z + (r() - 0.5) * Math.max(0, p.d - 4);
          cabins.add(x, 0, z, 1, 1, 1, 0, "#3d6fb5");
          if (r() < 0.5) cabins.add(x, 2.7, z, 1, 1, 1, 0, "#e6e1d6");
        }
        if (r() < 0.5) concrete.add(p.x + (r() - 0.5) * 4, 0, p.z + (r() - 0.5) * 4, 3 + r() * 3, 0.6 + r(), 2 + r() * 2);
      }
    }
  }

  // hoarding round the construction site
  {
    const r = rng(77);
    let run = 0;
    let color = HOARDING_COLORS[0];
    for (const h of plan.hoardings) {
      if (run-- <= 0) {
        run = 3 + Math.floor(r() * 6);
        color = HOARDING_COLORS[Math.floor(r() * HOARDING_COLORS.length)];
      }
      hoardings.add(h.x, 0, h.z, 1, 1, 1, h.alongX ? 0 : Math.PI / 2, color);
    }
  }

  // ---- materials & geometries ----
  const windowMats: Built["windowMats"] = [];
  const merged: Built["merged"] = [];
  for (const [style, geos] of geoByStyle) {
    const real = geos;
    const [wall, frame, variant] = STYLES[style];
    const t = windowTextures(wall, variant, frame);
    const mat = new MeshStandardMaterial({ map: t.map, emissiveMap: t.emissive, emissive: "#ffffff", emissiveIntensity: 0, roughness: 0.88 });
    windowMats.push({ mat, office: style.startsWith("office") });
    merged.push({ geo: mergeGeometries(real)!, mat, shadow: true });
    real.forEach((g) => g.dispose());
  }
  if (roofs.length) {
    merged.push({ geo: mergeGeometries(roofs)!, mat: new MeshStandardMaterial({ color: "#6f625a", roughness: 1 }), shadow: true });
    roofs.forEach((g) => g.dispose());
  }

  const std = (color: string, extra: Partial<MeshStandardMaterial> = {}) => Object.assign(new MeshStandardMaterial({ color, roughness: 0.9 }), extra);
  const inst: Built["inst"] = [
    { name: "pads", geo: new BoxGeometry(1, 0.08, 1).translate(0, 0.04, 0), mat: std("#ffffff", { roughness: 1 }), items: pads.items, shadow: false },
    { name: "shopfronts", geo: new BoxGeometry(1, 3.4, 1).translate(0, 1.7, 0), mat: std("#ffffff", { emissive: new Color("#ffcf8a"), roughness: 0.5 }), items: shopfronts.items, shadow: false },
    { name: "chimneys", geo: new BoxGeometry(2.2, 1.6, 0.9).translate(0, 0.8, 0), mat: std("#7d5244"), items: chimneys.items, shadow: true },
    { name: "trunks", geo: new CylinderGeometry(0.25, 0.35, 4, 6).translate(0, 2, 0), mat: std("#5a4636"), items: trunks.items, shadow: true },
    { name: "crowns", geo: new IcosahedronGeometry(3.2, 1).scale(1, 0.85, 1).translate(0, 6.2, 0), mat: std("#ffffff", { flatShading: true, roughness: 1 }), items: crowns.items, shadow: true },
    { name: "benches", geo: new BoxGeometry(1.8, 0.5, 0.6).translate(0, 0.45, 0), mat: std("#6b4a33"), items: benches.items, shadow: false },
    { name: "railings", geo: new BoxGeometry(1, 1.1, 0.08).translate(0, 0.55, 0), mat: std("#1d1f22", { roughness: 0.6 }), items: railings.items, shadow: false },
    { name: "lines", geo: new BoxGeometry(1, 0.02, 1).translate(0, 0.09, 0), mat: std(GROUND.marking), items: lines.items, shadow: false },
    { name: "carBodies", geo: new BoxGeometry(1.8, 0.9, 4.2).translate(0, 0.65, 0), mat: std("#ffffff", { roughness: 0.4, metalness: 0.3 }), items: carBodies.items, shadow: true },
    { name: "carCabins", geo: new BoxGeometry(1.6, 0.65, 2.2).translate(0, 1.42, -0.2), mat: std("#ffffff", { roughness: 0.3, metalness: 0.3 }), items: carCabins.items, shadow: false },
    { name: "containers", geo: new BoxGeometry(6.1, 2.55, 2.45).translate(0, 1.3, 0), mat: std("#ffffff", { roughness: 0.7 }), items: containers.items, shadow: true },
    { name: "hoardings", geo: new BoxGeometry(4, 2.6, 0.2).translate(0, 1.3, 0), mat: std("#ffffff", { roughness: 0.95 }), items: hoardings.items, shadow: true },
    { name: "concrete", geo: new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), mat: std("#a7a6a1", { roughness: 1 }), items: concrete.items, shadow: true },
    { name: "cabins", geo: new BoxGeometry(6, 2.6, 2.6).translate(0, 1.3, 0), mat: std("#ffffff"), items: cabins.items, shadow: true },
    { name: "bins", geo: new BoxGeometry(1.2, 1.3, 1).translate(0, 0.65, 0), mat: std("#ffffff"), items: bins.items, shadow: false },
  ].filter((x) => x.items.length > 0);
  // the cabin of a car shares the body colour but darker glass would need a second colour: tint it instead
  const cab = inst.find((x) => x.name === "carCabins");
  if (cab) cab.items = cab.items.map((it) => ({ m: it.m, c: it.c?.clone().multiplyScalar(0.55) }));

  const cr = rng(91);
  return { merged, inst, windowMats, cranes: plan.cranes.map((c) => ({ ...c, rot: cr() * Math.PI * 2 })) };
}

function Instanced({ geo, mat, items, shadow, name }: Built["inst"][number]) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      m.setMatrixAt(i, it.m);
      if (it.c) m.setColorAt(i, it.c);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  return <instancedMesh ref={ref} name={name} args={[geo, mat, items.length]} castShadow={shadow} receiveShadow raycast={noRaycast} />;
}

function Crane({ x, z, h, jib, rot, light }: Built["cranes"][number] & { light: MeshStandardMaterial }) {
  const [sx, sz] = toScene(x, z);
  const yellow = "#e8b32a";
  return (
    <group position={[sx, 0, sz]} name="crane">
      <mesh position-y={h / 2} castShadow raycast={noRaycast}>
        <boxGeometry args={[1.8, h, 1.8]} />
        <meshStandardMaterial color={yellow} roughness={0.7} wireframe={false} />
      </mesh>
      <group position-y={h} rotation-y={rot}>
        <mesh position={[jib / 2 - 2, 1, 0]} castShadow raycast={noRaycast}>
          <boxGeometry args={[jib, 1.3, 1.3]} />
          <meshStandardMaterial color={yellow} roughness={0.7} />
        </mesh>
        <mesh position={[-8, 1, 0]} castShadow raycast={noRaycast}>
          <boxGeometry args={[14, 1.1, 1.6]} />
          <meshStandardMaterial color={yellow} roughness={0.7} />
        </mesh>
        <mesh position={[-13, -0.4, 0]} castShadow raycast={noRaycast}>
          <boxGeometry args={[3.5, 2.6, 2.6]} />
          <meshStandardMaterial color="#8d8d88" roughness={1} />
        </mesh>
        <mesh position={[0, 4, 0]} raycast={noRaycast}>
          <coneGeometry args={[1.1, 6, 4]} />
          <meshStandardMaterial color={yellow} roughness={0.7} />
        </mesh>
        <mesh position={[1.6, -1.2, 1.4]} raycast={noRaycast}>
          <boxGeometry args={[2.2, 2.2, 2]} />
          <meshStandardMaterial color="#e6e1d6" roughness={0.6} />
        </mesh>
        {/* hook line partway out the jib */}
        <mesh position={[jib * 0.6, -h * 0.3, 0]} raycast={noRaycast}>
          <boxGeometry args={[0.12, h * 0.6, 0.12]} />
          <meshStandardMaterial color="#333" />
        </mesh>
        <mesh position={[jib - 2, 1.9, 0]} material={light} raycast={noRaycast}>
          <sphereGeometry args={[0.5, 8, 6]} />
        </mesh>
      </group>
    </group>
  );
}

export default function Infill() {
  const { map } = useWorld();
  const built = useMemo(() => build(map), [map]);
  const craneLight = useMemo(() => new MeshStandardMaterial({ color: "#ff3b2f", emissive: "#ff2a1a", emissiveIntensity: 0 }), []);
  const shopfront = built.inst.find((x) => x.name === "shopfronts")?.mat;

  useEffect(
    () => () => {
      built.merged.forEach(({ geo, mat }) => {
        geo.dispose();
        const m = mat as MeshStandardMaterial;
        m.map?.dispose();
        m.emissiveMap?.dispose();
        m.dispose();
      });
      built.inst.forEach(({ geo, mat }) => {
        geo.dispose();
        mat.dispose();
      });
      craneLight.dispose();
    },
    [built, craneLight],
  );

  // same window-glow curve as Buildings: homes light up in the evening, offices during working hours
  useFrame(({ clock }) => {
    const hour = hourOf(useSim.getState().t);
    const n = Math.round(nightLevel(hour) * 20) / 20;
    const late = hour >= 23 || hour < 6;
    const res = n * (late ? 0.55 : 1.15);
    const off = n * (hour >= 8 && hour < 20 ? 1 : late ? 0.15 : 0.6);
    for (const { mat, office } of built.windowMats) {
      const v = office ? off : res;
      if (mat.emissiveIntensity !== v) mat.emissiveIntensity = v;
    }
    const shop = n * (late ? 0.08 : 0.35);
    if (shopfront && shopfront.emissiveIntensity !== shop) shopfront.emissiveIntensity = shop;
    craneLight.emissiveIntensity = n > 0.1 ? (Math.sin(clock.elapsedTime * 3) > 0 ? 2 : 0.3) : 0;
  });

  return (
    <group name="infill">
      {built.merged.map(({ geo, mat, shadow }, i) => (
        <mesh key={i} geometry={geo} material={mat} castShadow={shadow} receiveShadow raycast={noRaycast} />
      ))}
      {built.inst.map((x) => (
        <Instanced key={x.name} {...x} />
      ))}
      {built.cranes.map((c, i) => (
        <Crane key={i} {...c} light={craneLight} />
      ))}
    </group>
  );
}
