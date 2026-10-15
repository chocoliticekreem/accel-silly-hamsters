// Module: Footfall (background crowd). The sim's coloured agents are a sample: per the backend's demand data
// (data/processed/demand.json) one sim agent stands for ~48 real arrivals. This layer draws the rest of those people.
// Each walker makes real trips along the street graph between real places on the map: commuters stream from the
// station and edge streets to offices in the morning and back in the evening, office workers go out for lunch,
// shoppers browse, the evening heads to bars and restaurants, and the club crowd walks to the Night Tube.
// The trip mix follows the sim clock; the head count follows the sim (agents on street × 48).
// Drawn, never counted: KPIs come only from the sim.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { useEffect } from "react";
import { Color } from "three";
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
const MIN_WALKERS = 700;
/** Walking pace (m/s of real time). Faster than life so flows read at a glance. */
const PACE = 3.2;

const KINDS: TripKind[] = ["toWork", "fromWork", "lunch", "shopping", "evening", "nightOut", "through"];
// Cartoon clothing: saturated enough to read against grey pavement from the default camera.
const TONES: Record<TripKind, string[]> = {
  toWork: ["#2f5fb3", "#3d7fe0", "#1f3a68", "#e9e4d8", "#5470a8", "#c0392b"],
  fromWork: ["#2f5fb3", "#3d7fe0", "#1f3a68", "#e9e4d8", "#5470a8", "#c0392b"],
  lunch: ["#e08a2c", "#2fae6a", "#3d7fe0", "#f2c230", "#e0559a"],
  shopping: ["#e0559a", "#f2c230", "#2fae6a", "#ff7f50", "#8e6fd8"],
  evening: ["#a463ff", "#e34b4b", "#f08a2c", "#2fae6a", "#3d7fe0"],
  nightOut: ["#a463ff", "#ff4fd8", "#4fd8ff", "#ffe14f", "#ff6b6b"],
  through: ["#e34b4b", "#3d7fe0", "#2fae6a", "#f2c230", "#e9e4d8", "#8e6fd8"],
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
  trousers: Color;
  skin: Color;
  stride: number;
}

const pt = newPoint();

export default function Footfall() {
  const { map, live } = useWorld();
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
      trousers: TROUSERS[Math.floor(r() * TROUSERS.length)],
      skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)],
      stride: r() * Math.PI * 2,
    }));
    return { walkers, assign };
  }, [map]);

  const people = useMemo(() => createPeople(MAX_WALKERS, { emissive: 0.06 }), []);
  useEffect(() => () => people.dispose(), [people]);

  useFrame(({ clock }, delta) => {
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
      const phase = time * 7 * (w.speed / PACE) + w.stride;
      people.set(k, x, Math.abs(Math.sin(phase)) * 0.06, z, Math.atan2(pt.dx, -pt.dz), phase, true, 2.3, w.color, w.trousers, w.skin);
      k++;
    }
    people.commit(k);
  });

  return <primitive object={people.group} name="footfall" />;
}
