// Mock simulation: persona agents live 14 days on the street grid, choosing open, lit stores.
// Decisions are seeded per (day, agent), so two runs differ only because store configs differ (fixed seed rule).
// KPIs are computed from the generated visits, so what you see in 3D matches the numbers in the HUD.
// Owners adapt day by day (mock/owners.ts): opening, lighting and energy follow each owner's evolving schedule.
import type { AgentDay, CityMap, DayData, LightLevel, OwnerEvent, PathKey, RunDay, RunKpis, RunStores, StoreKpis, StoreType, StoreVisit, StreetEvent } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";
import { frontage } from "../sim/geometry";
import type { RunConfig } from "./configs";
import { H_STREETS, V_STREETS } from "./map";
import { aggregateDaily } from "./daily";
import { OwnerBook, type DayStats } from "./owners";
import { generateStreetEvents, storeStreets } from "./streetEvents";
import { between, intBetween, pick, rng, seedOf, weighted, type Rng } from "./rng";

export const WALK_M_PER_MIN = 45; // an amble, not a commute sprint

// ---------- personas ----------

export type Persona = "commuter" | "resident" | "student" | "shopper" | "night-owl" | "tourist" | "foodie" | "passer-by";

type Prefs = Partial<Record<StoreType, number>>;

const NIGHT_FACTOR = [0.3, 0.3, 0.45, 0.7, 1, 1, 0.4]; // Mon..Sun (Day 1 = Monday)
const dow = (day: number) => (day - 1) % 7;
const isWeekend = (day: number) => dow(day) >= 5;

export { LIGHT_KWH } from "./owners";

// ---------- network: everyone walks the sidewalks of the street grid ----------

/** A point attached to a street line: on a north-south street at X ("v") or an east-west street at Z ("h"). */
interface Loc {
  x: number;
  z: number;
  axis: "v" | "h";
  line: number;
}

const vWidth = new Map(V_STREETS.map((s) => [s.x, s.width]));
const hWidth = new Map(H_STREETS.map((s) => [s.z, s.width]));

interface Walker {
  /** +1 / -1: which sidewalk this agent prefers on each axis. */
  sx: number;
  sz: number;
}

function sideX(w: Walker, X: number) {
  return X + w.sx * ((vWidth.get(X) ?? 10) / 2 + 2);
}
function sideZ(w: Walker, Z: number) {
  return Z + w.sz * ((hWidth.get(Z) ?? 10) / 2 + 2);
}

function nearestLine(lines: number[], a: number, b: number) {
  let best = lines[0];
  for (const l of lines) if (Math.abs(a - l) + Math.abs(b - l) < Math.abs(a - best) + Math.abs(b - best)) best = l;
  return best;
}
const VX = V_STREETS.map((s) => s.x);
const HZ = H_STREETS.map((s) => s.z);

/** Waypoints from a to b (contract coords), Manhattan-style along sidewalks. */
function route(w: Walker, a: Loc, b: Loc): [number, number][] {
  const pts: [number, number][] = [[a.x, a.z]];
  const proj = (l: Loc): [number, number] => (l.axis === "v" ? [sideX(w, l.line), l.z] : [l.x, sideZ(w, l.line)]);
  pts.push(proj(a));
  if (a.axis === "v" && b.axis === "v") {
    if (a.line !== b.line) {
      const Z = nearestLine(HZ, a.z, b.z);
      pts.push([sideX(w, a.line), sideZ(w, Z)], [sideX(w, b.line), sideZ(w, Z)]);
    }
  } else if (a.axis === "h" && b.axis === "h") {
    if (a.line !== b.line) {
      const X = nearestLine(VX, a.x, b.x);
      pts.push([sideX(w, X), sideZ(w, a.line)], [sideX(w, X), sideZ(w, b.line)]);
    }
  } else if (a.axis === "v") {
    pts.push([sideX(w, a.line), sideZ(w, b.line)]);
  } else {
    pts.push([sideX(w, b.line), sideZ(w, a.line)]);
  }
  pts.push(proj(b), [b.x, b.z]);
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.05);
}

// ---------- context ----------

interface StorePlace {
  id: string;
  /** Index into map.stores (and the owner book). */
  idx: number;
  type: StoreType;
  loc: Loc;
  area: number;
  streetId: string;
}

