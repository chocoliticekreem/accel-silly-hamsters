// Mock economy (docs/PEOPLE_ECONOMY.md): owners' money from the mock sim's own takings and costs, an append-only
// ledger that replays to the balances exactly, plain-English life stories, intervention forks (same seed, one
// change applied) and a rule-based daily headline. Builds on the shared mock state, so forked runs show up in
// the main mock API's /runs and /days like any other run.
import type { CityMap, RunSummary, StoreType, StreetEvent } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";
import type {
  EconomyApi,
  Headline,
  InterventionRequest,
  LedgerEntry,
  OwnerPerson,
  OwnerStatus,
  PersonDay,
  PersonStory,
  PersonVisit,
  RunIntervention,
} from "../api/economy";
import { GBP_PER_KWH, SPEND_GBP } from "../sim/economics";
import { nearestStreetName, shutStops, storeDoors } from "../sim/heatmap";
import { formatHHMM } from "../sim/time";
import { MOCK_RUN_COUNT } from "./configs";
import { MOCK_SEED, sharedMockState, type MockState } from "./index";
import { between, rng, seedOf } from "./rng";
import { citizenDiary, citizenIndex } from "./citizens";
import { simulateRun, type RunResult, type SimTweaks } from "./simulate";

const WEEKDAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const weekday = (day: number) => WEEKDAY[(day - 1) % 7];
const dayStart = (day: number) => (day - 1) * MINUTES_PER_DAY;
const isOwner = (a: PersonDay) => a.role === "owner";

// ---------- money ----------

/** Share of takings spent restocking. */
export const STOCK_SHARE: Record<StoreType, number> = { cafe: 0.32, restaurant: 0.36, takeaway: 0.38, bar: 0.3, shop: 0.5, offlicence: 0.55, club: 0 };
/** Paid staff alongside the owner, per open hour. */
export const STAFF: Record<StoreType, number> = { cafe: 0.6, restaurant: 1.5, takeaway: 0.6, bar: 1, shop: 0.3, offlicence: 0.2, club: 0 };
export const WAGE_GBP_PER_HOUR = 12.6;
export const RENT_GBP_PER_M2_YEAR = 48;
export const LIVING_GBP_PER_DAY = 38;
/** Below this business balance an owner turns cautious. */
export const CAUTIOUS_BELOW_GBP = 1500;
/** Business balance below zero this many days running = bust. */
export const BUST_DAYS = 3;

export interface MoneyOptions {
  /** Electricity price multiplier (the energy_price intervention). */
  energyFactor?: number;
  seed?: number;
}

export interface Money {
  owners: OwnerPerson[];
  /** Every owner's transactions, oldest first. */
  ledger: LedgerEntry[];
}

const pence = (gbp: number) => Math.round(gbp * 100);

