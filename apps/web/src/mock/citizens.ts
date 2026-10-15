// Mock citizens API (docs/CITIZENS.md §5-6): GET /api/runs/{run}/citizens and /citizens/{id}/diary, generated from
// the mock sim's own agents. Profiles are synthetic archetypes keyed by id (never a real person); diaries and
// memory lines are read off the person's own trips: where they came from, where they went, what they found shut.
import type { CityMap, StoreType } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";
import type { AgeBand, Budget, CitizenCard, CitizenDiary, CitizenIndex, CitizenProfile, DiaryDay, DiaryEntry, Occupation, PersonDay } from "../api/economy";
import { nearestStreetName, shutStops, storeDoors, type Door } from "../sim/heatmap";
import { formatHHMM } from "../sim/time";
import { between, pick, rng, seedOf } from "./rng";
import type { RunResult } from "./simulate";

const SEED = 42;
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const wd = (day: number) => (day - 1) % 7;
export const CITIZEN_NOTE = "Simulated, not a real person.";
const INDEX_NOTE = "Synthetic citizens built from anonymous aggregate data; not real people.";

const PURPOSE: Record<StoreType, string> = { cafe: "coffee", restaurant: "a meal", takeaway: "food to go", bar: "a drink", shop: "shopping", offlicence: "supplies", club: "a night out" };
const ARCHETYPE: Record<string, { profile: string; label: string; occupation: Occupation; ages: AgeBand[]; budgets: Budget[] }> = {
  commuter: { profile: "office-commuter", label: "Office commuter", occupation: "office", ages: ["25-34", "35-49", "50-64"], budgets: ["mid", "mid", "high"] },
  resident: { profile: "local-resident", label: "Local resident", occupation: "resident", ages: ["35-49", "50-64", "65+"], budgets: ["low", "mid", "mid"] },
  student: { profile: "student-local", label: "Student", occupation: "student", ages: ["18-24", "18-24", "25-34"], budgets: ["low", "low", "mid"] },
  shopper: { profile: "remote-worker", label: "Remote worker", occupation: "remote", ages: ["25-34", "35-49"], budgets: ["mid", "high"] },
  "night-owl": { profile: "nightlife-regular", label: "Night owl", occupation: "shift", ages: ["18-24", "25-34"], budgets: ["low", "mid"] },
  tourist: { profile: "tourist", label: "Tourist", occupation: "visitor", ages: ["25-34", "35-49", "50-64"], budgets: ["mid", "high"] },
  foodie: { profile: "evening-diner", label: "Evening diner", occupation: "visitor", ages: ["25-34", "35-49"], budgets: ["mid", "high"] },
  "passer-by": { profile: "passer-by", label: "Passer-by", occupation: "visitor", ages: ["18-24", "25-34", "35-49", "50-64"], budgets: ["low", "mid"] },
};

interface Trip {
  day: number;
  a: PersonDay;
}

const tripCache = new WeakMap<RunResult, Map<string, Trip[]>>();
/** person id → their trips this run, oldest first (owners excluded). */
export function tripsByPerson(res: RunResult): Map<string, Trip[]> {
  let m = tripCache.get(res);
  if (m) return m;
  m = new Map();
  for (const d of res.days)
    for (const a of d.agents as PersonDay[]) {
      if (a.role === "owner") continue;
      const id = a.id.split("~")[0];
      const list = m.get(id) ?? [];
      // trips past midnight sit in two day files: keep the first
      if (!list.some((t) => t.a.id === a.id && t.a.path[0]?.[0] === a.path[0]?.[0])) list.push({ day: d.day, a });
      m.set(id, list);
    }
  for (const list of m.values()) list.sort((x, y) => x.a.path[0][0] - y.a.path[0][0]);
  tripCache.set(res, m);
  return m;
}

const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

function placeOf(map: CityMap, x: number, z: number): { kind: "station" | "entry" | "home"; name: string } {
  for (const e of map.entryPoints)
    if (Math.hypot(e.x - x, e.z - z) < 25) return { kind: e.kind === "station" ? "station" : "entry", name: e.name ?? (e.kind === "station" ? "the station" : nearestStreetName(map, e.x, e.z)) };
  return { kind: "home", name: nearestStreetName(map, x, z) };
}

interface Built {
  diary: CitizenDiary;
  visits: number;
  foundShut: number;
  fav: { name: string; n: number } | null;
}

