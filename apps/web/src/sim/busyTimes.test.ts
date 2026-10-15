import { describe, expect, it } from "vitest";
import type { DayData } from "../api/contract";
import { arrivalsOfDay, averageDays, captionOf, daysOfWeekday, heat, hourlyCounts, kwhByHour, liveLevel, summarize } from "./busyTimes";

const day3: DayData = {
  day: 3,
  agents: [
    { id: "a", persona: "office-worker", returning: false, path: [], visits: [{ storeId: "s1", tIn: 2 * 1440 + 12 * 60 + 5, tOut: 0 }, { storeId: "s1", tIn: 2 * 1440 - 30, tOut: 0 }] },
    { id: "b", persona: "tourist", returning: false, path: [], visits: [{ storeId: "s1", tIn: 2 * 1440 + 12 * 60 + 40, tOut: 0 }, { storeId: "s2", tIn: 2 * 1440 + 20 * 60, tOut: 0 }] },
    { id: "o", persona: "owner", returning: false, path: [], visits: [{ storeId: "s1", tIn: 2 * 1440 + 8 * 60, tOut: 0 }] },
  ],
};

describe("busy times", () => {
  it("counts a day's arrivals by hour, without the previous night and the owner", () => {
    const a = arrivalsOfDay(day3);
    expect(a.get("s1")).toHaveLength(2);
    const h = hourlyCounts(a.get("s1"));
    expect(h[12]).toBe(2);
    expect(h.reduce((x, y) => x + y, 0)).toBe(2);
    expect(hourlyCounts(a.get("s1"), 2 * 1440 + 12 * 60 + 10)[12]).toBe(1);
  });

  it("averages weekdays over the run's days", () => {
    expect(daysOfWeekday(0)).toEqual([1, 8]);
    expect(daysOfWeekday(6)).toEqual([7, 14]);
    const avg = averageDays([arrivalsOfDay(day3), new Map()]);
    expect(avg.get("s1")![12]).toBe(1);
  });

  it("captions the peak stretch and quiet tail", () => {
    const v = new Array(24).fill(0);
    v[12] = 10;
    v[13] = 9;
    v[18] = 1;
    const open = v.map((_, h) => h >= 8 && h < 22);
    const s = summarize(v, open);
    expect(s.peak).toBe(12);
    expect(s.busiest).toEqual([12, 14]);
    expect(captionOf(s)).toBe("Usually busiest 12:00–14:00 · quiet until 12:00 · quiet after 14:00");
    expect(summarize(new Array(24).fill(0)).peak).toBeNull();
  });

  it("reads live busyness against the usual hour", () => {
    const usual = new Array(24).fill(4);
    const t = 12 * 60 + 30;
    expect(liveLevel([t - 10, t - 5, t - 1, t - 2, t - 3, t - 4, t - 6], usual, t, true).level).toBe("busier");
    expect(liveLevel([t - 10, t - 20, t - 30, t - 40], usual, t, true).level).toBe("usual");
    expect(liveLevel([], usual, t, true).level).toBe("quiet");
    expect(liveLevel([], usual, t, false).level).toBe("closed");
  });

  it("follows the backend energy formula", () => {
    const open = new Array(24).fill(false).map((_, h) => h >= 7 && h < 18);
    const k = kwhByHour("cafe", 100, open, new Array(24).fill("low"));
    expect(k[10]).toBeCloseTo(100 * 0.03223 + 0.25);
    expect(k[2]).toBeCloseTo(100 * 0.00645 + 0.25);
  });

  it("maps 0..1 to a colour ramp", () => {
    expect(heat(0)).toContain("rgba");
    expect(heat(1)).toBe("rgb(255,241,201)");
  });
});
