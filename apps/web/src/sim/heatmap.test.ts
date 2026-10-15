import { describe, expect, it } from "vitest";
import type { CityMap, PathKey } from "../api/contract";
import { addPoint, binFootfall, cellOf, gridMax, makeGrid, nearestStreetName, shutStops, splat } from "./heatmap";

const bounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
const total = (v: Float32Array) => v.reduce((a, b) => a + b, 0);

describe("heatmap grid", () => {
  it("bins points into the right cell and ignores points outside", () => {
    const g = makeGrid(bounds, 10);
    expect([g.nx, g.nz]).toEqual([10, 10]);
    expect(cellOf(g, -50, -50)).toBe(0);
    expect(cellOf(g, -41, -50)).toBe(0);
    expect(cellOf(g, -39, -50)).toBe(1);
    expect(cellOf(g, -50, -39)).toBe(10); // the next row is the next 10 m of z
    expect(cellOf(g, 49.9, 49.9)).toBe(99);
    expect(cellOf(g, 51, 0)).toBe(-1);
    addPoint(g, 5, 5, 2);
    addPoint(g, 500, 5, 7);
    expect(total(g.v)).toBe(2);
    expect(g.v[cellOf(g, 5, 5)]).toBe(2);
  });

  it("splat spreads exactly the weight it was given (inside the grid)", () => {
    const g = makeGrid(bounds, 10);
    splat(g, 0, 0, 12, 2);
    expect(total(g.v)).toBeCloseTo(12, 4);
    // the centre cell gets the most
    expect(g.v[cellOf(g, 0, 0)]).toBe(gridMax(g));
  });

  it("footfall counts person-minutes along the path, not time spent inside a shop", () => {
    const g = makeGrid(bounds, 10);
    // walk east along z = 5 for 20 minutes (x -45 → 45), 2-minute samples
    const path: PathKey[] = [
      [0, -45, 5],
      [20, 45, 5],
    ];
    binFootfall(g, [{ path }], 2);
    expect(total(g.v)).toBe(22); // 11 samples × 2 minutes
    for (let k = 0; k < g.v.length; k++) if (g.v[k] > 0) expect(Math.floor(k / g.nx)).toBe(5); // all in the z = 5 row
    const h = makeGrid(bounds, 10);
    binFootfall(h, [{ path, visits: [{ storeId: "s1", tIn: 0, tOut: 10 }] }], 2);
    expect(total(h.v)).toBe(12); // the 5 samples inside the visit don't count
  });

  it("spots a door stop with no visit as 'found it shut'", () => {
    const doors = [{ storeId: "s1", x: 10, z: 0 }];
    const path: PathKey[] = [
      [0, 0, 0],
      [5, 10, 0],
      [6, 10, 0], // waited a minute at the door, no visit: shut
      [10, 20, 0],
      [30, 20, 0], // a long wait away from any door: not a shop
    ];
    expect(shutStops(path, [], doors)).toEqual([{ storeId: "s1", t: 5, x: 10, z: 0 }]);
    // the same stop during a visit is a visit, not a miss
    expect(shutStops(path, [{ storeId: "s1", tIn: 5, tOut: 6 }], doors)).toEqual([]);
  });

  it("names the nearest street", () => {
    const map = { streets: [
      { id: "a", name: "Brick Ln", width: 10, points: [[90, -200], [90, 200]] },
      { id: "b", name: "Old St", width: 14, points: [[-200, 180], [200, 180]] },
    ] } as unknown as CityMap;
    expect(nearestStreetName(map, 80, 0)).toBe("Brick Ln");
    expect(nearestStreetName(map, 0, 170)).toBe("Old St");
  });
});
