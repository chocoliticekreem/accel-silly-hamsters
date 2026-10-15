import { describe, expect, it } from "vitest";
import type { Building, CityMap } from "../api/contract";
import { generateMap } from "../mock/map";
import { DECK_Y, headwaySeconds, overgroundRoute, railLevel, realRoute, routeAt, runMotion, TRAIN, trainsPerHour } from "./overground";

const day = (d: number, h: number) => (d - 1) * 1440 + h * 60;

describe("runMotion", () => {
  const stops = [500, 1700];
  const end = 2600;
  it("cruises in, stands at each stop with the doors opening and closing, and leaves", () => {
    expect(runMotion(0, stops, end)).toMatchObject({ d: 0, phase: "approach", stop: 0 });
    let prev = -1;
    const dwelt = [false, false];
    const opened = [0, 0];
    for (let t = 0; t < 400; t += 0.25) {
      const m = runMotion(t, stops, end);
      expect(m.d).toBeGreaterThanOrEqual(prev - 1e-6); // never runs backwards
      prev = m.d;
      if (m.phase === "dwell") {
        expect(m.d).toBe(stops[m.stop]);
        dwelt[m.stop] = true;
        opened[m.stop] = Math.max(opened[m.stop], m.doors);
      } else expect(m.doors).toBe(0);
      if (m.phase === "gone") {
        expect(m.d).toBe(end);
        break;
      }
    }
    expect(dwelt).toEqual([true, true]);
    expect(opened).toEqual([1, 1]);
    expect(runMotion(1e6, stops, end).phase).toBe("gone");
  });

  it("dwells for the configured time", () => {
    let dwell = 0;
    for (let t = 0; t < 200; t += 0.1) if (runMotion(t, [300], 1000).phase === "dwell") dwell += 0.1;
    expect(dwell).toBeCloseTo(TRAIN.dwell, 0);
  });
});

describe("timetable", () => {
  it("runs the weekday peaks hardest, stops in the small hours, and keeps the Night Overground on weekend nights", () => {
    expect(trainsPerHour(day(2, 8))).toBe(16); // Tuesday 08:00
    expect(trainsPerHour(day(2, 13))).toBe(12);
    expect(trainsPerHour(day(2, 22))).toBe(8);
    expect(trainsPerHour(day(2, 3))).toBe(0); // Tuesday 03:00
    expect(trainsPerHour(day(6, 3))).toBe(4); // Saturday 03:00 (Friday night)
    expect(trainsPerHour(day(6, 8))).toBe(12); // Saturday: no peak
    expect(headwaySeconds(0)).toBe(Infinity);
    expect(headwaySeconds(16)).toBeLessThan(headwaySeconds(8));
  });
});

describe("route", () => {
  it("uses the real East London line when the station sits on it: Hoxton then Shoreditch High St, into the tunnel", () => {
    const station: Building = { id: "st", kind: "station", x: -41.4, z: 1, w: 169.6, d: 15.2, h: 12.8 };
    const r = realRoute(station)!;
    expect(r.real).toBe(true);
    expect(r.stops.map((s) => s.name)).toEqual(["Haggerston", "Hoxton", "Shoreditch High Street"]);
    const at = routeAt(r, r.stationS);
    expect(Math.hypot(at.x - station.x, at.z - station.z)).toBeLessThan(3);
    expect(railLevel(r, r.stationS)).toBe(DECK_Y);
    expect(railLevel(r, r.length)).toBeLessThan(-3); // underground at the east end
  });

  it("falls back to the station's own axis on a map without the real line (the mock)", () => {
    const map: CityMap = generateMap();
    const r = overgroundRoute(map)!;
    expect(r.real).toBe(false);
    expect(r.stops).toHaveLength(1);
    const st = map.buildings.find((b) => b.kind === "station")!;
    const at = routeAt(r, r.stationS);
    expect(Math.hypot(at.x - st.x, at.z - st.z)).toBeLessThan(1);
  });
});
