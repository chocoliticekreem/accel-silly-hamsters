// Calibration maths: compare the sim's hourly visits with a Popular Times target on the same 0–100 scale.
import type { CalibrationVenue } from "../api/contract";

/** Scale so the busiest hour = 100 (Popular Times' convention). All-zero stays all-zero. */
export function toPeak100(xs: number[]): number[] {
  const peak = Math.max(0, ...xs);
  return peak > 0 ? xs.map((x) => (x / peak) * 100) : xs.map(() => 0);
}

/** The target for an average day of a 14-day run: 5 weekdays + 2 weekend days per week, re-peaked. */
export function blendedTarget(v: CalibrationVenue): number[] {
  return toPeak100(v.weekday.map((w, h) => (w * 5 + v.weekend[h] * 2) / 7));
}

/** Mean absolute gap in points (0–100) over hours where either curve is non-zero. */
export function meanGap(sim: number[], target: number[]): number {
  let sum = 0;
  let n = 0;
  for (let h = 0; h < 24; h++) {
    if (sim[h] === 0 && target[h] === 0) continue;
    sum += Math.abs(sim[h] - target[h]);
    n++;
  }
  return n ? sum / n : 0;
}
