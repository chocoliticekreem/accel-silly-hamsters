// Mock simulation: persona agents live 14 days on the street grid, choosing open, lit stores.
// Decisions are seeded per (day, agent), so two runs differ only because store configs differ (fixed seed rule).
// KPIs are computed from the generated visits, so what you see in 3D matches the numbers in the HUD.
import type { AgentDay, CityMap, DayData, LightLevel, PathKey, RunKpis, RunStores, StoreKpis, StoreType, StoreVisit } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";
import { frontage } from "../sim/geometry";
import { isOpenAt, parseHHMM } from "../sim/time";
import type { RunConfig, StoreConfig } from "./configs";
import { H_STREETS, V_STREETS } from "./map";
import { between, intBetween, pick, rng, seedOf, weighted, type Rng } from "./rng";

export const WALK_M_PER_MIN = 75;

// ---------- personas ----------

export type Persona = "commuter" | "resident" | "student" | "shopper" | "night-owl" | "tourist" | "foodie";

type Prefs = Partial<Record<StoreType, number>>;

const NIGHT_FACTOR = [0.3, 0.3, 0.45, 0.7, 1, 1, 0.4]; // Mon..Sun (Day 1 = Monday)
const dow = (day: number) => (day - 1) % 7;
const isWeekend = (day: number) => dow(day) >= 5;

// ---------- energy model (kWh per m² per hour) ----------

const OPEN_KWH: Record<StoreType, number> = { cafe: 0.004, restaurant: 0.005, takeaway: 0.0045, bar: 0.004, shop: 0.0025, offlicence: 0.003, club: 0.006 };
const LIGHT_KWH: Record<LightLevel, number> = { off: 0, low: 0.001, high: 0.003 };

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
  type: StoreType;
  loc: Loc;
  area: number;
}

