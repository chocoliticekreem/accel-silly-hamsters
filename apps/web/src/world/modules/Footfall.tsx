// Module: Footfall (background crowd). The sim's coloured agents are a sample: per the backend's demand data
// (data/processed/demand.json) one sim agent stands for ~48 real arrivals. This layer draws the rest of those people.
// Each walker makes real trips along the street graph between real places on the map: commuters stream from the
// station and edge streets to offices in the morning and back in the evening, office workers go out for lunch,
// shoppers browse, the evening heads to bars and restaurants, and the club crowd walks to the Night Tube.
// The trip mix follows the sim clock; the head count follows the sim (agents on street × 48).
// Drawn, never counted: KPIs come only from the sim.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { CapsuleGeometry, Color, DynamicDrawUsage, MeshStandardMaterial, Object3D, type InstancedMesh } from "three";
import type { CityMap } from "../../api/contract";
import { rng, weighted, type Rng } from "../../mock/rng";
import { toScene } from "../../sim/geometry";
import { newPoint, polyline, type Polyline } from "../../sim/polyline";
import { buildStreetGraph, tripMix, type StreetGraph, type TripKind } from "../../sim/streetGraph";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";

/** Real people per sim agent (demand.json notes: "1 sim agent ~ 48 real arrivals"). */
export const PEOPLE_PER_AGENT = 48;
const MAX_WALKERS = 2400;
/** Floor so a busy London street never looks dead between sim trips. */
const MIN_WALKERS = 260;
/** Walking pace (m/s of real time). Faster than life so flows read at a glance. */
const PACE = 3.2;

const KINDS: TripKind[] = ["toWork", "fromWork", "lunch", "shopping", "evening", "nightOut", "through"];
const TONES: Record<TripKind, string[]> = {
  toWork: ["#5d6b82", "#7d8aa1", "#4f5a6e", "#8c96a8", "#6b778c", "#c9c2b4"],
  fromWork: ["#5d6b82", "#7d8aa1", "#4f5a6e", "#8c96a8", "#6b778c", "#c9c2b4"],
  lunch: ["#7a8698", "#a8a092", "#5f6b7d", "#c2b8a6"],
  shopping: ["#b98c7a", "#a3a8b5", "#8e7f9c", "#c9b38f", "#7f9c8e"],
  evening: ["#8a6f86", "#5e6f8f", "#a07a62", "#6d8a7a", "#9a8fb0"],
  nightOut: ["#7d5f9a", "#4f5f8c", "#9a5f7d", "#3f6f8a", "#b06f8f"],
  through: ["#9aa3b2", "#b7aea3", "#7f8794", "#a59a8e", "#c4c9d1"],
};

interface Places {
  entries: number[];
  station: number[];
  offices: number[];
  homes: number[];
  food: number[];
  shops: number[];
  night: number[];
}

function places(map: CityMap, g: StreetGraph): Places {
  const node = (x: number, z: number) => g.nearest(x, z);
  const bNodes = (kinds: string[]) => map.buildings.filter((b) => kinds.includes(b.kind)).map((b) => node(b.x, b.z));
  const storeNodes = (types: string[]) =>
    map.stores
      .filter((s) => types.includes(s.type))
      .flatMap((s) => {
        const b = map.buildings.find((x) => x.id === s.buildingId);
        return b ? [node(b.x, b.z)] : [];
      });
  const entries = map.entryPoints.map((e) => node(e.x, e.z));
  const station = map.entryPoints.filter((e) => e.kind === "station").map((e) => node(e.x, e.z));
  const nonEmpty = (xs: number[], fallback: number[]) => (xs.length ? xs : fallback);
  return {
    entries,
    station: nonEmpty(station, entries),
    offices: nonEmpty(bNodes(["office"]), entries),
    homes: nonEmpty(bNodes(["residential"]), entries),
    food: nonEmpty(storeNodes(["cafe", "restaurant", "takeaway"]), entries),
    shops: nonEmpty(storeNodes(["shop", "offlicence"]), entries),
    night: nonEmpty(storeNodes(["bar", "club"]), entries),
  };
}

const pick = (r: Rng, xs: number[]) => xs[Math.floor(r() * xs.length)];

