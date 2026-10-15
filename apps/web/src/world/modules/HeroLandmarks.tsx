// Module: HeroLandmarks (decorative). Places the procedural Shoreditch hero landmarks (world/models/landmarks.ts):
// XOYO, art'otel, Encode Hub and Boxpark. Each is built to its real plot (world/models/plots.ts): on its host
// building's footprint (frontage along the street it faces, full depth, matching side walls and roof), or for
// art'otel on its OSM oval + podium footprint in true orientation. The same plots are the keep-outs that stop
// Buildings / Stores / Infill drawing generic boxes inside a landmark.
// Group names are stable (`landmark-xoyo`, `landmark-artotel`, `landmark-encode`, `landmark-boxpark`) so other
// modules (interiors, quick travel) can find and hide them.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { task, type TaskHandle } from "../../state/loading";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import type { HeroModel } from "../models/kit";
import { artotel, BOXPARK_ROW, boxpark, boxparkRows, encodeHub, xoyo } from "../models/landmarks";
import { heroObject, setHeroNight } from "../models/materials";
import { landmarkPlots, type LandmarkPlot } from "../models/plots";

const cache = new Map<string, HeroModel>();

function modelFor(p: LandmarkPlot): HeroModel {
  const id = `${p.key}:${p.w.toFixed(1)}x${p.d.toFixed(1)}`;
  let m = cache.get(id);
  if (!m) {
    m =
      p.key === "xoyo" ? xoyo({ w: p.w, d: p.d })
      : p.key === "encode" ? encodeHub({ w: p.w, d: p.d })
      : p.key === "boxpark" ? boxpark({ len: p.w, depth: p.d })
      : artotel();
    cache.set(id, m);
  }
  return m;
}

type Item = { name: string; object: ReturnType<typeof heroObject>; x: number; z: number; rot: number };

function itemFor(p: LandmarkPlot): Item {
  const object = heroObject(modelFor(p));
  object.name = p.name;
  // Boxpark: 2–3 container rows, stretched in depth to fill a deeper plot
  if (p.key === "boxpark") object.scale.z = p.d / (boxparkRows(p.d) * BOXPARK_ROW);
  const [x, z] = toScene(p.x, p.z);
  return { name: p.name, object, x, z, rot: p.rot };
}

export default function HeroLandmarks() {
  const { map } = useWorld();
  const plots = useMemo(() => landmarkPlots(map), [map]);
  // one model per frame (the art'otel alone is ~56k triangles): start-up never stalls on all four at once
  const [items, setItems] = useState<Item[]>([]);
  /** Built so far (a ref: a frame may run before React has re-rendered with the last one). */
  const list = useRef<Item[]>([]);
  const progress = useRef<TaskHandle | null>(null);
  useEffect(() => {
    progress.current = task("landmarks", "heroes", 2);
    list.current = [];
    setItems([]);
  }, [plots]);

  useFrame(() => {
    setHeroNight(nightLevel(hourOf(useSim.getState().t)));
    if (list.current.length < plots.length) {
      const next = [...list.current, itemFor(plots[list.current.length])];
      list.current = next;
      setItems(next);
      progress.current?.progress(next.length / plots.length);
      if (next.length === plots.length) progress.current?.done();
    } else if (!plots.length) progress.current?.done();
  });

  return (
    <group name="hero-landmarks">
      {items.map((it) => (
        <primitive key={it.name} object={it.object} position={[it.x, 0, it.z]} rotation={[0, it.rot, 0]} />
      ))}
    </group>
  );
}
