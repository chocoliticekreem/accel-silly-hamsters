import { describe, expect, it } from "vitest";
import type { AgentDay } from "../api/contract";
import { mergeDays, prepareAgents, sampleAgent } from "./interp";

const agent: AgentDay = {
  id: "a1",
  persona: "night-owl",
  returning: true,
  path: [
    [100, 0, 250],
    [110, 0, 150],
    [120, 30, 150],
    [150, 30, 150],
    [160, 0, 250],
  ],
  visits: [{ storeId: "s3", tIn: 120, tOut: 150 }],
};

describe("interp", () => {
  const [p] = prepareAgents([agent], { jitter: 0 });

  it("is hidden before the first and after the last keyframe", () => {
    expect(sampleAgent(p, 99).visible).toBe(false);
    expect(sampleAgent(p, 161).visible).toBe(false);
  });

  it("interpolates linearly between keyframes", () => {
    const s = sampleAgent(p, 105);
    expect(s.visible).toBe(true);
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(200);
    const s2 = sampleAgent(p, 115);
    expect(s2.x).toBeCloseTo(15);
  });

  it("is hidden while inside a store", () => {
    expect(sampleAgent(p, 130).visible).toBe(false);
    expect(sampleAgent(p, 155).visible).toBe(true);
  });

  it("works when scrubbing backwards (cached segment index resets)", () => {
    sampleAgent(p, 158);
    const s = sampleAgent(p, 101);
    expect(s.z).toBeCloseTo(240);
  });

  it("faces the direction of travel", () => {
    const s = sampleAgent(p, 115); // moving +x
    expect(s.heading).toBeCloseTo(Math.PI / 2);
  });
});

describe("mergeDays", () => {
  const trip = (id: string, t0: number): AgentDay => ({ id, persona: "night-owl", returning: true, path: [[t0, 0, 0], [t0 + 60, 10, 0]], visits: [] });

  it("keeps a trip that crosses midnight once, even though both day files list it", () => {
    const late = trip("r7", 1400);
    const merged = mergeDays([{ agents: [late, trip("v1-3", 600)] }, { agents: [late, trip("v2-1", 2000)] }]);
    expect(merged.map((a) => a.id)).toEqual(["r7", "v1-3", "v2-1"]);
  });

  it("keeps two different trips by the same regular", () => {
    expect(mergeDays([{ agents: [trip("r7", 1400), trip("r7", 1900)] }])).toHaveLength(2);
  });
});
