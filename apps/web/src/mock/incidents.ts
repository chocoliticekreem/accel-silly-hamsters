// Mock public-safety incidents (docs/INCIDENTS.md). Synthetic, anonymous, deterministic per seed, and the same in
// every run (fixed seed rule). Place-based: each incident is a time, a place and a response, never a person.
//
// What happens over a fortnight:
// - Fights at club closing time (mostly 02:00–04:00), far more on Thu–Sat club nights. They start inside, on the
//   dancefloor, and door staff walk them out; police attend outside.
// - One serious assault outside a club on the first Friday night: police and ambulance, a cordon on the street,
//   and a licence review that shuts the club for the next 2 nights. A rare second one may follow in week 2.
// - Thefts in busy daytime spots, antisocial behaviour on late weekend evenings, and the occasional police chase.
// Effects feed the mock sim (applyIncidents): a licence review shuts the club through its schedule, so the night-out
// crowd (and the spill-out to the takeaways) goes elsewhere; a response on scene cuts footfall on that street.
import type { CityMap, Store } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";
import type { Incident } from "../api/incidents";
import { closestOnStreet, frontage } from "../sim/geometry";
import { closureNights, licenceSchedule } from "../sim/incidents";
import { buildStreetGraph } from "../sim/streetGraph";
import { parseHHMM } from "../sim/time";
import type { OwnerBook } from "./owners";
import { between, intBetween, pick, rng, seedOf, weighted } from "./rng";

const dayStart = (day: number) => (day - 1) * MINUTES_PER_DAY;
const dow = (day: number) => (day - 1) % 7; // 0 = Monday
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Spot {
  store: Store;
  x: number;
  z: number;
  streetId: string;
}

function spotOf(map: CityMap, s: Store): Spot | null {
  const b = map.buildings.find((x) => x.id === s.buildingId);
  if (!b) return null;
  const f = frontage(b, map.streets);
  return { store: s, x: f.doorX, z: f.doorZ, streetId: f.street.id };
}

const inBounds = (map: CityMap, x: number, z: number) => x >= map.bounds.minX && x <= map.bounds.maxX && z >= map.bounds.minZ && z <= map.bounds.maxZ;

/** Minutes after midnight the club shuts (03:00 → 180); clubs without hours shut at 03:00. */
function closeAfterMidnight(s: Store): number {
  const c = s.defaultHours?.close ? parseHHMM(s.defaultHours.close) : 180;
  return c <= 12 * 60 ? c : 180;
}

const cache = new WeakMap<CityMap, Map<number, Incident[]>>();

/** The run's incidents, oldest first (cached per map and seed). */
export function generateIncidents(map: CityMap, seed: number): Incident[] {
  let m = cache.get(map);
  if (!m) cache.set(map, (m = new Map()));
  if (!m.has(seed)) m.set(seed, build(map, seed));
  return m.get(seed)!;
}

