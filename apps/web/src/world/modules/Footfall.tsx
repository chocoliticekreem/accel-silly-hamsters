// Module: Footfall (background crowd). The sim's coloured agents are a sample: per the backend's demand data
// (data/processed/demand.json) one sim agent stands for ~48 real arrivals. This layer draws the rest of those people.
// Each walker makes real trips along the street graph between real places on the map: commuters stream from the
// station and edge streets to offices in the morning and back in the evening, office workers go out for lunch,
// shoppers browse, the evening heads to bars and restaurants, and the club crowd walks to the Night Tube.
// The trip mix follows the sim clock; the head count follows the sim (agents on street × 48).
// Spacing: walkers keep to the pavements of the streets they are on (each on their own line across the pavement),
// leave from any corner near a place rather than one node, stagger their departures, and every frame a spatial
// hash steps anyone who would overlap another person (sim agents included) aside.
// Drawn, never counted: KPIs come only from the sim.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color } from "three";
import type { CityMap } from "../../api/contract";
import { rng, weighted, type Rng } from "../../mock/rng";
import { extendStreets, outerPoint } from "../../sim/edges";
import { createSeparator, obstacles, PAVEMENT_INSET_MAX, PAVEMENT_INSET_MIN, pavementPath, type PavementPath } from "../../sim/crowd";
import { toScene } from "../../sim/geometry";
import { newPoint } from "../../sim/polyline";
import { buildStreetGraph, tripMix, type StreetGraph, type TripKind } from "../../sim/streetGraph";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { stationPulse } from "../stationPulse";

/** Real people per sim agent (demand.json notes: "1 sim agent ~ 48 real arrivals"). */
export const PEOPLE_PER_AGENT = 48;
const MAX_WALKERS = 2400;
/** Floor so a busy London street never looks dead between sim trips. */
const MIN_WALKERS = 700;
/** Walking pace (m/s of real time). Faster than life so flows read at a glance. */
const PACE = 3.2;
/** Figure scale: a 1.75 m person drawn ~3.5 m tall so the crowd reads from the default camera. */
const SCALE = 2;
/** Centre-to-centre spacing between two figures at SCALE (shoulders plus swinging limbs). */
const MIN_GAP = 1.9;
/** Never shove a walker further than this off their line; past it a brief brush beats walking through walls. */
const MAX_PUSH = 1.6;
/** A place's walkers start/finish at any routable node this close to it, not all at the single nearest node. */
const PLACE_RADIUS = 25;
/** A station empties onto every street around it. */
const STATION_RADIUS = 45;
/** First stretch of a trip over which departures are staggered (m). */
const STAGGER = 24;

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

/** A place is a list of candidate street nodes (a building can be reached from several corners). */
type Place = number[];

interface Places {
  entries: Place[];
  station: Place[];
  /** Every node of every station place: trips starting here wait for a train. */
  stationNodes: Set<number>;
  offices: Place[];
  homes: Place[];
  food: Place[];
  shops: Place[];
  night: Place[];
}

function places(map: CityMap, g: StreetGraph): Places {
  const node = (x: number, z: number, radius = PLACE_RADIUS) => g.near(x, z, radius, 3);
  const bNodes = (kinds: string[]) => map.buildings.filter((b) => kinds.includes(b.kind)).map((b) => node(b.x, b.z));
  const storeNodes = (types: string[]) =>
    map.stores
      .filter((s) => types.includes(s.type))
      .flatMap((s) => {
        const b = map.buildings.find((x) => x.id === s.buildingId);
        return b ? [node(b.x, b.z)] : [];
      });
  // street entries lie out in the city beyond the edge (sim/edges.ts): people walk in from and out to there
  const entries = map.entryPoints.map((e) => {
    const far = e.kind === "street" ? outerPoint(map, e.x, e.z) : null;
    return far ? node(far[0], far[1]) : node(e.x, e.z);
  });
  const station = map.entryPoints.filter((e) => e.kind === "station").map((e) => node(e.x, e.z, STATION_RADIUS));
  const nonEmpty = (xs: Place[], fallback: Place[]) => (xs.length ? xs : fallback);
  return {
    entries,
    station: nonEmpty(station, entries),
    stationNodes: new Set(station.flat()),
    offices: nonEmpty(bNodes(["office"]), entries),
    homes: nonEmpty(bNodes(["residential"]), entries),
    food: nonEmpty(storeNodes(["cafe", "restaurant", "takeaway"]), entries),
    shops: nonEmpty(storeNodes(["shop", "offlicence"]), entries),
    night: nonEmpty(storeNodes(["bar", "club"]), entries),
  };
}

/** A random node of a random place. */
const pick = (r: Rng, xs: Place[]) => {
  const place = xs[Math.floor(r() * xs.length)];
  return place[Math.floor(r() * place.length)];
};

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
  path: PavementPath | null;
  s: number;
  /** +1 right-hand pavement, -1 left (re-drawn per trip). */
  side: number;
  /** Metres beyond the kerb: this walker's own line across the pavement (re-drawn per trip). */
  inset: number;
  speed: number;
  color: Color;
  trousers: Color;
  skin: Color;
  stride: number;
  /** Current side-step away from others (scene metres), eased frame to frame so nobody jumps. */
  ox: number;
  oz: number;
  /** Arrived by train: hidden in the station until train number `waitFor` + 1 opens its doors (-1 = not waiting). */
  waitFor: number;
  /** Real seconds spent waiting (a safety valve if no train comes). */
  waited: number;
}

const pt = newPoint();
/** How fast a side-step follows the separator (1/s); lower = smoother, higher = tighter. */
const EASE = 4;

