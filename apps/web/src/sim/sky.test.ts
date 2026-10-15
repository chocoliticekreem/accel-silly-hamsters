import { describe, expect, it } from "vitest";
import { nightLevel } from "./sky";

describe("sky", () => {
  it("is dark at night and bright at noon", () => {
    expect(nightLevel(2)).toBeGreaterThan(0.9);
    expect(nightLevel(13)).toBe(0);
    expect(nightLevel(23.99)).toBeGreaterThan(0.9);
  });
  it("wraps around midnight", () => {
    expect(nightLevel(24)).toBeCloseTo(nightLevel(0));
    expect(nightLevel(-1)).toBeCloseTo(nightLevel(23));
  });
});