/** Owners' money over the run, from the run's own visits, kWh and opening; balances are the ledger replayed. */
export function buildMoney(map: CityMap, res: RunResult, opts: MoneyOptions = {}): Money {
  const energyFactor = opts.energyFactor ?? 1;
  const seed = opts.seed ?? MOCK_SEED;
  const ledger: LedgerEntry[] = [];
  const owners: OwnerPerson[] = [];
  for (const o of res.owners) {
    const store = map.stores.find((s) => s.id === o.storeId)!;
    const b = map.buildings.find((x) => x.id === store.buildingId)!;
    const r = rng(seedOf(seed, "money", o.storeId));
    const startBiz = Math.round(between(r, 1800, 6000) / 10) * 1000; // pence, whole £10s
    const startPer = Math.round(between(r, 600, 2400) / 10) * 1000;
    const rentDay = pence((b.w * b.d * RENT_GBP_PER_M2_YEAR) / 365);
    let biz = startBiz;
    let per = startPer;
    const bizDaily: number[] = [];
    const perDaily: number[] = [];
    const totals = { takings: 0, energy: 0, rent: 0, stock: 0, wages: 0, drawings: 0, living: 0 };
    let negDays = 0;
    const entry = (t: number, day: number, kind: LedgerEntry["kind"], p: number, account: LedgerEntry["account"] = "business") => {
      if (p === 0) return;
      ledger.push({ t, day, storeId: o.storeId, kind, amountGbp: p / 100, account });
      if (account === "business") biz += p;
      else per += p;
    };
    for (let day = 1; day <= DAYS_PER_RUN; day++) {
      const agents = res.days[day - 1].agents as PersonDay[];
      // takings: every customer's visit, summed per hour
      const byHour = new Map<number, number>();
      let worked = 0;
      for (const a of agents)
        for (const v of a.visits) {
          if (v.storeId !== o.storeId) continue;
          if (isOwner(a)) {
            worked += Math.max(0, v.tOut - v.tIn) / 60;
            continue;
          }
          const h = Math.floor(v.tIn / 60);
          byHour.set(h, (byHour.get(h) ?? 0) + 1);
        }
      let takings = 0;
      for (const [h, n] of [...byHour.entries()].sort((x, y) => x[0] - y[0])) {
        const p = pence(n * SPEND_GBP[store.type]);
        takings += p;
        entry(h * 60 + 59, day, "sale", p);
      }
      const end = dayStart(day) + 23 * 60 + 50;
      const stock = -Math.round(takings * STOCK_SHARE[store.type]);
      const energy = -pence(res.kwhByDay[o.storeId][day - 1] * GBP_PER_KWH * energyFactor);
      const wages = -pence(worked * STAFF[store.type] * WAGE_GBP_PER_HOUR);
      entry(end, day, "stock", stock);
      entry(end, day, "energy", energy);
      entry(end, day, "rent", -rentDay);
      entry(end, day, "wages", wages);
      // drawings: what the owner can afford to take home today
      const draw = biz > 300000 ? 7000 : biz > CAUTIOUS_BELOW_GBP * 100 ? 4500 : biz > 0 ? 2000 : 0;
      entry(end + 5, day, "drawings", -draw);
      entry(end + 5, day, "drawings", draw, "personal");
      entry(end + 9, day, "living", -pence(LIVING_GBP_PER_DAY), "personal");
      totals.takings += takings;
      totals.stock -= stock;
      totals.energy -= energy;
      totals.rent += rentDay;
      totals.wages -= wages;
      totals.drawings += draw;
      totals.living += pence(LIVING_GBP_PER_DAY);
      negDays = biz < 0 ? negDays + 1 : 0;
      bizDaily.push(biz / 100);
      perDaily.push(per / 100);
    }
    const closedForGood = res.stores[o.storeId]?.closedFromDay != null;
    const status: OwnerStatus = negDays >= BUST_DAYS || closedForGood ? "bust" : biz < CAUTIOUS_BELOW_GBP * 100 || bizDaily[DAYS_PER_RUN - 1] < bizDaily[DAYS_PER_RUN - 4] - 150 ? "cautious" : "trading";
    owners.push({
      personId: o.personId,
      storeId: o.storeId,
      name: o.name,
      home: o.home,
      commuteMinutes: o.commuteMinutes,
      business: { startGbp: startBiz / 100, endGbp: biz / 100, daily: bizDaily },
      personal: { startGbp: startPer / 100, endGbp: per / 100, daily: perDaily },
      totals: {
        takingsGbp: totals.takings / 100,
        energyGbp: totals.energy / 100,
        rentGbp: totals.rent / 100,
        stockGbp: totals.stock / 100,
        wagesGbp: totals.wages / 100,
        drawingsGbp: totals.drawings / 100,
        livingGbp: totals.living / 100,
      },
      status,
    });
  }
  ledger.sort((a, b) => a.t - b.t || a.storeId.localeCompare(b.storeId));
  return { owners, ledger };
}

/** Replays a ledger onto starting balances: end-of-day balances per account (pence-exact). */
export function replayLedger(ledger: LedgerEntry[], storeId: string, startBizGbp: number, startPerGbp: number) {
  let biz = pence(startBizGbp);
  let per = pence(startPerGbp);
  const business: number[] = [];
  const personal: number[] = [];
  const rows = ledger.filter((e) => e.storeId === storeId);
  for (let day = 1; day <= DAYS_PER_RUN; day++) {
    for (const e of rows) if (e.day === day) (e.account === "business" ? (biz += pence(e.amountGbp)) : (per += pence(e.amountGbp)));
    business.push(biz / 100);
    personal.push(per / 100);
  }
  return { business, personal };
}

// ---------- life stories ----------

