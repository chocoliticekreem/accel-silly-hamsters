// Low-poly vehicle geometry (ported from hamyway-city's Traffic/models.ts, plus a Routemaster-style double-decker,
// a Met police car and an ambulance). Each model is merged into one BufferGeometry per part, so each part of each
// model is a single InstancedMesh: paint (per-vehicle colour), fixed (vertex-coloured trim, tyres, signs),
// glass (glows at night on buses), head and tail (emissive lights).
// Local frame: front is +z, left is +x, ground at y = 0.
// Swap point: a hand-made "hero" model for a kind can replace `buildVehicle(kind)` without touching Traffic.tsx.
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type VehicleKind = "bus" | "cab" | "hatch" | "saloon" | "suv" | "estate" | "van" | "police" | "ambulance" | "hgv" | "moto";
export const VEHICLE_KINDS: VehicleKind[] = ["bus", "cab", "hatch", "saloon", "suv", "estate", "van", "police", "ambulance", "hgv", "moto"];

export type Part = "paint" | "fixed" | "glass" | "head" | "tail";
export const PARTS: Part[] = ["paint", "fixed", "glass", "head", "tail"];

interface Piece {
  part: Part;
  geo: BufferGeometry;
  color?: string;
}

const tmpColor = new Color();

function box(part: Part, w: number, h: number, l: number, x: number, y: number, z: number, color?: string): Piece {
  const g = new BoxGeometry(w, h, l);
  g.translate(x, y, z);
  return { part, geo: g, color };
}

function wheel(x: number, z: number, r: number, width = 0.28): Piece[] {
  const g = new CylinderGeometry(r, r, width, 10);
  g.rotateZ(Math.PI / 2);
  g.translate(x, r, z);
  const hub = new CylinderGeometry(r * 0.55, r * 0.55, width + 0.02, 8);
  hub.rotateZ(Math.PI / 2);
  hub.translate(x, r, z);
  return [
    { part: "fixed", geo: g, color: "#1b1b1e" },
    { part: "fixed", geo: hub, color: "#8d9298" },
  ];
}

const GLASS = "#253241";
const TRIM = "#2e2f33";
const CHROME = "#b9bec4";
const AMBER = "#ff9a1a";

function lights(halfW: number, front: number, back: number, y: number, ySize = 0.16): Piece[] {
  const lw = Math.min(0.36, halfW * 0.4);
  const out: Piece[] = [];
  for (const s of [1, -1]) {
    out.push(box("head", lw, ySize, 0.06, s * (halfW - lw / 2 - 0.08), y, front + 0.02));
    out.push(box("tail", lw, ySize, 0.06, s * (halfW - lw / 2 - 0.08), y, back - 0.02));
    // amber indicators on the corners
    out.push(box("fixed", 0.08, 0.1, 0.1, s * (halfW + 0.01), y, front - 0.12, AMBER));
    out.push(box("fixed", 0.08, 0.1, 0.1, s * (halfW + 0.01), y, back + 0.12, AMBER));
  }
  return out;
}

interface CarSpec {
  L: number;
  W: number;
  bodyH: number;
  clearance: number;
  cabinL: number;
  cabinH: number;
  cabinZ: number;
  wheelR: number;
  wheelInset: number;
}

function car(s: CarSpec): Piece[] {
  const halfL = s.L / 2;
  const halfW = s.W / 2;
  const bodyY = s.clearance + s.bodyH / 2;
  const top = s.clearance + s.bodyH;
  const p: Piece[] = [
    box("paint", s.W, s.bodyH, s.L, 0, bodyY, 0),
    // bonnet and boot slope hints: a slightly narrower step on top of the body
    box("paint", s.W - 0.2, 0.06, s.L - 0.3, 0, top + 0.03, 0),
    box("glass", s.W - 0.12, s.cabinH, s.cabinL, 0, top + s.cabinH / 2, s.cabinZ, GLASS),
    // pillars so the cabin reads as glass with a frame, not a dark brick
    box("paint", s.W - 0.08, s.cabinH, 0.12, 0, top + s.cabinH / 2, s.cabinZ + s.cabinL / 2 - 0.06),
    box("paint", s.W - 0.08, s.cabinH, 0.12, 0, top + s.cabinH / 2, s.cabinZ - s.cabinL / 2 + 0.06),
    box("paint", s.W - 0.08, 0.1, s.cabinL - 0.1, 0, top + s.cabinH + 0.05, s.cabinZ),
    box("fixed", s.W + 0.04, 0.18, 0.16, 0, s.clearance + 0.1, halfL, TRIM),
    box("fixed", s.W + 0.04, 0.18, 0.16, 0, s.clearance + 0.1, -halfL, TRIM),
    box("fixed", s.W * 0.42, 0.14, 0.04, 0, bodyY + 0.02, halfL + 0.02, TRIM), // grille
    box("fixed", 0.52, 0.12, 0.03, 0, bodyY - 0.08, -halfL - 0.02, "#f2efe2"), // number plate
    box("fixed", 0.08, 0.1, 0.22, halfW + 0.04, top + 0.05, s.cabinZ + s.cabinL / 2 - 0.1, TRIM), // mirrors
    box("fixed", 0.08, 0.1, 0.22, -halfW - 0.04, top + 0.05, s.cabinZ + s.cabinL / 2 - 0.1, TRIM),
  ];
  for (const x of [halfW - 0.1, -(halfW - 0.1)]) for (const z of [halfL - s.wheelInset, -(halfL - s.wheelInset)]) p.push(...wheel(x, z, s.wheelR));
  p.push(...lights(halfW, halfL, -halfL, bodyY + s.bodyH * 0.15));
  return p;
}

