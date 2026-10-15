import { describe, expect, it } from "vitest";
import { ApiError, DAYS_PER_RUN, type DayData, type OwnerEvent } from "../api/contract";
import { countOwnerChanges } from "../api/overviewFallback";
import { GBP_PER_KWH, marginPerVisit } from "../sim/economics";
import { createMockState, mockApi } from ".";
import { aggregateDaily } from "./daily";
import { OPTIMISE_MS, optimiseProgress } from "./optimise";

const visit = (storeId: string) => ({ storeId, tIn: 0, tOut: 10 });
const agent = (id: string, stores: string[]) => ({ id, persona: "resident", returning: false, path: [], visits: stores.map(visit) });
const ev = (day: number, storeId: string): OwnerEvent => ({ day, t: day * 1440, storeId, action: "hours_changed", reason: "" });

describe("aggregateDaily", () => {
  const days: DayData[] = [
    { day: 1, agents: [agent("a", ["cafe1", "club1"]), agent("b", ["take1"])] },
    { day: 2, agents: [agent("c", ["cafe1"])] },
  ];
  const out = aggregateDaily({
    days,
    kwhByDay: { cafe1: [10, 12], take1: [5, 0], club1: [100, 100] },
    types: { cafe1: "cafe", take1: "takeaway", club1: "club" },
    ownerEvents: [ev(1, "cafe1"), ev(2, "cafe1"), ev(2, "take1"), ev(2, "club1")],
  });

  it("counts shop visits and kWh per day, leaving clubs out", () => {
    expect(out.map((d) => d.day)).toEqual([1, 2]);
    expect(out[0].visits).toBe(2);
    expect(out[0].kwh).toBe(15);
    expect(out[1].visits).toBe(1);
    expect(out[1].kwh).toBe(12);
    expect(out[0].visitsPerKwh).toBeCloseTo(2 / 15, 2);
  });

  it("profit is margin on visits minus energy", () => {
    const want = marginPerVisit("cafe") + marginPerVisit("takeaway") - 15 * GBP_PER_KWH;
    expect(out[0].profitGbp).toBeCloseTo(want, 2);
  });

  it("counts owner actions per day (shops only)", () => {
    expect(out.map((d) => d.ownerActions)).toEqual([1, 2]);
  });
});

describe("mock summary.daily", () => {
  const state = createMockState();
  const api = mockApi(state);

  it("has 14 days that add up to the run totals", async () => {
    const s = (await api.summary(1))!;
    expect(s.daily).toHaveLength(DAYS_PER_RUN);
    expect(s.daily!.map((d) => d.day)).toEqual(Array.from({ length: DAYS_PER_RUN }, (_, i) => i + 1));
    expect(s.daily!.reduce((n, d) => n + d.visits, 0)).toBe(s.kpis.visits);
    expect(Math.abs(s.daily!.reduce((n, d) => n + d.kwh, 0) - s.kpis.kwh)).toBeLessThan(DAYS_PER_RUN);
    const shopEvents = state.result(1).ownerEvents.filter((e) => state.map.stores.find((x) => x.id === e.storeId)?.type !== "club");
    expect(s.daily!.reduce((n, d) => n + d.ownerActions, 0)).toBe(shopEvents.length);
  });

  it("overview carries the shop's owner change count", async () => {
    const shop = state.map.stores.find((s) => s.type !== "club")!;
    const o = (await api.overview(shop.id))!;
    const events = state.result(o.run).ownerEvents;
    if (events.length) expect(o.ownerChanges).toBe(countOwnerChanges(events, shop.id));
    else expect(o.ownerChanges).toBeUndefined();
  });
});

describe("countOwnerChanges", () => {
  it("counts only this shop, undefined when not served", () => {
    expect(countOwnerChanges([ev(1, "a"), ev(2, "b"), ev(3, "a")], "a")).toBe(2);
    expect(countOwnerChanges(null, "a")).toBeUndefined();
  });
});

describe("mock optimise session", () => {
  it("runs through the loop and stops at the best run", () => {
    const start = optimiseProgress(0, 6);
    expect(start.state).toBe("running");
    expect(start.currentRun).toBe(4);
    expect(start.step).toBe("proposed");
    const mid = optimiseProgress(OPTIMISE_MS * 0.7, 6);
    expect(mid.state).toBe("running");
    expect(mid.currentRun).toBe(6);
    const end = optimiseProgress(OPTIMISE_MS, 6);
    expect(end).toMatchObject({ state: "stopped", bestRun: 6, currentRun: 6, stoppedReason: "threshold" });
  });

  it("copes with a best run of 2", () => {
    expect(optimiseProgress(0, 2).currentRun).toBe(2);
    expect(optimiseProgress(OPTIMISE_MS + 1, 2).runsThisSession).toEqual([2]);
  });

  it("the mock api answers 409 while a session runs and shows it running", async () => {
    const api = mockApi(createMockState());
    const s = await api.optimize("s1");
    expect(s.state).toBe("running");
    expect((await api.agentSession())!.state).toBe("running");
    expect((await api.analyst()).state).toBe("running");
    await expect(api.optimize("s1")).rejects.toBeInstanceOf(ApiError);
  });
});
