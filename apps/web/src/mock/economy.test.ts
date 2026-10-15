import { describe, expect, it } from "vitest";
import { DAYS_PER_RUN } from "../api/contract";
import type { PersonDay } from "../api/economy";
import { createMockState } from ".";
import { citizenDiary, citizenIndex } from "./citizens";
import { economyFor, forkRun, headlinesFor, mockEconomyApi, personStory, replayLedger } from "./economy";

const state = createMockState();
const econ = economyFor(state);
const RUN = 1;
const res = state.result(RUN);
const money = econ.money(RUN);

describe("owners are people", () => {
  it("gives every non-club shop exactly one owner who walks in, works, and walks home", () => {
    const shops = state.map.stores.filter((s) => s.type !== "club");
    expect(res.owners.map((o) => o.storeId).sort()).toEqual(shops.map((s) => s.id).sort());
    for (const d of res.days) {
      const owners = (d.agents as PersonDay[]).filter((a) => a.role === "owner");
      expect(new Set(owners.map((o) => o.id)).size).toBe(owners.length);
      for (const o of owners) {
        expect(o.persona).toBe("owner");
        expect(o.visits).toHaveLength(1);
        expect(o.visits[0].storeId).toBe(o.worksAt);
        // arrives before (or as) the shop opens; the trip starts and ends at home
        expect(o.path[0][0]).toBeLessThanOrEqual(o.visits[0].tIn);
        expect(o.path[0].slice(1)).toEqual(o.path[o.path.length - 1].slice(1));
      }
    }
  });

  it("keeps owners out of the customer numbers", () => {
    const visits = res.days.flatMap((d) => (d.agents as PersonDay[]).filter((a) => a.role !== "owner").flatMap((a) => a.visits));
    const shopIds = new Set(state.map.stores.filter((s) => s.type !== "club").map((s) => s.id));
    expect(visits.filter((v) => shopIds.has(v.storeId)).length).toBe(res.kpis.visits);
  });
});

describe("owner money", () => {
  it("replays the ledger to the daily balances exactly", () => {
    for (const o of money.owners) {
      const r = replayLedger(money.ledger, o.storeId, o.business.startGbp, o.personal.startGbp);
      expect(r.business).toEqual(o.business.daily);
      expect(r.personal).toEqual(o.personal.daily);
      expect(o.business.daily).toHaveLength(DAYS_PER_RUN);
      expect(o.business.endGbp).toBe(o.business.daily[DAYS_PER_RUN - 1]);
    }
  });

  it("totals match the ledger and drawings move money from business to personal", () => {
    for (const o of money.owners) {
      const rows = money.ledger.filter((e) => e.storeId === o.storeId);
      const sum = (k: string, acc = "business") => Math.round(rows.filter((e) => e.kind === k && e.account === acc).reduce((n, e) => n + e.amountGbp * 100, 0));
      expect(sum("sale")).toBe(Math.round(o.totals.takingsGbp * 100));
      expect(-sum("energy")).toBe(Math.round(o.totals.energyGbp * 100));
      expect(-sum("drawings")).toBe(sum("drawings", "personal"));
      expect(["trading", "cautious", "bust"]).toContain(o.status);
    }
  });

  it("charges takings from the run's own customer visits", () => {
    const o = money.owners[0];
    const visits = res.days.flatMap((d) => (d.agents as PersonDay[]).filter((a) => a.role !== "owner").flatMap((a) => a.visits)).filter((v) => v.storeId === o.storeId).length;
    expect(visits).toBe(res.stores[o.storeId].kpis.visits);
    expect(o.totals.takingsGbp).toBeGreaterThanOrEqual(0);
  });
});

describe("life stories", () => {
  it("writes 3–5 plain sentences for an owner, about their own shop only", () => {
    const o = res.owners[0];
    const s = personStory(state.map, res, money, o.personId)!;
    expect(s.role).toBe("owner");
    expect(s.story.length).toBeGreaterThanOrEqual(3);
    expect(s.story.length).toBeLessThanOrEqual(5);
    expect(s.story.join(" ")).toContain(state.map.stores.find((x) => x.id === o.storeId)!.name);
    // owner-scoped: no other shop is named
    for (const other of state.map.stores.filter((x) => x.id !== o.storeId)) expect(s.story.join(" ")).not.toContain(other.name);
    expect(s.visits.every((v) => v.storeId === o.storeId)).toBe(true);
    expect(s.balance!.daily).toHaveLength(DAYS_PER_RUN);
  });

  it("writes a non-empty story for a regular and a one-off visitor", () => {
    const regular = personStory(state.map, res, money, "r1")!;
    expect(regular.role).toBe("citizen");
    expect(regular.story.length).toBeGreaterThanOrEqual(2);
    const oneOff = res.days[0].agents.find((a) => a.id.startsWith("v1-tourist"))!;
    const s = personStory(state.map, res, money, oneOff.id)!;
    expect(s.story.length).toBeGreaterThanOrEqual(2);
    expect(s.story.every((l) => l.length > 10 && !/undefined|NaN/.test(l))).toBe(true);
    expect(personStory(state.map, res, money, "nobody")).toBeNull();
  });
});