const gbp = (n: number) => `£${Math.round(Math.abs(n)).toLocaleString("en-GB")}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A person's story from their own trips, the shop's events and their ledger (3–5 sentences). */
export function personStory(map: CityMap, res: RunResult, money: Money, personId: string): PersonStory | null {
  const storeName = (id: string) => map.stores.find((s) => s.id === id)?.name ?? id;
  const storeType = (id: string) => map.stores.find((s) => s.id === id)?.type ?? "shop";
  const owner = res.owners.find((o) => o.personId === personId);
  if (owner) {
    const o = money.owners.find((x) => x.personId === personId)!;
    const first = owner.name.split(" ")[0];
    const shop = storeName(owner.storeId);
    const trips = res.days.flatMap((d) => (d.agents as PersonDay[]).filter((a) => a.id === personId).map((a) => ({ day: d.day, a })));
    const visits: PersonVisit[] = trips.flatMap(({ day, a }) => a.visits.map((v) => ({ storeId: v.storeId, day, tIn: v.tIn, tOut: v.tOut, spentGbp: 0 })));
    const customers = res.days.map((d) => (d.agents as PersonDay[]).reduce((n, a) => n + (isOwner(a) ? 0 : a.visits.filter((v) => v.storeId === owner.storeId).length), 0));
    const openDays = new Set(visits.map((v) => v.day));
    const lines = [`${owner.name} runs ${shop} and lives near ${nearestStreetName(map, owner.home.x, owner.home.z)}, ${/^(8|11|18)$/.test(String(owner.commuteMinutes)) ? "an" : "a"} ${owner.commuteMinutes}-minute walk away.`];
    if (visits.length) {
      const opens = visits.map((v) => ((v.tIn % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY).sort((a, b) => a - b);
      lines.push(`${first} opened up on ${openDays.size} of ${DAYS_PER_RUN} days, usually at ${formatHHMM(opens[Math.floor(opens.length / 2)])} after the walk in.`);
      const open = [...openDays].sort((a, b) => a - b);
      const busiest = open.reduce((a, b) => (customers[b - 1] > customers[a - 1] ? b : a));
      const quietest = open.reduce((a, b) => (customers[b - 1] < customers[a - 1] ? b : a));
      lines.push(
        busiest === quietest
          ? `${plural(customers[busiest - 1], "customer")} on Day ${busiest}.`
          : `Busiest was ${weekday(busiest)} (Day ${busiest}) with ${plural(customers[busiest - 1], "customer")}; quietest ${weekday(quietest)} (Day ${quietest}) with ${customers[quietest - 1]}.`,
      );
    } else lines.push(`${shop} never opened this fortnight.`);
    const ev = res.ownerEvents.filter((e) => e.storeId === owner.storeId && e.action !== "lighting_changed");
    const notable = ev.find((e) => e.action === "closed_permanently") ?? ev.find((e) => e.trigger?.kind === "roadworks") ?? ev[0];
    if (notable) lines.push(`On Day ${notable.day}, ${first} said: "${notable.reason}"`);
    const delta = o.business.endGbp - o.business.startGbp;
    const status = o.status === "trading" ? "still trading" : o.status === "cautious" ? "keeping the hours tight" : "the business has run out of road";
    lines.push(`Business account ${delta >= 0 ? "up" : "down"} ${gbp(delta)} this fortnight to ${o.business.endGbp < 0 ? "−" : ""}${gbp(o.business.endGbp)}; ${status}.`);
    return { personId, role: "owner", name: owner.name, persona: "owner", home: owner.home, story: lines.slice(0, 5), balance: { daily: o.business.daily }, visits };
  }

  // a citizen: every trip whose id is this person's (regulars make several trips a day: r12, r12~lunch, ...)
  const trips = res.days.flatMap((d) => (d.agents as PersonDay[]).filter((a) => !isOwner(a) && a.id.split("~")[0] === personId).map((a) => ({ day: d.day, a })));
  if (!trips.length) return null;
  const persona = trips[0].a.persona;
  const station = map.entryPoints.find((e) => e.kind === "station");
  const nearStation = (x: number, z: number) => !!station && Math.hypot(x - station.x, z - station.z) < 25;
  const homeTrip = trips.find(({ a }) => a.path.length && !nearStation(a.path[0][1], a.path[0][2]) && map.entryPoints.every((e) => Math.hypot(a.path[0][1] - e.x, a.path[0][2] - e.z) > 25));
  const home = homeTrip ? { x: homeTrip.a.path[0][1], z: homeTrip.a.path[0][2] } : null;
  const visits: PersonVisit[] = trips.flatMap(({ day, a }) => a.visits.map((v) => ({ storeId: v.storeId, day, tIn: v.tIn, tOut: v.tOut, spentGbp: SPEND_GBP[storeType(v.storeId)] })));
  const spent = visits.reduce((n, v) => n + v.spentGbp, 0);
  const daysOut = new Set(trips.map((t) => t.day));
  const lines: string[] = [];
  const who = `A ${persona.replace("-", " ")}`;
  if (trips[0].a.returning) lines.push(`${who} ${home ? `from near ${nearestStreetName(map, home.x, home.z)}` : "who comes in by the station"}, out and about on ${daysOut.size} of ${DAYS_PER_RUN} days.`);
  else {
    const [t0, x0, z0] = trips[0].a.path[0];
    lines.push(`${who} in the area on Day ${trips[0].day} only, arriving ${nearStation(x0, z0) ? "by the station" : `along ${nearestStreetName(map, x0, z0)}`} at ${formatHHMM(t0)}.`);
  }
  if (visits.length) {
    const count = new Map<string, number>();
    for (const v of visits) count.set(v.storeId, (count.get(v.storeId) ?? 0) + 1);
    const [fav, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    lines.push(`${plural(visits.length, "visit")} to ${plural(count.size, "place")}${count.size > 1 && n > 1 ? `, most often ${storeName(fav)} (${n})` : `: ${storeName(fav)}`}.`);
    if (spent > 0) lines.push(`Spent about ${gbp(spent)} in total.`);
  } else lines.push("Walked through without stopping anywhere.");
  const doors = storeDoors(map);
  const shut = trips.flatMap(({ day, a }) => shutStops(a.path, a.visits, doors).map((s) => ({ ...s, day })));
  if (shut.length) lines.push(`Found ${storeName(shut[0].storeId)} shut on Day ${shut[0].day} at ${formatHHMM(shut[0].t)} and walked on.`);
  const last = trips[trips.length - 1];
  const lastVisits = trips.filter((t) => t.day === last.day).flatMap((t) => t.a.visits);
  if (lastVisits.length && lines.length < 5)
    lines.push(`On Day ${last.day} went to ${[...new Set(lastVisits.map((v) => storeName(v.storeId)))].join(" then ")}, and was gone by ${formatHHMM(last.a.path[last.a.path.length - 1][0])}.`);
  return { personId, role: "citizen", persona, home, story: lines.slice(0, 5), spentGbp: spent, visits };
}

// ---------- the daily headline ----------

export function headlinesFor(map: CityMap, res: RunResult): Headline[] {
  const name = (id: string) => map.stores.find((s) => s.id === id)?.name ?? id;
  const street = (id: string | null | undefined) => map.streets.find((s) => s.id === id)?.name ?? "the high street";
  const shopIds = new Set(map.stores.filter((s) => s.type !== "club").map((s) => s.id));
  const visits = res.days.map((d) => (d.agents as PersonDay[]).reduce((n, a) => n + (isOwner(a) ? 0 : a.visits.filter((v) => shopIds.has(v.storeId)).length), 0));
  const out: Headline[] = [];
  for (let day = 1; day <= DAYS_PER_RUN; day++) {
    const t0 = dayStart(day);
    const t1 = t0 + MINUTES_PER_DAY;
    const live = (e: StreetEvent) => e.fromT < t1 && e.toT > t0 + 6 * 60;
    const ev = res.ownerEvents.filter((e) => e.day === day);
    const parts: string[] = [];
    const special = res.streetEvents.find((e) => e.kind === "event" && e.day === day);
    if (special) parts.push(special.label);
    const works = res.streetEvents.filter((e) => e.kind === "roadworks" && live(e));
    const shut = ev.filter((e) => e.action === "shut_early" || e.action === "temporary_closure").length;
    for (const w of works.slice(0, 1)) parts.push(`${street(w.streetId)} dug up${shut ? `, ${shut === 1 ? "one shop shuts" : `${shut} shops shut`} early` : ""}`);
    if (res.streetEvents.some((e) => e.kind === "weather" && e.day === day)) parts.push("rain keeps shoppers at home");
    for (const e of ev.filter((x) => x.action === "closed_permanently")) parts.push(`${name(e.storeId)} closes for good`);
    const late = ev.find((e) => e.action === "open_late");
    const club = res.streetEvents.find((e) => e.kind === "club_night" && e.day === day);
    if (late) parts.push(`club crowd keeps ${name(late.storeId)} open till ${late.to}`);
    else if (club && club.severity >= 0.8) parts.push(`${club.label.replace(/^Club night, /, "")} packed out`);
    const hours = ev.filter((e) => e.action === "hours_changed" || e.action === "day_closed").length;
    if (hours >= 2) parts.push(`${hours} owners rethink their hours`);
    const others = visits.filter((_, i) => (i % 7) === ((day - 1) % 7) && i !== day - 1);
    const usual = (others.length ? others : visits).reduce((a, b) => a + b, 0) / Math.max(1, (others.length ? others : visits).length);
    const dv = usual ? (visits[day - 1] - usual) / usual : 0;
    if (Math.abs(dv) >= 0.12) parts.push(`${dv > 0 ? "busy" : "quiet"} ${weekday(day)}, shop visits ${dv > 0 ? "up" : "down"} ${Math.round(Math.abs(dv) * 100)}%`);
    const text = parts.length ? parts.slice(0, 2).join("; ") : `Steady ${weekday(day)}: ${visits[day - 1].toLocaleString("en-GB")} shop visits on the high street`;
    out.push({ day, text: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` });
  }
  return out;
}

