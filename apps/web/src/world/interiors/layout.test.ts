import { describe, expect, it } from "vitest";
import { isClubNight, localFrame, nightOf, queueLength, toWorld, venues, XOYO } from "../clubs";
import { generateMap } from "../../mock/map";
import { fightRing, planFor } from "./layout";

describe("interior plans", () => {
  it("lays out a club: dancefloor slots inside the walls, DJ, bar and cloakroom staff", () => {
    const p = planFor("club", 24, 18);
    expect(p.kind).toBe("club");
    expect(p.slots.length).toBeGreaterThan(40);
    expect(p.staff).toHaveLength(4);
    for (const s of [...p.slots, ...p.staff]) {
      expect(Math.abs(s.x)).toBeLessThanOrEqual(p.w / 2);
      expect(Math.abs(s.z)).toBeLessThanOrEqual(p.d / 2);
    }
    // the first dancer is the closest to the floor centre
    const c = p.floor!;
    const d = (s: { x: number; z: number }) => Math.hypot(s.x - c.x, s.z - c.z);
    expect(d(p.slots[0])).toBeLessThanOrEqual(d(p.slots[10]));
  });

  it("seats café customers at tables and gives shops a counter", () => {
    const cafe = planFor("cafe", 14, 12);
    expect(cafe.kind).toBe("seated");
    expect(cafe.slots.length).toBe(cafe.tables!.length * 2);
    expect(planFor("takeaway", 10, 10).kind).toBe("counter");
  });

  it("opens a ring around the two involved in a dancefloor fight; nobody inside it", () => {
    const p = planFor("club", 24, 18);
    const centre = { x: p.floor!.x, z: p.floor!.z };
    const ring = fightRing(p.slots.slice(0, 30), centre, 4);
    expect(Math.hypot(ring[0].x - ring[1].x, ring[0].z - ring[1].z)).toBeCloseTo(1.4);
    for (const s of ring.slice(2)) expect(Math.hypot(s.x - centre.x, s.z - centre.z)).toBeGreaterThanOrEqual(4 - 1e-9);
  });
});

describe("club venues", () => {
  it("lists the map's clubs plus XOYO in the surroundings at its real position", () => {
    const map = generateMap(42);
    const v = venues(map);
    expect(v.filter((x) => x.storeId && x.club)).toHaveLength(2);
    const xoyo = v.find((x) => x.key === "xoyo")!;
    expect(xoyo.storeId).toBeNull();
    expect([xoyo.b.x, xoyo.b.z]).toEqual([XOYO.x, XOYO.z]);
  });

  it("knows club nights, the night a minute belongs to, and builds a queue before opening", () => {
    expect(isClubNight(5)).toBe(true); // Friday
    expect(isClubNight(1)).toBe(false); // Monday
    expect(nightOf(5 * 1440 + 3 * 60)).toBe(5); // 03:00 Saturday belongs to Friday night
    expect(nightOf(5 * 1440 + 22 * 60)).toBe(6);
    const n = { open: true, openT: 1000, closeT: 1300 };
    expect(queueLength(n, 900, 10)).toBe(0);
    expect(queueLength(n, 1100, 10)).toBe(10);
    expect(queueLength(n, 1300, 10)).toBe(0);
  });

  it("maps the local frame so +z faces the street", () => {
    const f = localFrame({ x: 10, z: 20, w: 8, d: 12 }, 0, 1); // faces north
    const [x, z] = toWorld(f, 0, 5);
    // north = scene -z
    expect(x).toBeCloseTo(10);
    expect(z).toBeCloseTo(-25);
  });
});
