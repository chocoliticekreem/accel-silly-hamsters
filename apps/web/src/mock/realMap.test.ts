// The mock on the real processed map (what the no-backend deploy runs): stores, clubs and walkers on the real streets.
import { describe, expect, it } from "vitest";
import realMapData from "../../../../data/processed/map.json";
import { DAYS_PER_RUN, type CityMap } from "../api/contract";
import { closestOnStreet } from "../sim/geometry";
import { createMockState, MOCK_SEED } from ".";
import { generateMap } from "./map";
import { mockMap, usableMap } from "./realMap";
import { demoRoles } from "./roles";
import { buildWalkNet } from "./walk";

const real = realMapData as unknown as CityMap;
const state = createMockState();
const streetDist = (m: CityMap, x: number, z: number) => Math.min(...m.streets.map((s) => closestOnStreet(s, x, z)[2]));

describe("mock map source", () => {
  it("is the real processed map: its stores, clubs (XOYO among them), streets and stations", () => {
    expect(state.map.stores.map((s) => s.id)).toEqual(real.stores.map((s) => s.id));
    expect(state.map.streets.length).toBe(real.streets.length);
    expect(state.map.stores.some((s) => s.type === "club" && /xoyo/i.test(s.name))).toBe(true);
    expect(state.map.entryPoints).toEqual(real.entryPoints);
    expect(state.map.landmarks).toEqual(real.landmarks);
  });

  it("falls back to the schematic map only for an unusable file", () => {
    expect(usableMap(real)).toBe(true);
    expect(usableMap({})).toBe(false);
    expect(usableMap({ ...real, stores: [{ id: "x", name: "x", type: "cafe", buildingId: "nope" }] })).toBe(false);
    expect(mockMap(MOCK_SEED).stores.length).toBe(real.stores.length);
    expect(generateMap(MOCK_SEED).stores.length).toBeLessThan(40);
  });

  it("casts the demo story from real stores near the clubs and the station", () => {
    const r = demoRoles(state.map);
    expect(r.takeaway.type).toBe("takeaway");
    expect(r.offlicence.type).toBe("offlicence");
    expect(r.cafe.type).toBe("cafe");
    expect(r.lateClub?.type).toBe("club");
  });
});

describe("walking on the real streets", () => {
  const net = buildWalkNet(real.streets);
  it("puts every store's door on the pavement of a real street", () => {
    for (const s of real.stores) {
      const b = real.buildings.find((x) => x.id === s.buildingId)!;
      const [x, z] = net.door(b.x, b.z);
      expect(streetDist(real, x, z)).toBeLessThan(10);
    }
  });

  it("routes door to door along the streets, never cutting through blocks", () => {
    const doors = real.stores.slice(0, 12).map((s) => {
      const b = real.buildings.find((x) => x.id === s.buildingId)!;
      return net.place(...net.door(b.x, b.z));
    });
    for (const a of doors)
      for (const b of doors) {
        const pts = net.route(a, b, 1);
        expect(pts[0]).toEqual([a.x, a.z]);
        expect(pts[pts.length - 1]).toEqual([b.x, b.z]);
        // every leg's midpoint is on (or beside) a street: no straight lines across a block
        for (let i = 1; i < pts.length; i++) {
          const mx = (pts[i][0] + pts[i - 1][0]) / 2;
          const mz = (pts[i][1] + pts[i - 1][1]) / 2;
          expect(streetDist(real, mx, mz)).toBeLessThan(14);
        }
      }
  });
});

describe("mock runs on the real map", () => {
  it("simulates run 1 in a few seconds, with visits at shops and clubs", () => {
    const t0 = performance.now();
    const r = state.result(1);
    expect(performance.now() - t0).toBeLessThan(15_000);
    expect(r.days).toHaveLength(DAYS_PER_RUN);
    expect(r.kpis.visits).toBeGreaterThan(3000);
    const clubs = state.map.stores.filter((s) => s.type === "club");
    expect(clubs.filter((c) => r.stores[c.id].kpis.visits > 0).length).toBeGreaterThanOrEqual(clubs.length - 1);
  });

  it("re-simulates evicted days identically (same seed)", () => {
    const first = state.result(1).days[4].agents.slice(0, 50);
    state.result(2).days;
    state.result(3).days;
    state.result(4).days;
    state.result(5).days;
    expect(state.result(1).days[4].agents.slice(0, 50)).toEqual(first);
  });
});