function hgv(): Piece[] {
  const W = 2.5;
  const cabL = 2.3;
  const front = 5.8;
  const cabZ = front - cabL / 2;
  const trailerL = 8.8;
  const trailerZ = front - cabL - 0.4 - trailerL / 2;
  const back = trailerZ - trailerL / 2;
  const p: Piece[] = [
    box("paint", W, 2.5, cabL, 0, 0.6 + 1.25, cabZ),
    box("glass", W - 0.2, 0.9, 0.06, 0, 2.35, front + 0.01, GLASS),
    box("glass", W + 0.04, 0.7, 1.0, 0, 2.35, front - 0.6, GLASS),
    box("fixed", 1.2, 0.5, 0.1, 0, 0.95, front + 0.02, CHROME),
    box("paint", W - 0.3, 0.5, 1.4, 0, 3.35, cabZ - 0.2),
    box("fixed", 1.0, 0.25, front - back - 0.4, 0, 0.6, (front + back) / 2, TRIM),
    box("fixed", W, 3.0, trailerL, 0, 1.1 + 1.5, trailerZ, "#e9ebee"),
    box("fixed", W + 0.04, 0.25, trailerL, 0, 1.3, trailerZ, "#9aa1aa"),
    box("fixed", W + 0.04, 0.3, 0.16, 0, 0.75, front, TRIM),
  ];
  for (const x of [W / 2 - 0.15, -(W / 2 - 0.15)]) {
    p.push(...wheel(x, front - 1.0, 0.5, 0.36));
    p.push(...wheel(x, front - cabL - 0.2, 0.5, 0.36));
    p.push(...wheel(x, back + 1.2, 0.5, 0.36));
    p.push(...wheel(x, back + 2.3, 0.5, 0.36));
  }
  p.push(...lights(W / 2, front, back, 0.95, 0.22));
  return p;
}

/** London black cab (TX-style): tall, upright cabin, amber TAXI roof sign, chrome grille. */
function cab(): Piece[] {
  const p = car({ L: 4.55, W: 1.85, bodyH: 0.78, clearance: 0.32, cabinL: 2.7, cabinH: 0.86, cabinZ: -0.3, wheelR: 0.36, wheelInset: 0.85 });
  p.push(box("fixed", 0.72, 0.2, 0.3, 0, 0.32 + 0.78 + 0.86 + 0.2, 0.7, "#ffb000"));
  p.push(box("fixed", 1.1, 0.34, 0.06, 0, 0.62, 2.29, CHROME));
  return p;
}

function estate(): Piece[] {
  const p = car({ L: 4.75, W: 1.82, bodyH: 0.62, clearance: 0.3, cabinL: 3.0, cabinH: 0.56, cabinZ: -0.55, wheelR: 0.34, wheelInset: 0.85 });
  for (const x of [0.7, -0.7]) p.push(box("fixed", 0.06, 0.06, 2.6, x, 0.3 + 0.62 + 0.56 + 0.13, -0.55, TRIM));
  return p;
}

function van(): Piece[] {
  const W = 2.0;
  const L = 5.4;
  const halfL = L / 2;
  const p: Piece[] = [
    box("paint", W, 1.95, 3.8, 0, 0.38 + 0.975, -0.8),
    box("paint", W, 0.8, 1.6, 0, 0.38 + 0.4, 1.9),
    box("glass", W - 0.1, 0.75, 0.9, 0, 0.38 + 0.8 + 0.38, 1.45, GLASS),
    box("paint", W - 0.06, 0.08, 0.9, 0, 0.38 + 1.55 + 0.04 + 0.32, 1.45),
    box("fixed", W + 0.04, 0.2, 0.16, 0, 0.45, halfL, TRIM),
    box("fixed", W + 0.04, 0.2, 0.16, 0, 0.45, -halfL, TRIM),
    box("fixed", 0.02, 1.5, 0.04, W / 2 + 0.01, 1.3, -0.2, TRIM), // sliding door seam
    box("fixed", 0.02, 1.5, 0.04, -W / 2 - 0.01, 1.3, -2.7 + 0.02, TRIM),
  ];
  for (const x of [W / 2 - 0.1, -(W / 2 - 0.1)]) for (const z of [halfL - 0.9, -(halfL - 1.0)]) p.push(...wheel(x, z, 0.37));
  p.push(...lights(W / 2, halfL, -halfL, 0.85));
  return p;
}

