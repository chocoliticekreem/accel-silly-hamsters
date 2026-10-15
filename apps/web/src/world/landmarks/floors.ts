// Floor-by-floor interiors for the landmark buildings (XOYO, Encode Hub, art'otel Hoxton, Boxpark). Each floor is
// built procedurally into two merged buffers (solid furniture with vertex colours, and a glow layer for screens,
// laptops, menu boards and fairy lights), plus the spots where people sit or stand and an occupancy curve over the
// sim clock. Local frame (as world/clubs LocalFrame): x along the facade, +z toward the street, origin at the
// footprint centre, y = 0 at the floor's slab top. Metres. Pure: no WebGL objects are created until geometry().
import { planFor, type InteriorPlan } from "../interiors/layout";
import { Builder } from "./build";
import type { InteriorKey } from "./places";

/** People are drawn a touch over life size so they read from the street-level camera. */
export const PERSON_SCALE = 1.35;
/** Floor-to-floor height and slab thickness. */
export const FLOOR_H = 4.2;
export const SLAB = 0.3;
const S = PERSON_SCALE;
const TABLE = 0.74 * S;
const SEAT = 0.45 * S;
/** How far a seated figure sinks so it reads as sitting (the person mesh has straight legs). */
export const SIT_DROP = -0.36 * S;

export type Pose = "sit" | "stand" | "dance" | "walk";

export interface Slot {
  x: number;
  z: number;
  /** Facing about y in the local frame (0 = toward the street, +z). */
  face: number;
  pose: Pose;
}

/** Occupancy (0..1) at a fractional hour of the day; `wd` = weekday index, 0 = Monday. */
export type Curve = (hour: number, wd: number) => number;

export interface Screen {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  yaw: number;
}

export interface FloorPlan {
  short: string;
  label: string;
  /** Slab-top height relative to street level (negative = basement). */
  y: number;
  solid: Builder;
  glow: Builder;
  /** Customer / guest spots, fill order. */
  slots: Slot[];
  /** Staff spots (present whenever `staffOn` says so). */
  staff: Slot[];
  busy: Curve;
  staffOn: Curve;
  /** XOYO basement: the shared club fit-out (Interiors' ClubFit) uses this layout. */
  club?: InteriorPlan;
  /** People queueing outside the front door (street level). */
  queue?: Slot[];
  /** Big screens whose glow the module animates. */
  screens?: Screen[];
  /** Open-air level (roof terrace): parapet instead of walls. */
  open?: boolean;
}

export interface LevelInfo {
  short: string;
  label: string;
}

const HOTEL_FLOORS = 5;

/** Floor names per landmark, lowest first (the UI needs these without building geometry). */
export const LEVELS: Record<InteriorKey, LevelInfo[]> = {
  xoyo: [
    { short: "B", label: "Club · dancefloor" },
    { short: "G", label: "Entrance & box office" },
    { short: "1", label: "Offices" },
  ],
  encode: [
    { short: "G", label: "Reception & café" },
    { short: "1", label: "Hack hall" },
    { short: "2", label: "Breakout rooms" },
    { short: "R", label: "Roof terrace" },
  ],
  artotel: [
    { short: "G", label: "Lobby & gallery" },
    { short: "1", label: "Restaurant" },
    ...Array.from({ length: HOTEL_FLOORS }, (_, i) => ({ short: String(i + 2), label: "Hotel rooms" })),
    { short: "R", label: "Rooftop bar" },
  ],
  boxpark: [
    { short: "G", label: "Shops" },
    { short: "1", label: "Food & drink deck" },
  ],
};

/** The floor a landmark opens on (the interesting one). */
export const DEFAULT_FLOOR: Record<InteriorKey, number> = { xoyo: 0, encode: 1, artotel: 0, boxpark: 1 };

/** Lowest level's height: XOYO's club is a basement. */
export const BASE_LEVEL: Record<InteriorKey, number> = { xoyo: -1, encode: 0, artotel: 0, boxpark: 0 };

// ---------------------------------------------------------------- occupancy curves

/** 1 inside [a, b) hours (b may pass midnight, e.g. 22..28), easing in/out over `ramp` hours. */
export function window(h: number, a: number, b: number, ramp = 1): number {
  let best = 0;
  for (const x of [h, h + 24, h - 24]) {
    const up = Math.min(1, Math.max(0, (x - a + ramp) / ramp));
    const down = Math.min(1, Math.max(0, (b - x) / ramp));
    best = Math.max(best, Math.min(up, down));
  }
  return best;
}

const weekend = (wd: number) => wd >= 5;
const clubNight = (wd: number, h: number) => {
  // before noon it is still the previous night
  const night = h < 12 ? (wd + 6) % 7 : wd;
  return night >= 3 && night <= 5;
};
export const CURVES = {
  always: (() => 1) as Curve,
  club: ((h, wd) => (clubNight(wd, h) ? window(h, 22.5, 28, 1.2) : 0)) as Curve,
  clubStaff: ((h, wd) => (clubNight(wd, h) ? window(h, 21, 29, 0.2) : 0)) as Curve,
  office: ((h, wd) => (weekend(wd) ? 0.05 : window(h, 9, 18, 1) * 0.85)) as Curve,
  /** Hackathon: packed from mid-morning to late, a hard core coding through the night. */
  hack: ((h) => Math.max(0.3, window(h, 9.5, 23, 1.5))) as Curve,
  cafe: ((h) => window(h, 8, 18, 1) * (0.5 + 0.5 * window(h, 12, 14, 0.5))) as Curve,
  breakout: ((h) => Math.max(0.1, window(h, 10, 22, 1) * 0.8)) as Curve,
  terrace: ((h) => window(h, 12, 22, 1.5) * 0.7) as Curve,
  lobby: ((h) => 0.25 + 0.6 * window(h, 15, 19, 1.5) + 0.3 * window(h, 8, 10, 1)) as Curve,
  dining: ((h) => Math.max(window(h, 12, 14.5, 0.8) * 0.8, window(h, 18.5, 22.5, 1), 0.08 * window(h, 7, 23, 0.5))) as Curve,
  rooms: ((h) => 0.2 + 0.7 * window(h, 22, 32, 1.5)) as Curve,
  roofBar: ((h, wd) => window(h, 17, 25.5, 1.5) * (weekend(wd) || wd >= 3 ? 1 : 0.7)) as Curve,
  shops: ((h) => window(h, 10, 20, 1) * (0.55 + 0.45 * window(h, 12, 15, 1))) as Curve,
  food: ((h) => Math.max(window(h, 12, 14.5, 0.8), window(h, 17.5, 23, 1)) * 0.95 + 0.05 * window(h, 11, 23, 0.5)) as Curve,
  daytime: ((h) => window(h, 8, 23, 0.5)) as Curve,
};

