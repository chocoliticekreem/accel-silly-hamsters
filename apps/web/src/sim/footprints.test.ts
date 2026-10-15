import { describe, expect, it } from "vitest";
import type { Building } from "../api/contract";
import { overlapArea, resolveOverlaps } from "./footprints";

const b = (id: string, x: number, z: number, w: number, d: number, kind: Building["kind"] = "office", h = 10): Building => ({ id, kind, x, z, w, d, h });

describe("resolveOverlaps", () => {
  it("leaves separate buildings alone", () => {
    const out = resolveOverlaps([b("a", 0, 0, 10, 10), b("b", 20, 0, 10, 10)]);
    expect(out).toEqual([b("a", 0, 0, 10, 10), b("b", 20, 0, 10, 10)]);
  });

  it("cuts the smaller box out of the bigger one along the shallow axis", () => {
    const out = resolveOverlaps([b("big", 0, 0, 30, 30), b("small", 18, 0, 10, 10)]);
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(overlapArea(out[i], out[j])).toBe(0);
    const small = out.find((x) => x.id === "small")!;
    expect(small.x - small.w / 2).toBeGreaterThanOrEqual(15);
    expect(out.find((x) => x.id === "big")).toEqual(b("big", 0, 0, 30, 30));
  });

  it("never shrinks shops, clubs or the station; trims the other building instead", () => {
    const shop = { ...b("shop", 0, 0, 10, 10, "store"), storeId: "s1" };
    const out = resolveOverlaps([b("office", 6, 0, 20, 20), shop]);
    expect(out.find((x) => x.id === "shop")).toEqual(shop);
    expect(overlapArea(out[0], out[1])).toBe(0);
  });

  it("drops a non-shop building that would become a sliver, and resolves chains", () => {
    const out = resolveOverlaps([b("a", 0, 0, 20, 20), b("inside", 1, 1, 4, 4), b("c", 15, 0, 20, 20), b("d", 30, 0, 20, 20)]);
    expect(out.some((x) => x.id === "inside")).toBe(false);
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(overlapArea(out[i], out[j])).toBe(0);
  });
});
