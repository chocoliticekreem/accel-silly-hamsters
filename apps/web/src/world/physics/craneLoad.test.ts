import { describe, expect, it } from "vitest";
import { CraneLoadImpl, HOOK_HALF } from "./craneLoad";

const run = (l: CraneLoadImpl, seconds: number, move?: (t: number) => [number, number, number]) => {
  for (let i = 0; i < seconds * 60; i++) {
    if (move) l.setAnchor(...move(i / 60));
    l.fallbackStep(1 / 60);
  }
};

describe("crane load fallback pendulum", () => {
  it("hangs straight down under the anchor at rest", () => {
    const l = new CraneLoadImpl({ ropeLength: 20 });
    l.setAnchor(0, 50, 0);
    run(l, 2);
    expect(l.hook.x).toBeCloseTo(0, 3);
    expect(l.hook.y).toBeCloseTo(30, 1);
    expect(l.position.y).toBeCloseTo(30 - (HOOK_HALF + l.sling + l.size[1] / 2), 1);
  });

  it("lags behind when the trolley moves, then swings", () => {
    const l = new CraneLoadImpl({ ropeLength: 20 });
    l.setAnchor(0, 50, 0);
    run(l, 1);
    // trolley runs out 6 m in 2 s and stops
    run(l, 2, (t) => [Math.min(6, t * 3), 50, 0]);
    expect(l.hook.x).toBeLessThan(6); // still lagging
    let maxX = -Infinity;
    for (let i = 0; i < 300; i++) {
      l.fallbackStep(1 / 60);
      maxX = Math.max(maxX, l.hook.x);
    }
    expect(maxX).toBeGreaterThan(6); // overshoots: a real swing
    expect(Math.hypot(l.hook.x - 6, l.hook.y - 50)).toBeLessThanOrEqual(20.01); // rope never stretches
  });

  it("sets the load down on the ground when the rope is paid out", () => {
    const l = new CraneLoadImpl({ ropeLength: 20 });
    l.setAnchor(0, 30, 0);
    run(l, 1);
    l.setRopeLength(40);
    run(l, 3);
    expect(l.position.y).toBeCloseTo(l.size[1] / 2, 2);
  });
});
