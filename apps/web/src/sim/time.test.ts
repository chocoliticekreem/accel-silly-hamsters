import { describe, expect, it } from "vitest";
import { clockLabel, dayOf, formatHHMM, hourOf, isOpenAt, openByHour, parseHHMM, rangeLabel } from "./time";

describe("time", () => {
  it("parses and formats HH:MM", () => {
    expect(parseHHMM("07:30")).toBe(450);
    expect(parseHHMM("00:00")).toBe(0);
    expect(formatHHMM(450)).toBe("07:30");
    expect(formatHHMM(1440 + 61)).toBe("01:01");
  });

  it("splits t into day and hour", () => {
    expect(dayOf(0)).toBe(1);
    expect(dayOf(1920)).toBe(2);
    expect(dayOf(20159)).toBe(14);
    expect(dayOf(20160)).toBe(14); // clamps at the end
    expect(hourOf(1920)).toBe(8);
    expect(clockLabel(2880 + 22 * 60 + 40)).toBe("Day 3 · 22:40");
  });

  it("handles same-day opening hours", () => {
    expect(isOpenAt("07:00", "23:00", parseHHMM("06:59"))).toBe(false);
    expect(isOpenAt("07:00", "23:00", parseHHMM("07:00"))).toBe(true);
    expect(isOpenAt("07:00", "23:00", parseHHMM("23:00"))).toBe(false);
  });

  it("handles hours past midnight", () => {
    expect(isOpenAt("18:00", "03:00", parseHHMM("02:30"))).toBe(true);
    expect(isOpenAt("18:00", "03:00", parseHHMM("03:30"))).toBe(false);
    expect(isOpenAt("18:00", "03:00", parseHHMM("20:00"))).toBe(true);
    expect(isOpenAt("00:00", "00:00", 600)).toBe(true); // 24h
  });

  it("builds a 24-slot open strip", () => {
    const s = openByHour("07:00", "23:00");
    expect(s).toHaveLength(24);
    expect(s[6]).toBe(false);
    expect(s[7]).toBe(true);
    expect(s[22]).toBe(true);
    expect(s[23]).toBe(false);
    expect(openByHour("22:00", "03:00")[2]).toBe(true);
  });

  it("labels hour ranges", () => {
    expect(rangeLabel([1, 2])).toBe("01–03");
    expect(rangeLabel([20])).toBe("20–21");
  });
});