// ---------------------------------------------------------------- shared pieces

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const face = (dx: number, dz: number) => Math.atan2(dx, dz);

interface ShellOpts {
  wall: string;
  floor: string;
  /** Wall height (low cutaway walls). */
  wallH?: number;
  pillars?: boolean;
  /** Door gap in the front wall (ground floors). */
  door?: boolean;
  /** Parapet only (roof). */
  open?: boolean;
}

/** Slab, low cutaway walls with a door gap and full-height pillars at the corners and along the long walls. */
function shell(b: Builder, w: number, d: number, o: ShellOpts) {
  const t = 0.35;
  b.box(0, -SLAB, 0, w + t * 2, SLAB, d + t * 2, o.floor);
  const wh = o.open ? 1.1 : (o.wallH ?? 1.5);
  b.box(0, 0, -d / 2 - t / 2, w + t * 2, wh, t, o.wall);
  b.box(-w / 2 - t / 2, 0, 0, t, wh, d, o.wall);
  b.box(w / 2 + t / 2, 0, 0, t, wh, d, o.wall);
  if (o.door) {
    const gap = 3.6;
    const side = (w - gap) / 2;
    b.box(-(gap / 2 + side / 2), 0, d / 2 + t / 2, side, wh * 0.7, t, o.wall);
    b.box(gap / 2 + side / 2, 0, d / 2 + t / 2, side, wh * 0.7, t, o.wall);
  } else b.box(0, 0, d / 2 + t / 2, w + t * 2, wh * 0.7, t, o.wall);
  if (o.pillars !== false && !o.open) {
    const h = FLOOR_H - SLAB;
    const n = Math.max(1, Math.round(w / 8));
    for (let i = 0; i <= n; i++) {
      const x = -w / 2 + (i * w) / n;
      b.box(x, 0, -d / 2, 0.5, h, 0.5, o.wall);
      b.box(x, 0, d / 2, 0.5, h, 0.5, o.wall);
    }
  }
}

/** A chair: seat and back, the back on the far side from `faceYaw`. */
function chair(b: Builder, x: number, z: number, faceYaw: number, color: string) {
  b.box(x, 0, z, 0.5 * S, SEAT, 0.5 * S, color, faceYaw);
  b.box(x - Math.sin(faceYaw) * 0.25 * S, SEAT, z - Math.cos(faceYaw) * 0.25 * S, 0.5 * S, 0.5 * S, 0.08, color, faceYaw);
}

function table(b: Builder, x: number, z: number, w: number, d: number, top: string, h = TABLE, yaw = 0) {
  b.box(x, 0, z, 0.12, h, 0.12, "#2b2b30", yaw);
  b.box(x, h - 0.06, z, w, 0.06, d, top, yaw);
}

/** The stair and lift core every multi-storey landmark shares (back right corner). */
function core(b: Builder, glow: Builder, w: number, d: number, color: string, lift = true) {
  const cx = w / 2 - 2.6;
  const cz = -d / 2 + 2.8;
  // stair flight: stepped blocks
  for (let k = 0; k < 6; k++) b.box(cx - 0.9, 0, cz - 1.6 + k * 0.55, 1.6, 0.25 + k * 0.62, 0.55, "#77736d");
  if (lift) {
    b.box(cx + 1.0, 0, cz, 1.8, FLOOR_H - SLAB, 2.4, color);
    glow.panel(cx + 1.0, 0.1, cz + 1.25, 1.1, 2.5, "#9fb6c8");
  }
}

/** Monitor / laptop screen glow colours (code editors in dark mode). */
const SCREENS = ["#6fb6ff", "#8be9fd", "#b1f0c4", "#c3a6ff", "#ffd27a", "#e6f1ff"];
const SHIRT_TABLE = "#d9c3a0";

// ---------------------------------------------------------------- XOYO