function build(map: CityMap, run: number, id: string, trips: Trip[], doors: Door[]): Built {
  const storeName = (sid: string) => map.stores.find((s) => s.id === sid)?.name ?? sid;
  const storeType = (sid: string): StoreType => map.stores.find((s) => s.id === sid)?.type ?? "shop";
  const persona = trips[0].a.persona;
  const arch = ARCHETYPE[persona] ?? ARCHETYPE["passer-by"];
  const r = rng(seedOf(SEED, "cast", id));
  const ageBand = pick(r, arch.ages);
  const budget = pick(r, arch.budgets);
  const loyalty = Math.round(between(r, 0.2, 0.9) * 100) / 100;
  const lightingSensitivity = Math.round(between(r, 0.2, 0.8) * 100) / 100;
  const work = persona === "commuter" ? trips.find((t) => !t.a.id.includes("~")) : undefined;
  const workEnd = work?.a.path[work.a.path.length - 1];
  // trips that start at work (lunch, home time) say nothing about where they live
  const starts = trips.filter((t) => !workEnd || Math.hypot(workEnd[1] - t.a.path[0][1], workEnd[2] - t.a.path[0][2]) >= 1).map((t) => placeOf(map, t.a.path[0][1], t.a.path[0][2]));
  const homeStart = starts.find((p) => p.kind === "home");
  const via = starts.find((p) => p.kind !== "home");

  // the diary, day by day
  const seen = new Map<string, number>();
  const shutAt = new Map<string, number>();
  const days: DiaryDay[] = [];
  let visits = 0;
  let foundShut = 0;
  for (let day = 1; day <= DAYS_PER_RUN + 1; day++) {
    const today = trips.filter((t) => t.day === day);
    if (!today.length) continue;
    const entries: DiaryEntry[] = [];
    for (const { a } of today) {
      const [t0, x0, z0] = a.path[0];
      const [t1, x1, z1] = a.path[a.path.length - 1];
      const from = placeOf(map, x0, z0);
      const to = placeOf(map, x1, z1);
      const atWork = (x: number, z: number) => !!workEnd && Math.hypot(workEnd[1] - x, workEnd[2] - z) < 1;
      if (atWork(x0, z0)) entries.push({ t: t0, kind: "arrive", place: `work (${from.name})`, note: "left work" });
      else entries.push({ t: t0, kind: "arrive", place: from.kind === "home" ? `home (${from.name})` : from.name, note: from.kind === "home" ? "left home" : `arrived via ${from.name}` });
      for (const v of a.visits) {
        const n = (seen.get(v.storeId) ?? 0) + 1;
        seen.set(v.storeId, n);
        visits++;
        entries.push({ t: v.tIn, kind: "visit", storeId: v.storeId, storeName: storeName(v.storeId), purpose: PURPOSE[storeType(v.storeId)], tOut: v.tOut, note: n > 1 ? `${ord(n)} visit` : "first visit" });
      }
      for (const s of shutStops(a.path, a.visits, doors)) {
        foundShut++;
        shutAt.set(s.storeId, (shutAt.get(s.storeId) ?? 0) + 1);
        entries.push({ t: s.t, kind: "found_shut", storeId: s.storeId, storeName: storeName(s.storeId), purpose: PURPOSE[storeType(s.storeId)], note: "walked on" });
      }
      const isWork = atWork(x1, z1);
      entries.push({ t: t1, kind: "leave", place: isWork ? `work (${to.name})` : to.kind === "home" ? `home (${to.name})` : to.name });
    }
    entries.sort((x, y) => x.t - y.t);
    const parts = entries.map((e) => {
      const at = formatHHMM(e.t);
      if (e.kind === "arrive") return `${at} ${e.note?.startsWith("left") ? `left ${e.place}` : `arrived via ${e.place}`}`;
      if (e.kind === "visit") return `${at} ${e.purpose} at ${e.storeName}, ${Math.max(1, Math.round((e.tOut ?? e.t) - e.t))} min${e.note && e.note !== "first visit" ? `, ${e.note}` : ""}`;
      if (e.kind === "found_shut") return `${at} ${e.storeName} was shut`;
      return `${at} ${e.place?.startsWith("home") ? "home" : e.place?.startsWith("work") ? "at work" : `left via ${e.place}`}`;
    });
    days.push({ day, weekday: WEEKDAY[wd(day)], summary: `${WD[wd(day)]} · ${parts.join(" · ")}`, entries });
  }

  // routine: the same kind of stop on the same weekday, at about the same time
  const slots = new Map<string, { days: Set<number>; mins: number[]; type: StoreType; w: number }>();
  for (const { a, day } of trips)
    for (const v of a.visits) {
      const type = storeType(v.storeId);
      const key = `${wd(day)}:${type}`;
      const s = slots.get(key) ?? { days: new Set<number>(), mins: [], type, w: wd(day) };
      s.days.add(day);
      s.mins.push(((v.tIn % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
      slots.set(key, s);
    }
  const routine = [...slots.values()]
    .sort((x, y) => y.days.size - x.days.size || x.w - y.w)
    .slice(0, 4)
    .map((s) => {
      const m = s.mins.sort((x, y) => x - y)[Math.floor(s.mins.length / 2)];
      return `${WD[s.w]} ~${formatHHMM(Math.round(m / 15) * 15)} ${s.days.size > 1 ? "weekly" : "once"} ${s.type === "offlicence" ? "off-licence" : s.type}`;
    });
  if (persona === "commuter") {
    const am = trips.filter((t) => !t.a.id.includes("~") && wd(t.day) < 5).map((t) => ((t.a.path[0][0] % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
    if (am.length) routine.unshift(`Mon-Fri ~${formatHHMM(Math.round(am.sort((x, y) => x - y)[Math.floor(am.length / 2)] / 15) * 15)} to the office`);
  }

  // memory: what the history says about them
  const memory: string[] = [];
  const favs = [...seen.entries()].sort((x, y) => y[1] - x[1]);
  for (const [sid, n] of favs.filter(([, n]) => n >= 3).slice(0, 2)) memory.push(`regular at ${storeName(sid)} (${n} visits)`);
  for (const [sid, n] of [...shutAt.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2)) memory.push(n >= 2 ? `avoids ${storeName(sid)} (found shut ${n}x)` : `found ${storeName(sid)} shut once`);
  if (!memory.length && favs.length) memory.push(`tried ${favs.length === 1 ? storeName(favs[0][0]) : `${favs.length} places`}, no favourite yet`);

  const citizen: CitizenProfile = {
    id,
    persona,
    profile: trips[0].a.returning ? arch.profile : persona === "night-owl" ? "event-goer" : arch.profile,
    label: `${trips[0].a.returning ? arch.label : persona === "night-owl" ? "Night out" : arch.label}, ${ageBand}`,
    occupation: persona === "night-owl" && !trips[0].a.returning ? "visitor" : arch.occupation,
    ageBand,
    budget,
    home: homeStart ? homeStart.name : "outside the area",
    arrivesVia: via?.name ?? null,
    work: workEnd ? nearestStreetName(map, workEnd[1], workEnd[2]) : null,
    loyalty,
    lightingSensitivity,
    routine,
    returning: trips[0].a.returning,
  };
  return { diary: { run, citizen, days, memory, note: CITIZEN_NOTE }, visits, foundShut, fav: favs.length ? { name: storeName(favs[0][0]), n: favs[0][1] } : null };
}

/** GET /api/runs/{run}/citizens/{id}/diary (null for unknown ids and owners). */
export function citizenDiary(map: CityMap, res: RunResult, run: number, id: string): CitizenDiary | null {
  const trips = tripsByPerson(res).get(id);
  if (!trips?.length) return null;
  return build(map, run, id, trips, storeDoors(map)).diary;
}

/**
 * GET /api/runs/{run}/citizens. Featured ids are picked from `pickFrom` (run 1: the plan, config-independent),
 * so the same people are featured in every run; their counters come from `res`.
 */
export function citizenIndex(map: CityMap, res: RunResult, run: number, pickFrom: RunResult = res): CitizenIndex {
  const doors = storeDoors(map);
  const pickTrips = tripsByPerson(pickFrom);
  const all = tripsByPerson(res);
  const regulars = [...pickTrips.entries()].filter(([, t]) => t[0].a.returning);
  const score = (t: Trip[]) => new Set(t.map((x) => x.day)).size * 2 + t.reduce((n, x) => n + x.a.visits.length, 0);
  const ids: string[] = [];
  for (const persona of ["resident", "commuter", "student", "shopper", "night-owl"]) {
    const ranked = regulars.filter(([, t]) => t[0].a.persona === persona).sort((a, b) => score(b[1]) - score(a[1]) || a[0].localeCompare(b[0], "en", { numeric: true }));
    ids.push(...ranked.slice(0, 2).map(([id]) => id));
  }
  const tourist = [...pickTrips.entries()].filter(([, t]) => t[0].a.persona === "tourist").sort((a, b) => b[1][0].a.visits.length - a[1][0].a.visits.length || a[0].localeCompare(b[0]))[0];
  if (tourist) ids.push(tourist[0]);
  const featured: CitizenCard[] = ids.flatMap((id) => {
    const trips = all.get(id);
    if (!trips?.length) return [];
    const b = build(map, run, id, trips, doors);
    const c = b.diary.citizen;
    const daysPresent = b.diary.days.filter((d) => d.day <= DAYS_PER_RUN).length;
    const who = c.label.split(",")[0];
    const where = c.home !== "outside the area" ? `from ${c.home}` : c.arrivesVia ? `in via ${c.arrivesVia}` : "from outside the area";
    const story = c.returning
      ? `${who} ${where}: ${b.visits} visits over ${daysPresent} days${b.fav && b.fav.n > 1 ? `, most often ${b.fav.name}` : ""}${b.foundShut ? `, found a shop shut ${b.foundShut}x` : ""}.`
      : `${who} ${where} on Day ${b.diary.days[0].day}: ${b.visits} stops${b.fav ? `, starting at ${b.diary.days[0].entries.find((e) => e.kind === "visit")?.storeName ?? b.fav.name}` : ""}.`;
    const headline = b.fav && b.fav.n >= 3 ? `Regular at ${b.fav.name}` : b.foundShut ? `Found ${b.foundShut === 1 ? "a shop" : `${b.foundShut} shops`} shut` : c.routine[0] ?? who;
    return [{ id, persona: c.persona, label: c.label, story, headline, daysPresent, visits: b.visits, foundShut: b.foundShut }];
  });
  let regularsN = 0;
  let visitors = 0;
  for (const t of all.values()) t[0].a.returning ? regularsN++ : visitors++;
  return { run, featured, counts: { regulars: regularsN, visitors, total: regularsN + visitors, featured: featured.length }, note: INDEX_NOTE };
}
