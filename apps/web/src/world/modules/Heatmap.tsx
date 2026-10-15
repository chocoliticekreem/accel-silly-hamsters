// Module: Heatmap. A translucent grid over the ground, toggled from ui/HeatmapToggle (state/economy `heatmap`):
// - footfall: person-minutes on foot per cell over the current day (from the day file's paths);
// - missed: people who walked to a shop and found it shut today (stops at a door with no visit);
// - wealth: shop owners' business + personal balance at the end of the current day, spread around their homes.
// docs/PEOPLE_ECONOMY.md §3: computed in the frontend from day files and /owners; no extra endpoint.
import { useEffect, useMemo, useState } from "react";
import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from "three";
import { api } from "../../api/client";
import type { DayData } from "../../api/contract";
import type { PersonDay } from "../../api/economy";
import { binFootfall, gridMax, makeGrid, shutStops, splat, storeDoors, type Grid } from "../../sim/heatmap";
import { toScene } from "../../sim/geometry";
import { dayOf } from "../../sim/time";
import { load } from "../../state/data";
import { useEconomy, useOwners, type HeatmapLayer } from "../../state/economy";
import { useSim } from "../../state/store";
import { useWorld } from "../context";

const CELL = 10;

/** Colour ramps per layer: [r, g, b] at full strength (alpha follows the value). */
const RAMP: Record<Exclude<HeatmapLayer, null>, { pos: [number, number, number]; neg?: [number, number, number] }> = {
  footfall: { pos: [255, 200, 87] },
  missed: { pos: [255, 110, 96] },
  wealth: { pos: [111, 211, 160], neg: [255, 110, 96] },
};

function texture(g: Grid, layer: Exclude<HeatmapLayer, null>): DataTexture {
  const data = new Uint8Array(g.nx * g.nz * 4);
  const max = gridMax(g);
  const ramp = RAMP[layer];
  for (let k = 0; k < g.v.length; k++) {
    const v = g.v[k] / max;
    const s = Math.min(1, Math.sqrt(Math.abs(v))); // compress: a few busy cells shouldn't wash out the rest
    const c = v < 0 && ramp.neg ? ramp.neg : ramp.pos;
    // hot cells lighten towards white, like a glow
    const w = Math.max(0, s - 0.75) * 2;
    data[k * 4] = c[0] + (255 - c[0]) * w;
    data[k * 4 + 1] = c[1] + (255 - c[1]) * w;
    data[k * 4 + 2] = c[2] + (255 - c[2]) * w;
    data[k * 4 + 3] = s < 0.04 ? 0 : Math.round(40 + 175 * s);
  }
  const tex = new DataTexture(data, g.nx, g.nz, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export default function Heatmap() {
  const layer = useEconomy((s) => s.heatmap);
  return layer ? <HeatmapLayerView layer={layer} /> : null;
}

function HeatmapLayerView({ layer }: { layer: Exclude<HeatmapLayer, null> }) {
  const { map, run } = useWorld();
  const day = useSim((s) => dayOf(s.t));
  const owners = useOwners(layer === "wealth" ? run : null).data;
  const [dayData, setDayData] = useState<DayData | null>(null);
  useEffect(() => {
    if (layer === "wealth") return;
    let alive = true;
    // the same cache entry the Agents module loads, so this costs nothing extra
    void load(`day:${run}:${day}`, () => api.day(run, day)).then((d) => alive && setDayData(d));
    return () => {
      alive = false;
    };
  }, [layer, run, day]);
  const doors = useMemo(() => storeDoors(map), [map]);

  const grid = useMemo(() => {
    const g = makeGrid(map.bounds, CELL, 10);
    if (layer === "wealth") {
      for (const o of owners ?? []) splat(g, o.home.x, o.home.z, (o.business.daily[day - 1] ?? o.business.endGbp) + (o.personal.daily[day - 1] ?? o.personal.endGbp), 3);
      return g;
    }
    if (!dayData) return null;
    const people = (dayData.agents as PersonDay[]).filter((a) => a.role !== "owner");
    if (layer === "footfall") return binFootfall(g, people);
    for (const a of people) for (const s of shutStops(a.path, a.visits, doors)) splat(g, s.x, s.z, 1, 2);
    return g;
  }, [layer, map, owners, day, dayData, doors]);

  const tex = useMemo(() => (grid ? texture(grid, layer) : null), [grid, layer]);
  useEffect(() => () => tex?.dispose(), [tex]);
  if (!grid || !tex) return null;
  const w = grid.nx * grid.cell;
  const d = grid.nz * grid.cell;
  const [cx, cz] = toScene(grid.minX + w / 2, grid.minZ + d / 2);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[cx, 0.35, cz]} renderOrder={5} name={`heatmap-${layer}`} raycast={() => {}}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