/** Origin and destination nodes for a trip of this kind. */
function endsFor(kind: TripKind, p: Places, r: Rng): [number, number] {
  const arrive = () => (r() < 0.6 ? pick(r, p.station) : pick(r, p.entries));
  switch (kind) {
    case "toWork":
      return [arrive(), pick(r, p.offices)];
    case "fromWork":
      return [pick(r, p.offices), arrive()];
    case "lunch":
      return r() < 0.5 ? [pick(r, p.offices), pick(r, p.food)] : [pick(r, p.food), pick(r, p.offices)];
    case "shopping":
      return [r() < 0.5 ? pick(r, p.homes) : arrive(), pick(r, r() < 0.6 ? p.shops : p.food)];
    case "evening":
      return [arrive(), pick(r, r() < 0.5 ? p.night : p.food)];
    case "nightOut":
      return [pick(r, p.night), r() < 0.7 ? pick(r, p.station) : pick(r, p.entries)];
    default:
      return [pick(r, p.entries), pick(r, p.entries)];
  }
}

interface Walker {
  path: Polyline | null;
  s: number;
  side: number;
  speed: number;
  color: Color;
}

const o = new Object3D();
const pt = newPoint();

export default function Footfall() {
  const { map, live } = useWorld();
  const mesh = useRef<InstancedMesh>(null);
  const shown = useRef(MIN_WALKERS);

  const world = useMemo(() => {
    const g = buildStreetGraph(map.streets);
    const p = places(map, g);
    const r = rng(11);
    const colors = Object.fromEntries(KINDS.map((k) => [k, TONES[k].map((c) => new Color(c))])) as Record<TripKind, Color[]>;

    /** Give a walker a new trip chosen by the current hour's mix. */
    const assign = (w: Walker, hour: number, midway: boolean) => {
      const mix = tripMix(hour);
      const kind = KINDS[weighted(r, KINDS.map((k) => mix[k]))] ?? "through";
      for (let tries = 0; tries < 4; tries++) {
        const [a, b] = endsFor(kind, p, r);
        const route = a === b ? [] : g.route(a, b);
        if (route.length < 2) continue;
        w.path = polyline(route);
        w.s = midway ? r() * w.path.length : 0;
        w.color = colors[kind][Math.floor(r() * colors[kind].length)];
        return;
      }
      w.path = null;
    };

    const walkers: Walker[] = Array.from({ length: MAX_WALKERS }, () => ({
      path: null,
      s: 0,
      // pavement: clear of the carriageway on 8–14 m streets
      side: (r() < 0.5 ? -1 : 1) * (6 + r() * 1.6),
      speed: PACE * (0.8 + r() * 0.4),
      color: colors.through[0],
    }));
    return { walkers, assign };
  }, [map]);

  const { geo, mat } = useMemo(
    () => ({ geo: new CapsuleGeometry(0.42, 0.9, 3, 6).translate(0, 0.9, 0), mat: new MeshStandardMaterial({ roughness: 0.85 }) }),
    [],
  );

  useFrame(({ clock }, delta) => {
    const m = mesh.current;
    if (!m) return;
    const hour = hourOf(useSim.getState().t);
    // ease toward the data-driven head count so the crowd swells and thins instead of popping
    const target = Math.min(MAX_WALKERS, Math.max(MIN_WALKERS, live.onStreet * PEOPLE_PER_AGENT));
    shown.current += (target - shown.current) * Math.min(1, delta * 1.5);
    const n = Math.round(shown.current);
    const dt = Math.min(delta, 0.1);
    const time = clock.elapsedTime;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const w = world.walkers[i];
      if (!w.path) world.assign(w, hour, true);
      if (!w.path) continue;
      w.s += w.speed * dt;
      if (w.s >= w.path.length) {
        world.assign(w, hour, false);
        if (!w.path) continue;
      }
      w.path.at(w.s, w.side, pt);
      const [x, z] = toScene(pt.x, pt.z);
      o.position.set(x, Math.abs(Math.sin(time * 9 + i)) * 0.12, z);
      o.rotation.set(0, Math.atan2(pt.dx, -pt.dz), 0);
      o.scale.setScalar(1.75);
      o.updateMatrix();
      m.setMatrixAt(k, o.matrix);
      m.setColorAt(k, w.color);
      k++;
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={(m) => {
        mesh.current = m;
        if (m) {
          m.instanceMatrix.setUsage(DynamicDrawUsage);
          m.setColorAt(0, new Color());
          m.count = 0;
        }
      }}
      args={[geo, mat, MAX_WALKERS]}
      frustumCulled={false}
      name="footfall"
    />
  );
}
