// Module: Buildings. Offices, residential terraces and the station (stores and clubs belong to Stores).
// Boxes with a procedural window grid: UVs are scaled per building so a handful of shared materials cover the city.
// Window glow follows the night level, touching materials only when it changes by a visible step.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BoxGeometry, MeshStandardMaterial } from "three";
import type { Building } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { buildingKeptOut } from "../keepOut";
import { Station } from "../Station";
import { BUILDING_COLORS } from "../palette";
import { FLOOR_H, TILE_COLS, TILE_ROWS, WINDOW_W, windowTextures } from "../textures";

const VARIANTS = 4;

/** Box whose side-face UVs repeat the window tile by real size; roof/floor sample plain wall. */
function facadeBox(b: Building): BoxGeometry {
  const g = new BoxGeometry(b.w, b.h, b.d);
  const uv = g.attributes.uv;
  const tileW = TILE_COLS * WINDOW_W;
  const tileH = TILE_ROWS * FLOOR_H;
  // face order: +x, -x, +y, -y, +z, -z; 4 verts each
  const faceScale = [b.d, b.d, 0, 0, b.w, b.w];
  for (let f = 0; f < 6; f++)
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      const s = faceScale[f];
      uv.setXY(i, s ? (uv.getX(i) * s) / tileW : 0.005, s ? (uv.getY(i) * b.h) / tileH : 0.005);
    }
  return g;
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/**
 * OSM footprints are bounding boxes that overlap their neighbours, often with walls and roofs in exactly the same
 * plane: the GPU can't decide which is in front and the facade flickers (z-fighting). Pull each wall in by a few
 * centimetres and nudge the roof, by a per-building amount, so no two faces are ever coplanar.
 */
function unclash(b: Building): Building {
  const k = hash(b.id) % 7;
  const inset = 0.08 + k * 0.05;
  return { ...b, w: Math.max(1, b.w - inset), d: Math.max(1, b.d - inset), h: b.h + 0.03 + k * 0.06 };
}

export default function Buildings() {
  const { map } = useWorld();

  const built = useMemo(() => {
    const kinds = ["residential", "office"] as const;
    const mats = Object.fromEntries(
      kinds.map((k) => [
        k,
        Array.from({ length: VARIANTS }, (_, v) => {
          const t = windowTextures(BUILDING_COLORS[k], v + (k === "office" ? 10 : 0), k === "residential" ? "#efe9df" : undefined);
          return new MeshStandardMaterial({ map: t.map, bumpMap: t.bump, bumpScale: 2, emissiveMap: t.emissive, emissive: "#ffffff", emissiveIntensity: 0, roughness: 0.85 });
        }),
      ]),
    ) as Record<(typeof kinds)[number], MeshStandardMaterial[]>;
    const items = map.buildings
      .filter((b) => (b.kind === "residential" || b.kind === "office") && !buildingKeptOut(b))
      .map((raw) => {
        const b = unclash(raw);
        return { b, geo: facadeBox(b), mat: mats[b.kind as "residential" | "office"][hash(b.id) % VARIANTS] };
      });
    return { mats, items };
  }, [map]);

  useEffect(
    () => () => {
      built.items.forEach((i) => i.geo.dispose());
      Object.values(built.mats)
        .flat()
        .forEach((m) => {
          m.map?.dispose();
          m.emissiveMap?.dispose();
          m.bumpMap?.dispose();
          m.dispose();
        });
    },
    [built],
  );

  useFrame(() => {
    const hour = hourOf(useSim.getState().t);
    const n = Math.round(nightLevel(hour) * 20) / 20;
    const late = hour >= 23 || hour < 6;
    const res = n * (late ? 0.55 : 1.15);
    const off = n * (hour >= 8 && hour < 20 ? 1 : late ? 0.15 : 0.6);
    for (const m of built.mats.residential) if (m.emissiveIntensity !== res) m.emissiveIntensity = res;
    for (const m of built.mats.office) if (m.emissiveIntensity !== off) m.emissiveIntensity = off;
  });

  const station = map.buildings.find((b) => b.kind === "station");

  return (
    <group name="buildings">
      {built.items.map(({ b, geo, mat }) => {
        const [x, z] = toScene(b.x, b.z);
        return (
          <group key={b.id} position={[x, 0, z]}>
            <mesh geometry={geo} material={mat} position-y={b.h / 2} castShadow receiveShadow />
            {b.kind === "office" && (
              <mesh position={[b.w * 0.15, b.h + 1.2, 0]} castShadow>
                <boxGeometry args={[b.w * 0.3, 2.4, b.d * 0.35]} />
                <meshStandardMaterial color="#8794a6" roughness={0.9} />
              </mesh>
            )}
            {b.kind === "residential" && (
              <mesh position-y={b.h + 0.3}>
                <boxGeometry args={[b.w + 0.6, 0.6, b.d + 0.6]} />
                <meshStandardMaterial color="#8c7b70" roughness={1} />
              </mesh>
            )}
          </group>
        );
      })}
      {station && <Station b={station} map={map} />}
    </group>
  );
}
