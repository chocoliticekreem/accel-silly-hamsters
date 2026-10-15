// Mock owners adapting day by day (docs/OWNER_ACTIONS.md): deterministic, licence-safe, and what the
// simulated customers find matches what storeStateAt (the 3D world and UI) shows.
import { describe, expect, it } from "vitest";
import { MINUTES_PER_DAY } from "../api/contract";
import { daySpan, eventsByStore, storeStateAt, toSpan } from "../sim/storeState";
import { schematicMockState, mockApi } from ".";
import { MOCK_RUN_COUNT } from "./configs";

const state = schematicMockState();
const api = mockApi(state);
const kebab = () => state.map.stores.find((s) => s.name === "Kebab Co")!;

describe("street events", () => {
  it("are deterministic and the same in every run (fixed seed)", async () => {
    const other = mockApi(schematicMockState());
    const a = await api.streetEvents(1);
    expect(a).toEqual(await other.streetEvents(1));
    expect(a).toEqual(await api.streetEvents(4));
  });

  it("include roadworks on a real street for 1–3 days, weekday rush hours and Thu–Sat club nights", async () => {
    const ev = await api.streetEvents(1);
    const works = ev.filter((e) => e.kind === "roadworks");
    expect(works.length).toBeGreaterThanOrEqual(1);
    expect(works.length).toBeLessThanOrEqual(2);
    for (const w of works) {
      expect(state.map.streets.some((s) => s.id === w.streetId)).toBe(true);
      const days = Math.floor(w.toT / MINUTES_PER_DAY) - Math.floor(w.fromT / MINUTES_PER_DAY) + 1;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(3);
    }
    for (const e of ev.filter((x) => x.kind === "heavy_traffic")) expect((e.day - 1) % 7).toBeLessThan(5);
    for (const e of ev.filter((x) => x.kind === "club_night")) expect([3, 4, 5]).toContain((e.day - 1) % 7);
    for (const e of ev) {
      expect(e.toT).toBeGreaterThan(e.fromT);
      expect(e.severity).toBeGreaterThan(0);
      expect(e.severity).toBeLessThanOrEqual(1);
    }
  });
});

describe("owner events", () => {
  it("are deterministic", async () => {
    const other = mockApi(schematicMockState());
    for (const run of [1, 3]) expect(await api.ownerEvents(run)).toEqual(await other.ownerEvents(run));
  });

  it("come oldest first, each with a one-sentence owner reason (no emoji)", async () => {
    for (let run = 1; run <= MOCK_RUN_COUNT; run++) {
      const ev = await api.ownerEvents(run);
      expect(ev.length).toBeGreaterThan(0);
      for (let i = 1; i < ev.length; i++) expect(ev[i].t).toBeGreaterThanOrEqual(ev[i - 1].t);
      for (const e of ev) {
        expect(e.reason).toMatch(/^[A-Z][^.]*\.$/);
        expect(e.reason.length).toBeLessThan(90);
        expect(e.reason).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
        expect(e.day).toBe(Math.floor(e.t / MINUTES_PER_DAY) + 1);
      }
    }
  });

  it("a roadworks day makes owners on that street shut early, with roadworks as the reason", async () => {
    const works = (await api.streetEvents(1)).filter((e) => e.kind === "roadworks");
    const ev = await api.ownerEvents(1);
    const stores = await api.runStores(1);
    for (const w of works) {
      const shut = ev.filter((e) => e.day === w.day && e.action === "shut_early" && e.trigger?.kind === "roadworks");
      expect(shut.length, w.label).toBeGreaterThan(0);
      // the shop really is shut in 3D (and in the sim) an hour after it said so
      const e = shut[0];
      const s = storeStateAt(stores[e.storeId], eventsByStore(ev).get(e.storeId)!, e.t + 60);
      expect(s.open).toBe(false);
      expect(s.reason).toMatch(/Roadworks/);
    }
    // the demo story: Kebab Co is on the first roadworks street
    expect(ev.some((e) => e.storeId === kebab().id && e.action === "shut_early" && e.day === works[0].day)).toBe(true);
  });

  it("Kebab Co learns the club crowd: stays open late on club nights in run 1", async () => {
    const ev = (await api.ownerEvents(1)).filter((e) => e.storeId === kebab().id && e.action === "open_late");
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) expect([3, 4, 5]).toContain((e.day - 1) % 7); // Thu–Sat
  });

  it("never closes a shop for good in run 1", async () => {
    expect((await api.ownerEvents(1)).some((e) => e.action === "closed_permanently")).toBe(false);
    expect(Object.values(await api.runStores(1)).every((s) => !s.closedFromDay)).toBe(true);
  });
});

describe("adaptations respect the hard rules", () => {
  it("never open outside the licence, on any day of any run", async () => {
    for (let run = 1; run <= MOCK_RUN_COUNT; run++) {
      const stores = await api.runStores(run);
      const by = eventsByStore(await api.ownerEvents(run));
      for (const s of state.map.stores) {
        const lic = toSpan(s.licensedHours!)!;
        for (let day = 0; day <= 15; day++) {
          const span = daySpan(stores[s.id], by.get(s.id) ?? [], day);
          if (!span) continue;
          expect(span.o, `${s.name} run ${run} day ${day} opens`).toBeGreaterThanOrEqual(lic.o);
          expect(span.c, `${s.name} run ${run} day ${day} closes`).toBeLessThanOrEqual(lic.c);
        }
      }
    }
  });

  it("customers only ever got into shops that storeStateAt shows as open", async () => {
    for (const run of [1, 4]) {
      const stores = await api.runStores(run);
      const by = eventsByStore(await api.ownerEvents(run));
      for (let day = 1; day <= 14; day++)
        for (const a of state.result(run).days[day - 1].agents.filter((x) => (x as { role?: string }).role !== "owner")) // owners open up: not customers
          for (const v of a.visits) {
            if (state.map.stores.find((s) => s.id === v.storeId)!.type === "club") continue;
            expect(storeStateAt(stores[v.storeId], by.get(v.storeId) ?? [], v.tIn - 0.05).open, `${v.storeId} run ${run} t ${v.tIn}`).toBe(true);
          }
    }
  });

  it("serves the evolving schedule on each shop's results", async () => {
    const stores = await api.runStores(1);
    const k = stores[kebab().id];
    expect(k.schedule?.[0]).toMatchObject({ fromDay: 1 });
    expect(k.schedule![0].week).toHaveLength(7);
    expect(k.closedFromDay).toBeNull();
    // somebody changed their weekly hours during run 1
    expect(Object.values(stores).some((s) => (s.schedule?.length ?? 0) > 1)).toBe(true);
  });
});
