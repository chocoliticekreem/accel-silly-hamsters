import { describe, expect, it } from "vitest";
import type { CityMap } from "../api/contract";
import { generateMap } from "../mock/map";
import { closestOnStreet, frontage } from "./geometry";
import { BUILDING, cellCenter, CELL, FREE, findRegions, occupancy, planInfill, rectStreetDistance, STREET, STREET_PAD } from "./infill";

/** 100 m square, one east-west street through the middle, one building in the north-west quarter. */
const toy: CityMap = {
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  streets: [{ id: "s", name: "S", width: 10, points: [[-50, 0], [50, 0]] }],
  buildings: [{ id: "b", kind: "office", x: -25, z: 25, w: 20, d: 20, h: 20 }],
  stores: [],
  entryPoints: [],
};

const overlaps = (a: { x: number; z: number; w: number; d: number }, b: { x: number; z: number; w: number; d: number }, pad = 0) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w + pad * 2 - 1e-6 && Math.abs(a.z - b.z) * 2 < a.d + b.d + pad * 2 - 1e-6;

describe("infill occupancy", () => {
  it("marks building and street cells, leaves the rest free", () => {
    const g = occupancy(toy);
    expect(g.nx).toBe(100 / CELL);
    const at = (x: number, z: number) => g.state[Math.floor((z - g.z0) / g.cell) * g.nx + Math.floor((x - g.x0) / g.cell)];
    expect(at(-25, 25)).toBe(BUILDING);
    expect(at(0, 0)).toBe(STREET);
    expect(at(30, 30)).toBe(FREE);
    expect(at(30, -30)).toBe(FREE);
  });

  it("no free cell touches a building (+margin) or a street (+pavement)", () => {
    for (const map of [toy, generateMap()]) {
      const g = occupancy(map);
      for (let j = 0; j < g.nz; j++)
        for (let i = 0; i < g.nx; i++) {
          if (g.state[j * g.nx + i] !== FREE) continue;
          const [x, z] = cellCenter(g, i, j);
          const cell = { x, z, w: g.cell, d: g.cell };
          for (const b of map.buildings) expect(overlaps(cell, b, 2)).toBe(false);
          for (const s of map.streets) expect(closestOnStreet(s, x, z)[2]).toBeGreaterThanOrEqual(s.width / 2 + STREET_PAD);
        }
    }
  });
});

describe("infill regions", () => {
  it("finds the empty quarters of the toy map as separate regions", () => {
    const regions = findRegions(occupancy(toy));
    // north (minus the building) and south of the street are disconnected
    expect(regions.length).toBe(2);
    expect(regions[0].cells.length).toBeGreaterThan(regions[1].cells.length); // south is the bigger one
    expect(regions.every((r) => r.touchesStreet)).toBe(true);
  });

  it("drops regions below the minimum size", () => {
    expect(findRegions(occupancy(toy), 10_000)).toEqual([]);
  });
});

describe("infill plan", () => {
  for (const [name, map] of [
    ["toy", toy],
    ["mock", generateMap()],
  ] as const) {
    it(`${name}: plots stay off buildings and streets`, () => {
      const plan = planInfill(map);
      expect(plan.plots.length).toBeGreaterThan(0);
      for (const p of plan.plots) {
        for (const b of map.buildings) expect(overlaps(p, b, 2)).toBe(false);
        for (const s of map.streets) expect(rectStreetDistance(p, s)).toBeGreaterThanOrEqual(s.width / 2 + STREET_PAD - 1e-6);
        const { minX, maxX, minZ, maxZ } = map.bounds;
        expect(p.x - p.w / 2).toBeGreaterThanOrEqual(minX - 1e-6);
        expect(p.x + p.w / 2).toBeLessThanOrEqual(maxX + 1e-6);
        expect(p.z - p.d / 2).toBeGreaterThanOrEqual(minZ - 1e-6);
        expect(p.z + p.d / 2).toBeLessThanOrEqual(maxZ + 1e-6);
      }
    });

    it(`${name}: plots don't overlap each other and is deterministic`, () => {
      const a = planInfill(map);
      for (let i = 0; i < a.plots.length; i++) for (let k = i + 1; k < a.plots.length; k++) expect(overlaps(a.plots[i], a.plots[k])).toBe(false);
      expect(planInfill(map).plots).toEqual(a.plots);
    });
  }

  it("keeps store frontages clear", () => {
    const map = generateMap();
    const plan = planInfill(map);
    for (const b of map.buildings.filter((x) => x.kind === "store" || x.kind === "club")) {
      const f = frontage(b, map.streets);
      const front = { x: f.facadeX + f.nx * 2, z: f.facadeZ + f.nz * 2, w: f.nx ? 4 : b.w, d: f.nz ? 4 : b.d };
      for (const p of plan.plots) {
        expect(overlaps(p, b, 3)).toBe(false);
        expect(overlaps(p, front)).toBe(false);
      }
    }
  });

  it("measures rect-to-street distance", () => {
    const s = toy.streets[0];
    expect(rectStreetDistance({ x: 0, z: 20, w: 10, d: 10 }, s)).toBeCloseTo(15);
    expect(rectStreetDistance({ x: 0, z: 0, w: 4, d: 4 }, s)).toBe(0);
  });
});