interface Ctx {
  map: CityMap;
  cfg: RunConfig;
  /** The owners: what each shop's hours and lights are at any minute of this run. */
  book: OwnerBook;
  /** streetId → footfall factor windows from street events (roadworks, heavy traffic). */
  streetCuts: Map<string, { fromT: number; toT: number; factor: number }[]>;
  /** storeId → people who walked over and found it shut, by hour of day (14-day total). */
  missed: Map<string, number[]>;
  /** The same, for the day being simulated (what each owner reads that evening). */
  missedToday: Map<string, number[]>;
  stores: StorePlace[];
  byId: Map<string, StorePlace>;
  homes: Loc[];
  offices: Loc[];
  entries: Loc[];
  station: Loc;
}

function buildingLoc(map: CityMap, buildingId: string): Loc {
  const b = map.buildings.find((x) => x.id === buildingId)!;
  const f = frontage(b, map.streets);
  const [[sx, sz], [ex, ez]] = [f.street.points[0], f.street.points[f.street.points.length - 1]];
  const vertical = Math.abs(ex - sx) < Math.abs(ez - sz);
  return { x: f.doorX, z: f.doorZ, axis: vertical ? "v" : "h", line: vertical ? sx : sz };
}

const ctxCache = new WeakMap<CityMap, Omit<Ctx, "cfg" | "missed" | "missedToday" | "book" | "streetCuts">>();

function context(map: CityMap, cfg: RunConfig, street: StreetEvent[], run: number): Ctx {
  let base = ctxCache.get(map);
  if (!base) {
    const streets = storeStreets(map);
    const stores = map.stores.map((s, idx) => {
      const b = map.buildings.find((x) => x.id === s.buildingId)!;
      return { id: s.id, idx, type: s.type, loc: buildingLoc(map, s.buildingId), area: b.w * b.d, streetId: streets.get(s.id) ?? "" };
    });
    const entries: Loc[] = map.entryPoints.map((e) =>
      e.kind === "station" || Math.abs(e.z) >= Math.abs(e.x)
        ? { x: e.x, z: e.z, axis: "v", line: e.x }
        : { x: e.x, z: e.z, axis: "h", line: e.z },
    );
    base = {
      map,
      stores,
      byId: new Map(stores.map((s) => [s.id, s])),
      homes: map.buildings.filter((b) => b.kind === "residential").map((b) => buildingLoc(map, b.id)),
      offices: map.buildings.filter((b) => b.kind === "office").map((b) => buildingLoc(map, b.id)),
      entries: entries.filter((_, i) => map.entryPoints[i].kind === "street"),
      station: entries[map.entryPoints.findIndex((e) => e.kind === "station")],
    };
    ctxCache.set(map, base);
  }
  const streetCuts = new Map<string, { fromT: number; toT: number; factor: number }[]>();
  for (const e of street) {
    if (!e.streetId || (e.kind !== "roadworks" && e.kind !== "heavy_traffic")) continue;
    // roadworks: fewer people can get to the doors; heavy traffic: slower walking, fewer stops
    const factor = e.kind === "roadworks" ? 1 - e.severity : 1 - 0.5 * e.severity;
    streetCuts.set(e.streetId, [...(streetCuts.get(e.streetId) ?? []), { fromT: e.fromT, toT: e.toT, factor }]);
  }
  return { ...base, cfg, book: new OwnerBook(map, cfg, street, run), streetCuts, missed: new Map(), missedToday: new Map() };
}

// ---------- store rules ----------

function isOpen(ctx: Ctx, s: StorePlace, t: number) {
  return ctx.book.isOpen(ctx.book.shops[s.idx], t);
}

function minutesToClose(ctx: Ctx, s: StorePlace, t: number) {
  return ctx.book.minutesToClose(ctx.book.shops[s.idx], t);
}

function lightAt(ctx: Ctx, s: StorePlace, t: number): LightLevel {
  return ctx.book.light(ctx.book.shops[s.idx], t);
}

/** Street events cutting how many people reach a door on this street at t. */
function streetFactor(ctx: Ctx, s: StorePlace, t: number) {
  const cuts = ctx.streetCuts.get(s.streetId);
  if (!cuts) return 1;
  let f = 1;
  for (const c of cuts) if (t >= c.fromT && t < c.toT) f *= c.factor;
  return f;
}

