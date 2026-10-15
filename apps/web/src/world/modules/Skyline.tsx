// Module: Skyline (backdrop). The City of London towers you see looking south-west from Shoreditch, placed at their
// real offsets from Shoreditch High St station (x east, z north, metres) and real heights, low-poly. Outside the
// sim area; not interactive. Sky's fog hazes them like distance does; lit windows at night.
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import { BoxGeometry, ConeGeometry, CylinderGeometry, LatheGeometry, MeshStandardMaterial, Vector2, type BufferGeometry } from "three";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { windowTextures } from "../textures";

interface Tower {
  name: string;
  x: number;
  z: number;
  h: number;
  geo: () => BufferGeometry;
  tint: string;
}

/** Taper a box: scale the top face (y > 0) by `top` (x/z) — Walkie-Talkie widens, Cheesegrater leans back. */
function shapedBox(w: number, h: number, d: number, edit: (x: number, y: number, z: number) => [number, number, number]) {
  const g = new BoxGeometry(w, h, d, 1, 6, 1).translate(0, h / 2, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = edit(pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

const TOWERS: Tower[] = [
  {
    name: "The Gherkin",
    x: -354,
    z: -980,
    h: 180,
    tint: "#5f7f86",
    geo: () => {
      const pts = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 0.97, 1].map((t) => new Vector2(25 * Math.sin(Math.PI * (0.18 + 0.62 * t)) * (1 - 0.92 * t ** 6), t * 180));
      return new LatheGeometry([new Vector2(0, 0), ...pts, new Vector2(0, 180)], 14);
    },
  },
  { name: "22 Bishopsgate", x: -576, z: -990, h: 278, tint: "#7d8a99", geo: () => shapedBox(46, 278, 40, (x, y, z) => [x * (1 - (y / 278) * 0.08), y, z * (1 - (y / 278) * 0.08)]) },
  { name: "Heron Tower", x: -390, z: -790, h: 230, tint: "#8b98a6", geo: () => new BoxGeometry(34, 202, 30).translate(0, 101, 0) },
  {
    name: "The Cheesegrater",
    x: -480,
    z: -1060,
    h: 225,
    tint: "#9aa5b1",
    geo: () => shapedBox(48, 225, 40, (x, y, z) => [x, y, z < 0 ? z : z - (y / 225) * 38]),
  },
  { name: "The Walkie-Talkie", x: -583, z: -1345, h: 160, tint: "#6f8796", geo: () => shapedBox(42, 160, 34, (x, y, z) => [x * (1 + (y / 160) * 0.35), y, z * (1 + (y / 160) * 0.2)]) },
  { name: "The Shard", x: -785, z: -2090, h: 310, tint: "#9fb4c4", geo: () => new ConeGeometry(34, 310, 4).rotateY(Math.PI / 4).translate(0, 155, 0) },
  // a few mid-rise City blocks so the towers sit in a skyline, not on a lawn
  { name: "City block", x: -470, z: -880, h: 110, tint: "#8592a0", geo: () => new BoxGeometry(60, 110, 50).translate(0, 55, 0) },
  { name: "City block", x: -650, z: -1150, h: 140, tint: "#7c8996", geo: () => new BoxGeometry(50, 140, 50).translate(0, 70, 0) },
  { name: "City block", x: -300, z: -1180, h: 95, tint: "#8e99a6", geo: () => new CylinderGeometry(26, 26, 95, 10).translate(0, 47.5, 0) },
  { name: "City block", x: -700, z: -900, h: 120, tint: "#828f9c", geo: () => new BoxGeometry(44, 120, 60).translate(0, 60, 0) },
];

export default function Skyline() {
  const parts = useMemo(() => {
    const win = windowTextures("#ffffff", 21);
    win.map.repeat.set(4, 12);
    win.emissive.repeat.set(4, 12);
    return TOWERS.map((t) => ({
      t,
      geo: t.geo(),
      mat: new MeshStandardMaterial({ color: t.tint, roughness: 0.35, metalness: 0.25, emissiveMap: win.emissive, emissive: "#ffd99a", emissiveIntensity: 0 }),
    }));
  }, []);

  useFrame(() => {
    const n = nightLevel(hourOf(useSim.getState().t));
    for (const { mat } of parts) mat.emissiveIntensity = n * 0.9;
  });

  return (
    <group name="skyline">
      {parts.map(({ t, geo, mat }, i) => {
        const [x, z] = toScene(t.x, t.z);
        return <mesh key={i} geometry={geo} material={mat} position={[x, 0, z]} />;
      })}
    </group>
  );
}
