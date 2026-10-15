import { describe, expect, it } from "vitest";
import type { RunDay, StoreOverview } from "../api/contract";
import { actionRadius, dayCaption, dayCurve } from "./learningCurve";
import { doneLabel, progressLabel, sessionFinished } from "./optimiseStatus";

const day = (d: number, v: number, actions = 0): RunDay => ({ day: d, visits: 0, kwh: 0, visitsPerKwh: v, profitGbp: 0, ownerActions: actions });

describe("dayCurve", () => {
  it("sorts days and joins the baseline by day", () => {
    const pts = dayCurve([day(2, 0.6, 3), day(1, 0.5)], [day(1, 0.4), day(2, 0.45)]);
    expect(pts).toEqual([
      { day: 1, v: 0.5, base: 0.4, actions: 0 },
      { day: 2, v: 0.6, base: 0.45, actions: 3 },
    ]);
  });

  it("leaves base undefined without a baseline", () => {
    expect(dayCurve([day(1, 0.5)], null)[0].base).toBeUndefined();
  });
});

describe("actionRadius", () => {
  it("grows with actions and is capped", () => {
    expect(actionRadius(0)).toBeLessThan(actionRadius(1));
    expect(actionRadius(1)).toBeLessThan(actionRadius(4));
    expect(actionRadius(1000)).toBe(9);
  });
});

describe("dayCaption", () => {
  it("compares week 2 to week 1 and totals owner changes", () => {
    const pts = dayCurve(Array.from({ length: 14 }, (_, i) => day(i + 1, i < 7 ? 0.5 : 0.55, i === 3 ? 2 : 0)));
    expect(dayCaption(pts)).toBe("2 owner changes · week 2 vs week 1 +10% visits/kWh (owners learning inside the run)");
  });
  it("is empty with no days", () => {
    expect(dayCaption([])).toBe("");
  });
});

describe("optimise status words", () => {
  it("labels progress", () => {
    expect(progressLabel(null)).toBe("Optimising your shop");
    expect(progressLabel({ currentRun: 4, step: "ran" })).toBe("Optimising your shop · run 4 · step re-running the 14 days");
  });

  it("finishes once stopped after running, or after two polls", () => {
    expect(sessionFinished({ state: "running" }, true, 5)).toBe(false);
    expect(sessionFinished({ state: "stopped" }, true, 1)).toBe(true);
    expect(sessionFinished({ state: "stopped" }, false, 1)).toBe(false);
    expect(sessionFinished(null, false, 2)).toBe(true);
  });

  it("says the best run and the £ gain", () => {
    const o = {
      run: 6,
      bestRun: 6,
      numbers: { profitChangePerWeekGbp: 10 },
      history: [
        { run: 1, best: false, profitChangePerWeekGbp: 0 },
        { run: 5, best: true, profitChangePerWeekGbp: 93.4 },
      ],
    } as unknown as StoreOverview;
    expect(doneLabel(o)).toBe("Done: best run 5, £93/week better");
    expect(doneLabel({ ...o, history: [] })).toBe("Done: best run 6, £10/week better");
    expect(doneLabel({ ...o, history: [], numbers: { ...o.numbers, profitChangePerWeekGbp: 0 } })).toBe("Done: best run 6, nothing beat your original settings");
  });
});
