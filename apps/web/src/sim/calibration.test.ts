import { describe, expect, it } from "vitest";
import type { CalibrationVenue } from "../api/contract";
import { blendedTarget, meanGap, toPeak100 } from "./calibration";

const flat = (v: number) => Array(24).fill(v);

describe("calibration", () => {
  it("rescales to a busiest hour of 100", () => {
    expect(toPeak100([0, 5, 10])).toEqual([0, 50, 100]);
    expect(toPeak100([0, 0])).toEqual([0, 0]);
  });

  it("blends weekdays and weekends 5:2", () => {
    const v = { weekday: flat(70), weekend: flat(0) } as CalibrationVenue;
    v.weekday[3] = 0;
    v.weekend[3] = 70;
    const t = blendedTarget(v);
    expect(t[0]).toBe(100);
    expect(t[3]).toBeCloseTo(40);
  });

  it("measures the gap only where either curve is active", () => {
    const a = flat(0);
    const b = flat(0);
    a[10] = 100;
    b[10] = 80;
    expect(meanGap(a, b)).toBe(20);
    expect(meanGap(flat(0), flat(0))).toBe(0);
  });
});
