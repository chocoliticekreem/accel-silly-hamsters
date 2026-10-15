// Public-safety incidents in the mock (docs/INCIDENTS.md): deterministic, mostly at club closing time, the licence
// review really shuts the club in the sim, police reach the scene, and the copy stays calm and place-based.
import { describe, expect, it } from "vitest";
import { MINUTES_PER_DAY } from "../api/contract";
import type { Incident } from "../api/incidents";
import { BANNED_TERMS, callLabel, closureNights, driveMinutes, policeBase, policeRoute, responseCarAt } from "../sim/incidents";
import { storeStateAt } from "../sim/storeState";
import { buildStreetGraph } from "../sim/streetGraph";
import { createMockState, mockApi, MOCK_SEED } from ".";
import { generateIncidents } from "./incidents";

const state = createMockState();
const incidents = generateIncidents(state.map, MOCK_SEED);
const minuteOf = (t: number) => ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

describe("incident generation", () => {
  it("is deterministic per seed and independent of the map object", () => {
    expect(generateIncidents(createMockState().map, MOCK_SEED)).toEqual(incidents);
    expect(generateIncidents(structuredClone(state.map), MOCK_SEED)).toEqual(incidents);
    expect(generateIncidents(createMockState().map, 7)).not.toEqual(incidents);
  });

  it("has every kind, sorted by time, inside the run, with sane fields", () => {
    const kinds = new Set(incidents.map((i) => i.kind));
    for (const k of ["fight", "assault", "theft", "antisocial", "chase", "collision"]) expect(kinds.has(k as Incident["kind"])).toBe(true);
    incidents.forEach((i, k) => {
      if (k) expect(i.t).toBeGreaterThanOrEqual(incidents[k - 1].t);
      expect(i.day).toBe(Math.floor(i.t / MINUTES_PER_DAY) + 1);
      expect(i.day).toBeGreaterThanOrEqual(1);
      expect(i.day).toBeLessThanOrEqual(14);
      expect([1, 2, 3]).toContain(i.severity);
      expect(i.response.durationMin).toBeGreaterThan(0);
    });
    expect(new Set(incidents.map((i) => i.id)).size).toBe(incidents.length);
  });

  it("puts club fights mostly at closing time (01:00–05:00), outside a club, and Fri/Sat nights always have one", () => {
    const clubIds = new Set(state.map.stores.filter((s) => s.type === "club").map((s) => s.id));
    const venue = incidents.filter((i) => i.kind === "fight" || i.kind === "assault");
    expect(venue.length).toBeGreaterThanOrEqual(6);
    const late = venue.filter((i) => minuteOf(i.t) >= 60 && minuteOf(i.t) <= 5 * 60);
    expect(late.length / venue.length).toBeGreaterThanOrEqual(0.9);
    for (const i of venue) expect(clubIds.has(i.nearStoreId!)).toBe(true);
    // Friday night = early hours of day 6 / 13, Saturday night = day 7 / 14
    for (const day of [6, 7, 13, 14]) expect(venue.some((i) => i.day === day)).toBe(true);
    // thefts are daytime
    for (const i of incidents.filter((x) => x.kind === "theft")) expect(minuteOf(i.t)).toBeGreaterThanOrEqual(11 * 60);
  });

  it("starts venue fights inside only while the club is open", async () => {
    const stores = await mockApi(state).runStores(1);
    for (const i of incidents.filter((x) => x.insideMin)) {
      const s = storeStateAt(stores[i.nearStoreId!], [], i.t - i.insideMin!);
      expect(s.open, i.id).toBe(true);
    }
  });

  it("has one serious assault in week one: police, ambulance, cordon and a 2-night licence review", () => {
    const serious = incidents.filter((i) => i.severity === 3);
    expect(serious.length).toBeGreaterThanOrEqual(1);
    const first = serious[0];
    expect(first.kind).toBe("assault");
    expect(first.day).toBeLessThanOrEqual(7);
    expect(first.response).toMatchObject({ police: true, ambulance: true });
    expect(first.effects.closedStoreId).toBe(first.nearStoreId);
    expect(first.effects.closedDays).toBe(2);
    expect(first.effects.streetClosedMin).toBeGreaterThan(0);
    // no venue incident while it's shut
    const shut = closureNights(first);
    for (const i of incidents.filter((x) => x.nearStoreId === first.nearStoreId && x.t > first.t)) {
      const night = minuteOf(i.t) < 12 * 60 ? i.day - 1 : i.day;
      expect(shut).not.toContain(night);
    }
  });
});