function build(map: CityMap, seed: number): Incident[] {
  const r = rng(seedOf(seed, "incidents"));
  const out: Incident[] = [];
  const clubs = map.stores
    .filter((s) => s.type === "club")
    .map((s) => spotOf(map, s))
    .filter((s): s is Spot => !!s && inBounds(map, s.x, s.z));
  const nightSpots = map.stores.filter((s) => s.type === "bar" || s.type === "offlicence" || s.type === "takeaway").map((s) => spotOf(map, s)).filter((s): s is Spot => !!s);
  const daySpots = map.stores.filter((s) => s.type === "shop" || s.type === "cafe" || s.type === "restaurant").map((s) => spotOf(map, s)).filter((s): s is Spot => !!s);
  const station = map.entryPoints.find((e) => e.kind === "station");
  const closed = new Map<string, Set<number>>(); // clubId → nights shut by a licence review
  let seq = 0;
  const push = (i: Omit<Incident, "id" | "day">) => {
    const day = Math.floor(i.t / MINUTES_PER_DAY) + 1;
    out.push({ id: `inc-${day}-${i.kind}-${++seq}`, day, ...i, x: r1(i.x), z: r1(i.z) });
  };
  const jitter = (s: Spot, m: number): [number, number] => [s.x + between(r, -m, m), s.z + between(r, -m, m)];

  // ---- club nights: fights at closing time ----
  // The first Friday night has the serious one (police, ambulance, cordon, licence review).
  // It falls on the club furthest from the demo takeaway, so the demo's spill-out story (Kebab Co) stays intact.
  const demo = map.stores.find((s) => s.name === "Kebab Co");
  const demoSpot = demo ? spotOf(map, demo) : null;
  const far = (c: Spot) => (demoSpot ? Math.hypot(c.x - demoSpot.x, c.z - demoSpot.z) : 0);
  const serious = clubs.length ? (demoSpot ? clubs.reduce((a, b) => (far(b) > far(a) ? b : a)) : pick(r, clubs)) : null;
  const clubIncident = (c: Spot, night: number, forced: boolean) => {
    const close = closeAfterMidnight(c.store);
    // Most start inside in the last hour before close and are walked out; some flare up in the spill-out after it.
    const inside = forced || r() < 0.65;
    const minute = forced ? close - 25 : inside ? close - between(r, 10, 70) : close + between(r, 2, 40);
    const t = Math.round(dayStart(night + 1) + minute);
    // week 2 can (rarely) bring a second serious one, if it fits before the run ends
    const sev = forced ? 3 : ((weighted(r, [0.66, 0.29, night >= 8 && night <= 11 ? 0.05 : 0]) + 1) as 1 | 2 | 3);
    const [x, z] = jitter(c, 3);
    const name = c.store.name;
    if (sev === 3) {
      const inc: Omit<Incident, "id" | "day"> = {
        t,
        kind: "assault",
        severity: 3,
        x,
        z,
        streetId: c.streetId,
        nearStoreId: c.store.id,
        label: `Serious assault outside ${name}`,
        response: { police: true, ambulance: true, durationMin: intBetween(r, 140, 190) },
        effects: { closedStoreId: c.store.id, closedDays: 2, footfallDrop: 0.4, streetClosedMin: intBetween(r, 100, 140) },
        insideMin: 9,
      };
      push(inc);
      const nights = closureNights({ ...inc, id: "", day: Math.floor(t / MINUTES_PER_DAY) + 1 });
      closed.set(c.store.id, new Set([...(closed.get(c.store.id) ?? []), ...nights]));
      return;
    }
    push({
      t,
      kind: "fight",
      severity: sev,
      x,
      z,
      streetId: c.streetId,
      nearStoreId: c.store.id,
      label: `Fight outside ${name}`,
      response: { police: true, ambulance: sev === 2 && r() < 0.4, durationMin: sev === 2 ? intBetween(r, 50, 80) : intBetween(r, 25, 45) },
      effects: sev === 2 ? { footfallDrop: 0.15 } : {},
      insideMin: inside ? intBetween(r, 4, 7) : null,
    });
  };
  for (let night = 1; night < DAYS_PER_RUN; night++) {
    const d = dow(night);
    const open = clubs.filter((c) => !closed.get(c.store.id)?.has(night));
    let any = false;
    for (const c of open) {
      const forced = serious === c && night === 5;
      const p = d === 5 ? 0.75 : d === 4 ? 0.6 : d === 3 ? 0.4 : 0.08; // Sat, Fri, Thu, other nights
      if (!forced && r() >= p) continue;
      any = true;
      clubIncident(c, night, forced);
    }
    // Friday and Saturday nights always see at least one
    if (!any && (d === 4 || d === 5) && open.length) clubIncident(pick(r, open), night, false);
  }

  // ---- late weekend evenings: antisocial behaviour near bars and off-licences ----
  for (let day = 1; day <= DAYS_PER_RUN; day++) {
    const d = dow(day);
    if (!nightSpots.length || (d < 4 ? r() > 0.12 : r() > 0.55)) continue;
    const s = pick(r, nightSpots);
    const [x, z] = jitter(s, 6);
    const police = r() < 0.5;
    push({
      t: Math.round(dayStart(day) + between(r, 22.5, 24.8) * 60),
      kind: "antisocial",
      severity: 1,
      x,
      z,
      streetId: s.streetId,
      nearStoreId: s.store.id,
      label: `Noise and antisocial behaviour near ${s.store.name}`,
      response: { police, ambulance: false, durationMin: intBetween(r, 15, 30) },
      effects: {},
    });
  }

  // ---- daytime: thefts where it's busy (shops, cafés, the station) ----
  for (let day = 1; day <= DAYS_PER_RUN; day++) {
    const n = dow(day) >= 5 ? intBetween(r, 1, 2) : r() < 0.55 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const atStation = station && r() < 0.25;
      const s = pick(r, daySpots);
      if (!atStation && !s) continue;
      const [x, z] = atStation ? [station!.x + between(r, -8, 8), station!.z - 14 + between(r, -4, 4)] : jitter(s, 4);
      push({
        t: Math.round(dayStart(day) + between(r, 11, 18.5) * 60),
        kind: "theft",
        severity: 1,
        x,
        z,
        streetId: atStation ? null : s.streetId,
        nearStoreId: atStation ? null : s.store.id,
        label: atStation ? `Phone theft reported at ${station!.name ?? "the station"}` : `Theft reported near ${s.store.name}`,
        response: { police: true, ambulance: false, durationMin: intBetween(r, 15, 25) },
        effects: {},
      });
    }
  }

  // ---- police chases: one each week, late evening, from the map edge to a stop inside ----
  const streets = map.streets.filter((s) => s.width >= 10 && s.points.length >= 2);
  for (const day of [3 + intBetween(r, 0, 1), 10 + intBetween(r, 0, 2)]) {
    if (!streets.length || day > DAYS_PER_RUN) continue;
    const a = pick(r, streets);
    const end = a.points[r() < 0.5 ? 0 : a.points.length - 1];
    const b = pick(r, streets.filter((s) => s.id !== a.id).length ? streets.filter((s) => s.id !== a.id) : streets);
    // stop roughly midway along another street, inside the map
    const mid = b.points[Math.floor(b.points.length / 2)];
    const k = between(r, 0.3, 0.7);
    const p0 = b.points[0];
    const p1 = b.points[b.points.length - 1];
    const [x, z] = b.points.length === 2 ? [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k] : mid;
    push({
      t: Math.round(dayStart(day) + between(r, 22.5, 25.5) * 60),
      kind: "chase",
      severity: 2,
      x,
      z,
      streetId: b.id,
      nearStoreId: null,
      label: `Police pursuit ends on ${b.name}`,
      response: { police: true, ambulance: false, durationMin: intBetween(r, 35, 50) },
      effects: { footfallDrop: 0.1, streetClosedMin: 20 },
      from: { x: r1(end[0]), z: r1(end[1]) },
    });
  }

  // ---- road traffic collisions at junctions: a few a fortnight, mostly rush hour or late at night ----
  const g = buildStreetGraph(map.streets);
  const junctions = g.nodes
    .map((p, n) => ({ p, n }))
    .filter(({ p, n }) => g.adj[n].length >= 3 && inBounds(map, p[0], p[1]))
    .map(({ p }) => {
      const near = map.streets
        .map((s) => ({ s, d: closestOnStreet(s, p[0], p[1])[2] }))
        .filter((x) => x.d < 3)
        .sort((a, b) => b.s.width - a.s.width || a.s.name.localeCompare(b.s.name));
      return { p, streets: near.map((x) => x.s) };
    })
    .filter((j) => j.streets.length >= 2);
  const crashes = junctions.length ? intBetween(r, 3, 5) : 0;
  for (let k = 0; k < crashes; k++) {
    const day = intBetween(r, 1, DAYS_PER_RUN);
    const weekday = dow(day) < 5;
    // rush hour on weekdays, otherwise late night
    const hour = weekday && r() < 0.6 ? (r() < 0.5 ? between(r, 7.5, 9.5) : between(r, 17, 19)) : between(r, 22.5, 26.5);
    // busier junctions (wider roads) more often
    const j = junctions[weighted(r, junctions.map((x) => x.streets[0].width + x.streets[1].width - 16 + 1))];
    const sev = r() < 0.3 ? 2 : 1;
    const main = j.streets[0];
    push({
      t: Math.round(dayStart(day) + hour * 60),
      kind: "collision",
      severity: sev,
      x: j.p[0] + between(r, -4, 4),
      z: j.p[1] + between(r, -4, 4),
      streetId: main.id,
      nearStoreId: null,
      label: `Collision at ${main.name} / ${j.streets[1].name}`,
      response: { police: true, ambulance: sev === 2, durationMin: intBetween(r, 35, 70) },
      effects: { footfallDrop: 0.2, streetClosedMin: intBetween(r, 25, 50) },
    });
  }

  return out.filter((i) => i.t < DAYS_PER_RUN * MINUTES_PER_DAY).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

