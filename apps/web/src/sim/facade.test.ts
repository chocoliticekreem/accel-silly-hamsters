import { describe, expect, it } from "vitest";
import type { Building } from "../api/contract";
import { facadeFreeSpans, shopfrontSpan } from "./facade";

const box = (id: string, x: number, z: number, w: number, d: number): Building => ({ id, kind: "office", x, z, w, d, h: 10 });
// a 10 m wide shop facing north (nz = +1): facade plane z = 5, facade runs x -5..5
const shop = box("s", 0, 0, 10, 10);

describe("facadeFreeSpans", () => {
  it("is the whole facade when nothing pokes out", () => {
    expect(facadeFreeSpans(shop, 0, 1, [shop])).toEqual([{ from: -5, to: 5 }]);
  });

  it("ignores flush neighbours and ones fully behind the facade", () => {
    const flush = box("n", 9, 0, 8, 10); // same facade line, overlapping 1 m sideways
    const behind = box("b", 0, -12, 10, 10);
    expect(facadeFreeSpans(shop, 0, 1, [flush, behind])).toEqual([{ from: -5, to: 5 }]);
  });

  it("cuts out a neighbour that reaches past the facade", () => {
    // neighbour east of centre, x 2..10, reaching to z = 8 (3 m in front of our facade)
    const n = box("n", 6, 3, 8, 10);
    // facing north the local u axis is -x: x in 2..5 → u in -5..-2
    expect(facadeFreeSpans(shop, 0, 1, [n])).toEqual([{ from: -2, to: 5 }]);
  });

  it("works for every facing and orders spans widest first", () => {
    // facing east (nx = +1): facade plane x = 5, u = +z
    const a = box("a", 7, 4, 6, 2); // covers z 3..5 → u 3..5
    const b = box("b", 7, -3, 6, 2); // covers z -4..-2 → u -4..-2
    expect(facadeFreeSpans(shop, 1, 0, [a, b])).toEqual([
      { from: -2, to: 3 },
      { from: -5, to: -4 },
    ]);
    // facing west (nx = -1): u = -z, so the same neighbours mirror (and sit on the wrong side: nothing covered)
    expect(facadeFreeSpans(shop, -1, 0, [a, b])).toEqual([{ from: -5, to: 5 }]);
    // facing south (nz = -1): u = +x
    const c = box("c", -4, -7, 4, 6); // x -6..-2, reaches z -10..-4: pokes out past z = -5
    expect(facadeFreeSpans(shop, 0, -1, [c])).toEqual([{ from: -2, to: 5 }]);
  });

  it("ignores buildings beyond the awning's reach (across the street)", () => {
    const across = box("x", 0, 20, 10, 10); // starts 10 m in front
    expect(facadeFreeSpans(shop, 0, 1, [across])).toEqual([{ from: -5, to: 5 }]);
  });
});

describe("shopfrontSpan", () => {
  it("picks the widest free span with a margin, or nothing when it is too narrow", () => {
    const n = box("n", 6, 3, 8, 10);
    expect(shopfrontSpan(shop, 0, 1, [n])).toEqual({ centre: 1.5, width: 6.2 });
    const wide = box("w", 0, 3, 9, 10); // covers x -4.5..4.5: 0.5 m slivers left
    expect(shopfrontSpan(shop, 0, 1, [wide])).toBeNull();
  });
});
