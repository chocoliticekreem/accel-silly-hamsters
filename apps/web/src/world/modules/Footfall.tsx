// Module: Footfall (background crowd). The sim's coloured citizens are a sample: one stands for `peoplePerAgent` real
// people (GET /api/health, from the backend's demand data), and this layer draws the rest of the people on the street.
// How many: the sim's mean count on the street in this hour of this day (GET /api/runs/{run}/footfall) × that scale,
// so the street empties when the sim's does (a weekday 04:00) and fills with its peaks. Nothing without that data.
// Where to: each walker repeats a leg of a sim citizen who is out around now (sim/footfall.ts): from the station or
// a street edge to a shop, between shops, or out of the area, routed along the street graph, and never towards a shop
// that is shut at this moment (storeStateAt: the owner's schedule, closures and today-only changes, as the Stores
// module shows it). So the mix follows the run, the day of the week and the shops' hours. Street entries lie out in
// the city beyond the map edge (sim/edges.ts), and fresh arrivals at the station come out when a train stops
// (world/stationPulse).
// When: on the sim clock. Walkers stand still while it is paused, walk faster (within reason) at 10× and 100×, and
// swap to a current trip once theirs is an hour of sim time (or a few seconds of playback) away from the clock.
// Spacing: walkers keep to the pavements of the streets they are on (each on their own line across the pavement),
// leave from any corner near a place rather than one node, stagger their departures, and every frame a spatial
// hash asks anyone who would overlap another person (sim agents included) to step aside; the side-step eases in with
// the clock and never points at the road.
// Shirts are neutral warm greys, unlike any persona colour, so the decoration never reads as sim data.
// Drawn, never counted: KPIs come only from the sim.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color } from "three";
import type { OwnerEvent, RunStores } from "../../api/contract";
import { rng, type Rng } from "../../mock/rng";
import { extendStreets, outerPoint } from "../../sim/edges";
import { createSeparator, obstacles, PAVEMENT_INSET_MAX, PAVEMENT_INSET_MIN, pavementPath, type PavementPath } from "../../sim/crowd";
import { clockSeconds, crowdSize, legIsStale, legsAround, legsOf, pickOpenLeg, walkStep, type ActiveLegs, type Leg } from "../../sim/footfall";
import { toScene } from "../../sim/geometry";
import { newPoint } from "../../sim/polyline";
import { eventsByStore, storeStateAt } from "../../sim/storeState";
import { buildStreetGraph } from "../../sim/streetGraph";
import { dayOf } from "../../sim/time";
import { useDayAgents, useFootfall, useHealth, useOwnerEvents } from "../../state/data";
import { RATE, useSim } from "../../state/store";
import { useWorld } from "../context";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";
import { stationPulse } from "../stationPulse";

/**
 * Background-crowd shirts, kept here rather than in world/palette.ts: warm, low-chroma greys. They are unlike every
 * persona colour (saturated hues plus the cool grey-blue of passers-by), so a drawn person never passes for sim data.
 */
export const CROWD_TONES = ["#8c867e", "#a19b92", "#b4aea4", "#77726c", "#c6c0b6"];
const MAX_WALKERS = 2400;
/** Walking pace on screen at 1× (m per real second), faster than life so flows read at a glance. */
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
/** A walker takes a leg a sim citizen walks within this many sim minutes of the clock. */
const WINDOW = 30;
/**
 * A walker keeps its leg until the leg is HOLD_MIN sim minutes, or HOLD_S seconds of playback, away from the clock,
 * whichever is longer. The sim's trips last ~9 minutes, a quarter of a second at 10×: holding them any tighter makes
 * the crowd jump about, any looser lets its mix lag the clock.
 */
const HOLD_MIN = 60;
const HOLD_S = 4;
/** Walk-cycle radians per metre walked, so legs swing only while walkers move. */
const STRIDE = 2.2;
/** How fast a side-step follows the separator (1/s of playback); lower = smoother, higher = tighter. */
const EASE = 4;
/** Longest wait for a train (s of playback) before a station arrival walks out anyway. */
const MAX_TRAIN_WAIT = 90;