export default function Footfall() {
  const { map, live } = useWorld();
  const shown = useRef(MIN_WALKERS);

  const world = useMemo(() => {
    const g = buildStreetGraph(extendStreets(map));
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
        w.path = pavementPath(route, g.routeWidths(a, b));
        // stagger departures so everyone leaving a busy corner doesn't start on the same spot
        w.s = midway ? r() * w.path.length : r() * Math.min(STAGGER, w.path.length * 0.3);
        w.side = r() < 0.5 ? -1 : 1;
        w.inset = PAVEMENT_INSET_MIN + r() * (PAVEMENT_INSET_MAX - PAVEMENT_INSET_MIN);
        w.color = colors[kind][Math.floor(r() * colors[kind].length)];
        // fresh arrivals by Overground come out of the station when a train stops, then stream out over a few s
        w.waitFor = !midway && stationPulse.active && p.stationNodes.has(a) ? stationPulse.arrivals : -1;
        w.waited = 0;
        if (w.waitFor >= 0) w.s = -r() * 14;
        return;
      }
      w.path = null;
    };

    const walkers: Walker[] = Array.from({ length: MAX_WALKERS }, () => ({
      path: null,
      s: 0,
      side: 1,
      inset: PAVEMENT_INSET_MIN,
      speed: PACE * (0.8 + r() * 0.4),
      color: colors.through[0],
      trousers: TROUSERS[Math.floor(r() * TROUSERS.length)],
      skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)],
      stride: r() * Math.PI * 2,
      ox: 0,
      oz: 0,
      waitFor: -1,
      waited: 0,
    }));
    return { walkers, assign };
  }, [map]);

  const people = useMemo(() => createPeople(MAX_WALKERS, { emissive: 0.06 }), []);
  useEffect(() => () => people.dispose(), [people]);

  // this frame's figures in scene x/z (sim agents first, as fixed obstacles), then heading/phase/walker per figure
  const frame = useMemo(() => {
    const cap = obstacles.xs.length + MAX_WALKERS;
    return {
      xs: new Float32Array(cap),
      zs: new Float32Array(cap),
      heading: new Float32Array(MAX_WALKERS),
      baseX: new Float32Array(MAX_WALKERS),
      roadX: new Float32Array(MAX_WALKERS),
      roadZ: new Float32Array(MAX_WALKERS),
      baseZ: new Float32Array(MAX_WALKERS),
      phase: new Float32Array(MAX_WALKERS),
      who: new Int32Array(MAX_WALKERS),
      sep: createSeparator(cap),
    };
  }, []);

  useFrame(({ clock }, delta) => {
    const hour = hourOf(useSim.getState().t);
    // ease toward the data-driven head count so the crowd swells and thins instead of popping
    const target = Math.min(MAX_WALKERS, Math.max(MIN_WALKERS, live.onStreet * PEOPLE_PER_AGENT));
    shown.current += (target - shown.current) * Math.min(1, delta * 1.5);
    const n = Math.round(shown.current);
    const dt = Math.min(delta, 0.1);
    const time = clock.elapsedTime;
    const f = frame;
    const fixed = obstacles.n;
    f.xs.set(obstacles.xs.subarray(0, fixed));
    f.zs.set(obstacles.zs.subarray(0, fixed));
    let k = 0;
    for (let i = 0; i < n; i++) {
      const w = world.walkers[i];
      if (!w.path) world.assign(w, hour, true);
      if (!w.path) continue;
      if (w.waitFor >= 0) {
        w.waited += dt;
        if (stationPulse.arrivals <= w.waitFor && w.waited < 90 && stationPulse.active) continue;
        w.waitFor = -1;
      }
      w.s += w.speed * dt;
      if (w.s < 0) continue; // still on the stairs
      if (w.s >= w.path.length) {
        world.assign(w, hour, false);
        if (!w.path) continue;
      }
      w.path.at(w.s, w.side, w.inset, pt);
      const [x, z] = toScene(pt.x, pt.z);
      // ask the separator from where this walker already is (path + its current side-step)
      f.xs[fixed + k] = x + w.ox;
      f.zs[fixed + k] = z + w.oz;
      f.baseX[k] = x;
      f.baseZ[k] = z;
      // unit vector pointing from the kerb toward the road, in scene coords (right-normal (dz,-dx) × side, z flipped)
      f.roadX[k] = -w.side * pt.dz;
      f.roadZ[k] = -w.side * pt.dx;
      f.heading[k] = Math.atan2(pt.dx, -pt.dz);
      f.phase[k] = time * 7 * (w.speed / PACE) + w.stride;
      f.who[k] = i;
      k++;
    }
    // step aside: nobody walks through anybody, sim agents included
    f.sep.separate(f.xs, f.zs, fixed + k, MIN_GAP, { fixed, maxPush: MAX_PUSH });
    const ease = Math.min(1, dt * EASE);
    for (let q = 0; q < k; q++) {
      const w = world.walkers[f.who[q]];
      const phase = f.phase[q];
      // glide toward the separated spot instead of snapping to it
      w.ox += (f.xs[fixed + q] - f.baseX[q] - w.ox) * ease;
      w.oz += (f.zs[fixed + q] - f.baseZ[q] - w.oz) * ease;
      // never step toward the road: drop any side-step component pointing at the carriageway
      const toRoad = w.ox * f.roadX[q] + w.oz * f.roadZ[q];
      if (toRoad > 0) {
        w.ox -= toRoad * f.roadX[q];
        w.oz -= toRoad * f.roadZ[q];
      }
      people.set(q, f.baseX[q] + w.ox, Math.abs(Math.sin(phase)) * 0.05, f.baseZ[q] + w.oz, f.heading[q], phase, true, SCALE, w.color, w.trousers, w.skin);
    }
    people.commit(k);
  });

  return <primitive object={people.group} name="footfall" />;
}
