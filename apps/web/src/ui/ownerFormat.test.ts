import { describe, expect, it } from "vitest";
import type { OwnerEvent, StreetEvent } from "../api/contract";
import { actionLabel, feedItems, feedRows, momentLabel, RUSH_HOUR_TEXT, weekdayTime, type FeedItem } from "./ownerFormat";

const shut: OwnerEvent = {
  day: 3,
  t: 3780,
  storeId: "s1",
  action: "shut_early",
  from: "23:00",
  to: "15:00",
  reason: "Roadworks outside, nobody can get in, shutting at 15:00.",
  trigger: { kind: "roadworks", value: 0.54, label: "footfall −54% vs usual" },
};
const works: StreetEvent = { day: 3, fromT: 3300, toT: 4020, kind: "roadworks", streetId: "brick-ln", label: "Roadworks, Brick Ln", severity: 0.54 };
const traffic = (streetId: string, name: string): StreetEvent => ({ day: 3, fromT: 3330, toT: 3450, kind: "heavy_traffic", streetId, label: `Heavy traffic, ${name}`, severity: 0.4 });
const names = (id: string) => (id === "s1" ? "Kebab Co" : id);

describe("owner labels", () => {
  it("reads like the spec's ticker", () => {
    expect(momentLabel(shut.t)).toBe("Wed · 15:00");
    expect(weekdayTime(shut.t)).toBe("Wed 15:00");
    expect(actionLabel(shut)).toBe("shut early at 15:00");
    expect(actionLabel({ ...shut, action: "temporary_closure", from: "Friday", to: "Saturday" })).toBe("closed until Saturday");
    expect(actionLabel({ ...shut, action: "closed_permanently", from: null, to: null })).toBe("closed for good");
  });
});

describe("feedItems", () => {
  it("lists what happened in the window, newest first, with the trigger", () => {
    const items = feedItems([shut], [works, traffic("old-st", "Old St"), traffic("shoreditch-high-st", "Shoreditch High St")], 3800, 24 * 60, names);
    expect(items.map((i) => i.text)).toEqual(["Kebab Co shut early at 15:00 · roadworks outside", "Rush-hour traffic on the main roads", "Roadworks · Brick Ln"]);
    expect(items[2]).toMatchObject({ kind: "street", live: true });
    expect(items[1]).toMatchObject({ kind: "street", live: false });
  });

  it("hides what hasn't happened yet and what's long over, but keeps ongoing street events", () => {
    expect(feedItems([shut], [], 3700, 1440, names)).toHaveLength(0);
    expect(feedItems([shut], [], 3780 + 1441, 1440, names)).toHaveLength(0);
    const long = { ...works, toT: 3300 + 3 * 1440 };
    expect(feedItems([], [long], 3300 + 2 * 1440, 1440, names)).toHaveLength(1);
  });
});

describe("feed collapsing", () => {
  const jam = (day: number, fromT: number, streetId: string): StreetEvent => ({ day, fromT, toT: fromT + 120, kind: "heavy_traffic", streetId, label: `Heavy traffic, ${streetId}`, severity: 0.4 });
  const club = (day: number, fromT: number): StreetEvent => ({ day, fromT, toT: fromT + 300, kind: "club_night", streetId: null, label: "Club night, Little Fires", severity: 0.5 });
  const day = (d: number, minutes: number) => (d - 1) * 1440 + minutes;

  it("folds a day's morning and evening jams on every main road into one rush-hour line, listed once", () => {
    const street = [4, 5].flatMap((d) => ["bgr", "commercial", "ges"].flatMap((s) => [jam(d, day(d, 450), s), jam(d, day(d, 990), s)]));
    const items = feedItems([], street, day(5, 14 * 60), 24 * 60, names);
    expect(items.map((i) => i.text)).toEqual([RUSH_HOUR_TEXT]);
    expect(items[0]).toMatchObject({ t: day(5, 450), live: false });
    // the evening rush has started: still a single line, now stamped at the evening and live
    const evening = feedItems([], street, day(5, 17 * 60), 24 * 60, names);
    expect(evening).toHaveLength(1);
    expect(evening[0]).toMatchObject({ t: day(5, 990), live: true });
  });

  it("lists a repeating street event once, at its latest occurrence", () => {
    const items = feedItems([], [club(4, day(4, 22 * 60)), club(5, day(5, 22 * 60))], day(5, 23 * 60), 48 * 60, names);
    expect(items).toHaveLength(1);
    expect(items[0].t).toBe(day(5, 22 * 60));
  });
});

describe("feedRows", () => {
  const owner = (t: number): FeedItem => ({ key: `o${t}`, kind: "owner", t, event: { ...shut, t }, storeName: "Kebab Co", text: `o${t}` });
  const street = (t: number): FeedItem => ({ key: `s${t}`, kind: "street", t, events: [works], text: `s${t}`, live: false });

  it("gives owner decisions the rows first, keeping a little room for the street", () => {
    const items = [street(100), street(90), street(80), owner(70), owner(60), owner(50), owner(40), owner(30), owner(20), owner(10)];
    expect(feedRows(items, 6).map((r) => r.text)).toEqual(["s100", "s90", "o70", "o60", "o50", "o40"]);
  });

  it("lets street events fill the rows when owners are quiet, newest first", () => {
    expect(feedRows([street(100), owner(95), street(90), street(80), street(70)], 3).map((r) => r.text)).toEqual(["s100", "o95", "s90"]);
  });
});
