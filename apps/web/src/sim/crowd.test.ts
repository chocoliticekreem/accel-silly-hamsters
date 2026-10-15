import { describe, expect, it } from "vitest";
import { rng } from "../mock/rng";
import { createSeparator, pavementPath } from "./crowd";
import { newPoint } from "./polyline";

function minPairDistance(xs: Float32Array, zs: Float32Array, from: number, n: number) {
  let best = Infinity;
  for (let i = from; i < n; i++)
    for (let j = 0; j < i; j++) best = Math.min(best, Math.hypot(xs[i] - xs[j], zs[i] - zs[j]));
  return best;
}

describe("separator", () => {
  it("splits people standing on exactly the same spot", () => {
    const sep = createSeparator(16);
    const xs = new Float32Array(5).fill(10);
    const zs = new Float32Array(5).fill(-4);
    sep.separate(xs, zs, 5, 2);
    expect(minPairDistance(xs, zs, 0, 5)).toBeGreaterThan(1.9);
  });

  it("clears a dense random crowd to the minimum gap", () => {
    const r = rng(3);
    const n = 600;
    const sep = createSeparator(n);
    const xs = new Float32Array(n);
    const zs = new Float32Array(n);
    // 600 people in an 80 x 80 m square (~11 m² each): far denser than any pavement in the sim
    for (let i = 0; i < n; i++) {
      xs[i] = r() * 80;
      zs[i] = r() * 80;
    }
    sep.separate(xs, zs, n, 1.9);
    let close = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (Math.hypot(xs[i] - xs[j], zs[i] - zs[j]) < 1.9 * 0.7) close++;
    expect(close).toBe(0);
  });

  it("never moves fixed obstacles, steers others clear of them, and respects maxPush", () => {
    const sep = createSeparator(8);
    const xs = new Float32Array([0, 0.1, 0.2]);
    const zs = new Float32Array([0, 0, 0]);
    sep.separate(xs, zs, 3, 2, { fixed: 1, maxPush: 5 });
    expect(xs[0]).toBe(0);
    expect(zs[0]).toBe(0);
    expect(minPairDistance(xs, zs, 1, 3)).toBeGreaterThan(1.9);

    const ys = new Float32Array([0, 0.5]);
    const ws = new Float32Array([0, 0]);
    sep.separate(ys, ws, 2, 4, { fixed: 1, maxPush: 1 });
    expect(Math.hypot(ys[1] - 0.5, ws[1])).toBeCloseTo(1, 5);
  });

  it("leaves people who are already apart exactly where they are", () => {
    const sep = createSeparator(8);
    const xs = new Float32Array([0, 3, 6, 0]);
    const zs = new Float32Array([0, 0, 0, 3]);
    expect(sep.separate(xs, zs, 4, 2)).toBe(0);
    expect(Array.from(xs)).toEqual([0, 3, 6, 0]);
  });
});

describe("pavementPath", () => {
  const p = newPoint();

  it("walks beside the kerb: half the street width plus the inset, on the chosen side", () => {
    // a 10 m wide street running north
    const path = pavementPath([[0, 0], [0, 100]], [10]);
    expect(path.length).toBe(100);
    path.at(50, 1, 2, p);
    expect(p.x).toBeCloseTo(7); // right of northward travel = east
    expect(p.z).toBeCloseTo(50);
    path.at(50, -1, 2, p);
    expect(p.x).toBeCloseTo(-7);
  });

  it("follows each street's width and glides round corners without jumping", () => {
    // 14 m wide street east, then a 3 m alley north
    const path = pavementPath([[0, 0], [100, 0], [100, 80]], [14, 3]);
    path.at(40, -1, 2, p);
    expect(p.z).toBeCloseTo(9); // left of eastward travel = north, 7 + 2
    path.at(150, -1, 2, p);
    expect(p.x).toBeCloseTo(96.5); // left of northward travel = west, 1.5 + 2
    let prevX = NaN;
    let prevZ = NaN;
    let worst = 0;
    for (let s = 0; s <= path.length; s += 0.25) {
      path.at(s, -1, 3, p);
      if (!Number.isNaN(prevX)) worst = Math.max(worst, Math.hypot(p.x - prevX, p.z - prevZ));
      prevX = p.x;
      prevZ = p.z;
      expect(Math.hypot(p.dx, p.dz)).toBeCloseTo(1);
    }
    // 0.25 m steps along the centre line: a jump would show as a step of metres
    expect(worst).toBeLessThan(1.5);
  });
});