function xoyo(w: number, d: number): FloorPlan[] {
  const levels = LEVELS.xoyo;
  // B: the club itself; Interiors' ClubFit draws the floor tiles, booth, lasers and bar from the shared layout
  const club = planFor("club", w, d);
  const bS = new Builder();
  const bG = new Builder();
  shell(bS, w, d, { wall: "#2a2238", floor: "#1d1a22", wallH: 2.6, pillars: false });
  // speaker stacks either side of the booth, a lighting truss over the floor
  const booth = club.booth!;
  for (const sx of [-1, 1]) {
    bS.box(booth.x + sx * 3.2, 0, booth.z, 1.4, 2.6, 1.2, "#121116");
    bG.panel(booth.x + sx * 3.2, 1.6, booth.z + 0.65, 0.9, 0.5, "#3a2e55");
  }
  const fl = club.floor!;
  for (const sx of [-1, 1]) bS.box(fl.x + (sx * fl.w) / 2, 0, fl.z - fl.d / 2, 0.2, 3.6, 0.2, "#3b3842");
  bS.box(fl.x, 3.5, fl.z - fl.d / 2, fl.w, 0.2, 0.2, "#3b3842");
  bG.box(fl.x, 3.35, fl.z - fl.d / 2 + 0.2, fl.w * 0.9, 0.12, 0.12, "#ff4fd8");
  const basement: FloorPlan = {
    ...levels[0],
    y: -FLOOR_H,
    solid: bS,
    glow: bG,
    club,
    slots: [...club.slots.map((s, k): Slot => ({ ...s, pose: k < club.slots.length - Math.floor((club.bar!.len) / 1.5) ? "dance" : "stand" }))],
    staff: club.staff.map((s) => ({ ...s, pose: "stand" as const })),
    busy: CURVES.club,
    staffOn: CURVES.clubStaff,
  };

  // G: box office, security arch, stairs down, merch; the queue outside along the facade
  const gS = new Builder();
  const gG = new Builder();
  shell(gS, w, d, { wall: "#3a3150", floor: "#3b3740", door: true });
  gS.box(w / 2 - 3, 0, d / 2 - 2.4, 3.2, 1.1 * S * 0.8, 0.9, "#4a3b52"); // box office counter
  gG.panel(w / 2 - 3, 1.4, d / 2 - 2.9, 2.4, 0.6, "#ffc857");
  // security arch just inside the door
  gS.box(-0.9, 0, d / 2 - 2.6, 0.2, 2.6, 0.5, "#9aa0aa");
  gS.box(0.9, 0, d / 2 - 2.6, 0.2, 2.6, 0.5, "#9aa0aa");
  gS.box(0, 2.6, d / 2 - 2.6, 2.0, 0.25, 0.5, "#9aa0aa");
  // stairs down to the club at the back
  for (let k = 0; k < 7; k++) gS.box(-w / 4, -0.02 - k * 0.04, -d / 2 + 1.2 + k * 0.7, 2.6, 0.04, 0.7, k % 2 ? "#26222d" : "#302a38");
  gG.box(-w / 4, 0, -d / 2 + 1.2 + 3.2, 2.8, 0.05, 0.08, "#ff4fd8");
  // merch table, neon sign on the back wall
  table(gS, -w / 2 + 3, 0, 2.4, 1.0, "#22202a");
  gG.panel(0, 1.8, -d / 2 + 0.2, Math.min(8, w * 0.4), 1.0, "#ff4fd8");
  // queue barrier posts outside the front
  const queue: Slot[] = [];
  const qz = d / 2 + 2.2;
  for (let i = 0; i < 26; i++) {
    const x = 2.4 + i * 1.05;
    // the queue runs along the facade, then bends back along the side
    const along = x < w / 2 + 6;
    queue.push(along ? { x, z: qz, face: -Math.PI / 2, pose: "stand" } : { x: w / 2 + 6, z: qz + (x - w / 2 - 6), face: Math.PI, pose: "stand" });
  }
  for (let x = 2; x < w / 2 + 6; x += 2.2) gS.box(x, 0, qz - 0.8, 0.12, 1.0, 0.12, "#c9a227");
  const ground: FloorPlan = {
    ...levels[1],
    y: 0,
    solid: gS,
    glow: gG,
    slots: [
      { x: 0, z: d / 2 - 1.2, face: Math.PI, pose: "walk" },
      { x: w / 2 - 3, z: d / 2 - 1.5, face: Math.PI, pose: "stand" },
      { x: w / 2 - 4.2, z: d / 2 - 1.4, face: Math.PI, pose: "stand" },
      { x: -w / 4, z: -d / 2 + 4.5, face: Math.PI, pose: "walk" },
      { x: -w / 2 + 3, z: 1.4, face: Math.PI, pose: "stand" },
      { x: -w / 2 + 4.2, z: 1.2, face: Math.PI, pose: "stand" },
    ],
    staff: [
      { x: -1.6, z: d / 2 - 1.2, face: 0, pose: "stand" },
      { x: 1.6, z: d / 2 - 1.2, face: 0, pose: "stand" },
      { x: w / 2 - 3, z: d / 2 - 3.3, face: 0, pose: "stand" },
    ],
    queue,
    busy: CURVES.club,
    staffOn: CURVES.clubStaff,
  };

  // 1: promoter and booking offices
  const oS = new Builder();
  const oG = new Builder();
  shell(oS, w, d, { wall: "#cfc8bd", floor: "#8a7f72" });
  const desks: Slot[] = [];
  const cols = Math.max(1, Math.floor((w - 6) / 3.2));
  for (let i = 0; i < cols; i++)
    for (const row of [-1, 1]) {
      const x = -w / 2 + 2.5 + i * 3.2;
      const z = row * 2.2 - 0.5;
      table(oS, x, z, 2.4, 1.1, "#e8e2d8");
      oG.panel(x, TABLE, z - row * 0.3, 0.9, 0.55, SCREENS[(i + row + 6) % SCREENS.length], row > 0 ? 0 : Math.PI);
      chair(oS, x, z + row * 1.0, row > 0 ? Math.PI : 0, "#3a3f4b");
      desks.push({ x, z: z + row * 1.0, face: row > 0 ? Math.PI : 0, pose: "sit" });
    }
  table(oS, w / 2 - 4, d / 2 - 3, 3.2, 1.6, "#6b4f3a");
  core(oS, oG, w, d, "#a8a196", false);
  const office: FloorPlan = { ...levels[2], y: FLOOR_H, solid: oS, glow: oG, slots: desks, staff: [], busy: CURVES.office, staffOn: CURVES.office };
  return [basement, ground, office];
}

// ---------------------------------------------------------------- Encode Hub