function isDark(t: number) {
  const h = (((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60;
  return h >= 19 || h < 7;
}

/** A lit shop is more likely to be chosen at night; light does nothing by day (that's wasted kWh). */
function lightFactor(level: LightLevel, t: number) {
  if (!isDark(t)) return 1;
  return level === "high" ? 1.35 : level === "low" ? 1.1 : 0.3;
}

const STAY: Record<StoreType, [number, number]> = {
  cafe: [15, 35],
  restaurant: [45, 90],
  takeaway: [8, 20],
  bar: [40, 110],
  shop: [10, 30],
  offlicence: [4, 10],
  club: [120, 300],
};

// ---------- one agent's day ----------

interface Memory {
  affinity: Map<string, number>;
}

interface Agent {
  id: string;
  persona: Persona;
  returning: boolean;
  walker: Walker;
  path: PathKey[];
  visits: StoreVisit[];
  memory?: Memory;
  /** Current position and time. */
  at: Loc;
  t: number;
}

function startAgent(id: string, persona: Persona, returning: boolean, at: Loc, t: number, r: Rng, memory?: Memory): Agent {
  return { id, persona, returning, walker: { sx: r() < 0.5 ? 1 : -1, sz: r() < 0.5 ? 1 : -1 }, path: [[round(t), round(at.x), round(at.z)]], visits: [], memory, at, t };
}

function walkTo(a: Agent, to: Loc) {
  const pts = route(a.walker, a.at, to);
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    a.t += d / WALK_M_PER_MIN;
    a.path.push([round(a.t), round(pts[i][0]), round(pts[i][1])]);
  }
  a.at = to;
}

/** Window-shopping: wander to a random point on a random street. */
function stroll(a: Agent, r: Rng) {
  const vertical = r() < 0.5;
  const line = vertical ? pick(r, VX) : pick(r, HZ);
  const along = between(r, -200, 200);
  walkTo(a, vertical ? { x: line, z: along, axis: "v", line } : { x: along, z: line, axis: "h", line });
}

function wait(a: Agent, minutes: number) {
  a.t += minutes;
  a.path.push([round(a.t), round(a.at.x), round(a.at.z)]);
}

interface Choice {
  prefs: Prefs;
  /** Weight of "go nowhere" — lower = more eager. */
  outside: number;
  maxDist?: number;
}

/** Picks a store and walks there. Returns true if the agent got in (store open on arrival). */
function visitOne(ctx: Ctx, a: Agent, choice: Choice, r: Rng, stayScale = 1): boolean {
  const candidates = ctx.stores.filter((s) => (choice.prefs[s.type] ?? 0) > 0);
  const weights = candidates.map((s) => {
    const d = Math.hypot(s.loc.x - a.at.x, s.loc.z - a.at.z);
    if (choice.maxDist && d > choice.maxDist) return 0;
    const arrive = a.t + d / WALK_M_PER_MIN;
    const open = isOpen(ctx, s, arrive);
    // strangers can't know hours (they go by the lights); regulars mostly remember
    const knowsHours = a.memory ? 0.85 : 0.2;
    const openW = open ? 1 : 1 - knowsHours;
    const mem = a.memory?.affinity.get(s.id) ?? 1;
    return (choice.prefs[s.type] ?? 0) * Math.exp(-d / 160) * lightFactor(lightAt(ctx, s, arrive), arrive) * openW * mem * streetFactor(ctx, s, arrive);
  });
  const i = weighted(r, [...weights, choice.outside]);
  if (i < 0 || i >= candidates.length) return false;
  const s = candidates[i];
  walkTo(a, s.loc);
  if (!isOpen(ctx, s, a.t)) {
    // walked over, it's shut: remember that (this changes tomorrow's route)
    const hour = Math.floor((((a.t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60);
    for (const m of [ctx.missed, ctx.missedToday]) {
      const row = m.get(s.id) ?? Array(24).fill(0);
      row[hour] += 1;
      m.set(s.id, row);
    }
    wait(a, 1);
    a.memory?.affinity.set(s.id, (a.memory.affinity.get(s.id) ?? 1) * 0.4);
    return false;
  }
  const [lo, hi] = STAY[s.type];
  const dur = Math.min(between(r, lo, hi) * stayScale, minutesToClose(ctx, s, a.t));
  const tIn = round(a.t);
  wait(a, Math.max(2, dur));
  a.visits.push({ storeId: s.id, tIn, tOut: round(a.t) });
  if (a.memory) a.memory.affinity.set(s.id, Math.min(2.5, (a.memory.affinity.get(s.id) ?? 1) * 1.2));
  return true;
}

function finish(a: Agent): AgentDay {
  return { id: a.id, persona: a.persona, returning: a.returning, path: a.path, visits: a.visits };
}

// ---------- persona routines ----------

interface Regular {
  id: string;
  persona: Persona;
  home: Loc;
  work?: Loc;
  memory: Memory;
}

function regulars(ctx: Ctx, seed: number): Regular[] {
  const r = rng(seedOf(seed, "regulars"));
  const mix: [Persona, number][] = [
    ["commuter", 60],
    ["resident", 50],
    ["student", 30],
    ["shopper", 20],
    ["night-owl", 20],
  ];
  const out: Regular[] = [];
  for (const [persona, n] of mix)
    for (let i = 0; i < n; i++)
      out.push({
        id: `r${out.length + 1}`,
        persona,
        home: persona === "commuter" ? ctx.station : pick(r, ctx.homes),
        work: persona === "commuter" ? pick(r, ctx.offices) : undefined,
        memory: { affinity: new Map() },
      });
  return out;
}

const at = (day: number, hour: number) => (day - 1) * MINUTES_PER_DAY + hour * 60;

function nightOut(ctx: Ctx, a: Agent, day: number, r: Rng) {
  if (a.t < at(day, 23) && r() < 0.45) visitOne(ctx, a, { prefs: { bar: 2, offlicence: 0.6 }, outside: 0.8 }, r, 0.8);
  // the club: in until close-ish
  const club = ctx.stores.filter((s) => s.type === "club");
  const target = pick(r, club);
  walkTo(a, target.loc);
  if (isOpen(ctx, target, a.t) || a.t < at(day, 22)) {
    if (!isOpen(ctx, target, a.t)) wait(a, at(day, 22) - a.t + between(r, 0, 10));
    const tIn = round(a.t);
    wait(a, Math.max(30, minutesToClose(ctx, target, a.t) - between(r, 0, 50)));
    a.visits.push({ storeId: target.id, tIn, tOut: round(a.t) });
  }
  // after the club: hungry, looking for anything open and lit nearby
  if (r() < 0.75) visitOne(ctx, a, { prefs: { takeaway: 3, offlicence: 1.4, cafe: 0.6 }, outside: 0.5, maxDist: 240 }, r);
  walkTo(a, r() < 0.6 ? ctx.station : pick(r, ctx.entries));
}

function dayAgents(ctx: Ctx, regs: Regular[], day: number, seed: number): AgentDay[] {
  const out: AgentDay[] = [];
  const weekend = isWeekend(day);
  const night = NIGHT_FACTOR[dow(day)];

  for (const reg of regs) {
    const r = rng(seedOf(seed, day, reg.id));
    const mem = reg.memory;
    const go = (suffix: string, from: Loc, t: number) => startAgent(suffix ? `${reg.id}~${suffix}` : reg.id, reg.persona, true, from, t, r, mem);
    switch (reg.persona) {
      case "commuter": {
        if (weekend || r() > 0.85) break;
        const am = go("", ctx.station, at(day, between(r, 7.2, 9.2)));
        if (r() < 0.55) visitOne(ctx, am, { prefs: { cafe: 3 }, outside: 0.6, maxDist: 260 }, r, 0.5);
        walkTo(am, reg.work!);
        out.push(finish(am));
        if (r() < 0.6) {
          const lunch = go("lunch", reg.work!, at(day, between(r, 12, 13.5)));
          visitOne(ctx, lunch, { prefs: { restaurant: 1.5, takeaway: 1.2, cafe: 1 }, outside: 0.3, maxDist: 300 }, r, 0.6);
          walkTo(lunch, reg.work!);
          out.push(finish(lunch));
        }
        const pm = go("pm", reg.work!, at(day, between(r, 17.2, 18.8)));
        if (r() < 0.45) visitOne(ctx, pm, { prefs: { bar: 2, offlicence: 1, shop: 0.5 }, outside: 1 }, r);
        walkTo(pm, ctx.station);
        out.push(finish(pm));
        break;
      }
      case "resident": {
        if (r() > 0.7) break;
        if (r() < 0.35) {
          const m = go("am", reg.home, at(day, between(r, 7.5, 11)));
          visitOne(ctx, m, { prefs: { cafe: 2, shop: 0.6 }, outside: 0.5 }, r);
          walkTo(m, reg.home);
          out.push(finish(m));
        }
        const e = go("", reg.home, at(day, between(r, 17.5, 21.5)));
        visitOne(ctx, e, { prefs: { offlicence: 1.5, takeaway: 1.2, restaurant: 1, bar: 0.8 }, outside: 0.6 }, r);
        walkTo(e, reg.home);
        out.push(finish(e));
        break;
      }
      case "student": {
        if (r() > 0.6) break;
        const s = go("", reg.home, at(day, between(r, 12.5, 16.5)));
        visitOne(ctx, s, { prefs: { cafe: 2, shop: 1 }, outside: 0.5 }, r, 1.4);
        walkTo(s, reg.home);
        out.push(finish(s));
        if (r() < 0.4 + 0.4 * night) {
          const n = go("night", reg.home, at(day, between(r, 21, 24.5)));
          visitOne(ctx, n, { prefs: { takeaway: 2, bar: 1.2, offlicence: 1 }, outside: 0.6 }, r);
          walkTo(n, reg.home);
          out.push(finish(n));
        }
        break;
      }
      case "shopper": {
        if (r() > (weekend ? 0.85 : 0.4)) break;
        const s = go("", reg.home, at(day, between(r, 10.5, 16)));
        for (let k = intBetween(r, 1, 3); k > 0; k--) {
          stroll(s, r);
          visitOne(ctx, s, { prefs: { shop: 3, cafe: 1 }, outside: 0.3 }, r);
        }
        walkTo(s, reg.home);
        out.push(finish(s));
        break;
      }
      case "night-owl": {
        if (r() > 0.2 + 0.65 * night) break;
        const n = go("", r() < 0.5 ? ctx.station : reg.home, at(day, between(r, 21.5, 23.8)));
        nightOut(ctx, n, day, r);
        out.push(finish(n));
        break;
      }
      default:
        break;
    }
  }

  // one-off visitors: appear once, never come back
  const oneOff = (persona: Persona, n: number, fn: (a: Agent, r: Rng) => void, hours: [number, number]) => {
    for (let i = 0; i < n; i++) {
      const id = `v${day}-${persona}-${hours[0]}-${i}`;
      const r = rng(seedOf(seed, day, id));
      const from = r() < 0.5 ? ctx.station : pick(r, ctx.entries);
      const a = startAgent(id, persona, false, from, at(day, between(r, hours[0], hours[1])), r);
      fn(a, r);
      out.push(finish(a));
    }
  };
  oneOff("tourist", weekend ? 70 : 40, (a, r) => {
    for (let k = intBetween(r, 2, 4); k > 0; k--) {
      stroll(a, r);
      visitOne(ctx, a, { prefs: { shop: 2, cafe: 1.5, restaurant: 1, bar: 0.5 }, outside: 0.4 }, r);
    }
    walkTo(a, r() < 0.6 ? ctx.station : pick(r, ctx.entries));
  }, [10, 17]);
  oneOff("foodie", Math.round(25 + 20 * night), (a, r) => {
    visitOne(ctx, a, { prefs: { restaurant: 3, bar: 0.5 }, outside: 0.3 }, r);
    if (r() < 0.4) visitOne(ctx, a, { prefs: { bar: 2 }, outside: 0.6 }, r);
    walkTo(a, r() < 0.6 ? ctx.station : pick(r, ctx.entries));
  }, [18, 21]);
  oneOff("night-owl", Math.round(110 * night), (a, r) => nightOut(ctx, a, day, r), [21.5, 23.8]);

  // passers-by: the through-traffic of a busy high street. Most never stop; a lit, open shop can catch a few.
  const PASSER_SCALE = 4;
  const through = (n: number, hours: [number, number]) =>
    oneOff("passer-by", Math.round(n * PASSER_SCALE), (a, r) => {
      if (r() < 0.6) stroll(a, r);
      visitOne(ctx, a, { prefs: { cafe: 1, takeaway: 1, shop: 0.8, offlicence: 0.8, bar: 0.6 }, outside: 14, maxDist: 120 }, r);
      walkTo(a, r() < 0.4 ? ctx.station : pick(r, ctx.entries));
    }, hours);
  through(weekend ? 60 : 160, [7, 9.5]); // morning commute
  through(weekend ? 260 : 200, [9.5, 17]);
  through(weekend ? 120 : 180, [17, 19.5]); // evening commute
  through(Math.round(120 * night + 40), [19.5, 23.5]);
  through(Math.round(70 * night), [23.5, 27]); // after midnight (into the next morning)

  return out;
}

// ---------- the run ----------

export interface RunResult {
  days: DayData[];
  stores: RunStores;
  kpis: RunKpis;
  /** Area demand (kW) by hour of day, shops only (clubs are anchors). */
  demandByHourKw: number[];
  /** People in the area by hour of day, averaged over the 14 days. */
  footfallByHour: number[];
  agents: { returning: number; oneOff: number; total: number };
  /** storeId → people who found it shut, per day, by hour. */
  missedByHour: Record<string, number[]>;
  /** storeId → kWh drawn in each hour of a day, averaged over the 14 days. */
  kwhByHour: Record<string, number[]>;
  /** Every owner's day-by-day decisions, oldest first. */
  ownerEvents: OwnerEvent[];
  /** What the owners reacted to (same in every run: fixed seed). */
  streetEvents: StreetEvent[];
  /** Shops' totals per sim day: the inner learning loop (RunAreaSummary.daily). */
  daily: RunDay[];
}

/** kWh drawn in each hour of a day (= average kW over that hour), averaged over the run's days. */
function storeKwhByHour(ctx: Ctx, s: StorePlace): number[] {
  const shop = ctx.book.shops[s.idx];
  const out = Array(24).fill(0);
  for (let day = 1; day <= DAYS_PER_RUN; day++) ctx.book.kwhByHour(shop, day).forEach((k, h) => (out[h] += k / DAYS_PER_RUN));
  return out;
}

const streetCache = new WeakMap<CityMap, Map<number, StreetEvent[]>>();
/** The run's street events (deterministic per map + seed, shared by every run). */
export function streetEventsFor(map: CityMap, seed: number): StreetEvent[] {
  let m = streetCache.get(map);
  if (!m) streetCache.set(map, (m = new Map()));
  if (!m.has(seed)) m.set(seed, generateStreetEvents(map, seed));
  return m.get(seed)!;
}

/** `run` = which run of the session (owners never close for good in run 1). */
export function simulateRun(map: CityMap, cfg: RunConfig, seed: number, run = 1): RunResult {
  const street = streetEventsFor(map, seed);
  const ctx = context(map, cfg, street, run);
  const regs = regulars(ctx, seed);
  const days: DayData[] = [];
  for (let day = 1; day <= DAYS_PER_RUN; day++) {
    ctx.book.morning(day);
    ctx.missedToday = new Map();
    const agents = dayAgents(ctx, regs, day, seed);
    days.push({ day, agents });
    // each owner reads only its own shop's day
    const stats = new Map<string, DayStats>();
    for (const s of ctx.stores) stats.set(s.id, { visits: Array(24).fill(0), missed: ctx.missedToday.get(s.id) ?? Array(24).fill(0) });
    for (const a of agents) for (const v of a.visits) stats.get(v.storeId)!.visits[Math.floor((((v.tIn % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60)] += 1;
    ctx.book.evening(day, stats);
  }

  // ---- per-store results ----
  const visits = new Map<string, number>();
  const byHour = new Map<string, number[]>();
  const visitorDays = new Map<string, Map<string, Set<number>>>(); // store → returning agent → days
  for (const s of ctx.stores) {
    visits.set(s.id, 0);
    byHour.set(s.id, Array(24).fill(0));
    visitorDays.set(s.id, new Map());
  }
  for (const d of days)
    for (const a of d.agents)
      for (const v of a.visits) {
        visits.set(v.storeId, visits.get(v.storeId)! + 1);
        byHour.get(v.storeId)![Math.floor(((v.tIn % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY / 60)] += 1;
        if (!a.returning) continue;
        const base = a.id.split("~")[0];
        const m = visitorDays.get(v.storeId)!;
        if (!m.has(base)) m.set(base, new Set());
        m.get(base)!.add(d.day);
      }

  const stores: RunStores = {};
  let totalVisits = 0;
  let totalKwh = 0;
  const kwhHourly = new Map(ctx.stores.map((s) => [s.id, storeKwhByHour(ctx, s)]));
  for (const s of ctx.stores) {
    const c = cfg[s.id];
    const shop = ctx.book.shops[s.idx];
    const kwh = kwhHourly.get(s.id)!.reduce((a, b) => a + b, 0) * DAYS_PER_RUN;
    const vd = [...visitorDays.get(s.id)!.values()];
    const returnRate = vd.length ? vd.filter((x) => x.size > 1).length / vd.length : 0;
    const kpis: StoreKpis = { visits: visits.get(s.id)!, kwh: round(kwh), returnRate: round2(returnRate) };
    stores[s.id] = {
      open: c.open,
      close: c.close,
      lighting: [...c.lighting],
      kpis,
      visitsByHour: byHour.get(s.id)!.map((n) => round2(n / DAYS_PER_RUN)),
      ...(s.type === "club" ? {} : { schedule: structuredClone(shop.src.schedule), closedFromDay: shop.src.closedFromDay }),
    };
    if (s.type !== "club") {
      totalVisits += kpis.visits;
      totalKwh += kwh;
    }
  }
  // run return rate: of every (shop, regular) pair that met at least once, the share that met on 2+ days
  const pairs = ctx.stores.filter((s) => s.type !== "club").flatMap((s) => [...visitorDays.get(s.id)!.values()]);
  const kpis: RunKpis = {
    visits: totalVisits,
    kwh: Math.round(totalKwh),
    visitsPerKwh: round2(totalVisits / totalKwh),
    returnRate: round2(pairs.length ? pairs.filter((x) => x.size > 1).length / pairs.length : 0),
  };
  const demandByHourKw = Array(24).fill(0);
  for (const s of ctx.stores) if (s.type !== "club") kwhHourly.get(s.id)!.forEach((k, h) => (demandByHourKw[h] += k));
  const footfall = Array(24).fill(0);
  const returningIds = new Set<string>();
  const oneOffIds = new Set<string>();
  for (const d of days)
    for (const a of d.agents) {
      (a.returning ? returningIds : oneOffIds).add(a.id.split("~")[0]);
      const t0 = a.path[0][0];
      const t1 = a.path[a.path.length - 1][0];
      for (let hh = Math.floor(t0 / 60); hh <= Math.floor(t1 / 60); hh++) footfall[hh % 24] += 1;
    }
  const ownerEvents = ctx.book.allEvents();
  return {
    days,
    stores,
    kpis,
    demandByHourKw: demandByHourKw.map(round2),
    footfallByHour: footfall.map((n) => round(n / DAYS_PER_RUN)),
    agents: { returning: returningIds.size, oneOff: oneOffIds.size, total: returningIds.size + oneOffIds.size },
    missedByHour: Object.fromEntries(ctx.stores.map((s) => [s.id, (ctx.missed.get(s.id) ?? Array(24).fill(0)).map((n) => round2(n / DAYS_PER_RUN))])),
    kwhByHour: Object.fromEntries(ctx.stores.map((s) => [s.id, kwhHourly.get(s.id)!.map(round2)])),
    ownerEvents,
    streetEvents: street,
    daily: aggregateDaily({
      days,
      kwhByDay: Object.fromEntries(ctx.stores.map((s) => [s.id, Array.from({ length: DAYS_PER_RUN }, (_, i) => ctx.book.kwhByHour(ctx.book.shops[s.idx], i + 1).reduce((a, b) => a + b, 0))])),
      types: Object.fromEntries(ctx.stores.map((s) => [s.id, s.type])),
      ownerEvents,
    }),
  };
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
