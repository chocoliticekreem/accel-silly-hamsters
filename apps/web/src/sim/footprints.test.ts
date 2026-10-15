import { describe, expect, it } from "vitest";
import type { Building } from "../api/contract";
import realMap from "../../../../data/processed/map.json";
import type { CityMap } from "../api/contract";
import { clearCarriageways, kerbDistance, MIN_PAVEMENT, overlapArea, resolveOverlaps } from "./footprints";
import { frontage } from "./geometry";

describe("clearCarriageways", () => {
  const street = { id: "s", name: "S", width: 10, points: [[-50, 0], [50, 0]] as [number, number][] };
  const box = (id: string, x: number, z: number, w: number, d: number, kind: Building["kind"] = "office"): Building => ({ id, kind, x, z, w, d, h: 10 });
  it("cuts a shop box back from the road, keeping its back wall", () => {
    const [m] = clearCarriageways([box("x", 0, 8, 10, 10, "store")], [street]);
    expect(m.z + m.d / 2).toBeCloseTo(13, 1);
    expect(m.z - m.d / 2).toBeGreaterThanOrEqual(5 + MIN_PAVEMENT - 0.3);
  });

  it("leaves offices and shops that already clear the road alone", () => {
    const office = box("o", 0, 8, 10, 10);
    const ok = box("k", 0, 20, 10, 10, "store");
    expect(clearCarriageways([office, ok], [street])).toEqual([office, ok]);
  });

  it("keeps every real store and club off the carriageway", () => {
    const m = realMap as unknown as CityMap;
    const out = clearCarriageways(m.buildings.filter((x) => x.kind === "store" || x.kind === "club"), m.streets);
    for (const x of out) {
      const f = frontage(x, m.streets);
      const half = f.nx !== 0 ? x.w / 2 : x.d / 2;
      expect(kerbDistance(x, f.nx, f.nz, m.streets) - half).toBeGreaterThan(MIN_PAVEMENT - 0.5);
    }
  });
});

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
