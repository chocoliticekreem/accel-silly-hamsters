// Mock street events: what owners (and citizens) react to. Deterministic per seed and the same in every run
// (fixed seed rule: runs differ only because of decisions). See docs/OWNER_ACTIONS.md.
import type { CityMap, StreetEvent } from "../api/contract";
import { MINUTES_PER_DAY, DAYS_PER_RUN } from "../api/contract";
import { frontage } from "../sim/geometry";
import { demoRoles } from "./roles";
import { between, intBetween, pick, rng, seedOf } from "./rng";

const dayStart = (day: number) => (day - 1) * MINUTES_PER_DAY;
const isWeekday = (day: number) => (day - 1) % 7 < 5;

/** storeId → the street its door opens onto. */
export function storeStreets(map: CityMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of map.stores) {
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (b) out.set(s.id, frontage(b, map.streets).street.id);
  }
  return out;
}

export function generateStreetEvents(map: CityMap, seed: number): StreetEvent[] {
  const r = rng(seedOf(seed, "street-events"));
  const streetOf = storeStreets(map);
  const name = (id: string) => map.streets.find((s) => s.id === id)?.name ?? id;
  const out: StreetEvent[] = [];

  // roadworks: 1–2 blocks of 1–3 days on shopping streets. The first sits outside the demo takeaway, mid-week one.
  const shopsOn = (id: string) => map.stores.filter((s) => s.type !== "club" && streetOf.get(s.id) === id).length;
  const kebab = demoRoles(map).takeaway;
  const busy = [...new Set(streetOf.values())].filter((id) => shopsOn(id) >= 2).sort();
  const first = (kebab && streetOf.get(kebab.id)) || pick(r, busy);
  const works: { street: string; start: number; days: number }[] = [{ street: first, start: 3, days: intBetween(r, 1, 3) }];
  const others = busy.filter((id) => id !== first);
  if (others.length && r() < 0.75) works.push({ street: pick(r, others), start: intBetween(r, 8, 11), days: intBetween(r, 1, 3) });
  for (const w of works) {
    const last = Math.min(DAYS_PER_RUN, w.start + w.days - 1);
    out.push({
      day: w.start,
      fromT: dayStart(w.start) + 7 * 60,
      toT: dayStart(last) + 19 * 60,
      kind: "roadworks",
      streetId: w.street,
      label: `Roadworks, ${name(w.street)}`,
      severity: Math.round(between(r, 0.5, 0.7) * 100) / 100,
    });
  }

  // heavy traffic: weekday rush hours on the main roads (the widest streets)
  const mains = map.streets.filter((s) => s.width >= 12).map((s) => s.id);
  for (let day = 1; day <= DAYS_PER_RUN; day++) {
    if (!isWeekday(day)) continue;
    for (const id of mains)
      for (const [from, to] of [
        [7.5, 9.5],
        [17, 19],
      ])
        out.push({
          day,
          fromT: dayStart(day) + from * 60,
          toT: dayStart(day) + to * 60,
          kind: "heavy_traffic",
          streetId: id,
          label: `Heavy traffic, ${name(id)}`,
          severity: Math.round(between(r, 0.3, 0.45) * 100) / 100,
        });
  }

  // club nights: Thursday to Saturday, 22:00 till 04:00
  for (let day = 1; day <= DAYS_PER_RUN; day++) {
    const dow = (day - 1) % 7;
    if (dow < 3 || dow > 5) continue;
    for (const c of map.stores.filter((s) => s.type === "club"))
      out.push({
        day,
        fromT: dayStart(day) + 22 * 60,
        toT: dayStart(day + 1) + 4 * 60,
        kind: "club_night",
        streetId: streetOf.get(c.id) ?? null,
        label: `Club night, ${c.name}`,
        severity: dow === 5 ? 0.8 : 0.6,
      });
  }

  return out.sort((a, b) => a.fromT - b.fromT || a.kind.localeCompare(b.kind));
}