interface Walker {
  path: PavementPath | null;
  /** The sim citizen's leg this walker repeats. */
  leg: Leg | null;
  /** The run `leg` belongs to: switching runs re-plans everyone. */
  run: number | null;
  s: number;
  /** +1 right-hand pavement, -1 left (re-drawn per trip). */
  side: number;
  /** Metres beyond the kerb: this walker's own line across the pavement (re-drawn per trip). */
  inset: number;
  /** Personal pace, a factor around PACE. */
  pace: number;
  phase: number;
  color: Color;
  trousers: Color;
  skin: Color;
  /** Current side-step away from others (scene metres), eased frame to frame so nobody jumps. */
  ox: number;
  oz: number;
  /** Arrived by train: hidden in the station until train number `waitFor` + 1 opens its doors (-1 = not waiting). */
  waitFor: number;
  /** Playback seconds spent waiting (a safety valve if no train comes). */
  waited: number;
}

interface Seen {
  t: number | null;
  minute: number;
  legs: Leg[] | null;
  stores: RunStores | undefined;
  byStore: Map<string, OwnerEvent[]> | null;
  active: ActiveLegs;
}

/** Street nodes a walker may leave from or arrive at for one place, and whether the place is a station. */
interface PlaceNodes {
  nodes: number[];
  station: boolean;
}

/** A routed trip, and the stretch of it (metres along) that lies inside the map: the rest is the city beyond the edge. */
interface Trip {
  path: PavementPath;
  inStart: number;
  inEnd: number;
}

const pt = newPoint();
const pick = (r: Rng, xs: number[]) => xs[Math.floor(r() * xs.length)];
const NO_EVENTS: OwnerEvent[] = [];

/** Fills `shut` with the shops not open at `t`, by the rules the Stores module draws them with (no results = shut). */
function markShut(shut: Set<string>, ids: string[], stores: RunStores | undefined, byStore: Map<string, OwnerEvent[]>, t: number) {
  shut.clear();
  for (const id of ids) {
    const cfg = stores?.[id];
    if (!cfg || !storeStateAt(cfg, byStore.get(id) ?? NO_EVENTS, t).open) shut.add(id);
  }
}

