import { describe, expect, it } from "vitest";
import type { HoursWindow, LightLevel, OwnerEvent, StoreRunResult } from "../api/contract";
import { isOpenAt } from "./time";
import { closureDays, dayHours, eventsByStore, resolveDayRef, storeStateAt, weekdayIndex, weekGrid } from "./storeState";

const D = 1440;
/** Sim minute of `day` (1-based) at "HH:MM". */
const at = (day: number, hhmm: string) => (day - 1) * D + Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const lighting = (on: number, off: number, level: LightLevel = "high"): LightLevel[] =>
  Array.from({ length: 24 }, (_, h) => (h >= on && h < off ? level : "off"));

function result(open: string, close: string, extra: Partial<StoreRunResult> = {}): StoreRunResult {
  return { open, close, lighting: lighting(0, 24), kpis: { visits: 0, kwh: 0, returnRate: 0 }, visitsByHour: Array(24).fill(0), ...extra };
}

const ev = (e: Partial<OwnerEvent> & Pick<OwnerEvent, "day" | "t" | "action">): OwnerEvent => ({ storeId: "s1", reason: "Because.", ...e });
const week = (h: HoursWindow | null, overrides: Record<number, HoursWindow | null> = {}) => Array.from({ length: 7 }, (_, i) => (i in overrides ? overrides[i] : h));

describe("weekdays", () => {
  it("Day 1 is a Monday, Day 7 a Sunday, Day 0 the Sunday before", () => {
    expect(weekdayIndex(1)).toBe(0);
    expect(weekdayIndex(7)).toBe(6);
    expect(weekdayIndex(8)).toBe(0);
    expect(weekdayIndex(0)).toBe(6);
  });

  it("resolves weekday names and day numbers", () => {
    expect(resolveDayRef("Thursday", 2, false)).toBe(4);
    expect(resolveDayRef("thu", 4, false)).toBe(4);
    expect(resolveDayRef("Thu", 4, true)).toBe(11);
    expect(resolveDayRef("Day 9", 1, false)).toBe(9);
    expect(resolveDayRef("12", 1, false)).toBe(12);
    expect(resolveDayRef("someday", 1, false)).toBeNull();
  });
});

describe("storeStateAt without a schedule (today's behaviour)", () => {
  const r = result("11:00", "23:00");
  it("matches isOpenAt every half hour of every day", () => {
    for (let t = 0; t < 14 * D; t += 30) expect(storeStateAt(r, [], t).open, `t=${t}`).toBe(isOpenAt("11:00", "23:00", t % D));
  });

  it("matches isOpenAt for hours past midnight, including Day 1 just after midnight", () => {
    const late = result("16:00", "02:00");
    for (let t = 0; t < 3 * D; t += 15) expect(storeStateAt(late, [], t).open, `t=${t}`).toBe(isOpenAt("16:00", "02:00", t % D));
  });

  it("treats open == close as 24 hours", () => {
    const allDay = result("06:00", "06:00");
    for (let t = 0; t < 2 * D; t += 60) expect(storeStateAt(allDay, [], t).open).toBe(true);
  });

  it("reports the day's hours, lighting and no reason", () => {
    const s = storeStateAt(result("11:00", "23:00", { lighting: lighting(10, 24) }), [], at(3, "12:00"));
    expect(s).toMatchObject({ open: true, hours: { open: "11:00", close: "23:00" }, lighting: "high", closedForGood: false, shutAllDay: false });
    expect(s.reason).toBeUndefined();
    expect(s.todayAction).toBeUndefined();
  });
});

describe("schedule by weekday", () => {
  // closed Mondays from day 8; Fridays till 01:00 from the start
  const r = result("11:00", "23:00", {
    schedule: [
      { fromDay: 1, week: week({ open: "11:00", close: "23:00" }, { 4: { open: "11:00", close: "01:00" } }) },
      { fromDay: 8, week: week({ open: "11:00", close: "23:00" }, { 0: null, 4: { open: "11:00", close: "01:00" } }) },
    ],
  });

  it("uses the week in effect that day", () => {
    expect(storeStateAt(r, [], at(1, "12:00")).open).toBe(true); // Monday, week 1
    const mon2 = storeStateAt(r, [], at(8, "12:00"));
    expect(mon2.open).toBe(false); // Monday, week 2: closed
    expect(mon2.hours).toBeNull();
    expect(mon2.shutAllDay).toBe(true);
    expect(storeStateAt(r, [], at(9, "12:00")).open).toBe(true); // Tuesday
  });

  it("carries a late night into the next morning (Friday till 01:00 → Saturday 00:30)", () => {
    expect(storeStateAt(r, [], at(5, "23:30")).open).toBe(true);
    expect(storeStateAt(r, [], at(6, "00:30")).open).toBe(true);
    expect(storeStateAt(r, [], at(6, "01:00")).open).toBe(false);
    expect(storeStateAt(r, [], at(5, "00:30")).open).toBe(false); // Thursday closes at 23:00
  });

  it("lights off on a day the shop is shut all day", () => {
    expect(storeStateAt(r, [], at(8, "12:00")).lighting).toBe("off");
  });

  it("before the first entry's day, uses the first entry", () => {
    const later = result("09:00", "17:00", { schedule: [{ fromDay: 3, week: week({ open: "10:00", close: "12:00" }) }] });
    expect(storeStateAt(later, [], at(1, "11:00")).hours).toEqual({ open: "10:00", close: "12:00" });
  });
});

