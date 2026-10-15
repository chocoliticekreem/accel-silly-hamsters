import { describe, expect, it } from "vitest";
import type { LightLevel, RunStores, StoreRunResult } from "../api/contract";
import { mockApi } from "../mock";
import { DEMO_STEPS, demoRuns, pickDemoMoment } from "./demo";

const lights = (l: LightLevel = "off") => Array.from({ length: 24 }, () => l);
const store = (open: string, close: string, visits: number, byHour: Record<number, number> = {}, light: LightLevel = "off"): StoreRunResult => ({
  open,
  close,
  lighting: lights(light),
  kpis: { visits, kwh: 100, returnRate: 0.3 },
  visitsByHour: Array.from({ length: 24 }, (_, h) => byHour[h] ?? 0),
});

describe("pickDemoMoment", () => {
  it("picks the shop that now opens into the night, at its busiest new hour on the Saturday", () => {
    const base: RunStores = { a: store("09:00", "18:00", 500), b: store("11:00", "23:00", 300), c: store("07:00", "17:00", 200) };
    const best: RunStores = {
      a: store("08:00", "18:00", 700), // bigger gain, but daytime only
      b: store("11:00", "03:00", 420, { 0: 5, 1: 9, 2: 4 }),
      c: store("07:00", "17:00", 200),
    };
    const m = pickDemoMoment(base, best)!;
    expect(m.storeId).toBe("b");
    expect(m.night).toBe(true);
    expect(m.t).toBe(5 * 1440 + 1 * 60 + 30); // day 6, 01:30
  });

  it("falls back to the biggest changed shop at 22:30, and to null when nothing changed", () => {
    const base: RunStores = { a: store("09:00", "18:00", 500), b: store("09:00", "18:00", 300) };
    const best: RunStores = { a: store("09:00", "18:00", 520, {}, "low"), b: store("08:00", "18:00", 340) };
    expect(pickDemoMoment(base, best)).toEqual({ storeId: "b", t: 5 * 1440 + 22 * 60 + 30, night: false });
    expect(pickDemoMoment(base, base)).toBeNull();
  });

  it("skips shops the caller rules out (clubs)", () => {
    const base: RunStores = { club: store("22:00", "03:00", 900), b: store("09:00", "18:00", 300) };
    const best: RunStores = { club: store("22:00", "05:00", 1500), b: store("09:00", "20:00", 310, { 19: 3 }) };
    expect(pickDemoMoment(base, best, (id) => id !== "club")?.storeId).toBe("b");
  });

  it("finds a night opener in the mock runs", async () => {
    const api = mockApi();
    const runs = await api.runs();
    const r = demoRuns(runs, await api.analyst())!;
    expect(r.best).toBeGreaterThan(r.base);
    const m = pickDemoMoment(await api.runStores(r.base), await api.runStores(r.best));
    expect(m?.night).toBe(true);
    expect(m?.storeId).toBe("s1"); // Kebab Co, next to the club
  });
});

describe("demoRuns", () => {
  const runs = [
    { run: 1, status: "done", kpis: { visitsPerKwh: 1 } },
    { run: 2, status: "done", kpis: { visitsPerKwh: 1.3 } },
    { run: 3, status: "done", kpis: { visitsPerKwh: 1.2 } },
    { run: 4, status: "running", kpis: null },
  ];
  it("prefers the analyst's runs, else first and best finished", () => {
    expect(demoRuns(runs, { baselineRun: 1, bestRun: 3 })).toEqual({ base: 1, best: 3 });
    expect(demoRuns(runs, null)).toEqual({ base: 1, best: 2 });
    expect(demoRuns([], null)).toBeNull();
  });
  it("has the six demo-plan steps", () => {
    expect(DEMO_STEPS.map((s) => s.key)).toEqual(["analyst", "before", "shop", "after", "report", "area"]);
  });
});
