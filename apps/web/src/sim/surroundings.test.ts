import { describe, expect, it } from "vitest";
import { generateMap } from "../mock/map";
import { exitContinuations, fillLines, mapExits, planSurroundings, polyDist } from "./surroundings";
import { rng } from "../mock/rng";

const map = generateMap();
const plan = planSurroundings(map);

describe("surroundings plan", () => {
  it("is deterministic", () => {
    const again = planSurroundings(map);
    expect(again.buildings.length).toBe(plan.buildings.length);
    expect(again.buildings[123]).toEqual(plan.buildings[123]);
  });

  it("never builds on the map or its perimeter road, and fills out to the horizon", () => {
    const { x0, x1, z0, z1 } = plan.inner;
    for (const b of plan.buildings) {
      const inside = b.x + b.w / 2 > x0 && b.x - b.w / 2 < x1 && b.z + b.d / 2 > z0 && b.z - b.d / 2 < z1;
      expect(inside).toBe(false);
    }
    expect(plan.buildings.length).toBeGreaterThan(3000);
    expect(Math.max(...plan.buildings.map((b) => Math.hypot(b.x, b.z)))).toBeGreaterThan(2400);
  });

  it("keeps buildings off every road", () => {
    // sample: the nearest 2000 buildings to the map, against every road
    const near = [...plan.buildings].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 2000);
    for (const b of near)
      for (const r of plan.roads) {
        // the road's centreline must not pass through the footprint
        const steps = Math.ceil(Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]) / 2);
        const dx = (r.b[0] - r.a[0]) / steps;
        const dz = (r.b[1] - r.a[1]) / steps;
        // only check segments that come near
        if (polyDist(b.x, b.z, [r.a, r.b]) > Math.hypot(b.w, b.d) / 2 + r.width) continue;
        for (let k = 0; k <= steps; k++) {
          const x = r.a[0] + dx * k;
          const z = r.a[1] + dz * k;
          expect(Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2).toBe(false);
        }
      }
  });

  it("continues every street that leaves the map: a stub to the perimeter, then a grid line straight on", () => {
    const exits = mapExits(map);
    expect(exits.length).toBeGreaterThan(0);
    for (const e of exits) {
      const vertical = e.side === "n" || e.side === "s";
      const line = plan.roads.find((r) => (vertical ? Math.abs(r.a[0] - e.x) < 0.1 && Math.abs(r.b[0] - e.x) < 0.1 : Math.abs(r.a[1] - e.z) < 0.1 && Math.abs(r.b[1] - e.z) < 0.1) && Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]) > 1000);
      expect(line, `${e.street.id} ${e.side}`).toBeTruthy();
    }
    const cont = exitContinuations(map, 200);
    expect(cont).toHaveLength(exits.length);
    for (const c of cont) expect(c.points).toHaveLength(3);
  });
});

describe("fillLines", () => {
  it("keeps the fixed lines and fills the gaps", () => {
    const lines = fillLines([10, 400], 0, 600, () => 100, rng(1));
    expect(lines).toContain(10);
    expect(lines).toContain(400);
    for (let i = 1; i < lines.length; i++) expect(lines[i] - lines[i - 1]).toBeLessThan(160);
  });
});
