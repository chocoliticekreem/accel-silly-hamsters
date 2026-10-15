// Module: Stores. Every store and club: a pastel box with a lit shop window, an awning and an OPEN sign.
// Window glow = this run's lighting level for the current hour (off / low / high), stronger at night,
// with an additive pool of light on the pavement. A lamp-yellow column above the roof shows how many agents are inside.
// Click to select (opens the store card); hover shows the name.
import { Html } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { AdditiveBlending, type Group, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial } from "three";
import type { Building, Store } from "../../api/contract";
import { frontage, toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf, isOpenAt, minuteOfDay } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { LAMP, LIGHT_INTENSITY, STORE_COLORS } from "../palette";
import { glowTexture } from "../textures";

export default function Stores() {
  const { map } = useWorld();
  const items = useMemo(
    () =>
      map.stores.flatMap((s) => {
        const b = map.buildings.find((x) => x.id === s.buildingId);
        return b ? [{ s, b, f: frontage(b, map.streets) }] : [];
      }),
    [map],
  );
  return (
    <group name="stores">
      {items.map(({ s, b, f }) => (
        <StoreBox key={s.id} store={s} b={b} nx={f.nx} nz={f.nz} />
      ))}
    </group>
  );
}

function StoreBox({ store, b, nx, nz }: { store: Store; b: Building; nx: number; nz: number }) {
  const { stores, live, interactive } = useWorld();
  const selected = useSim((s) => s.selectedStoreId === store.id);
  const hovered = useSim((s) => s.hoveredStoreId === store.id);
  const isClub = store.type === "club";
  const colors = STORE_COLORS[store.type];

  // local frame: +z faces the street
  const [x, z] = toScene(b.x, b.z);
  const [snx, snz] = toScene(nx, nz);
  const rot = Math.atan2(snx, snz);
  const width = nx !== 0 ? b.d : b.w;
  const depth = nx !== 0 ? b.w : b.d;
  const h = b.h;

  const glass = useRef<MeshStandardMaterial>(null);
  const sign = useRef<MeshStandardMaterial>(null);
  const pool = useRef<MeshBasicMaterial>(null);
  const column = useRef<Mesh>(null);
  const ring = useRef<Group>(null);
  const neon = useRef<MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    const t = useSim.getState().t;
    const cfg = stores?.[store.id];
    const hour = hourOf(t);
    const night = nightLevel(hour);
    const open = cfg ? isOpenAt(cfg.open, cfg.close, minuteOfDay(t)) : false;
    const level = cfg ? LIGHT_INTENSITY[cfg.lighting[Math.floor(hour) % 24]] : 0;
    const glow = level * (0.35 + 2.4 * night);
    if (glass.current) glass.current.emissiveIntensity = glow + (open ? 0.12 : 0);
    if (pool.current) pool.current.opacity = level * night * 0.85;
    if (sign.current) {
      sign.current.color.set(open ? "#57d68d" : "#7a3b3b");
      sign.current.emissive.set(open ? "#57d68d" : "#000000");
      sign.current.emissiveIntensity = open ? 1.2 + night : 0;
    }
    if (neon.current) neon.current.emissiveIntensity = open ? 1.5 + Math.sin(clock.elapsedTime * 3) * 0.6 : 0.05;
    if (column.current) {
      const n = live.occupancy.get(store.id) ?? 0;
      const target = Math.min(28, n * (isClub ? 0.12 : 1.3));
      const cur = column.current.scale.y;
      const next = cur + (target - cur) * 0.15;
      column.current.scale.y = Math.max(0.001, next);
      column.current.position.y = h + 1 + next / 2;
      column.current.visible = next > 0.05;
    }
    if (ring.current) {
      ring.current.visible = selected || hovered;
      const s = 1 + Math.sin(clock.elapsedTime * 4) * 0.04;
      ring.current.scale.set(s, s, s);
    }
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    if (!interactive) return;
    e.stopPropagation();
    useSim.getState().hoverStore(store.id);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    if (!interactive) return;
    if (useSim.getState().hoveredStoreId === store.id) useSim.getState().hoverStore(null);
    document.body.style.cursor = "";
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    if (!interactive) return;
    e.stopPropagation();
    useSim.getState().selectStore(store.id);
  };

  const glassH = Math.min(4.2, h * 0.45);
  return (
    <group position={[x, 0, z]} rotation-y={rot} name={`store-${store.id}`}>
      <group onPointerOver={over} onPointerOut={out} onClick={click}>
        <mesh position-y={h / 2} castShadow receiveShadow>
          <boxGeometry args={[width, h, depth]} />
          <meshStandardMaterial color={colors.body} roughness={0.85} />
        </mesh>
        {/* roof lip */}
        <mesh position-y={h + 0.25}>
          <boxGeometry args={[width + 0.5, 0.5, depth + 0.5]} />
          <meshStandardMaterial color={isClub ? "#251f35" : "#9a8f86"} roughness={1} />
        </mesh>
        {/* shop window: the lit facade */}
        <mesh position={[0, 0.4 + glassH / 2, depth / 2 + 0.06]}>
          <boxGeometry args={[width * 0.82, glassH, 0.1]} />
          <meshStandardMaterial ref={glass} color={isClub ? "#1b1626" : "#3a4458"} emissive={isClub ? "#9a6bff" : LAMP} emissiveIntensity={0} roughness={0.25} />
        </mesh>
        {/* awning / club neon strip */}
        {isClub ? (
          <mesh position={[0, h - 1.4, depth / 2 + 0.12]}>
            <boxGeometry args={[width * 0.9, 0.6, 0.15]} />
            <meshStandardMaterial ref={neon} color={colors.awning} emissive={colors.awning} emissiveIntensity={0} />
          </mesh>
        ) : (
          <mesh position={[0, 0.4 + glassH + 0.6, depth / 2 + 1.1]} rotation-x={0.45} castShadow>
            <boxGeometry args={[width * 0.86, 0.18, 2.4]} />
            <meshStandardMaterial color={colors.awning} roughness={0.8} />
          </mesh>
        )}
        {/* OPEN sign */}
        <mesh position={[width * 0.32, 0.4 + glassH + 0.05, depth / 2 + 0.2]}>
          <boxGeometry args={[1.6, 0.6, 0.12]} />
          <meshStandardMaterial ref={sign} color="#7a3b3b" />
        </mesh>
      </group>

      {/* pool of light on the pavement */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.15, depth / 2 + 4]} renderOrder={2}>
        <planeGeometry args={[width * 1.6, 11]} />
        <meshBasicMaterial ref={pool} map={glowTexture()} color={isClub ? "#b88bff" : LAMP} transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>

      {/* occupancy column */}
      <mesh ref={column} position-y={h + 1} visible={false}>
        <cylinderGeometry args={[0.9, 0.9, 1, 12]} />
        <meshStandardMaterial color={LAMP} emissive={LAMP} emissiveIntensity={0.9} transparent opacity={0.85} toneMapped={false} />
      </mesh>

      {/* selection ring */}
      <group ref={ring} visible={false}>
        <mesh rotation-x={-Math.PI / 2} position-y={0.2}>
          <ringGeometry args={[Math.max(width, depth) * 0.75, Math.max(width, depth) * 0.75 + 1.2, 48]} />
          <meshBasicMaterial color={selected ? LAMP : "#ffffff"} transparent opacity={selected ? 0.95 : 0.5} toneMapped={false} />
        </mesh>
      </group>

      {(hovered || selected) && (
        <Html position={[0, h + 4, 0]} center distanceFactor={260} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div className="map-label">
            <span>{colors.icon}</span>
            {store.name}
          </div>
        </Html>
      )}
    </group>
  );
}
