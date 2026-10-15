import { describe, expect, it } from "vitest";
import type { OwnerEvent, StreetEvent } from "../api/contract";
import { actionLabel, feedItems, momentLabel, weekdayTime } from "./ownerFormat";

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
    expect(momentLabel(shut.t)).toBe("Day 3 · 15:00");
    expect(weekdayTime(shut.t)).toBe("Wed 15:00");
    expect(actionLabel(shut)).toBe("shut early at 15:00");
    expect(actionLabel({ ...shut, action: "temporary_closure", from: "Friday", to: "Saturday" })).toBe("closed until Saturday");
    expect(actionLabel({ ...shut, action: "closed_permanently", from: null, to: null })).toBe("closed for good");
  });
});

describe("feedItems", () => {
  it("lists what happened in the window, newest first, with the trigger", () => {
    const items = feedItems([shut], [works, traffic("old-st", "Old St"), traffic("shoreditch-high-st", "Shoreditch High St")], 3800, 24 * 60, names);
    expect(items.map((i) => i.text)).toEqual(["Kebab Co shut early at 15:00 · roadworks outside", "Heavy traffic · Old St, Shoreditch High St", "Roadworks · Brick Ln"]);
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