// ---------- interventions: forks of a run with one change ----------

export interface ForkPlan {
  label: string;
  tweaks: SimTweaks;
  energyFactor: number;
}

const daysFrom = (from: number, n: number) => Array.from({ length: Math.max(1, n) }, (_, i) => from + i).filter((d) => d >= 1 && d <= DAYS_PER_RUN);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : d);

/** Turns an intervention request into sim tweaks (and a money change) on the same seed. */
export function planIntervention(map: CityMap, req: InterventionRequest): ForkPlan {
  const p = req.params ?? {};
  switch (req.kind) {
    case "station_closed": {
      const all = p.day === "all" || p.day == null;
      const days = all ? daysFrom(1, DAYS_PER_RUN) : daysFrom(num(p.day, 1), 1);
      const station = map.entryPoints.find((e) => e.kind === "station")?.name ?? "the station";
      return {
        label: `${station} closed ${all ? "all fortnight" : `on Day ${days[0]}`}`,
        energyFactor: 1,
        tweaks: {
          stationClosedDays: days,
          extraStreetEvents: days.map((d) => ({ day: d, fromT: dayStart(d) + 5 * 60, toT: dayStart(d) + 24 * 60, kind: "event", streetId: null, label: `${station} closed`, severity: 1 })),
        },
      };
    }
    case "roadworks": {
      const streetId = String(p.streetId ?? map.streets[0]?.id ?? "");
      const days = daysFrom(num(p.fromDay, 1), num(p.days, 3));
      const name = map.streets.find((s) => s.id === streetId)?.name ?? streetId;
      return {
        label: `Roadworks on ${name}, Day ${days[0]}${days.length > 1 ? `–${days[days.length - 1]}` : ""}`,
        energyFactor: 1,
        tweaks: { extraStreetEvents: [{ day: days[0], fromT: dayStart(days[0]) + 7 * 60, toT: dayStart(days[days.length - 1]) + 19 * 60, kind: "roadworks", streetId, label: `Roadworks, ${name}`, severity: 0.65 }] },
      };
    }
    case "energy_price": {
      const f = num(p.factor, 2);
      return { label: `Electricity price ×${f}`, energyFactor: f, tweaks: {} };
    }
    case "club_event": {
      const club = map.stores.find((s) => s.id === p.clubId) ?? map.stores.find((s) => s.type === "club");
      const day = daysFrom(num(p.day, 6), 1)[0];
      const clubName = club?.name ?? "the club";
      return {
        label: `Big event at ${clubName}, Day ${day}`,
        energyFactor: 1,
        tweaks: {
          nightBoost: { [day]: 2.2 },
          extraStreetEvents: [
            { day, fromT: dayStart(day) + 21 * 60, toT: dayStart(day + 1) + 4 * 60, kind: "club_night", streetId: null, label: `Club night, ${clubName}`, severity: 1 },
            { day, fromT: dayStart(day) + 20 * 60, toT: dayStart(day + 1) + 4 * 60, kind: "event", streetId: null, label: `Big event at ${clubName}`, severity: 0.9 },
          ],
        },
      };
    }
    case "rain": {
      const days = daysFrom(num(p.fromDay, 1), num(p.days, 7));
      return {
        label: `Rain, Day ${days[0]}–${days[days.length - 1]}`,
        energyFactor: 1,
        tweaks: {
          arrivalFactor: Object.fromEntries(days.map((d) => [d, 0.6])),
          extraStreetEvents: days.map((d) => ({ day: d, fromT: dayStart(d) + 7 * 60, toT: dayStart(d) + 23 * 60, kind: "weather" as const, streetId: null, label: "Rain all day", severity: 0.6 })),
        },
      };
    }
  }
}