/** Street footfall cuts while a response is on scene (or the street is cordoned), in the mock sim's streetCuts shape. */
export function incidentStreetCuts(incidents: readonly Incident[]): Map<string, { fromT: number; toT: number; factor: number }[]> {
  const out = new Map<string, { fromT: number; toT: number; factor: number }[]>();
  for (const i of incidents) {
    const drop = i.effects.footfallDrop ?? 0;
    if (!i.streetId || drop <= 0) continue;
    const mins = Math.max(i.response.durationMin, i.effects.streetClosedMin ?? 0);
    out.set(i.streetId, [...(out.get(i.streetId) ?? []), { fromT: i.t, toT: i.t + mins, factor: 1 - drop }]);
  }
  return out;
}

/**
 * Feeds the incidents into a mock run: licence reviews shut the club through its schedule (the same path owners'
 * closed days take, so 3D, UI and customers agree) and responses on scene cut footfall on their street.
 */
export function applyIncidents(book: OwnerBook, streetCuts: Map<string, { fromT: number; toT: number; factor: number }[]>, incidents: readonly Incident[]) {
  const nights = new Map<string, number[]>();
  for (const i of incidents) {
    const n = closureNights(i);
    if (n.length) nights.set(i.effects.closedStoreId!, [...(nights.get(i.effects.closedStoreId!) ?? []), ...n]);
  }
  for (const [id, list] of nights) {
    const shop = book.byId.get(id);
    if (!shop) continue;
    shop.src.schedule = licenceSchedule({ open: shop.src.open, close: shop.src.close }, list);
    shop.spans = [];
  }
  for (const [street, cuts] of incidentStreetCuts(incidents)) streetCuts.set(street, [...(streetCuts.get(street) ?? []), ...cuts]);
}