function encode(w: number, d: number): FloorPlan[] {
  const L = LEVELS.encode;
  const r = rng(41);
  // G: reception desk by the door, café counter at the back, café tables and sofas
  const gS = new Builder();
  const gG = new Builder();
  shell(gS, w, d, { wall: "#e6e1d6", floor: "#b9a58c", door: true });
  gS.box(w / 4, 0, d / 2 - 3, 4, 1.1, 1.0, "#1f2a44");
  gG.panel(w / 4, 1.1, d / 2 - 2.45, 3.0, 0.35, "#57e3a4"); // the Encode green strip
  gS.box(-w / 4, 0, -d / 2 + 1.6, w * 0.4, 1.1, 1.0, "#5a4636"); // café counter
  gG.box(-w / 4 - w * 0.12, 1.1, -d / 2 + 1.5, 0.7, 0.5, 0.5, "#ffc857"); // espresso machine
  gG.panel(-w / 4, 2.0, -d / 2 + 0.4, w * 0.35, 1.0, "#2b3a52");
  const gSlots: Slot[] = [];
  const tx = Math.max(1, Math.floor((w / 2 - 2) / 3));
  for (let i = 0; i < tx; i++)
    for (let j = 0; j < 2; j++) {
      const x = -w / 2 + 2.2 + i * 3;
      const z = -d / 2 + 5 + j * 3.4;
      table(gS, x, z, 1.1, 1.1, SHIRT_TABLE);
      for (const s of [-1, 1]) {
        chair(gS, x + s * 0.95, z, -s * (Math.PI / 2), "#3d7fe0");
        gSlots.push({ x: x + s * 0.95, z, face: face(-s, 0), pose: "sit" });
      }
    }
  // sofas on the right
  for (let k = 0; k < 2; k++) {
    const z = -d / 2 + 6 + k * 3.6;
    gS.box(w / 2 - 2.2, 0, z, 1.0, 0.8, 3.0, "#2fae6a");
    gSlots.push({ x: w / 2 - 2.6, z: z - 0.7, face: -Math.PI / 2, pose: "sit" }, { x: w / 2 - 2.6, z: z + 0.7, face: -Math.PI / 2, pose: "sit" });
  }
  for (let k = 0; k < 4; k++) gSlots.push({ x: -w / 4 - 1.5 + k * 1.1, z: -d / 2 + 3.0, face: Math.PI, pose: "stand" });
  gSlots.push({ x: w / 4 - 0.6, z: d / 2 - 1.8, face: Math.PI, pose: "stand" }, { x: w / 4 + 0.8, z: d / 2 - 1.7, face: Math.PI, pose: "stand" });
  core(gS, gG, w, d, "#cfc8bd");
  const ground: FloorPlan = {
    ...L[0],
    y: 0,
    solid: gS,
    glow: gG,
    slots: gSlots,
    staff: [
      { x: w / 4, z: d / 2 - 3.9, face: 0, pose: "stand" },
      { x: -w / 4 - 1, z: -d / 2 + 0.8, face: 0, pose: "stand" },
      { x: -w / 4 + 1.5, z: -d / 2 + 0.8, face: 0, pose: "stand" },
    ],
    busy: CURVES.cafe,
    staffOn: CURVES.daytime,
  };

  // 1: the hack hall: stage and screen at the back, rows of desks with laptops facing it
  const hS = new Builder();
  const hG = new Builder();
  shell(hS, w, d, { wall: "#2b3346", floor: "#4a4f5c" });
  const stageW = Math.min(w * 0.55, 14);
  hS.box(0, 0, -d / 2 + 1.6, stageW, 0.5, 3.0, "#1b1f2a");
  hS.box(0, 0, -d / 2 + 0.35, stageW * 0.85, 3.6, 0.2, "#101318"); // screen frame
  const screens: Screen[] = [{ x: 0, y: 0.8, z: -d / 2 + 0.5, w: stageW * 0.78, h: 2.7, yaw: 0 }];
  hS.box(stageW / 2 - 1.2, 0.5, -d / 2 + 2.2, 0.6, 1.1, 0.5, "#2b2f3a"); // lectern
  hG.box(-stageW / 2 - 0.6, 0, -d / 2 + 2.4, 0.5, 1.6, 0.5, "#57e3a4"); // stage uplights
  hG.box(stageW / 2 + 0.6, 0, -d / 2 + 2.4, 0.5, 1.6, 0.5, "#57e3a4");
  const hSlots: Slot[] = [];
  const rows: { z: number; xs: number[] }[] = [];
  const deskLen = w - 4.5;
  const per = Math.max(2, Math.floor(deskLen / 1.35));
  for (let z = -d / 2 + 5.2; z < d / 2 - 1.6; z += 2.7) {
    const xs = Array.from({ length: per }, (_, k) => -deskLen / 2 + (k + 0.5) * (deskLen / per));
    rows.push({ z, xs });
    // a long trestle desk, laptops and the occasional energy-drink can
    hS.box(-deskLen / 2 + 0.3, 0, z, 0.1, TABLE, 0.8, "#2b2b30");
    hS.box(deskLen / 2 - 0.3, 0, z, 0.1, TABLE, 0.8, "#2b2b30");
    hS.box(0, TABLE - 0.06, z, deskLen, 0.06, 0.95, "#e8e4dc");
    for (const x of xs) {
      hS.box(x, TABLE, z + 0.05, 0.62, 0.04, 0.42, "#3a3d44"); // laptop base
      hG.box(x, TABLE + 0.04, z - 0.14, 0.62, 0.42, 0.03, SCREENS[Math.floor(r() * SCREENS.length)], 0); // lit lid
      if (r() < 0.25) hS.box(x + 0.45, TABLE, z + 0.2, 0.09, 0.16, 0.09, r() < 0.5 ? "#e33b3b" : "#3d7fe0");
      chair(hS, x, z + 0.95, Math.PI, "#30343c");
    }
  }
  // fill the front rows' middle first (everyone wants to sit near the stage)
  for (const row of rows) {
    const sorted = [...row.xs].sort((a, b) => Math.abs(a) - Math.abs(b));
    for (const x of sorted) hSlots.push({ x, z: row.z + 0.95, face: Math.PI, pose: "sit" });
  }
  // power and snacks along the side
  hS.box(-w / 2 + 0.8, 0, 0, 0.9, 1.0, Math.min(8, d * 0.4), "#5a4636");
  for (let k = 0; k < 5; k++) hG.box(-w / 2 + 0.8, 1.0, -Math.min(8, d * 0.4) / 2 + 0.8 + k * 1.5, 0.4, 0.3, 0.4, ["#ffc857", "#ff6b6b", "#57e3a4"][k % 3]);
  core(hS, hG, w, d, "#4b5263");
  const hall: FloorPlan = {
    ...L[1],
    y: FLOOR_H,
    solid: hS,
    glow: hG,
    slots: hSlots,
    staff: [
      { x: stageW / 2 - 1.2, z: -d / 2 + 2.9, face: 0, pose: "stand" }, // the speaker
      { x: -w / 2 + 2, z: 2, face: Math.PI / 2, pose: "walk" }, // mentors walking the rows
      { x: w / 2 - 2, z: d / 2 - 3, face: -Math.PI / 2, pose: "walk" },
    ],
    screens,
    busy: CURVES.hack,
    staffOn: CURVES.daytime,
  };

  // 2: breakout rooms at the back, meeting pods along the front
  const bS = new Builder();
  const bG = new Builder();
  shell(bS, w, d, { wall: "#e6e1d6", floor: "#9aa3ad" });
  const rooms = Math.max(2, Math.floor((w - 5) / 6));
  const roomW = (w - 5) / rooms;
  const roomD = Math.min(7, d * 0.45);
  const bSlots: Slot[] = [];
  for (let i = 0; i < rooms; i++) {
    const cx = -w / 2 + roomW * (i + 0.5);
    const cz = -d / 2 + roomD / 2;
    // glass-ish partitions (low, pale blue) and a whiteboard on the back wall
    bS.box(cx + roomW / 2, 0, cz, 0.12, 2.4, roomD, "#a9c6dc");
    bS.box(cx - roomW * 0.3, 0, cz + roomD / 2, roomW * 0.4, 2.4, 0.12, "#a9c6dc");
    bS.box(cx + roomW * 0.3, 0, cz + roomD / 2, roomW * 0.4, 2.4, 0.12, "#a9c6dc");
    bG.panel(cx, 1.0, -d / 2 + 0.25, roomW * 0.6, 1.3, "#f4f4ef");
    table(bS, cx, cz + 0.4, roomW * 0.5, 1.4, "#ffffff");
    for (const s of [-1, 1])
      for (const k of [-1, 1]) {
        const x = cx + s * (roomW * 0.25 + 0.55);
        const z = cz + 0.4 + k * 0.45;
        chair(bS, x, z, face(-s, 0), "#f08a2c");
        bSlots.push({ x, z, face: face(-s, 0), pose: "sit" });
      }
  }
  // pods: high-backed booths
  const pods = Math.max(2, Math.floor((w - 6) / 4.4));
  for (let i = 0; i < pods; i++) {
    const x = -w / 2 + 2.8 + i * 4.4;
    const z = d / 2 - 2.6;
    bS.box(x, 0, z - 1.0, 3.0, 1.8, 0.3, "#2e3b2e");
    bS.box(x, 0, z + 1.0, 3.0, 1.8, 0.3, "#2e3b2e");
    table(bS, x, z, 1.6, 0.8, "#c9a87a");
    bSlots.push({ x: x - 0.4, z: z - 0.65, face: 0, pose: "sit" }, { x: x + 0.4, z: z + 0.65, face: Math.PI, pose: "sit" });
  }
  core(bS, bG, w, d, "#cfc8bd");
  const breakout: FloorPlan = { ...L[2], y: FLOOR_H * 2, solid: bS, glow: bG, slots: bSlots, staff: [], busy: CURVES.breakout, staffOn: CURVES.daytime };

  // R: roof terrace: decking, planters, benches, string lights
  const rS = new Builder();
  const rG = new Builder();
  shell(rS, w, d, { wall: "#8a8f99", floor: "#8a6a4a", open: true });
  const rSlots: Slot[] = [];
  for (let i = 0; i < 4; i++) {
    const x = -w / 2 + 2 + (i * (w - 4)) / 3;
    rS.box(x, 0, -d / 2 + 1.0, 2.6, 0.8, 1.2, "#5b4a3a");
    rS.box(x, 0.8, -d / 2 + 1.0, 2.2, 0.5, 0.9, "#3f8f4e");
  }
  for (let k = 0; k < 3; k++) {
    const z = -d / 2 + 4.5 + k * 3.2;
    rS.box(-w / 4, 0, z, 4, SEAT, 0.6, "#a07850");
    rSlots.push({ x: -w / 4 - 1, z: z + 0.2, face: 0, pose: "sit" }, { x: -w / 4 + 1, z: z + 0.2, face: 0, pose: "sit" });
  }
  // standing groups round high tables
  for (let k = 0; k < 4; k++) {
    const x = w / 6 + (k % 2) * 4;
    const z = -d / 2 + 5 + Math.floor(k / 2) * 4.5;
    table(rS, x, z, 0.8, 0.8, "#2b2b30", 1.1 * S);
    for (let a = 0; a < 3; a++) {
      const ang = (a / 3) * Math.PI * 2 + k;
      rSlots.push({ x: x + Math.sin(ang) * 1.0, z: z + Math.cos(ang) * 1.0, face: ang + Math.PI, pose: "stand" });
    }
  }
  // fairy lights strung between posts
  for (const sx of [-1, 1]) rS.box((sx * w) / 2.2, 0, 0, 0.12, 3.2, 0.12, "#3b3842");
  for (let k = 0; k <= 16; k++) {
    const x = -w / 2.2 + (k / 16) * (w / 1.1);
    const sag = 2.9 - Math.sin((k / 16) * Math.PI) * 0.6;
    rG.box(x, sag, 0, 0.14, 0.14, 0.14, "#ffe2a0");
  }
  const roof: FloorPlan = { ...L[3], y: FLOOR_H * 3, solid: rS, glow: rG, slots: rSlots, staff: [], busy: CURVES.terrace, staffOn: () => 0, open: true };
  return [ground, hall, breakout, roof];
}

