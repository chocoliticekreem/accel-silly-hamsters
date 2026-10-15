import { describe, expect, it } from "vitest";
import { newPoint, pingPong, polyline } from "./polyline";

describe("polyline", () => {
  const p = polyline([
    [0, 0],
    [0, 10],
    [10, 10],
  ]);

  it("measures length and samples along segments", () => {
    expect(p.length).toBe(20);
    const o = p.at(5, 0, newPoint());
    expect([o.x, o.z]).toEqual([0, 5]);
    p.at(15, 0, o);
    expect([o.x, o.z]).toEqual([5, 10]);
    expect([o.dx, o.dz]).toEqual([1, 0]);
  });

  it("offsets to the right of travel", () => {
    const o = p.at(5, 2, newPoint()); // heading north → right is east
    expect(o.x).toBeCloseTo(2);
    expect(o.z).toBeCloseTo(5);
  });

  it("clamps outside the path", () => {
    expect(p.at(-3, 0, newPoint()).z).toBe(0);
    expect(p.at(99, 0, newPoint()).x).toBe(10);
  });
});

describe("pingPong", () => {
  it("goes out and back", () => {
    expect(pingPong(3, 10)).toEqual([3, true]);
    expect(pingPong(13, 10)).toEqual([7, false]);
    expect(pingPong(20, 10)).toEqual([0, true]);
  });
});