describe("headlines", () => {
  it("one plain line per day", () => {
    const h = headlinesFor(state.map, res);
    expect(h.map((x) => x.day)).toEqual(Array.from({ length: DAYS_PER_RUN }, (_, i) => i + 1));
    for (const x of h) {
      expect(x.text.length).toBeGreaterThan(10);
      expect(x.text).not.toMatch(/\n|undefined|NaN/);
    }
    // the mock's first roadworks (Day 3) makes the news
    expect(h[2].text).toMatch(/dug up/);
  });
});

describe("interventions fork the same seed", () => {
  const fresh = state; // forks are added to the same state: fewer simulations, same checks
  const api = mockEconomyApi(fresh);
  const base = fresh.result(RUN);
  const sig = (day: number, r = base) => JSON.stringify(r.days[day - 1].agents);

  it("energy price: same people and shops, only the energy bill doubles", async () => {
    const run = forkRun(fresh, { kind: "energy_price", params: { factor: 2 } }, RUN);
    const f = fresh.result(run);
    expect(f.kpis).toEqual(base.kpis);
    for (let d = 1; d <= DAYS_PER_RUN; d++) expect(sig(d, f)).toBe(sig(d));
    const a = (await api.owners(RUN))[0];
    const b = (await api.owners(run))[0];
    expect(b.totals.takingsGbp).toBe(a.totals.takingsGbp);
    expect(b.totals.rentGbp).toBe(a.totals.rentGbp);
    expect(Math.abs(b.totals.energyGbp - 2 * a.totals.energyGbp)).toBeLessThan(0.01 * DAYS_PER_RUN);
  });

  it("roadworks from Day 6: days before are identical, the works hit that street", () => {
    const street = fresh.map.streets.find((s) => s.id === "old-st")!;
    const run = forkRun(fresh, { kind: "roadworks", params: { streetId: street.id, fromDay: 6, days: 2 } }, RUN);
    const f = fresh.result(run);
    for (let d = 1; d <= 5; d++) expect(sig(d, f)).toBe(sig(d));
    expect(f.streetEvents.filter((e) => e.kind === "roadworks" && e.streetId === street.id && e.day === 6)).toHaveLength(1);
    expect(f.streetEvents.length).toBe(base.streetEvents.length + 1);
  });

  it("station closed on Day 9: nobody arrives at the station that day, earlier days unchanged", () => {
    const run = forkRun(fresh, { kind: "station_closed", params: { day: 9 } }, RUN);
    const f = fresh.result(run);
    for (let d = 1; d <= 8; d++) expect(sig(d, f)).toBe(sig(d));
    const st = fresh.map.entryPoints.find((e) => e.kind === "station")!;
    const fromStation = (r: typeof base, d: number) => r.days[d - 1].agents.filter((a) => Math.hypot(a.path[0][1] - st.x, a.path[0][2] - st.z) < 5).length;
    expect(fromStation(base, 9)).toBeGreaterThan(0);
    expect(fromStation(f, 9)).toBe(0);
    expect(f.days[8].agents.length).toBeLessThan(base.days[8].agents.length);
  });

  it("rain thins the crowd only on the rainy days", () => {
    const run = forkRun(fresh, { kind: "rain", params: { fromDay: 8, days: 7 } }, RUN);
    const f = fresh.result(run);
    for (let d = 1; d <= 7; d++) expect(sig(d, f)).toBe(sig(d));
    expect(f.days[9].agents.length).toBeLessThan(base.days[9].agents.length * 0.8);
  });

  it("forks are listed in /runs with their intervention", () => {
    const runs = fresh.runs() as (ReturnType<typeof fresh.runs>[number] & { intervention?: { kind: string } })[];
    expect(runs.filter((r) => r.intervention).map((r) => r.intervention!.kind)).toEqual(["energy_price", "roadworks", "station_closed", "rain"]);
  });
});

describe("citizens (docs/CITIZENS.md)", () => {
  it("features the same regulars in every run, with plain one-line stories", () => {
    const a = citizenIndex(state.map, res, RUN, state.result(1));
    const b = citizenIndex(state.map, state.result(1), 1);
    expect(a.featured.length).toBeGreaterThanOrEqual(8);
    expect(a.featured.map((c) => c.id)).toEqual(b.featured.map((c) => c.id));
    for (const c of a.featured) {
      expect(c.story).toMatch(/^[A-Z].+\.$/);
      expect(c.story).not.toMatch(/undefined|NaN|\n/);
      expect(c.daysPresent).toBeGreaterThan(0);
    }
    expect(a.note).toMatch(/not real people/);
  });

  it("writes a diary from the person's own trips", () => {
    const d = citizenDiary(state.map, res, RUN, "r1")!;
    expect(d.citizen.id).toBe("r1");
    expect(d.note).toBe("Simulated, not a real person.");
    expect(d.days.length).toBeGreaterThan(0);
    const visits = res.days.flatMap((x) => x.agents.filter((a) => a.id.split("~")[0] === "r1").flatMap((a) => a.visits));
    const diaryVisits = d.days.flatMap((x) => x.entries.filter((e) => e.kind === "visit"));
    expect(diaryVisits.length).toBeLessThanOrEqual(visits.length);
    expect(diaryVisits.length).toBeGreaterThan(0);
    for (const day of d.days) {
      expect(day.summary.length).toBeGreaterThan(5);
      expect(day.entries.map((e) => e.t)).toEqual([...day.entries.map((e) => e.t)].sort((x, y) => x - y));
    }
    expect(citizenDiary(state.map, res, RUN, res.owners[0].personId)).toBeNull();
  });
});