// ---------------------------------------------------------------- art'otel Hoxton

function artotel(w: number, d: number): FloorPlan[] {
  const L = LEVELS.artotel;
  const r = rng(7);
  const ART = ["#ff4fd8", "#4fd8ff", "#ffe14f", "#ff6b6b", "#a463ff", "#57e3a4"];
  // G: lobby and gallery
  const gS = new Builder();
  const gG = new Builder();
  shell(gS, w, d, { wall: "#f1ede6", floor: "#d8d2c8", door: true });
  gS.box(w / 4, 0, d / 2 - 3.2, 5, 1.1, 1.0, "#2a2a2e"); // reception
  gG.panel(w / 4, 1.1, d / 2 - 2.65, 4.2, 0.25, "#ffc857");
  const gSlots: Slot[] = [];
  // gallery: plinths with sculptures on the left, lit works on the walls
  for (let k = 0; k < 4; k++) {
    const x = -w / 2 + 3 + (k % 2) * 4;
    const z = -d / 2 + 4 + Math.floor(k / 2) * 5;
    gS.box(x, 0, z, 1.0, 1.0, 1.0, "#ffffff");
    gS.box(x, 1.0, z, 0.5 + r() * 0.4, 0.8 + r() * 1.2, 0.5, ART[k % ART.length], r() * 3);
    gSlots.push({ x: x + 1.4, z: z + 1.2, face: face(-1.4, -1.2), pose: "stand" });
  }
  for (let k = 0; k < 4; k++) gG.panel(-w / 2 + 0.45, 1.2, -d / 2 + 3 + k * ((d - 6) / 3), 2.2, 1.6, ART[(k + 2) % ART.length], Math.PI / 2);
  for (let k = 0; k < Math.floor(w / 5); k++) gG.panel(-w / 2 + 3 + k * 5, 1.2, -d / 2 + 0.3, 3, 1.8, ART[(k + 4) % ART.length]);
  // lounge chairs
  for (let k = 0; k < 3; k++) {
    gS.box(w / 6 + k * 2.4, 0, -1, 1.2, 0.7, 1.2, "#7a3b3b");
    gSlots.push({ x: w / 6 + k * 2.4, z: -1, face: 0, pose: "sit" });
  }
  gSlots.push({ x: w / 4 - 1, z: d / 2 - 1.8, face: Math.PI, pose: "stand" }, { x: w / 4 + 1, z: d / 2 - 1.8, face: Math.PI, pose: "stand" }, { x: 0, z: d / 2 - 1.2, face: Math.PI, pose: "walk" });
  core(gS, gG, w, d, "#3a3a40");
  const lobby: FloorPlan = {
    ...L[0],
    y: 0,
    solid: gS,
    glow: gG,
    slots: gSlots,
    staff: [
      { x: w / 4 - 1, z: d / 2 - 4.1, face: 0, pose: "stand" },
      { x: w / 4 + 1, z: d / 2 - 4.1, face: 0, pose: "stand" },
      { x: 2.4, z: d / 2 - 1, face: 0, pose: "stand" }, // doorman
    ],
    busy: CURVES.lobby,
    staffOn: CURVES.always,
  };

  // 1: restaurant: open kitchen at the back, tables for two and four
  const fS = new Builder();
  const fG = new Builder();
  shell(fS, w, d, { wall: "#3b2f2a", floor: "#6b4f3a" });
  fS.box(-2, 0, -d / 2 + 1.4, w * 0.6, 1.1, 1.0, "#2a2a2e");
  fG.box(-2, 1.1, -d / 2 + 0.6, w * 0.6, 0.12, 0.6, "#ff9a3c"); // the pass, heat-lamp orange
  const fSlots: Slot[] = [];
  const tx = Math.max(1, Math.floor((w - 4) / 3.6));
  const tz = Math.max(1, Math.floor((d - 6) / 3.2));
  for (let i = 0; i < tx; i++)
    for (let j = 0; j < tz; j++) {
      const x = -w / 2 + 2.4 + i * 3.6;
      const z = -d / 2 + 4.4 + j * 3.2;
      table(fS, x, z, 1.3, 1.0, "#f4f1ea");
      fG.box(x, TABLE, z, 0.08, 0.16, 0.08, "#ffd27a"); // candle
      for (const s of [-1, 1]) {
        chair(fS, x + s * 0.95, z, -s * (Math.PI / 2), "#7a3b3b");
        fSlots.push({ x: x + s * 0.95, z, face: face(-s, 0), pose: "sit" });
      }
    }
  core(fS, fG, w, d, "#3a3a40");
  const restaurant: FloorPlan = {
    ...L[1],
    y: FLOOR_H,
    solid: fS,
    glow: fG,
    slots: fSlots,
    staff: [
      { x: -4, z: -d / 2 + 0.6, face: 0, pose: "stand" },
      { x: 0, z: -d / 2 + 0.6, face: 0, pose: "stand" },
      { x: 2, z: 0, face: Math.PI / 2, pose: "walk" },
      { x: -w / 4, z: d / 4, face: -Math.PI / 2, pose: "walk" },
    ],
    busy: CURVES.dining,
    staffOn: CURVES.daytime,
  };

  // 2..: hotel floors: corridor down the middle, rooms either side
  const hotel = (n: number): FloorPlan => {
    const b = new Builder();
    const g = new Builder();
    const rr = rng(100 + n);
    shell(b, w, d, { wall: "#e9e4dc", floor: "#7d6f63", wallH: 2.4 });
    const cw = 2.2;
    const roomW = 4.4;
    const per = Math.max(2, Math.floor((w - 5.5) / roomW));
    const roomD = (d - cw) / 2;
    const slots: Slot[] = [];
    b.box(0, -0.01, 0, w, 0.03, cw, "#5a2f3a"); // corridor carpet
    for (const side of [-1, 1]) {
      const cz = side * (cw / 2 + roomD / 2);
      for (let i = 0; i < per; i++) {
        const cx = -w / 2 + roomW * (i + 0.5);
        // party walls and the corridor wall with its door gap
        b.box(cx + roomW / 2, 0, cz, 0.15, 2.4, roomD, "#e9e4dc");
        b.box(cx - 0.9, 0, side * (cw / 2), roomW - 1.8, 2.4, 0.15, "#e9e4dc");
        // bed against the party wall, headboard, nightstand, desk under the window
        const bz = cz + side * (roomD / 2 - 1.6);
        b.box(cx - 0.6, 0, bz, 2.0, 0.55, 2.4, "#f4f2ee");
        b.box(cx - 0.6, 0.55, bz + side * 0.9, 1.9, 0.12, 0.5, "#ffffff");
        b.box(cx - 0.6, 0, bz + side * 1.25, 2.1, 1.3, 0.12, ["#2f4a6b", "#6b2f4a", "#2f6b56"][(i + n) % 3]);
        b.box(cx + 0.9, 0, bz + side * 1.0, 0.5, 0.55, 0.5, "#6b4f3a");
        g.box(cx + 0.9, 0.55, bz + side * 1.0, 0.18, 0.3, 0.18, "#ffd9a0"); // bedside lamp
        b.box(cx + 1.2, 0, cz - side * 0.6, 0.6, TABLE, 1.2, "#6b4f3a");
        // occupied rooms glow at the window
        if (rr() < 0.7) g.panel(cx, 0.9, cz + side * (roomD / 2 - 0.05), roomW * 0.7, 1.4, "#ffe8b8", 0);
        slots.push(
          rr() < 0.5
            ? { x: cx - 0.6, z: bz - side * 1.0, face: side > 0 ? Math.PI : 0, pose: "sit" }
            : { x: cx + 1.0, z: cz - side * 0.2, face: face(0, -side), pose: "stand" },
        );
      }
    }
    core(b, g, w, d, "#3a3a40");
    return {
      short: L[n].short,
      label: L[n].label,
      y: FLOOR_H * n,
      solid: b,
      glow: g,
      slots,
      staff: [{ x: -w / 4, z: 0, face: Math.PI / 2, pose: "walk" }],
      busy: CURVES.rooms,
      staffOn: (h) => window(h, 9, 15, 0.5), // housekeeping
    };
  };
  const rooms = Array.from({ length: HOTEL_FLOORS }, (_, i) => hotel(i + 2));

  // R: rooftop bar with a plunge pool
  const top = L.length - 1;
  const rS = new Builder();
  const rG = new Builder();
  shell(rS, w, d, { wall: "#a9c6dc", floor: "#6f6a64", open: true });
  rS.box(-w / 4, 0, -d / 2 + 1.6, w * 0.4, 1.15, 1.0, "#1b1b1f");
  rG.box(-w / 4, 1.15, -d / 2 + 1.0, w * 0.38, 1.0, 0.1, "#ff4fd8");
  rG.box(w / 4, -0.02, -d / 2 + 4, Math.min(8, w * 0.3), 0.05, 4, "#3fd0ff"); // the pool
  rS.box(w / 4, 0, -d / 2 + 4, Math.min(8, w * 0.3) + 0.6, 0.4, 4.6, "#d8d2c8");
  const rSlots: Slot[] = [];
  for (let k = 0; k < 5; k++) rSlots.push({ x: -w / 4 - w * 0.15 + k * (w * 0.075), z: -d / 2 + 2.8, face: Math.PI, pose: "stand" });
  for (let k = 0; k < 6; k++) {
    const x = -w / 2 + 3 + (k % 3) * ((w - 6) / 2);
    const z = 1 + Math.floor(k / 3) * 4;
    table(rS, x, z, 0.8, 0.8, "#2b2b30", 1.1 * S);
    rG.box(x, 1.1 * S, z, 0.1, 0.15, 0.1, "#ffd27a");
    for (let a = 0; a < 3; a++) {
      const ang = (a / 3) * Math.PI * 2 + k;
      rSlots.push({ x: x + Math.sin(ang) * 1.0, z: z + Math.cos(ang) * 1.0, face: ang + Math.PI, pose: "stand" });
    }
  }
  for (let k = 0; k < 4; k++) {
    rS.box(w / 4 - 3 + k * 2, 0, -d / 2 + 7.4, 0.9, 0.4, 2.0, "#f4f1ea"); // loungers
    rSlots.push({ x: w / 4 - 3 + k * 2, z: -d / 2 + 7.4, face: 0, pose: "sit" });
  }
  const roof: FloorPlan = {
    ...L[top],
    y: FLOOR_H * top,
    solid: rS,
    glow: rG,
    slots: rSlots,
    staff: [
      { x: -w / 4 - 1.5, z: -d / 2 + 0.6, face: 0, pose: "stand" },
      { x: -w / 4 + 1.5, z: -d / 2 + 0.6, face: 0, pose: "stand" },
    ],
    busy: CURVES.roofBar,
    staffOn: (h) => window(h, 16, 26, 0.3),
    open: true,
  };
  return [lobby, restaurant, ...rooms, roof];
}

