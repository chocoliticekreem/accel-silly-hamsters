// Interior layouts for the "Look inside" cutaway (pure, no WebGL). Local frame: x along the facade, z toward the
// street (+z = front wall with the door), origin at the building centre. Metres.
import type { StoreType } from "../../api/contract";

export interface Slot {
  x: number;
  z: number;
  /** Facing: rotation about y in the local frame (0 = toward the street). */
  face: number;
}

export interface InteriorPlan {
  kind: "club" | "seated" | "counter";
  /** Usable floor (inside the walls). */
  w: number;
  d: number;
  /** Where customers stand / sit, in fill order. */
  slots: Slot[];
  /** Staff spots (bar staff, DJ, cloakroom, counter). */
  staff: Slot[];
  /** Club: dancefloor rectangle and the DJ booth. */
  floor?: { x: number; z: number; w: number; d: number };
  booth?: { x: number; z: number };
  bar?: { x: number; z: number; len: number };
  cloak?: { x: number; z: number };
  /** Cafés/restaurants: table centres. */
  tables?: { x: number; z: number }[];
  door: { x: number; z: number };
}

const WALL = 0.6;
/** Spacing between figures (they are drawn at 2× scale, so ~1.5 m apart). */
const GAP = 1.5;

export function planFor(type: StoreType, width: number, depth: number): InteriorPlan {
  const w = Math.max(6, width - WALL * 2);
  const d = Math.max(6, depth - WALL * 2);
  const door = { x: 0, z: d / 2 - 0.8 };
  if (type === "club") {
    // DJ booth at the back, dancefloor in the middle, bar down the left wall, cloakroom by the door on the right
    const floor = { x: w * 0.08, z: -d * 0.02, w: w * 0.62, d: d * 0.55 };
    const slots: Slot[] = [];
    const cols = Math.max(2, Math.floor(floor.w / GAP));
    const rows = Math.max(2, Math.floor(floor.d / GAP));
    // fill from the middle of the floor outwards (the busiest spot is the centre, near the decks)
    const cells: Slot[] = [];
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const x = floor.x - floor.w / 2 + (i + 0.5) * (floor.w / cols);
        const z = floor.z - floor.d / 2 + (j + 0.5) * (floor.d / rows);
        cells.push({ x, z, face: Math.PI }); // facing the DJ at the back
      }
    cells.sort((a, b) => Math.hypot(a.x - floor.x, a.z - floor.z) - Math.hypot(b.x - floor.x, b.z - floor.z) || a.x - b.x || a.z - b.z);
    slots.push(...cells);
    // then along the bar
    const bar = { x: -w / 2 + 1.2, z: -d * 0.05, len: d * 0.6 };
    for (let k = 0; k < Math.floor(bar.len / GAP); k++) slots.push({ x: bar.x + 1.6, z: bar.z - bar.len / 2 + (k + 0.5) * GAP, face: -Math.PI / 2 });
    const booth = { x: floor.x, z: -d / 2 + 1.6 };
    const cloak = { x: w / 2 - 1.6, z: d / 2 - 2.4 };
    const staff: Slot[] = [
      { x: booth.x, z: booth.z - 0.6, face: 0 }, // DJ facing the floor
      { x: bar.x - 0.5, z: bar.z - bar.len / 4, face: Math.PI / 2 },
      { x: bar.x - 0.5, z: bar.z + bar.len / 4, face: Math.PI / 2 },
      { x: cloak.x + 0.6, z: cloak.z, face: -Math.PI / 2 },
    ];
    return { kind: "club", w, d, slots, staff, floor, booth, bar, cloak, door };
  }
  if (type === "cafe" || type === "restaurant" || type === "bar") {
    // tables in a grid, two seats each, counter along the back
    const tables: { x: number; z: number }[] = [];
    const tx = Math.max(1, Math.floor((w - 1) / 3.4));
    const tz = Math.max(1, Math.floor((d - 3.5) / 3.2));
    for (let i = 0; i < tx; i++)
      for (let j = 0; j < tz; j++) tables.push({ x: -w / 2 + (i + 0.5) * (w / tx), z: -d / 2 + 3 + (j + 0.5) * ((d - 3.5) / tz) });
    const slots = tables.flatMap((t) => [
      { x: t.x - 0.9, z: t.z, face: Math.PI / 2 },
      { x: t.x + 0.9, z: t.z, face: -Math.PI / 2 },
    ]);
    const staff = [{ x: 0, z: -d / 2 + 0.9, face: 0 }];
    return { kind: "seated", w, d, slots, staff, tables, bar: { x: 0, z: -d / 2 + 1.6, len: w * 0.6 }, door };
  }
  // shops, takeaways, off-licences: a counter at the back, people standing at it and browsing
  const slots: Slot[] = [];
  for (let k = 0; k < Math.floor((w - 2) / GAP); k++) slots.push({ x: -w / 2 + 1.5 + k * GAP, z: -d / 2 + 2.8, face: Math.PI });
  for (let j = 0; j < Math.floor((d - 5) / GAP); j++)
    for (let i = 0; i < Math.floor((w - 3) / (GAP * 2)); i++) slots.push({ x: -w / 2 + 2 + i * GAP * 2, z: -d / 2 + 4.6 + j * GAP, face: Math.PI / 2 });
  return { kind: "counter", w, d, slots, staff: [{ x: 0, z: -d / 2 + 0.9, face: 0 }], bar: { x: 0, z: -d / 2 + 1.6, len: w * 0.7 }, door };
}

/**
 * A fight on the dancefloor, non-graphic: the two involved square up 1.4 m apart at the floor centre, everyone within
 * `radius` steps back onto a ring facing them. Returns new positions for `slots` (the first two are the pair).
 */
export function fightRing(slots: Slot[], centre: { x: number; z: number }, radius = 4.2): Slot[] {
  return slots.map((s, k) => {
    if (k === 0) return { x: centre.x - 0.7, z: centre.z, face: Math.PI / 2 };
    if (k === 1) return { x: centre.x + 0.7, z: centre.z, face: -Math.PI / 2 };
    const dx = s.x - centre.x;
    const dz = s.z - centre.z;
    const d = Math.hypot(dx, dz);
    if (d >= radius) return s;
    const a = d > 0.01 ? Math.atan2(dx, dz) : (k * 2.4) % (Math.PI * 2);
    const r = radius + (k % 3) * 0.5;
    // face the centre: direction (−sin a, −cos a)
    return { x: centre.x + Math.sin(a) * r, z: centre.z + Math.cos(a) * r, face: a + Math.PI };
  });
}

/** Linear blend of two points (k clamped to 0..1). */
export const lerp2 = (a: { x: number; z: number }, b: { x: number; z: number }, k: number) => {
  const t = Math.max(0, Math.min(1, k));
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
};
