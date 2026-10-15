// Spitalfields crowds: who is out where, by the sim clock. Each walker paces a short path (ping-pong, pausing at
// the ends to browse a stall or wait), and each zone's turnout follows the real week:
//  - Old Spitalfields Market: daily 10:00-20:00, busiest at weekends;
//  - Sunday Upmarket / Ely's Yard / Brick Lane north: the Sunday market (10-17), a smaller Saturday one;
//  - Brick Lane: shoppers by day, the curry crowd in the evening (Fri/Sat late);
//  - Petticoat Lane (Wentworth St): Mon-Fri 9-14 and Sunday mornings;
//  - Bishopsgate and Liverpool Street: weekday commuters in the rush hours;
//  - Commercial Street and Christ Church's steps: steady through the day.
// Pure planning (contract coords). The module turns walkers into people every frame.
import { Color } from "three";
import { rng, type Rng } from "../../mock/rng";
import { polyline, type Polyline } from "../../sim/polyline";
import { SKIN_TONES, TROUSERS } from "../people";

export type Zone = "hall" | "upmarket" | "sundayRoad" | "bricklane" | "petticoat" | "commute" | "commercial" | "church";

export interface Walker {
  zone: Zone;
  path: Polyline;
  /** Metres right of the path (constant). */
  lateral: number;
  /** Stretch of the path this walker paces: [s0, s1]. */
  s0: number;
  s1: number;
  speed: number;
  pause: number;
  phase: number;
  /** Order within its zone, 0..1: shown when below the zone's turnout. */
  rank: number;
  shirt: Color;
  trousers: Color;
  skin: Color;
  scale: number;
  /** Never walks (stands, chats, waits). */
  still: boolean;
}

const BRIGHT = ["#c0392b", "#e67e22", "#f1c40f", "#16a085", "#2980b9", "#8e44ad", "#ecf0f1", "#d35400", "#27ae60", "#e84393", "#fdcb6e", "#2d3436"];
const SMART = ["#1f2a36", "#2c3e50", "#34495e", "#ecf0f1", "#dfe6e9", "#3d3d3d", "#5d6d7e", "#1b2631"];

export function makeWalker(zone: Zone, pts: [number, number][], r: Rng, opts: { lateral: number; minLen?: number; maxLen?: number; speed?: [number, number]; pause?: [number, number]; smart?: boolean; still?: boolean }): Walker | null {
  if (pts.length < 2) return null;
  const path = polyline(pts);
  if (path.length < 1) return null;
  const want = Math.min(path.length, (opts.minLen ?? 12) + r() * ((opts.maxLen ?? 60) - (opts.minLen ?? 12)));
  const s0 = r() * (path.length - want);
  const [v0, v1] = opts.speed ?? [1.1, 1.5];
  const [p0, p1] = opts.pause ?? [0.5, 3];
  const pal = opts.smart && r() < 0.75 ? SMART : BRIGHT;
  return {
    zone,
    path,
    lateral: opts.lateral,
    s0,
    s1: s0 + want,
    speed: v0 + r() * (v1 - v0),
    pause: p0 + r() * (p1 - p0),
    phase: r() * 200,
    rank: r(),
    shirt: new Color(pal[Math.floor(r() * pal.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.08),
    trousers: TROUSERS[Math.floor(r() * TROUSERS.length)],
    skin: SKIN_TONES[Math.floor(r() * SKIN_TONES.length)],
    scale: 1.68 + r() * 0.2,
    still: !!opts.still,
  };
}

/** Where a walker is at real time `time` (s): distance along its path, whether it's moving, which way. */
export function pace(w: Walker, time: number): { s: number; moving: boolean; dir: 1 | -1 } {
  if (w.still) return { s: (w.s0 + w.s1) / 2, moving: false, dir: 1 };
  const L = w.s1 - w.s0;
  const walk = L / w.speed;
  const P = 2 * (walk + w.pause);
  const tau = (((time + w.phase) % P) + P) % P;
  if (tau < w.pause) return { s: w.s0, moving: false, dir: 1 };
  if (tau < w.pause + walk) return { s: w.s0 + (tau - w.pause) * w.speed, moving: true, dir: 1 };
  if (tau < 2 * w.pause + walk) return { s: w.s1, moving: false, dir: -1 };
  return { s: w.s1 - (tau - 2 * w.pause - walk) * w.speed, moving: true, dir: -1 };
}

/** 0..1 turnout of a zone on weekday `wd` (0 = Monday … 6 = Sunday) at fractional hour `h`. */
export function turnout(zone: Zone, wd: number, h: number): number {
  const weekend = wd >= 5;
  const sun = wd === 6;
  const sat = wd === 5;
  const friSat = wd === 4 || wd === 5;
  const late = h < 6;
  switch (zone) {
    case "hall": {
      const close = sun ? 17 : sat ? 18 : 20;
      if (h < 9.5 || h >= close + 0.5) return 0.02;
      const lunch = h >= 12 && h < 14.5 ? 0.25 : 0;
      return weekend ? 1 : 0.4 + lunch;
    }
    case "upmarket":
      if (sun) return h >= 10 && h < 17.5 ? 1 : h >= 17.5 && h < 20 ? 0.25 : 0.03;
      if (sat) return h >= 11 && h < 18 ? 0.55 : 0.05;
      return h >= 11.5 && h < 15 ? 0.3 : h >= 17 && h < 22 ? 0.25 : 0.03;
    case "sundayRoad":
      return sun && h >= 9 && h < 17.5 ? 1 : 0;
    case "bricklane":
      if (late) return friSat || wd === 5 || wd === 6 ? (h < 3 ? 0.4 : 0.05) : h < 1 ? 0.15 : 0.03;
      if (h < 9) return 0.12;
      if (h < 18) return sun ? 1 : sat ? 0.8 : 0.45;
      if (h < 23.5) return friSat ? 1 : 0.7;
      return 0.4;
    case "petticoat":
      if ((wd <= 4 || sun) && h >= 8.5 && h < 14.5) return sun ? 1 : 0.75;
      return h >= 7 && h < 20 ? 0.12 : 0.02;
    case "commute":
      if (weekend) return h >= 9 && h < 21 ? 0.3 : 0.05;
      if ((h >= 7 && h < 9.75) || (h >= 16.75 && h < 19.25)) return 1;
      if (h >= 9.75 && h < 16.75) return 0.45;
      return h >= 19.25 && h < 23 ? 0.3 : 0.04;
    case "commercial":
      return late ? 0.05 : h < 8 ? 0.15 : h < 22 ? (weekend ? 0.8 : 0.6) : 0.3;
    case "church":
      return h >= 9 && h < 18 ? (sun ? 1 : 0.5) : h >= 18 && h < 21 ? 0.25 : 0;
  }
}

/** The weekday index (0 = Monday) of sim minute `t`: day 1 is a Monday, as in sim/storeState. */
export const weekdayOf = (t: number) => ((Math.floor(t / 1440) % 7) + 7) % 7;

export { rng };