describe("today-only actions", () => {
  const r = result("11:00", "23:00");
  const shut = ev({ day: 3, t: at(3, "15:00"), action: "shut_early", from: "23:00", to: "15:00", reason: "Roadworks outside, nobody can get in, shutting at 15:00." });

  it("shut_early closes at `to` that day only", () => {
    expect(storeStateAt(r, [shut], at(3, "14:59")).open).toBe(true);
    const s = storeStateAt(r, [shut], at(3, "16:00"));
    expect(s.open).toBe(false);
    expect(s.hours).toEqual({ open: "11:00", close: "15:00" });
    expect(s.todayAction).toBe("shut_early");
    expect(s.reason).toBe(shut.reason);
    expect(storeStateAt(r, [shut], at(4, "16:00")).open).toBe(true);
    expect(storeStateAt(r, [shut], at(4, "16:00")).reason).toBeUndefined();
  });

  it("ignores events not decided yet", () => {
    const s = storeStateAt(r, [shut], at(3, "12:00"));
    expect(s.hours).toEqual({ open: "11:00", close: "23:00" });
    expect(s.reason).toBeUndefined();
  });

  it("shut_early cuts the after-midnight tail too, and never extends", () => {
    const late = result("11:00", "03:00");
    const e = ev({ day: 2, t: at(2, "15:00"), action: "shut_early", to: "15:00" });
    expect(storeStateAt(late, [e], at(3, "01:00")).open).toBe(false);
    expect(storeStateAt(late, [], at(3, "01:00")).open).toBe(true);
    // a "shut early" time before opening can't mean the next afternoon
    const odd = ev({ day: 2, t: at(2, "08:00"), action: "shut_early", to: "09:00" });
    expect(storeStateAt(late, [odd], at(2, "20:00")).open).toBe(true);
  });

  it("open_late keeps the shop open past its close, into the next morning", () => {
    const e = ev({ day: 4, t: at(4, "22:45"), action: "open_late", from: "23:00", to: "03:00", reason: "Club crowd outside, staying open till 03:00 tonight." });
    expect(storeStateAt(r, [e], at(4, "23:30")).open).toBe(true);
    const s = storeStateAt(r, [e], at(5, "02:30"));
    expect(s.open).toBe(true);
    expect(s.reason).toBe(e.reason);
    expect(storeStateAt(r, [e], at(5, "03:00")).open).toBe(false);
    expect(storeStateAt(r, [e], at(4, "23:30")).todayAction).toBe("open_late");
    expect(storeStateAt(r, [e], at(5, "23:30")).open).toBe(false);
  });

  it("open_late never stretches past 24 hours", () => {
    const e = ev({ day: 1, t: at(1, "20:00"), action: "open_late", to: "11:00" });
    expect(dayHours(r, [e], 1)).toEqual({ open: "11:00", close: "11:00" });
  });
});

describe("temporary closure", () => {
  const r = result("08:00", "18:00", { lighting: lighting(0, 24) });
  // decided Tuesday night: closed Wednesday, reopening Thursday
  const e = ev({ day: 2, t: at(2, "23:30"), action: "temporary_closure", from: "Wednesday", to: "Thursday", reason: "Street closed for works, closed until Thursday." });

  it("resolves its days", () => {
    expect(closureDays(e)).toEqual([3, 4]);
    expect(closureDays(ev({ day: 2, t: 0, action: "temporary_closure" }))).toEqual([3, 4]);
    expect(closureDays(ev({ day: 2, t: 0, action: "temporary_closure", to: "Saturday" }))).toEqual([3, 6]);
  });

  it("shuts whole days, dark, with the owner's reason", () => {
    const s = storeStateAt(r, [e], at(3, "12:00"));
    expect(s).toMatchObject({ open: false, hours: null, shutAllDay: true, lighting: "off", reason: e.reason });
    expect(storeStateAt(r, [e], at(4, "12:00")).open).toBe(true);
    expect(storeStateAt(r, [e], at(2, "12:00")).open).toBe(true);
  });
});

