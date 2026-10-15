import { describe, expect, it } from "vitest";
import type { AgentDay } from "../api/contract";
import { DAYS_PER_RUN, RUN_MINUTES } from "../api/contract";
import { clockSeconds, crowdSize, legIsStale, legsAround, legsOf, pickLeg, pickOpenLeg, walkStep } from "./footfall";
import { prepareAgents } from "./interp";

/** 14 days × 24 hours of zeros, with `set` overriding [day - 1][hour]. */
function table(set: Record<string, number> = {}): number[][] {
  const t = Array.from({ length: DAYS_PER_RUN }, () => Array<number>(24).fill(0));
  for (const [k, v] of Object.entries(set)) {
    const [day, hour] = k.split(":").map(Number);
    t[day - 1][hour] = v;
  }
  return t;
}
/** Sim minute of day `day` at `hour` (fractional hours allowed). */
const at = (day: number, hour: number) => (day - 1) * 1440 + hour * 60;

describe("crowdSize", () => {
  it("draws nobody when the sim has nobody on the street", () => {
    expect(crowdSize(table(), at(2, 4), 48, 2400)).toBe(0);
    // a quiet night between two busy evenings: 04:00 sits between two empty hours
    const night = table({ "2:0": 8.3, "2:1": 0.3, "2:6": 0.9, "2:17": 17.2 });
    expect(crowdSize(night, at(2, 4), 48, 2400)).toBe(0);
    expect(crowdSize(night, at(2, 3.5), 48, 2400)).toBe(0);
  });

  it("keeps an empty hour empty even next to a busy one (run 1, Friday 02:00–05:00)", () => {
    const friday = table({ "5:3": 2.9 });
    for (const hour of [2, 2.5, 2.99, 4, 4.01, 4.5, 4.99]) expect(crowdSize(friday, at(5, hour), 48, 2400), `${hour}`).toBe(0);
    expect(crowdSize(friday, at(5, 3), 48, 2400)).toBe(Math.round(2.9 * 0.5 * 48));
    expect(crowdSize(friday, at(5, 3.5), 48, 2400)).toBe(Math.round(2.9 * 48));
    expect(crowdSize(friday, at(5, 3.99), 48, 2400)).toBeGreaterThan(0);
  });

  it("draws nobody for a clock that is not a number (e.g. ?t=abc)", () => {
    expect(crowdSize(table({ "2:17": 10 }), Number.NaN, 48, 2400)).toBe(0);
  });

  it("looks up the day and the hour: weekday and weekend differ", () => {
    const t = table({ "2:17": 17.2, "6:17": 22.3, "6:4": 1.1 });
    expect(crowdSize(t, at(2, 17.5), 48, 2400)).toBe(Math.round(17.2 * 48));
    expect(crowdSize(t, at(6, 17.5), 48, 2400)).toBe(Math.round(22.3 * 48));
    expect(crowdSize(t, at(6, 4.5), 48, 2400)).toBe(Math.round(1.1 * 48));
    expect(crowdSize(t, at(9, 17.5), 48, 2400)).toBe(0);
  });

  it("scales by the people-per-agent figure the API publishes, and draws nothing without one", () => {
    const t = table({ "2:17": 10 });
    expect(crowdSize(t, at(2, 17.5), 48, 2400)).toBe(480);
    expect(crowdSize(t, at(2, 17.5), 24, 2400)).toBe(240);
    expect(crowdSize(t, at(2, 17.5), 0, 2400)).toBe(0);
    expect(crowdSize(t, at(2, 17.5), Number.NaN, 2400)).toBe(0);
    expect(crowdSize([], at(2, 17.5), 48, 2400)).toBe(0);
  });

  it("blends the two nearest hours, so the crowd follows the clock between them", () => {
    const t = table({ "2:16": 18, "2:17": 12 });
    expect(crowdSize(t, at(2, 17), 10, 2400)).toBe(150);
    expect(crowdSize(t, at(2, 16.75), 10, 2400)).toBe(165);
  });

  it("caps the crowd and clamps to the run's first and last hour", () => {
    const t = table({ "1:0": 5, "14:23": 7, "3:12": 1000 });
    expect(crowdSize(t, at(3, 12.5), 48, 2400)).toBe(2400);
    expect(crowdSize(t, 0, 10, 2400)).toBe(50);
    expect(crowdSize(t, RUN_MINUTES, 10, 2400)).toBe(70);
  });
});

describe("walkStep", () => {
  const BASE = 3.36; // sim minutes per real second at 1×
  const PACE = 3.2;

  it("stands still while the clock does: paused, rewound or seeking", () => {
    expect(walkStep(0, BASE, BASE, PACE)).toBe(0);
    expect(walkStep(-5, BASE, BASE, PACE)).toBe(0);
    expect(walkStep(60, BASE, BASE, PACE)).toBe(0); // a one-hour jump at 1× is a seek
    expect(clockSeconds(0, BASE)).toBe(0);
    expect(clockSeconds(60, BASE)).toBe(0);
    expect(clockSeconds(BASE / 60, BASE)).toBeCloseTo(1 / 60, 12);
  });

  it("walks at the base pace at 1× and gently faster at 10× and 100×", () => {
    const frame = 1 / 60;
    const s1 = walkStep(BASE * frame, BASE, BASE, PACE);
    const s10 = walkStep(BASE * 10 * frame, BASE * 10, BASE, PACE);
    const s100 = walkStep(BASE * 100 * frame, BASE * 100, BASE, PACE);
    expect(s1).toBeCloseTo(PACE * frame, 9);
    expect(s10 / s1).toBeCloseTo(2, 6);
    expect(s100 / s1).toBeCloseTo(4, 6);
  });
});