// ---------------------------------------------------------------- Boxpark

function container(b: Builder, x: number, z: number, len: number, openSide: 1 | -1, color: string, h: number) {
  // 20 ft box: closed back and ends, open shop front (cutaway: no roof)
  const t = 0.12;
  const wid = 2.44;
  b.box(x, 0, z - (openSide * len) / 2, wid, h, t, color);
  b.box(x - wid / 2, 0, z, t, h, len, color);
  b.box(x + wid / 2, 0, z, t, h, len, color);
  // corrugation ribs on the ends
  for (let k = -2; k <= 2; k++) b.box(x - wid / 2 - 0.05, 0, z + k * (len / 5), 0.06, h, 0.12, "#000000");
}

function boxpark(w: number, d: number): FloorPlan[] {
  const L = LEVELS.boxpark;
  const r = rng(3);
  const len = Math.min(6.1, d * 0.38);
  const n = Math.max(3, Math.floor(w / 2.6));
  const step = w / n;
  const h = FLOOR_H - SLAB;
  const STOCK = ["#ff6b6b", "#ffe14f", "#4fd8ff", "#f2f2f2", "#a463ff", "#2fae6a", "#f08a2c"];

  // G: two rows of shop containers facing a walkway
  const gS = new Builder();
  const gG = new Builder();
  gS.box(0, -SLAB, 0, w + 0.6, SLAB, d + 0.6, "#3a3a3a");
  const gSlots: Slot[] = [];
  const staffG: Slot[] = [];
  for (const row of [-1, 1] as const) {
    const cz = row * (d / 2 - len / 2);
    const open = (-row) as 1 | -1; // fronts face the walkway in the middle
    for (let i = 0; i < n; i++) {
      const cx = -w / 2 + step * (i + 0.5);
      // the middle front-row container is the way in from the street
      if (row === 1 && i === Math.floor(n / 2)) continue;
      container(gS, cx, cz, len, open === 1 ? -1 : 1, "#17181b", h);
      // racks and a counter in the shop's colour
      gS.box(cx, 0, cz + row * (len / 2 - 0.6), 2.0, 2.0, 0.4, STOCK[(i + (row > 0 ? 3 : 0)) % STOCK.length]);
      gS.box(cx, 0, cz - row * (len / 2 - 1.4), 1.6, 1.0, 0.6, "#c9a87a");
      gG.box(cx, h - 0.6, cz - row * (len / 2 - 0.1), 2.2, 0.35, 0.08, STOCK[(i + 2) % STOCK.length]); // fascia
      staffG.push({ x: cx, z: cz + row * 0.2, face: face(0, -row), pose: "stand" });
      gSlots.push({ x: cx + (r() - 0.5), z: cz - row * (len / 2 - 0.2), face: face(0, row), pose: "stand" });
    }
  }
  // shoppers wandering the walkway
  for (let k = 0; k < n * 2; k++) gSlots.push({ x: -w / 2 + 1.5 + r() * (w - 3), z: (r() - 0.5) * Math.max(0.5, d - len * 2 - 1.5), face: r() < 0.5 ? Math.PI / 2 : -Math.PI / 2, pose: "walk" });
  // stairs up to the deck at one end
  for (let k = 0; k < 8; k++) gS.box(w / 2 - 1.4, 0, -d / 2 + len + 0.6 + k * 0.45, 1.6, 0.3 + k * 0.48, 0.45, "#5c5c5c");
  const ground: FloorPlan = { ...L[0], y: 0, solid: gS, glow: gG, slots: gSlots, staff: staffG, busy: CURVES.shops, staffOn: (hh) => window(hh, 9.5, 20.5, 0.3) };

  // 1: food stalls along the back, communal tables on the open deck, railing at the front
  const uS = new Builder();
  const uG = new Builder();
  uS.box(0, -SLAB, 0, w + 0.6, SLAB, d + 0.6, "#5a4636");
  for (let x = -w / 2; x <= w / 2 + 0.01; x += 1.6) uS.box(x, 0, d / 2, 0.08, 1.1, 0.08, "#2b2b30");
  uS.box(0, 1.05, d / 2, w, 0.08, 0.1, "#2b2b30");
  const uSlots: Slot[] = [];
  const staffU: Slot[] = [];
  const cz = -d / 2 + len / 2;
  const FOOD = ["#ff9a3c", "#ff4f6d", "#ffe14f", "#57e3a4", "#4fd8ff"];
  for (let i = 0; i < n; i++) {
    const cx = -w / 2 + step * (i + 0.5);
    container(uS, cx, cz, len, -1, i % 2 ? "#17181b" : "#24262b", h);
    uS.box(cx, 0, cz + len / 2 - 0.5, 2.2, 1.1, 0.6, "#3a3a40"); // serving hatch counter
    uG.panel(cx, 1.9, cz - len / 2 + 0.2, 1.8, 0.8, FOOD[i % FOOD.length]); // menu board
    uG.box(cx, 1.1, cz + len / 2 - 0.5, 1.6, 0.1, 0.3, "#ffd27a"); // heat lamp glow on the pass
    staffU.push({ x: cx, z: cz + len / 2 - 1.3, face: 0, pose: "stand" });
    for (let q = 0; q < 2; q++) uSlots.push({ x: cx + (q - 0.5) * 0.9, z: cz + len / 2 + 0.6 + q * 0.9, face: Math.PI, pose: "stand" });
  }
  const deckD = d - len - 1.5;
  const tables = Math.max(1, Math.floor((w - 4) / 6));
  for (let i = 0; i < tables; i++)
    for (let j = 0; j < Math.max(1, Math.floor(deckD / 4)); j++) {
      const x = -w / 2 + 3.5 + i * 6;
      const z = -d / 2 + len + 2.6 + j * 4;
      if (z > d / 2 - 1.5) continue;
      table(uS, x, z, 4.0, 1.0, "#a07850");
      for (const s of [-1, 1]) {
        uS.box(x, 0, z + s * 0.95, 4.0, SEAT, 0.35, "#7a5a3a");
        for (let k = 0; k < 3; k++) uSlots.push({ x: x - 1.3 + k * 1.3, z: z + s * 0.95, face: s > 0 ? Math.PI : 0, pose: "sit" });
      }
    }
  for (let k = 0; k <= 20; k++) uG.box(-w / 2 + (k / 20) * w, 3.4 - Math.sin((k / 20) * Math.PI * 3) * 0.2, d / 2 - 0.2, 0.14, 0.14, 0.14, "#ffe2a0");
  const deck: FloorPlan = { ...L[1], y: FLOOR_H, solid: uS, glow: uG, slots: uSlots, staff: staffU, busy: CURVES.food, staffOn: (hh) => window(hh, 11, 23, 0.3), open: true };
  return [ground, deck];
}

/** Interior footprint for a host footprint: never smaller than a readable cutaway, never a whole block. */
export function interiorSize(key: InteriorKey, width: number, depth: number): [number, number] {
  // never wider or deeper than the building itself (Encode Hub is a 6 m-wide terrace): only cap the big ones
  const c = (v: number, _a: number, b: number) => Math.min(b, v);
  if (key === "artotel") return [c(width, 24, 34), c(depth, 18, 24)];
  if (key === "boxpark") return [c(width, 30, 48), c(depth, 14, 18)];
  if (key === "xoyo") return [c(width, 20, 30), c(depth, 15, 22)];
  return [c(width, 20, 32), c(depth, 16, 24)];
}

export function buildFloors(key: InteriorKey, w: number, d: number): FloorPlan[] {
  switch (key) {
    case "xoyo":
      return xoyo(w, d);
    case "encode":
      return encode(w, d);
    case "artotel":
      return artotel(w, d);
    case "boxpark":
      return boxpark(w, d);
  }
}