describe("closed for good", () => {
  const r = result("08:00", "18:00", { closedFromDay: 11 });
  it("is shut and dark from closedFromDay on", () => {
    expect(storeStateAt(r, [], at(10, "12:00")).open).toBe(true);
    const s = storeStateAt(r, [], at(11, "12:00"));
    expect(s).toMatchObject({ open: false, closedForGood: true, lighting: "off", hours: null });
    expect(storeStateAt(r, [], at(14, "12:00")).closedForGood).toBe(true);
  });

  it("falls back to the closed_permanently event (from the next day)", () => {
    const e = ev({ day: 10, t: at(10, "23:30"), action: "closed_permanently", reason: "Not enough trade to cover costs, closing for good." });
    const plain = result("08:00", "18:00");
    expect(storeStateAt(plain, [e], at(10, "12:00")).closedForGood).toBe(false);
    const s = storeStateAt(plain, [e], at(12, "12:00"));
    expect(s.closedForGood).toBe(true);
    expect(s.reason).toBe(e.reason);
  });
});

describe("lighting", () => {
  it("lighting_changed applies to closed hours with the `from` level, from the decision on", () => {
    const r = result("08:00", "18:00", { lighting: lighting(0, 24, "high") });
    const e = ev({ day: 2, t: at(2, "23:30"), action: "lighting_changed", from: "high", to: "off", reason: "Window lights off after close." });
    expect(storeStateAt(r, [e], at(2, "22:00")).lighting).toBe("high"); // not decided yet
    expect(storeStateAt(r, [e], at(3, "22:00")).lighting).toBe("off");
    expect(storeStateAt(r, [e], at(3, "12:00")).lighting).toBe("high"); // open: unchanged
    const lowOnly = { ...e, from: "low" };
    expect(storeStateAt(r, [lowOnly], at(3, "22:00")).lighting).toBe("high");
  });

  it("reason for persistent decisions shows the day they're made and the next day only", () => {
    const r = result("08:00", "18:00");
    const e = ev({ day: 2, t: at(2, "23:30"), action: "hours_changed", from: "18:00", to: "19:00", reason: "Busy evenings." });
    expect(storeStateAt(r, [e], at(3, "10:00")).reason).toBe("Busy evenings.");
    expect(storeStateAt(r, [e], at(4, "10:00")).reason).toBeUndefined();
  });
});

describe("eventsByStore", () => {
  it("groups and sorts by time", () => {
    const m = eventsByStore([
      ev({ storeId: "a", day: 2, t: 50, action: "shut_early" }),
      ev({ storeId: "b", day: 1, t: 10, action: "open_late" }),
      ev({ storeId: "a", day: 1, t: 5, action: "open_late" }),
    ]);
    expect(m.get("a")!.map((e) => e.t)).toEqual([5, 50]);
    expect(m.get("b")).toHaveLength(1);
  });
});

describe("weekGrid", () => {
  it("marks cells that changed vs the run's start, and applies today-only actions on today's row", () => {
    const r = result("11:00", "23:00", {
      schedule: [
        { fromDay: 1, week: week({ open: "11:00", close: "23:00" }) },
        { fromDay: 4, week: week({ open: "11:00", close: "00:00" }, { 0: null }) },
      ],
    });
    const shut = ev({ day: 5, t: at(5, "15:00"), action: "shut_early", to: "15:00" });
    const g = weekGrid(r, [shut], 5);
    expect(g).toHaveLength(7);
    expect(g[0].open.every((x) => !x)).toBe(true);
    expect(g[0].changed[12]).toBe("removed");
    expect(g[1].open[23]).toBe(true);
    expect(g[1].changed[23]).toBe("added");
    expect(g[1].changed[12]).toBeNull();
    // Friday (day 5) is today: shut at 15:00
    expect(g[4].today).toBe(true);
    expect(g[4].hours).toEqual({ open: "11:00", close: "15:00" });
    expect(g[4].open[14]).toBe(true);
    expect(g[4].open[16]).toBe(false);
    expect(g[4].changed[16]).toBe("removed");
    // week 1 has no changes at all
    expect(weekGrid(r, [], 2).flatMap((row) => row.changed).every((c) => c === null)).toBe(true);
  });
});
