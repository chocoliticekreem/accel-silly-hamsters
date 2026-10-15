// Module: MapGround. In "Satellite" / "Map" graphics mode, the real Shoreditch from free keyless tiles as the ground:
// Esri World Imagery, or the OSM-based CARTO basemap (light by day, cross-fading to dark at night). A fixed tile mosaic
// covering the map + a margin is stitched into one texture once (browser-cached, cached here across mode switches),
// placed on the contract frame (freemap/mosaic.ts) so OSM streets and our street polylines coincide.
// Any fetch failure falls back silently to the stylised ground (mode reset for this session only, not remembered).
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { CanvasTexture, Color, SRGBColorSpace, type MeshStandardMaterial } from "three";
import type { Bounds } from "../../api/contract";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { buildMosaic, type Mosaic, type TileSource } from "../freemap/mosaic";
import { useFreeMap } from "../graphics";
import { useWorld } from "../context";

const cache = new Map<string, Promise<Mosaic>>();
const never = new AbortController().signal;
function mosaic(source: TileSource, b: Bounds) {
  const key = `${source}:${b.minX},${b.maxX},${b.minZ},${b.maxZ}`;
  let p = cache.get(key);
  if (!p) {
    p = buildMosaic(source, b, never);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

interface Layer {
  tex: CanvasTexture;
  m: Mosaic;
}

const APRON = { satellite: new Color("#5b6052"), map: new Color("#dcd9d2") };

export default function MapGround() {
  const mode = useSim((s) => s.graphicsMode);
  if (mode !== "satellite" && mode !== "map") return null;
  return <Drape key={mode} kind={mode} />;
}

function Drape({ kind }: { kind: "satellite" | "map" }) {
  const { map } = useWorld();
  const [layers, setLayers] = useState<{ day: Layer; night: Layer | null } | null>(null);

  useEffect(() => {
    let live = true;
    const toLayer = (m: Mosaic): Layer => {
      const tex = new CanvasTexture(m.canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 8;
      return { tex, m };
    };
    const sources: TileSource[] = kind === "satellite" ? ["satellite"] : ["light", "dark"];
    Promise.all(sources.map((s) => mosaic(s, map.bounds)))
      .then((ms) => {
        if (!live) return;
        const [day, night] = ms.map(toLayer);
        setLayers({ day, night: night ?? null });
        useFreeMap.setState({ ready: true });
      })
      .catch((e) => {
        if (!live) return;
        console.warn("[map ground] tiles unavailable, using the stylised ground", e);
        useSim.setState({ graphicsMode: "stylised" }); // not persisted: try again next visit
      });
    return () => {
      live = false;
      useFreeMap.setState({ ready: false });
    };
  }, [kind, map.bounds]);

  useEffect(
    () => () => {
      layers?.day.tex.dispose();
      layers?.night?.tex.dispose();
    },
    [layers],
  );

  const dayMat = useRef<MeshStandardMaterial>(null);
  const nightMat = useRef<MeshStandardMaterial>(null);
  useFrame(() => {
    const night = nightLevel(hourOf(useSim.getState().t));
    // the scene lights dim the photo at night; a little self-light keeps streets readable under the glows
    if (dayMat.current) dayMat.current.emissiveIntensity = kind === "satellite" ? 0.08 + 0.12 * night : 0.05 * night;
    if (nightMat.current) {
      nightMat.current.opacity = night;
      nightMat.current.emissiveIntensity = 0.55 * night;
      nightMat.current.visible = night > 0.01;
    }
  });

  if (!layers) return null;
  const { m } = layers.day;
  const w = m.maxX - m.minX;
  const d = m.maxZ - m.minZ;
  // scene position of the rectangle centre: toScene(x, z) = [x, -z]
  const cx = (m.minX + m.maxX) / 2;
  const cz = -(m.minZ + m.maxZ) / 2;
  return (
    <group name="map-ground">
      <mesh rotation-x={-Math.PI / 2} position={[cx, -0.25, cz]} receiveShadow>
        <planeGeometry args={[w * 8, d * 8]} />
        <meshStandardMaterial color={APRON[kind]} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0.01, cz]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial ref={dayMat} map={layers.day.tex} emissiveMap={layers.day.tex} emissive="#ffffff" color={kind === "map" ? "#d2d2d2" : "#ffffff"} roughness={1} metalness={0} />
      </mesh>
      {layers.night && (
        <mesh rotation-x={-Math.PI / 2} position={[cx, 0.02, cz]} receiveShadow renderOrder={1}>
          <planeGeometry args={[w, d]} />
          <meshStandardMaterial ref={nightMat} map={layers.night.tex} emissiveMap={layers.night.tex} emissive="#ffffff" roughness={1} metalness={0} transparent depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