export default function Footfall() {
  const { map, run, stores } = useWorld();
  const storeIds = useMemo(() => map.stores.map((s) => s.id), [map]);
  const day = useSim((s) => dayOf(s.t));
  const agents = useDayAgents(run, day);
  const legs = useMemo(() => legsOf(agents), [agents]);
  const foot = useFootfall(run).data;
  // the previous run's table stays loaded while this run's arrives: never draw one run's crowd in another
  const table = foot && foot.run === run ? foot.onStreetByDayHour : null;
  const scale = useHealth().data?.peoplePerAgent ?? 0;
  const owner = useOwnerEvents(run).data;
  const byStore = useMemo(() => eventsByStore(owner ?? []), [owner]);

  const world = useMemo(() => {
    const g = buildStreetGraph(extendStreets(map));
    const r = rng(11);
    const near = new Map<string, PlaceNodes>();
    /** Where a walker leaves from or arrives at for a place at (x, z): a station empties onto every street around it, a street entry lies out in the city. */
    const placeNodes = (x: number, z: number) => {
      const key = `${Math.round(x)},${Math.round(z)}`;
      let place = near.get(key);
      if (!place) {
        const entry = map.entryPoints.find((e) => Math.hypot(e.x - x, e.z - z) < 5);
        const far = entry?.kind === "street" ? outerPoint(map, entry.x, entry.z) : null;
        const station = entry?.kind === "station";
        place = { nodes: far ? g.near(far[0], far[1], PLACE_RADIUS, 3) : g.near(x, z, station ? STATION_RADIUS : PLACE_RADIUS, 3), station };
        near.set(key, place);
      }
      return place;
    };
    const { minX, maxX, minZ, maxZ } = map.bounds;
    const trips = new Map<number, Trip | null>();
    const tripBetween = (a: number, b: number) => {
      const key = a * g.nodes.length + b;
      let trip = trips.get(key);
      if (trip === undefined) {
        const route = a === b ? [] : g.route(a, b);
        trip = null;
        if (route.length >= 2) {
          let along = 0;
          let inStart = -1;
          let inEnd = 0;
          route.forEach(([x, z], i) => {
            if (i > 0) along += Math.hypot(x - route[i - 1][0], z - route[i - 1][1]);
            if (x < minX || x > maxX || z < minZ || z > maxZ) return;
            if (inStart < 0) inStart = along;
            inEnd = along;
          });
          const path = pavementPath(route, g.routeWidths(a, b));
          trip = inStart < 0 || inEnd <= inStart ? { path, inStart: 0, inEnd: path.length } : { path, inStart, inEnd };
        }
        trips.set(key, trip);
      }
      return trip;
    };
    /** Shops shut at the clock's current minute (refreshed with the active legs). */
    const shut = new Set<string>();

    /**
     * Give a walker a leg a sim citizen of `run` is walking around now. midway = somewhere along its stretch inside the
     * map (a person on the street right now), else setting off from its start (out in the city for a street entry).
     */
    const assign = (w: Walker, active: ActiveLegs, run: number, midway: boolean) => {
      w.path = null;
      w.leg = null;
      w.run = run;
      for (let tries = 0; tries < 4; tries++) {
        const leg = pickOpenLeg(active, shut, r);
        if (!leg) return;
        const from = placeNodes(leg.ax, leg.az);
        const trip = tripBetween(pick(r, from.nodes), pick(r, placeNodes(leg.bx, leg.bz).nodes));
        if (!trip) continue;
        const { path } = trip;
        w.path = path;
        w.leg = leg;
        // stagger departures so everyone leaving a busy corner doesn't start on the same spot
        w.s = midway ? trip.inStart + r() * (trip.inEnd - trip.inStart) : r() * Math.min(STAGGER, path.length * 0.3);
        w.side = r() < 0.5 ? -1 : 1;
        w.inset = PAVEMENT_INSET_MIN + r() * (PAVEMENT_INSET_MAX - PAVEMENT_INSET_MIN);
        w.ox = 0;
        w.oz = 0;
        // fresh arrivals by Overground come out of the station when a train stops, then stream out over a few s
        w.waitFor = !midway && stationPulse.active && from.station ? stationPulse.arrivals : -1;
        w.waited = 0;
        if (w.waitFor >= 0) w.s = -r() * 14;
        return;
      }
    };

    const tones = CROWD_TONES.map((c) => new Color(c));
    const walkers: Walker[] = Array.from({ length: MAX_WALKERS }, () => ({
      path: null,
      leg: null,
      run: null,
      s: 0,
      side: 1,
      inset: PAVEMENT_INSET_MIN,
      pace: 0.8 + r() * 0.4,
      phase: r() * Math.PI * 2,
      color: tones[Math.floor(r() * tones.length)],
      trousers: TROUSERS[Math.floor(r() * TROUSERS.length)],
      skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)],
      ox: 0,
      oz: 0,
      waitFor: -1,
      waited: 0,
    }));
    return { walkers, assign, shut };
  }, [map]);

  const people = useMemo(() => createPeople(MAX_WALKERS, { emissive: 0.06 }), []);
  useEffect(() => () => people.dispose(), [people]);

  // this frame's figures in scene x/z (sim agents first, as fixed obstacles), then per walker: its spot on the path,
  // which way the road is, heading, phase and which walker it is
  const frame = useMemo(() => {
    const cap = obstacles.xs.length + MAX_WALKERS;
    return {
      xs: new Float32Array(cap),
      zs: new Float32Array(cap),
      baseX: new Float32Array(MAX_WALKERS),
      baseZ: new Float32Array(MAX_WALKERS),
      roadX: new Float32Array(MAX_WALKERS),
      roadZ: new Float32Array(MAX_WALKERS),
      heading: new Float32Array(MAX_WALKERS),
      phase: new Float32Array(MAX_WALKERS),
      who: new Int32Array(MAX_WALKERS),
      sep: createSeparator(cap),
    };
  }, []);

  // the clock as last seen; the legs on the street and the shut shops around it (refreshed once per sim minute)
  const seen = useRef<Seen>({ t: null, minute: -1, legs: null, stores: undefined, byStore: null, active: { legs: [], cum: [] } });

  useFrame(() => {
    const { t, playing, speed } = useSim.getState();
    const c = seen.current;
    const dtSim = playing && c.t !== null ? t - c.t : 0;
    const secs = clockSeconds(dtSim, RATE[speed]);
    const step = walkStep(dtSim, RATE[speed], RATE[1], PACE);
    c.t = t;
    const { walkers, assign, shut } = world;
    const minute = Math.floor(t);
    if (minute !== c.minute || legs !== c.legs || stores !== c.stores || byStore !== c.byStore) {
      c.active = legsAround(legs, t, WINDOW);
      markShut(shut, storeIds, stores, byStore, t);
      Object.assign(c, { minute, legs, stores, byStore });
    }
    const hold = Math.max(HOLD_MIN, RATE[speed] * HOLD_S);

    const n = table ? crowdSize(table, t, scale, MAX_WALKERS) : 0;
    const f = frame;
    const fixed = obstacles.n;
    f.xs.set(obstacles.xs.subarray(0, fixed));
    f.zs.set(obstacles.zs.subarray(0, fixed));
    let k = 0;
    for (let i = 0; i < n; i++) {
      const w = walkers[i];
      // a leg from another run, too far from the clock, or heading into a shop that just shut
      if (w.run !== run || legIsStale(w.leg, t, hold, shut)) assign(w, c.active, run, true);
      if (!w.path) continue;
      if (w.waitFor >= 0) {
        w.waited += secs;
        if (stationPulse.arrivals <= w.waitFor && w.waited < MAX_TRAIN_WAIT && stationPulse.active) continue;
        w.waitFor = -1;
      }
      const d = step * w.pace;
      w.s += d;
      w.phase += d * STRIDE;
      if (w.s < 0) continue; // still on the station stairs
      if (w.s >= w.path.length) {
        assign(w, c.active, run, false);
        if (!w.path || w.waitFor >= 0 || w.s < 0) continue;
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
      f.phase[k] = w.phase;
      f.who[k] = i;
      k++;
    }
    // step aside: nobody walks through anybody, sim agents included
    f.sep.separate(f.xs, f.zs, fixed + k, MIN_GAP, { fixed, maxPush: MAX_PUSH });
    // side-steps ease in with playback time, so a paused frame leaves everyone exactly where they were
    const ease = Math.min(1, secs * EASE);
    const moving = step > 0;
    for (let q = 0; q < k; q++) {
      const w = walkers[f.who[q]];
      if (ease > 0) {
        // glide toward the separated spot instead of snapping to it
        w.ox += (f.xs[fixed + q] - f.baseX[q] - w.ox) * ease;
        w.oz += (f.zs[fixed + q] - f.baseZ[q] - w.oz) * ease;
        // never step toward the road: drop any side-step component pointing at the carriageway
        const toRoad = w.ox * f.roadX[q] + w.oz * f.roadZ[q];
        if (toRoad > 0) {
          w.ox -= toRoad * f.roadX[q];
          w.oz -= toRoad * f.roadZ[q];
        }
      }
      const phase = f.phase[q];
      people.set(q, f.baseX[q] + w.ox, moving ? Math.abs(Math.sin(phase)) * 0.05 : 0, f.baseZ[q] + w.oz, f.heading[q], phase, moving, SCALE, w.color, w.trousers, w.skin);
    }
    people.commit(k);
  });

  return <primitive object={people.group} name="footfall" />;
}