const trip = (id: string, path: [number, number, number][], visits: [string, number, number][] = []): AgentDay => ({
  id,
  persona: "tourist",
  returning: false,
  path,
  visits: visits.map(([storeId, tIn, tOut]) => ({ storeId, tIn, tOut })),
});

describe("legsOf", () => {
  it("cuts each trip at its shop visits: entry → shop → exit", () => {
    const [a] = prepareAgents(
      [trip("v1", [[100, 0, 0], [110, 10, 0], [140, 10, 0], [160, 10, 20]], [["s1", 110, 140]])],
      { jitter: 0 },
    );
    expect(legsOf([a])).toEqual([
      { ax: 0, az: 0, bx: 10, bz: 0, tA: 100, tB: 110, store: "s1" },
      { ax: 10, az: 0, bx: 10, bz: 20, tA: 140, tB: 160, store: null },
    ]);
  });

  it("finds doors between keyframes, keeps through trips and drops legs with no street time", () => {
    const agents = prepareAgents(
      [
        trip("through", [[0, -50, 0], [20, 50, 0]]),
        trip("door", [[0, 0, 0], [10, 0, 100]], [["s2", 5, 10]]),
        trip("still", [[30, 5, 5]]),
      ],
      { jitter: 0 },
    );
    expect(legsOf(agents)).toEqual([
      { ax: -50, az: 0, bx: 50, bz: 0, tA: 0, tB: 20, store: null },
      { ax: 0, az: 0, bx: 0, bz: 50, tA: 0, tB: 5, store: "s2" },
    ]);
  });
});

describe("legsAround / pickLeg", () => {
  const leg = (tA: number, tB: number, store: string | null = null) => ({ ax: 0, az: 0, bx: 1, bz: 1, tA, tB, store });

  it("keeps the legs on the street around t, weighted by their minutes there", () => {
    const early = leg(0, 50);
    const now = leg(90, 110, "s1");
    const late = leg(125, 200);
    const active = legsAround([early, now, late], 100, 30);
    expect(active.legs).toEqual([now, late]);
    expect(active.cum).toEqual([20, 25]);
    expect(pickLeg(active, 0)).toBe(now);
    expect(pickLeg(active, 0.79)).toBe(now);
    expect(pickLeg(active, 0.81)).toBe(late);
    expect(pickLeg(active, 0.999)).toBe(late);
  });

  it("has nothing to pick when nobody is out", () => {
    const active = legsAround([leg(0, 10)], 600, 30);
    expect(active.legs).toEqual([]);
    expect(pickLeg(active, 0.5)).toBeNull();
  });
});

describe("pickOpenLeg / legIsStale: never towards a shut shop, never behind the clock", () => {
  const leg = (tA: number, tB: number, store: string | null = null) => ({ ax: 0, az: 0, bx: 1, bz: 1, tA, tB, store });
  const sequence = (...us: number[]) => {
    let i = 0;
    return () => us[i++ % us.length];
  };

  it("skips legs into shut shops however heavily they weigh", () => {
    const intoShut = leg(0, 90, "s1");
    const intoOpen = leg(80, 90, "s2");
    const active = legsAround([intoShut, intoOpen], 60, 30);
    const shut = new Set(["s1"]);
    for (let k = 0; k < 50; k++) expect(pickOpenLeg(active, shut, () => k / 50)).not.toBe(intoShut);
    expect(pickOpenLeg(active, shut, sequence(0.1, 0.2, 0.95))).toBe(intoOpen);
    expect(pickOpenLeg(active, new Set(["s1", "s2"]), Math.random)).toBeNull();
    expect(pickOpenLeg(active, new Set(), sequence(0.1))).toBe(intoShut);
  });

  it("re-plans a walker whose leg is over, not started, or heading into a shop that just shut", () => {
    const none = new Set<string>();
    expect(legIsStale(null, 100, 30, none)).toBe(true);
    expect(legIsStale(leg(90, 110, "s1"), 100, 30, none)).toBe(false);
    expect(legIsStale(leg(20, 60), 100, 30, none)).toBe(true); // ended 40 sim minutes ago
    expect(legIsStale(leg(140, 150), 100, 30, none)).toBe(true); // a seek back: starts 40 minutes ahead
    expect(legIsStale(leg(90, 110, "s1"), 100, 30, new Set(["s1"]))).toBe(true);
    expect(legIsStale(leg(90, 110), 100, 30, new Set(["s1"]))).toBe(false); // leaving the area: no shop to be shut
  });
});