interface Fork extends ForkPlan {
  run: number;
  baseRun: number;
  kind: InterventionRequest["kind"];
  params: InterventionRequest["params"];
  createdAt: string;
}

interface Economy {
  forks: Map<number, Fork>;
  money(run: number): Money;
}

const installed = new WeakMap<MockState, Economy>();

/** Wraps the mock state once so forked runs are served by the main mock API like any other run. */
export function economyFor(state: MockState): Economy {
  const have = installed.get(state);
  if (have) return have;
  const forks = new Map<number, Fork>();
  const results = new Map<number, RunResult>();
  const baseResult = state.result.bind(state);
  const baseConfig = state.config.bind(state);
  const baseRuns = state.runs.bind(state);
  state.config = (run) => baseConfig(forks.get(run)?.baseRun ?? run);
  state.result = (run) => {
    const f = forks.get(run);
    if (!f) return baseResult(run);
    if (!results.has(run)) results.set(run, simulateRun(state.map, baseConfig(f.baseRun), MOCK_SEED, f.baseRun, f.tweaks));
    return results.get(run)!;
  };
  state.runs = () => [
    ...baseRuns(),
    ...[...forks.values()].map(
      (f): RunSummary & { intervention: RunIntervention } => ({
        run: f.run,
        seed: MOCK_SEED,
        status: "done",
        kpis: state.result(f.run).kpis,
        notebook: `What if: ${f.label} (fork of run ${f.baseRun})`,
        createdAt: f.createdAt,
        intervention: { kind: f.kind, label: f.label, baseRun: f.baseRun, params: f.params },
      }),
    ),
  ];
  const moneyCache = new Map<RunResult, Money>();
  const econ: Economy = {
    forks,
    money(run) {
      const res = state.result(run);
      if (!moneyCache.has(res)) moneyCache.set(res, buildMoney(state.map, res, { energyFactor: forks.get(run)?.energyFactor ?? 1 }));
      return moneyCache.get(res)!;
    },
  };
  installed.set(state, econ);
  return econ;
}