interface Ctx {
  map: CityMap;
  cfg: RunConfig;
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

const ctxCache = new WeakMap<CityMap, Omit<Ctx, "cfg">>();

function context(map: CityMap, cfg: RunConfig): Ctx {
  let base = ctxCache.get(map);
  if (!base) {
    const stores = map.stores.map((s) => {
      const b = map.buildings.find((x) => x.id === s.buildingId)!;
      return { id: s.id, type: s.type, loc: buildingLoc(map, s.buildingId), area: b.w * b.d };
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
  return { ...base, cfg };
}

// ---------- store rules ----------

function isOpen(c: StoreConfig, t: number) {
  return isOpenAt(c.open, c.close, ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
}

function minutesToClose(c: StoreConfig, t: number) {
  const m = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const close = parseHHMM(c.close);
  return (close - m + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
}

function lightAt(c: StoreConfig, t: number): LightLevel {
  return c.lighting[Math.floor((((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60)];
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
    const c = ctx.cfg[s.id];
    const d = Math.hypot(s.loc.x - a.at.x, s.loc.z - a.at.z);
    if (choice.maxDist && d > choice.maxDist) return 0;
    const arrive = a.t + d / WALK_M_PER_MIN;
    const open = isOpen(c, arrive);
    // strangers can't know hours (they go by the lights); regulars mostly remember
    const knowsHours = a.memory ? 0.85 : 0.2;
    const openW = open ? 1 : 1 - knowsHours;
    const mem = a.memory?.affinity.get(s.id) ?? 1;
    return (choice.prefs[s.type] ?? 0) * Math.exp(-d / 160) * lightFactor(lightAt(c, arrive), arrive) * openW * mem;
  });
  const i = weighted(r, [...weights, choice.outside]);
  if (i < 0 || i >= candidates.length) return false;
  const s = candidates[i];
  const c = ctx.cfg[s.id];
  walkTo(a, s.loc);
  if (!isOpen(c, a.t)) {
    // walked over, it's shut: remember that (this changes tomorrow's route)
    wait(a, 1);
    a.memory?.affinity.set(s.id, (a.memory.affinity.get(s.id) ?? 1) * 0.4);
    return false;
  }
  const [lo, hi] = STAY[s.type];
  const dur = Math.min(between(r, lo, hi) * stayScale, minutesToClose(c, a.t));
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
  const c = ctx.cfg[target.id];
  if (isOpen(c, a.t) || a.t < at(day, 22)) {
    if (!isOpen(c, a.t)) wait(a, at(day, 22) - a.t + between(r, 0, 10));
    const tIn = round(a.t);
    wait(a, Math.max(30, minutesToClose(c, a.t) - between(r, 0, 50)));
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
        for (let k = intBetween(r, 1, 3); k > 0; k--) visitOne(ctx, s, { prefs: { shop: 3, cafe: 1 }, outside: 0.3 }, r);
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
      const id = `v${day}-${persona}-${i}`;
      const r = rng(seedOf(seed, day, id));
      const from = r() < 0.5 ? ctx.station : pick(r, ctx.entries);
      const a = startAgent(id, persona, false, from, at(day, between(r, hours[0], hours[1])), r);
      fn(a, r);
      out.push(finish(a));
    }
  };
  oneOff("tourist", weekend ? 70 : 40, (a, r) => {
    for (let k = intBetween(r, 2, 4); k > 0; k--) visitOne(ctx, a, { prefs: { shop: 2, cafe: 1.5, restaurant: 1, bar: 0.5 }, outside: 0.4 }, r);
    walkTo(a, r() < 0.6 ? ctx.station : pick(r, ctx.entries));
  }, [10, 17]);
  oneOff("foodie", Math.round(25 + 20 * night), (a, r) => {
    visitOne(ctx, a, { prefs: { restaurant: 3, bar: 0.5 }, outside: 0.3 }, r);
    if (r() < 0.4) visitOne(ctx, a, { prefs: { bar: 2 }, outside: 0.6 }, r);
    walkTo(a, r() < 0.6 ? ctx.station : pick(r, ctx.entries));
  }, [18, 21]);
  oneOff("night-owl", Math.round(110 * night), (a, r) => nightOut(ctx, a, day, r), [21.5, 23.8]);

  return out;
}

// ---------- the run ----------

export interface RunResult {
  days: DayData[];
  stores: RunStores;
  kpis: RunKpis;
}

function storeKwhPerDay(ctx: Ctx, s: StorePlace) {
  const c = ctx.cfg[s.id];
  let kwh = 0;
  for (let h = 0; h < 24; h++) {
    // half-hour resolution, so 30-minute hour changes cost what they should
    const openShare = (Number(isOpenAt(c.open, c.close, h * 60 + 15)) + Number(isOpenAt(c.open, c.close, h * 60 + 45))) / 2;
    kwh += s.area * (OPEN_KWH[s.type] * openShare + LIGHT_KWH[c.lighting[h]]);
  }
  return kwh;
}

export function simulateRun(map: CityMap, cfg: RunConfig, seed: number): RunResult {
  const ctx = context(map, cfg);
  const regs = regulars(ctx, seed);
  const days: DayData[] = [];
  for (let day = 1; day <= DAYS_PER_RUN; day++) days.push({ day, agents: dayAgents(ctx, regs, day, seed) });

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
  for (const s of ctx.stores) {
    const c = cfg[s.id];
    const kwh = storeKwhPerDay(ctx, s) * DAYS_PER_RUN;
    const vd = [...visitorDays.get(s.id)!.values()];
    const returnRate = vd.length ? vd.filter((x) => x.size > 1).length / vd.length : 0;
    const kpis: StoreKpis = { visits: visits.get(s.id)!, kwh: round(kwh), returnRate: round2(returnRate) };
    stores[s.id] = {
      open: c.open,
      close: c.close,
      lighting: [...c.lighting],
      kpis,
      visitsByHour: byHour.get(s.id)!.map((n) => round2(n / DAYS_PER_RUN)),
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
  return { days, stores, kpis };
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