/** Met police: white estate, blue light bar, Battenburg-ish blue/yellow side squares. */
function police(): Piece[] {
  const p = estate();
  const top = 0.3 + 0.62 + 0.56 + 0.1;
  p.push(box("fixed", 1.2, 0.14, 0.32, 0, top + 0.08, -0.2, "#1f4fff"));
  p.push(box("fixed", 0.3, 0.15, 0.33, 0, top + 0.08, -0.2, "#e8e8e8"));
  for (let k = 0; k < 6; k++)
    for (const s of [1, -1]) p.push(box("fixed", 0.03, 0.22, 0.6, s * 0.925, 0.62, -1.75 + k * 0.7, k % 2 ? "#1d3fb8" : "#f4d21c"));
  return p;
}

/** NHS ambulance: yellow box van with green Battenburg and blue lights. */
function ambulance(): Piece[] {
  const p = van();
  p.push(box("fixed", 1.6, 0.14, 0.3, 0, 0.38 + 1.95 + 0.08, 0.95, "#1f4fff"));
  for (let k = 0; k < 6; k++)
    for (const s of [1, -1]) p.push(box("fixed", 0.03, 0.3, 0.6, s * 1.015, 1.0, -2.45 + k * 0.62, k % 2 ? "#1f8a3a" : "#f2e21a"));
  p.push(box("fixed", 0.03, 0.18, 3.6, 1.015, 1.75, -0.8, "#1f5fd0"));
  p.push(box("fixed", 0.03, 0.18, 3.6, -1.015, 1.75, -0.8, "#1f5fd0"));
  return p;
}

/** Routemaster-style red double-decker: two glazed decks, cream band, dark skirt, destination blind. */
function bus(): Piece[] {
  const W = 2.5;
  const L = 10.4;
  const halfL = L / 2;
  const p: Piece[] = [
    box("paint", W, 1.9, L, 0, 0.42 + 0.95, 0), // lower deck
    box("paint", W - 0.04, 1.62, L - 0.25, 0, 2.32 + 0.81, -0.08), // upper deck
    box("paint", W - 0.14, 0.14, L - 0.5, 0, 4.0, -0.1), // roof
    box("paint", W - 0.3, 0.1, L - 0.9, 0, 4.1, -0.1),
    box("fixed", W + 0.03, 0.14, L + 0.01, 0, 2.32, 0, "#ede3c8"), // cream between-deck band
    box("fixed", W + 0.02, 0.4, L + 0.02, 0, 0.6, 0, "#26282b"), // skirt
    box("glass", W + 0.04, 0.82, L - 1.8, 0, 1.8, -0.3, GLASS), // lower side windows
    box("glass", W + 0.04, 0.78, L - 1.0, 0, 3.15, -0.1, GLASS), // upper side windows
    box("glass", W - 0.3, 0.9, 0.06, 0, 1.8, halfL + 0.02, GLASS), // windscreen
    box("glass", W - 0.3, 0.78, 0.06, 0, 3.15, halfL - 0.1, GLASS), // upper front
    box("glass", W - 0.6, 0.7, 0.06, 0, 3.15, -halfL + 0.1, GLASS), // upper rear
    box("fixed", 1.6, 0.34, 0.05, 0, 2.6, halfL - 0.08, "#121212"), // destination blind
    box("fixed", 1.2, 0.12, 0.06, 0, 2.6, halfL - 0.05, "#ffd34d"),
    box("fixed", 1.0, 0.36, 0.05, 0, 0.92, halfL + 0.03, CHROME), // grille
    box("fixed", 0.04, 1.5, 1.2, W / 2 + 0.02, 1.2, halfL - 2.2, "#3a3d42"), // nearside door
    box("fixed", 0.52, 0.12, 0.03, 0, 0.8, -halfL - 0.02, "#f2e21a"), // rear plate
  ];
  for (const x of [W / 2 - 0.15, -(W / 2 - 0.15)]) {
    p.push(...wheel(x, halfL - 1.6, 0.5, 0.34));
    p.push(...wheel(x, -halfL + 2.4, 0.5, 0.34));
  }
  p.push(...lights(W / 2, halfL, -halfL, 0.9, 0.2));
  return p;
}

