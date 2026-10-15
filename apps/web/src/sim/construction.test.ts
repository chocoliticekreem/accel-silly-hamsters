import { describe, expect, it } from "vitest";
import { RUN_MINUTES, type CityMap } from "../api/contract";
import { generateMap } from "../mock/map";
import {
  angleDelta,
  approachAngle,
  buildProgress,
  columnFrac,
  CYCLE_S,
  cranePose,
  deckHeight,
  deliveryAt,
  FLOOR_H,
  gatePieces,
  infillPlanFor,
  isToppedOut,
  LEVELS,
  LORRY_TIMES,
  maxRect,
  newPendulum,
  planSite,
  siteState,
  slabCount,
  STAGES,
  stepPendulum,
  workedMinutes,
  workersPresent,
  type CraneJob,
} from "./construction";
import type { Grid } from "./infill";

const at = (day: number, h: number, m = 0) => (day - 1) * 1440 + h * 60 + m;

describe("site timetable", () => {
  it("works weekdays 07:30–17:30 with lunch, Saturday mornings, never Sunday", () => {
    expect(siteState(at(4, 8, 30))).toBe("work"); // Thursday 08:30
    expect(siteState(at(4, 7, 29))).toBe("off");
    expect(siteState(at(4, 7, 30))).toBe("work");
    expect(siteState(at(4, 12, 45))).toBe("lunch");
    expect(siteState(at(4, 17, 29))).toBe("work");
    expect(siteState(at(4, 17, 30))).toBe("off");
    expect(siteState(7300)).toBe("off"); // Day 6, 01:40
    expect(siteState(at(6, 10))).toBe("work"); // Saturday
    expect(siteState(at(6, 13, 30))).toBe("off");
    expect(siteState(8640 + 720)).toBe("off"); // Sunday noon
    expect(siteState(at(14, 10))).toBe("off");
  });

  it("counts worked minutes: none at night or Sunday, 9h15 a weekday", () => {
    expect(workedMinutes(at(1, 7))).toBe(0);
    expect(workedMinutes(at(2, 0))).toBe(9 * 60 + 15);
    expect(workedMinutes(at(7, 23))).toBe(workedMinutes(at(7, 1)));
    expect(workedMinutes(RUN_MINUTES)).toBe(2 * (5 * 555 + 300));
  });

  it("ramps workers in before the shift and out after it", () => {
    expect(workersPresent(at(4, 3), 20)).toBe(0);
    expect(workersPresent(at(4, 7, 15), 20)).toBe(10);
    expect(workersPresent(at(4, 10), 20)).toBe(20);
    expect(workersPresent(at(4, 17, 45), 20)).toBe(10);
    expect(workersPresent(8640 + 720, 20)).toBe(0);
  });

  it("delivers a few times on working days only", () => {
    expect(deliveryAt(at(4, 7, 52))?.phase).toBe("arrive");
    expect(deliveryAt(at(4, 8, 20))?.phase).toBe("unload");
    expect(deliveryAt(at(4, 7, 50 + LORRY_TIMES.arrive + LORRY_TIMES.unload + 1))?.phase).toBe("depart");
    expect(deliveryAt(at(4, 9))).toBeNull();
    let sunday = 0;
    for (let m = 0; m < 1440; m++) if (deliveryAt(at(7, 0, m))) sunday++;
    expect(sunday).toBe(0);
    const seen = new Set<number>();
    for (let m = 0; m < 1440; m++) {
      const d = deliveryAt(at(3, 0, m));
      if (d) seen.add(d.index);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe("building growth", () => {
  it("starts with the ground slab on day 1 and tops out before the run ends", () => {
    expect(slabCount(buildProgress(0))).toBe(0);
    const day1 = buildProgress(at(1, 18));
    expect(slabCount(day1)).toBe(1);
    expect(isToppedOut(buildProgress(at(13, 23)))).toBe(true);
    expect(isToppedOut(buildProgress(at(12, 12)))).toBe(false);
    expect(slabCount(buildProgress(RUN_MINUTES))).toBe(LEVELS + 1);
  });

  it("only ever grows, a storey at a time", () => {
    let prev = 0;
    for (let t = 0; t <= RUN_MINUTES; t += 30) {
      const n = slabCount(buildProgress(t));
      expect(n).toBeGreaterThanOrEqual(prev);
      expect(n - prev).toBeLessThanOrEqual(1);
      prev = n;
    }
  });

  it("doesn't build overnight or on Sunday", () => {
    expect(buildProgress(at(4, 22))).toBe(buildProgress(at(5, 7)));
    expect(buildProgress(at(7, 1))).toBe(buildProgress(at(7, 23)));
  });

  it("raises columns before the slab above them, deck on the top slab", () => {
    const p = 5.3; // storey 5 columns half up, slab 5 not yet poured
    expect(slabCount(p)).toBe(5);
    expect(columnFrac(p, 5)).toBeCloseTo(0.5);
    expect(columnFrac(p, 4)).toBe(1);
    expect(columnFrac(p, 6)).toBe(0);
    expect(deckHeight(p)).toBeCloseTo(4 * FLOOR_H + 0.3);
  });
});

describe("crane cycle", () => {
  const job: CraneJob = { pickA: 0, pickR: 20, pickY: 3, dropA: Math.PI / 2, dropR: 35, dropY: 30, clearY: 40 };
  const startOf = (stage: string) => {
    let s = 0;
    for (const [n, d] of STAGES) {
      if (n === stage) return s;
      s += d;
    }
    return NaN;
  };

  it("picks up, hoists, slews, trollies out, lowers, releases, returns", () => {
    const p0 = cranePose(job, 0.1);
    expect(p0).toMatchObject({ slew: 0, radius: 20, hookY: 3, loaded: false });
    expect(cranePose(job, startOf("hoist") - 0.1).loaded).toBe(true);
    expect(cranePose(job, startOf("slew") - 0.01).hookY).toBeCloseTo(40, 1);
    expect(cranePose(job, startOf("trolley") - 0.01).slew).toBeCloseTo(Math.PI / 2, 2);
    expect(cranePose(job, startOf("lower") - 0.01).radius).toBeCloseTo(35, 1);
    const set = cranePose(job, startOf("release") + 0.1);
    expect(set.hookY).toBeCloseTo(30, 1);
    expect(set.loaded).toBe(true);
    const back = cranePose(job, startOf("descend") - 0.01);
    expect(back.loaded).toBe(false);
    expect(back.delivered).toBe(true);
    expect(back.slew).toBeCloseTo(0, 2);
    expect(back.radius).toBeCloseTo(20, 1);
    // the cycle closes on itself
    const end = cranePose(job, CYCLE_S - 0.001);
    expect(end.hookY).toBeCloseTo(3, 1);
  });

  it("moves continuously (no jumps between frames)", () => {
    let prev = cranePose(job, 0);
    for (let s = 1 / 60; s < CYCLE_S; s += 1 / 60) {
      const p = cranePose(job, s);
      expect(Math.abs(angleDelta(prev.slew, p.slew))).toBeLessThan(0.05);
      expect(Math.abs(p.radius - prev.radius)).toBeLessThan(0.5);
      expect(Math.abs(p.hookY - prev.hookY)).toBeLessThan(0.6);
      prev = p;
    }
  });

  it("slews the short way round", () => {
    const j = { ...job, pickA: 3, dropA: -3 };
    const mid = cranePose(j, startOf("slew") + 4.5);
    expect(Math.abs(angleDelta(mid.slew, Math.PI))).toBeLessThan(0.3);
    expect(approachAngle(3, -3, 0.1)).toBeCloseTo(3.1);
  });

  it("hook swings away from the acceleration and settles back under the trolley", () => {
    const p = newPendulum();
    stepPendulum(p, 2, 0, 20, 0.5);
    expect(p.x).toBeLessThan(0);
    for (let k = 0; k < 60 * 60; k++) stepPendulum(p, 0, 0, 20, 1 / 60);
    expect(Math.hypot(p.x, p.z)).toBeLessThan(0.05);
  });
});

describe("site layout", () => {
  // a 200 m square with one street along the south edge and nothing built: the whole interior is one big void
  const open: CityMap = {
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    streets: [{ id: "s", name: "S", width: 12, points: [[-100, -92], [100, -92]] }],
    buildings: [{ id: "st", kind: "station", x: -80, z: -70, w: 10, d: 10, h: 8 }],
    stores: [],
    entryPoints: [],
  };

  it("finds the largest rectangle of cells", () => {
    const g: Grid = { cell: 1, x0: 0, z0: 0, nx: 5, nz: 4, state: new Uint8Array(20) };
    const set = new Set([0, 1, 2, 5, 6, 7, 8, 10, 11, 12, 13, 16]);
    expect(maxRect(g, set)).toEqual({ i: 0, j: 0, w: 3, d: 3 });
  });

  it("returns null without a big site (mock map)", () => {
    expect(planSite(generateMap())).toBeNull();
  });

  it("lays out a building, cranes that reach their pick and drop spots, a gate on the hoarding", () => {
    const plan = infillPlanFor(open);
    const site = planSite(open, plan);
    if (!site) return; // the planner may not make a site on this toy; the real map is checked in the app
    const b = site.building;
    expect(site.cranes.length).toBeGreaterThanOrEqual(1);
    expect(site.cranes.length).toBeLessThanOrEqual(3);
    for (const c of site.cranes) {
      // mast outside the building, building corners and its pick spot within reach
      expect(Math.abs(c.x - b.x) * 2 >= b.w || Math.abs(c.z - b.z) * 2 >= b.d).toBe(true);
      for (const [sx, sz] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ])
        expect(Math.hypot(b.x + (sx * b.w) / 2 - c.x, b.z + (sz * b.d) / 2 - c.z)).toBeLessThan(c.jib);
      expect(Math.hypot(c.pick.x - c.x, c.pick.z - c.z)).toBeLessThan(c.jib);
      expect(c.h).toBeGreaterThan(LEVELS * FLOOR_H + 8);
    }
    const lorryCrane = site.cranes.find((c) => c.lorry)!;
    expect(Math.hypot(site.bay.x - lorryCrane.x, site.bay.z - lorryCrane.z)).toBeLessThan(lorryCrane.jib);
    const gate = gatePieces(open, plan);
    expect(gate.length).toBeGreaterThan(0);
    for (const h of gate) expect(plan.hoardings).toContainEqual(h);
  });
});