/** Adds a fork of `baseRun` with the intervention applied; returns its run number. */
export function forkRun(state: MockState, req: InterventionRequest, baseRun: number): number {
  const econ = economyFor(state);
  const run = Math.max(MOCK_RUN_COUNT, ...econ.forks.keys()) + 1;
  econ.forks.set(run, { ...planIntervention(state.map, req), run, baseRun, kind: req.kind, params: req.params, createdAt: new Date().toISOString() });
  return run;
}

const later = <T>(fn: () => T, ms = 40): Promise<T> =>
  new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(structuredClone(fn()));
      } catch (e) {
        reject(e);
      }
    }, ms),
  );

export function mockEconomyApi(state: MockState = sharedMockState()): EconomyApi {
  const econ = economyFor(state);
  const headlineCache = new Map<RunResult, Headline[]>();
  return {
    owners: (run) => later(() => econ.money(run).owners),
    ledger: (run, q = {}) =>
      later(() => {
        const rows = econ.money(run).ledger.filter((e) => (!q.storeId || e.storeId === q.storeId) && (q.day == null || e.day === q.day));
        return q.limit != null ? rows.slice(0, q.limit) : rows;
      }),
    person: (run, id) => later(() => personStory(state.map, state.result(run), econ.money(run), id)),
    intervene: (req) =>
      later(() => {
        const queuedRun = forkRun(state, req, req.baseRun ?? state.bestRun());
        state.result(queuedRun); // simulate now, so the run is "done" when polled
        return { queuedRun };
      }, 20),
    interventions: () =>
      later(() => Object.fromEntries([...econ.forks.values()].map((f) => [f.run, { kind: f.kind, label: f.label, baseRun: f.baseRun, params: f.params }]))),
    // docs/CITIZENS.md: featured people are picked from run 1 (the plan), so they're the same in every run
    citizens: (run) => later(() => citizenIndex(state.map, state.result(run), run, state.result(1))),
    diary: (run, id) => later(() => citizenDiary(state.map, state.result(run), run, id)),
    headlines: (run) =>
      later(() => {
        const res = state.result(run);
        if (!headlineCache.has(res)) headlineCache.set(res, headlinesFor(state.map, res));
        return headlineCache.get(res)!;
      }),
  };
}