describe("licence review in the mock sim", () => {
  const serious = incidents.find((i) => i.effects.closedStoreId)!;
  const club = serious.effects.closedStoreId!;
  const nights = closureNights(serious);

  it("closes the club those nights (schedule → storeState) and reopens it after", async () => {
    const api = mockApi(state);
    for (const run of [1, state.bestRun()]) {
      const r = (await api.runStores(run))[club];
      expect(r.schedule?.length).toBeGreaterThan(1);
      for (const night of nights) {
        const st = storeStateAt(r, [], (night - 1) * MINUTES_PER_DAY + 23 * 60 + 30);
        expect(st.open).toBe(false);
        expect(st.shutAllDay).toBe(true);
        expect(st.lighting).toBe("off");
      }
      // the night of the incident it was open, and the night after the closure it is again
      expect(storeStateAt(r, [], (nights[0] - 2) * MINUTES_PER_DAY + 23 * 60 + 30).open).toBe(true);
      expect(storeStateAt(r, [], (nights.at(-1)!) * MINUTES_PER_DAY + 23 * 60 + 30).open).toBe(true);
    }
  });

  it("sends nobody into the club on those nights; the night-out crowd goes to the other club", async () => {
    const res = state.result(1);
    for (const night of nights) {
      const from = (night - 1) * MINUTES_PER_DAY + 18 * 60;
      const to = night * MINUTES_PER_DAY + 8 * 60;
      const visits = [night, night + 1]
        .filter((d) => d <= 14)
        .flatMap((d) => res.days[d - 1].agents.flatMap((a) => a.visits))
        .filter((v) => v.tIn >= from && v.tIn < to);
      expect(visits.some((v) => v.storeId === club)).toBe(false);
      const other = state.map.stores.find((s) => s.type === "club" && s.id !== club)!;
      expect(visits.some((v) => v.storeId === other.id)).toBe(true);
    }
  });
});

describe("police response", () => {
  const g = buildStreetGraph(state.map.streets);
  const base = policeBase(state.map.bounds);

  it("drives along the street graph and reaches every incident it attends", () => {
    for (const i of incidents.filter((x) => x.response.police)) {
      const from: [number, number] = i.from ? [i.from.x, i.from.z] : base;
      const r = policeRoute(g, from, [i.x, i.z]);
      const end = r.points.at(-1)!;
      expect(Math.hypot(end[0] - i.x, end[1] - i.z)).toBeLessThan(0.01);
      // consecutive route points are linked graph nodes (or the short hops on/off the kerb)
      for (let k = 2; k < r.points.length - 1; k++) {
        const a = g.nearest(...r.points[k - 1]);
        const b = g.nearest(...r.points[k]);
        expect(g.adj[a].some(([n]) => n === b)).toBe(true);
      }
      const arrived = responseCarAt(i, r, i.t + driveMinutes(r) + 0.01)!;
      expect(Math.hypot(arrived.x - i.x, arrived.z - i.z)).toBeLessThan(12);
      expect(arrived.driving).toBe(false);
      expect(responseCarAt(i, r, i.t - 1)).toBeNull();
      expect(responseCarAt(i, r, i.t + i.response.durationMin)).toBeNull();
    }
  });
});

describe("responsible copy", () => {
  it("never uses graphic or person-blaming terms, and carries no personal fields", () => {
    for (const i of incidents) {
      for (const text of [i.label, callLabel(i)]) for (const w of BANNED_TERMS) expect(text.toLowerCase(), text).not.toContain(w);
      expect(Object.keys(i).sort()).toEqual(expect.arrayContaining(["id", "day", "t", "kind", "severity", "x", "z", "label", "response", "effects"]));
      for (const k of ["persona", "agentId", "personId", "age", "gender", "name"]) expect(k in i).toBe(false);
    }
  });
});
