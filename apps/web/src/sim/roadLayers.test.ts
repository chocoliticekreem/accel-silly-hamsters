import { describe, expect, it } from "vitest";
import type { Street } from "../api/contract";
import { ROAD_TOP, roadLayout } from "./roadLayers";

const st = (id: string, width: number, points: [number, number][]): Street => ({ id, name: id, width, points });

describe("roadLayout", () => {
  it("skips a way lying inside a wider road's carriageway and layers classes by height", () => {
    const main = st("main", 14, [[0, 0], [200, 0]]);
    const link = st("link", 6, [[40, 2], [90, 2]]); // a service way inside the main road
    const side = st("side", 8, [[100, 0], [100, 100]]);
    const { pieces } = roadLayout([main, link, side]);
    expect(pieces.map((p) => p.street)).toEqual([0, 2]);
    expect(pieces[0].top).toBe(ROAD_TOP[2]);
    expect(pieces[1].top).toBe(ROAD_TOP[1]);
    expect(pieces[0].top).toBeGreaterThan(pieces[1].top);
  });

  it("keeps one of two identical overlapping ways", () => {
    const a = st("a", 8, [[0, 0], [100, 0]]);
    const b = st("b", 8, [[0, 0], [100, 0]]);
    expect(roadLayout([a, b]).pieces).toHaveLength(1);
  });

  it("stops centre dashes at junctions", () => {
    const main = st("main", 14, [[0, 0], [200, 0]]);
    const cross = st("cross", 10, [[100, -60], [100, 60]]);
    const { dashes } = roadLayout([main, cross]);
    const onMain = dashes.filter((d) => Math.abs(d.z) < 0.01);
    expect(onMain.length).toBeGreaterThan(10);
    // none within the crossing road's carriageway (+1 m and half a dash)
    for (const d of onMain) expect(Math.abs(d.x - 100)).toBeGreaterThan(5 + 1);
    const onCross = dashes.filter((d) => Math.abs(d.x - 100) < 0.01);
    for (const d of onCross) expect(Math.abs(d.z)).toBeGreaterThan(7 + 1);
  });
});