function moto(): Piece[] {
  const p: Piece[] = [
    box("paint", 0.42, 0.42, 1.1, 0, 0.78, 0.1),
    box("paint", 0.3, 0.25, 0.6, 0, 0.82, -0.6),
    box("fixed", 0.46, 0.62, 0.4, 0, 1.3, -0.2, "#2a2d34"), // rider
    box("fixed", 0.32, 0.3, 0.34, 0, 1.78, -0.12, "#e8e8e8"), // helmet
    box("fixed", 0.6, 0.06, 0.06, 0, 1.08, 0.48, TRIM),
  ];
  for (const z of [0.72, -0.72]) {
    const g = new CylinderGeometry(0.32, 0.32, 0.14, 10);
    g.rotateZ(Math.PI / 2);
    g.translate(0, 0.32, z);
    p.push({ part: "fixed", geo: g, color: "#1b1b1e" });
  }
  p.push(box("head", 0.16, 0.14, 0.06, 0, 0.9, 0.68));
  p.push(box("tail", 0.14, 0.08, 0.06, 0, 0.88, -0.92));
  return p;
}

const SPECS: Record<VehicleKind, () => Piece[]> = {
  bus,
  cab,
  hatch: () => car({ L: 3.8, W: 1.72, bodyH: 0.62, clearance: 0.28, cabinL: 2.0, cabinH: 0.58, cabinZ: -0.3, wheelR: 0.32, wheelInset: 0.65 }),
  saloon: () => car({ L: 4.6, W: 1.8, bodyH: 0.6, clearance: 0.28, cabinL: 2.2, cabinH: 0.55, cabinZ: -0.2, wheelR: 0.33, wheelInset: 0.85 }),
  suv: () => car({ L: 4.7, W: 1.95, bodyH: 0.85, clearance: 0.42, cabinL: 2.9, cabinH: 0.68, cabinZ: -0.35, wheelR: 0.42, wheelInset: 0.85 }),
  estate,
  van,
  police,
  ambulance,
  hgv,
  moto,
};

/** One merged geometry per part (null when the model has no pieces for that part). */
export function buildVehicle(kind: VehicleKind): Record<Part, BufferGeometry | null> {
  const pieces = SPECS[kind]();
  const out = {} as Record<Part, BufferGeometry | null>;
  for (const part of PARTS) {
    const list = pieces.filter((p) => p.part === part);
    if (!list.length) {
      out[part] = null;
      continue;
    }
    const geos = list.map((p) => {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      if (part === "fixed") {
        tmpColor.set(p.color ?? "#888888");
        const n = g.getAttribute("position").count;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          arr[i * 3] = tmpColor.r;
          arr[i * 3 + 1] = tmpColor.g;
          arr[i * 3 + 2] = tmpColor.b;
        }
        g.setAttribute("color", new BufferAttribute(arr, 3));
      }
      g.deleteAttribute("uv");
      return g;
    });
    out[part] = mergeGeometries(geos, false);
    for (const p of list) p.geo.dispose();
    for (const g of geos) g.dispose();
  }
  return out;
}

/** Paint colours per kind (sRGB hex). */
export const PALETTES: Record<VehicleKind, string[]> = {
  bus: ["#d3201b"],
  cab: ["#141414", "#141414", "#141414", "#1d232c", "#3a1418"],
  hatch: ["#c8ced6", "#2f6db5", "#f2f2f2", "#d6453d", "#3d8a5a", "#9aa3ab", "#2b2b2b", "#e8b33a"],
  saloon: ["#1f2a44", "#c9ccd1", "#2b2b2b", "#8a1f2b", "#3b5f8a", "#f2f2f2", "#5a6b5a"],
  suv: ["#2b2b2b", "#f2f2f2", "#4a5568", "#2f4f3a", "#9aa3ab", "#c08a3e"],
  estate: ["#5b6770", "#f2f2f2", "#2c3e50", "#7d2e2e", "#a8b2a0", "#202020"],
  van: ["#f4f4f4", "#f4f4f4", "#c9ccd1", "#2b4c7e", "#1f3d2b", "#d9d4c7"],
  police: ["#f4f4f4"],
  ambulance: ["#f2e21a"],
  hgv: ["#2a5db0", "#c43a2f", "#f2f2f2", "#2f8f4e", "#474b52"],
  moto: ["#e01b24", "#111111", "#1c6dd0", "#f2f2f2"],
};

/** Body length (m), for spacing. */
export const LENGTH: Record<VehicleKind, number> = { bus: 10.4, cab: 4.55, hatch: 3.8, saloon: 4.6, suv: 4.7, estate: 4.75, van: 5.4, police: 4.75, ambulance: 5.4, hgv: 11.8, moto: 2 };
