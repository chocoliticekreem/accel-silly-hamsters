import { describe, expect, it } from "vitest";
import type { Street } from "../api/contract";
import { buildStreetGraph, tripMix } from "./streetGraph";

const st = (id: string, points: [number, number][]): Street => ({ id, name: id, width: 8, points });

describe("street graph", () => {
  it("connects streets that cross mid-segment and routes along them", () => {
    // a plus sign: no shared vertices, only a crossing at (0, 0)
    const g = buildStreetGraph([st("ns", [[0, -100], [0, 100]]), st("ew", [[-100, 0], [100, 0]])]);
    const a = g.nearest(0, -100);
    const b = g.nearest(100, 0);
    const path = g.route(a, b);
    expect(path[0]).toEqual([0, -100]);
    expect(path[path.length - 1]).toEqual([100, 0]);
    expect(path.some(([x, z]) => Math.abs(x) < 0.01 && Math.abs(z) < 0.01)).toBe(true);
  });

  it("merges vertices that nearly touch and returns [] when unreachable", () => {
    const g = buildStreetGraph([st("a", [[0, 0], [50, 0]]), st("b", [[50.5, 0], [50.5, 60]]), st("island", [[300, 300], [320, 300]])]);
    expect(g.route(g.nearest(0, 0), g.nearest(50, 60)).length).toBeGreaterThan(1);
    expect(g.route(g.nearest(0, 0), g.nearest(310, 300))).toEqual([]);
  });
});

describe("tripMix", () => {
  it("commutes in the morning, home in the evening, out at night", () => {
    const top = (h: number) => Object.entries(tripMix(h)).sort((x, y) => y[1] - x[1])[0][0];
    expect(top(8.5)).toBe("toWork");
    expect(top(18)).toBe("fromWork");
    expect(top(13)).toBe("lunch");
    expect(top(2.5)).toBe("nightOut");
  });
});
