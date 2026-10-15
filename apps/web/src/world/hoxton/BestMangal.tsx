// Best Mangal Bar & Restaurant (Turkish charcoal grill), next door to City Best Wine at the Pitfield St / Boot St
// corner: map building b579, which the Buildings module skips (sim/areaKeepouts REPLACED_BUILDINGS) so we can open
// up its ground floor. Black and gold shopfront with the gold "B" monogram fascia, glazed on both street faces,
// showing the open charcoal mangal grill (glowing, flickering coals and skewers), the chef behind the counter and
// diners at their tables in a warm amber room; awning, pavement tables, a projecting blade sign, a roof flue with
// smoke. At night the sign and the room glow. A queue forms on Friday and Saturday evenings (sim clock).
// Draw calls: hero slots (solid/paint/metal/brick/glow ~5) + interior + glass + coals + sign + smoke + people (3).
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  PlaneGeometry,
  PointsMaterial,
  SRGBColorSpace,
  type Group,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { nightLevel } from "../../sim/sky";
import { dayOf, hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { Kit, type SlotGeos } from "../models/kit";
import { heroMaterials } from "../models/materials";
import { createPeople, SKIN_TONES, TROUSERS } from "../people";

/** b579 (contract): centre and size. */
export const BEST_MANGAL = { x: -625.2, z: 395.1, w: 9.2, d: 4.2, h: 16 };
const GF = 4.4; // ground-floor height
const HW = BEST_MANGAL.w / 2; // 4.6, local x
const HD = BEST_MANGAL.d / 2; // 2.1, local z (scene); north face at z = -HD
const GOLD = "#c9a24a";
const BLACK = "#111214";

function signCanvas() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  // --- main fascia (0..1024 x 0..220) ---
  g.fillStyle = "#0b0b0c";
  g.fillRect(0, 0, 1024, 220);
  g.strokeStyle = GOLD;
  g.lineWidth = 6;
  g.strokeRect(8, 8, 1008, 204);
  g.lineWidth = 2;
  g.strokeRect(18, 18, 988, 184);
  monogram(g, 104, 110, 74);
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  const goldGrad = g.createLinearGradient(0, 50, 0, 150);
  goldGrad.addColorStop(0, "#f3dc9a");
  goldGrad.addColorStop(0.5, "#d4ac52");
  goldGrad.addColorStop(1, "#a07a2c");
  g.fillStyle = goldGrad;
  let px = 92;
  g.font = `700 ${px}px Didot, 'Bodoni 72', Georgia, 'Times New Roman', serif`;
  const tw = g.measureText("BEST MANGAL").width;
  if (tw > 600) px *= 600 / tw;
  g.font = `700 ${px}px Didot, 'Bodoni 72', Georgia, 'Times New Roman', serif`;
  g.fillText("BEST MANGAL", 520, 128);
  g.fillStyle = "#f2ede0";
  g.font = "600 34px Georgia, 'Times New Roman', serif";
  g.fillText("B A R   &   R E S T A U R A N T", 520, 182);
  flame(g, 930, 108, 0.95);
  // --- awning valance strip (0..1024 x 240..330) ---
  g.fillStyle = "#0b0b0c";
  g.fillRect(0, 240, 1024, 90);
  g.fillStyle = GOLD;
  g.fillRect(0, 244, 1024, 4);
  g.fillRect(0, 322, 1024, 4);
  g.font = "600 46px Georgia, 'Times New Roman', serif";
  g.fillText("CHARCOAL GRILL  ·  OCAKBAŞI  ·  MEZE", 512, 302);
  // --- blade sign monogram (0..256 x 340..596 -> clipped to 512) ---
  g.fillStyle = "#0b0b0c";
  g.fillRect(0, 340, 172, 172);
  g.strokeStyle = GOLD;
  g.lineWidth = 5;
  g.strokeRect(6, 346, 160, 160);
  monogram(g, 86, 426, 64);
  // --- menu board (200..520 x 340..512) ---
  g.fillStyle = "#1b1a18";
  g.fillRect(200, 340, 320, 172);
  g.fillStyle = "#f2ede0";
  g.font = "700 26px Georgia, serif";
  g.textAlign = "left";
  const lines = ["Adana  £16", "Lamb Shish  £18", "Chicken Wings  £14", "Mixed Grill  £26", "Meze  £9"];
  lines.forEach((l, i) => g.fillText(l, 216, 376 + i * 30));
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function monogram(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.save();
  g.strokeStyle = GOLD;
  g.lineWidth = 4;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(x, y, r - 8, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#e2bf6a";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `italic 700 ${r * 1.45}px 'Snell Roundhand', 'Apple Chancery', 'Brush Script MT', 'Lucida Handwriting', cursive`;
  g.fillText("B", x + r * 0.04, y + r * 0.06);
  g.restore();
}

function flame(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  // grill bars
  g.fillStyle = GOLD;
  for (let i = -2; i <= 2; i++) g.fillRect(-46, 38 + i * 0, 92, 5);
  g.fillRect(-46, 50, 92, 4);
  // flames
  const grad = g.createLinearGradient(0, 40, 0, -60);
  grad.addColorStop(0, "#e8562a");
  grad.addColorStop(0.6, "#f2a33a");
  grad.addColorStop(1, "#f7dc7a");
  g.fillStyle = grad;
  for (const [dx, h] of [
    [-24, 62],
    [0, 86],
    [24, 58],
  ]) {
    g.beginPath();
    g.moveTo(dx - 16, 36);
    g.quadraticCurveTo(dx - 20, 36 - h * 0.5, dx, 36 - h);
    g.quadraticCurveTo(dx + 4, 36 - h * 0.55, dx + 16, 36);
    g.closePath();
    g.fill();
  }
  g.restore();
}

/** A UV-mapped plane (local +z facing) using the canvas region [x0, y0, x1, y1] px of the 1024x512 sign canvas. */
function signPlane(w: number, h: number, px: [number, number, number, number]) {
  const g = new PlaneGeometry(w, h);
  const uv = g.getAttribute("uv");
  const [x0, y0, x1, y1] = px;
  const u0 = x0 / 1024, u1 = x1 / 1024, v0 = 1 - y1 / 512, v1 = 1 - y0 / 512;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? u1 : u0, uv.getY(i) ? v1 : v0);
  return g;
}

function seated(k: Kit, x: number, z: number, face: number, shirt: string, skin: string, trousers: string) {
  // a diner sitting on a chair facing local direction `face` (+1: toward +z)
  k.at(x, 0, z, face > 0 ? 0 : Math.PI, () => {
    k.box("solid", 0.42, 0.04, 0.42, 0, 0.46, -0.05, "#2a1a10"); // chair seat
    k.box("solid", 0.42, 0.5, 0.04, 0, 0.72, -0.26, "#2a1a10"); // chair back
    for (const sx of [-0.18, 0.18]) for (const sz of [-0.23, 0.13]) k.box("solid", 0.03, 0.46, 0.03, sx, 0.23, sz, "#1a100a");
    k.box("solid", 0.38, 0.14, 0.42, 0, 0.55, 0.1, trousers); // thighs
    for (const sx of [-0.1, 0.1]) k.box("solid", 0.13, 0.48, 0.13, sx, 0.26, 0.3, trousers); // shins
    k.rbox("solid", 0.4, 0.56, 0.24, 0, 0.88, -0.08, shirt, 0.06); // torso
    for (const sx of [-0.22, 0.22]) k.box("solid", 0.1, 0.1, 0.38, sx, 0.86, 0.12, shirt); // forearms to the table
    k.sphere("solid", 0.12, 10, 8, [0, 1.3, -0.07], skin);
    k.sphere("solid", 0.125, 10, 6, [0, 1.36, -0.1], "#2a1d14", [1, 0.6, 1]); // hair
  });
}

function build(): { ext: SlotGeos; int: BufferGeometry | null; coals: BufferGeometry; glass: BufferGeometry; signs: BufferGeometry } {
  const k = new Kit();
  // ---------------- upper floors: dark London brick with stone dressings and sash windows ----------------
  k.box("brick", BEST_MANGAL.w, BEST_MANGAL.h - GF, BEST_MANGAL.d, 0, GF + (BEST_MANGAL.h - GF) / 2, 0, "#6a4636");
  k.box("solid", BEST_MANGAL.w + 0.3, 0.35, BEST_MANGAL.d + 0.3, 0, BEST_MANGAL.h - 0.4, 0, "#d6cebd"); // cornice
  k.box("solid", BEST_MANGAL.w + 0.1, 0.5, BEST_MANGAL.d + 0.1, 0, BEST_MANGAL.h + 0.25, 0, "#5a3a2e"); // parapet
  k.box("solid", BEST_MANGAL.w - 0.4, 0.1, BEST_MANGAL.d - 0.4, 0, BEST_MANGAL.h + 0.05, 0, "#3a3a3c"); // roof
  for (let f = 0; f < 3; f++) {
    const y = GF + 0.95 + f * 3.75;
    // north face (z = -HD): four sashes
    for (const x of [-3.3, -1.1, 1.1, 3.3]) {
      const lit = (f * 7 + Math.round(x * 3)) % 3 === 0;
      k.box("glass", 1.15, 1.95, 0.06, x, y + 0.98, -HD - 0.01, lit ? "#6a5034" : "#28313a");
      k.box("solid", 1.4, 0.14, 0.18, x, y - 0.05, -HD - 0.06, "#ddd5c4"); // sill
      k.box("solid", 1.4, 0.22, 0.1, x, y + 2.08, -HD - 0.04, "#ddd5c4"); // lintel
      k.box("paint", 1.15, 0.05, 0.08, x, y + 0.98, -HD - 0.05, "#efe9df"); // meeting rail
    }
    // west face (x = -HW): two sashes
    for (const z of [-0.95, 0.95]) {
      const lit = (f + Math.round(z)) % 2 === 0;
      k.box("glass", 0.06, 1.95, 1.0, -HW - 0.01, y + 0.98, z, lit ? "#6a5034" : "#28313a");
      k.box("solid", 0.18, 0.14, 1.25, -HW - 0.06, y - 0.05, z, "#ddd5c4");
      k.box("solid", 0.1, 0.22, 1.25, -HW - 0.04, y + 2.08, z, "#ddd5c4");
      k.box("paint", 0.08, 0.05, 1.0, -HW - 0.05, y + 0.98, z, "#efe9df");
    }
  }
  // flue: steel duct up the back (south-east) corner to above the roof, with a cowl
  k.cyl("metal", 0.22, 0.22, BEST_MANGAL.h - GF + 2.2, 12, [HW - 0.6, GF + (BEST_MANGAL.h - GF + 2.2) / 2, HD - 0.5], "#9da3a9");
  k.cyl("metal", 0.4, 0.28, 0.3, 12, [HW - 0.6, BEST_MANGAL.h + 2.4, HD - 0.5], "#7d8288");

  // ---------------- ground floor shell: black piers, gold trims, fascia ----------------
  for (const [x, z] of [
    [-HW, -HD],
    [HW, -HD],
    [-HW, HD],
  ] as const) {
    k.box("paint", 0.42, GF, 0.42, x, GF / 2, z, BLACK);
    k.box("paint", 0.5, 0.12, 0.5, x, 3.25, z, GOLD); // capital
    k.box("paint", 0.5, 0.2, 0.5, x, 0.1, z, "#1a1a1c"); // plinth
  }
  // fascia boards on both faces (sign planes go on top)
  k.box("paint", BEST_MANGAL.w + 0.5, 1.0, 0.24, 0, 3.82, -HD - 0.12, BLACK);
  k.box("paint", 0.24, 1.0, BEST_MANGAL.d + 0.5, -HW - 0.12, 3.82, 0, BLACK);
  for (const y of [3.3, 4.34]) {
    k.box("paint", BEST_MANGAL.w + 0.56, 0.06, 0.3, 0, y, -HD - 0.13, GOLD);
    k.box("paint", 0.3, 0.06, BEST_MANGAL.d + 0.56, -HW - 0.13, y, 0, GOLD);
  }
  k.box("paint", BEST_MANGAL.w + 0.7, 0.14, 0.42, 0, 4.42, -HD - 0.14, BLACK); // cornice over the fascia
  k.box("paint", 0.42, 0.14, BEST_MANGAL.d + 0.7, -HW - 0.14, 4.42, 0, BLACK);
  // stall risers (black marble) and gold glazing bars
  k.box("paint", BEST_MANGAL.w - 0.4, 0.42, 0.16, 0, 0.21, -HD - 0.02, "#151517");
  k.box("paint", 0.16, 0.42, 1.6, -HW - 0.02, 0.21, 0.9, "#151517");
  k.box("paint", BEST_MANGAL.w - 0.4, 0.05, 0.1, 0, 0.44, -HD - 0.06, GOLD);
  k.box("paint", BEST_MANGAL.w - 0.4, 0.06, 0.1, 0, 2.75, -HD - 0.06, GOLD); // transom
  k.box("paint", 0.1, 0.06, BEST_MANGAL.d - 0.4, -HW - 0.06, 2.75, 0, GOLD);
  for (const x of [-1.6, 1.4]) k.box("paint", 0.07, 2.85, 0.1, x, 1.75, -HD - 0.06, GOLD);
  // door on the west (Pitfield St) face, north end
  k.box("paint", 0.1, 2.75, 0.08, -HW - 0.06, 1.38, -0.05, GOLD);
  k.box("paint", 0.1, 2.75, 0.08, -HW - 0.06, 1.38, -1.8, GOLD);
  k.box("metal", 0.12, 0.9, 0.04, -HW - 0.1, 1.15, -0.35, GOLD); // bar handle
  k.box("solid", 1.9, 0.04, 0.9, -HW - 0.45, 0.03, -0.9, "#2a2a2a"); // door mat / threshold
  // awning on the Boot St (north) face, black with a gold edge
  k.box("paint", BEST_MANGAL.w - 0.4, 0.05, 1.35, 0, 3.0, -HD - 0.62, "#151515", [-0.3, 0, 0]);
  k.box("paint", BEST_MANGAL.w - 0.4, 0.04, 0.05, 0, 2.8, -HD - 1.28, GOLD);
  for (const x of [-4.1, 4.1]) k.beam("metal", [x, 3.25, -HD], [x, 2.82, -HD - 1.28], 0.025, "#2a2c30");
  // blade sign bracket at the north-west corner
  k.box("paint", 0.06, 0.06, 1.2, -HW - 0.1, 5.2, -HD - 0.6, GOLD);
  k.box("paint", 0.9, 0.9, 0.06, -HW - 0.1, 4.7, -HD - 0.85, BLACK);
  // pendant lamps (glow) hanging inside
  for (const x of [-0.4, 1.4, 3.2]) {
    k.cyl("metal", 0.008, 0.008, 1.0, 4, [x, 3.7, -0.5], "#1a1a1a");
    k.sphere("glow", 0.14, 12, 8, [x, 3.15, -0.5], "#ffbf6a");
  }
  k.box("glow", 2.6, 0.04, 0.2, -2.8, 2.65, 1.45, "#ffd28a"); // strip light in the grill hood
  // pavement: two bistro tables on Pitfield St and bay trees by the door
  for (const z of [0.6, 1.8]) {
    k.at(-HW - 1.6, 0, z, 0, () => {
      k.cyl("metal", 0.32, 0.32, 0.03, 16, [0, 0.74, 0], "#18191b");
      k.cyl("metal", 0.03, 0.03, 0.72, 6, [0, 0.37, 0], "#18191b");
      k.cyl("metal", 0.2, 0.22, 0.03, 12, [0, 0.015, 0], "#18191b");
      for (const s of [-1, 1]) {
        k.box("solid", 0.4, 0.04, 0.4, 0, 0.46, s * 0.55, "#2a1d14");
        k.box("solid", 0.4, 0.45, 0.04, 0, 0.7, s * 0.75, "#2a1d14");
        for (const sx of [-0.17, 0.17]) for (const sz of [0.38, 0.72]) k.box("metal", 0.03, 0.46, 0.03, sx, 0.23, s * sz, "#18191b");
      }
      k.box("solid", 0.28, 0.03, 0.28, 0.05, 0.765, 0, "#7a4a28"); // board of kebabs
      k.box("solid", 0.2, 0.04, 0.06, 0.05, 0.79, 0, "#8a3e1c");
    });
  }
  for (const z of [-2.35, 0.35]) {
    k.box("paint", 0.5, 0.5, 0.5, -HW - 0.5, 0.25, z, BLACK);
    k.blob("solid", 0.34, 1, [-HW - 0.5, 0.9, z], "#3f6b33", [1, 1.2, 1]);
  }
  const ext = k.bake({ ao: 3 });

  // ---------------- interior (warm self-lit material) ----------------
  const ki = new Kit();
  ki.box("solid", BEST_MANGAL.w - 0.2, 0.06, BEST_MANGAL.d - 0.2, 0, 0.03, 0, "#5a3820"); // oak floor
  ki.box("solid", BEST_MANGAL.w - 0.2, 0.1, BEST_MANGAL.d - 0.2, 0, GF - 0.1, 0, "#3a2416"); // ceiling
  // back (south) wall: wood panelling below, warm plaster above, Turkish tiles behind the grill
  ki.box("solid", BEST_MANGAL.w - 0.2, 1.1, 0.08, 0, 0.55, HD - 0.1, "#4a2a16");
  ki.box("solid", BEST_MANGAL.w - 0.2, GF - 1.1, 0.06, 0, 1.1 + (GF - 1.1) / 2, HD - 0.12, "#9a6236");
  for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) ki.box("solid", 0.22, 0.22, 0.02, -4.2 + i * 0.24, 1.15 + j * 0.24, HD - 0.16, (i + j) % 2 ? "#2a5d8f" : "#ece4d0");
  // east wall with gold-framed pictures and a mirror
  ki.box("solid", 0.08, GF - 0.1, BEST_MANGAL.d - 0.2, HW - 0.1, GF / 2, 0, "#8a5530");
  for (const z of [-1.0, 0.6]) {
    ki.box("solid", 0.04, 0.8, 0.95, HW - 0.15, 2.1, z, GOLD);
    ki.box("solid", 0.02, 0.68, 0.83, HW - 0.17, 2.1, z, z < 0 ? "#6a7c88" : "#7a3b26");
  }
  // the mangal: steel cabinet, charcoal trough, hood
  ki.box("solid", 2.8, 0.92, 0.8, -2.8, 0.46, HD - 0.55, "#a9adb2");
  ki.box("solid", 2.7, 0.08, 0.7, -2.8, 0.94, HD - 0.55, "#3a3c40");
  ki.box("solid", 2.9, 0.5, 1.0, -2.8, 2.9, HD - 0.6, "#b8bcc1"); // hood
  ki.box("solid", 0.5, 1.2, 0.5, -2.8, 3.6, HD - 0.5, "#9da3a9"); // duct to the ceiling
  // skewers over the coals: steel blades with meat, peppers and tomatoes
  for (let i = 0; i < 11; i++) {
    const x = -4.0 + i * 0.24;
    ki.box("solid", 0.02, 0.02, 0.85, x, 1.08, HD - 0.55, "#d9dde2");
    for (let j = 0; j < 4; j++) ki.box("solid", 0.07, 0.06, 0.12, x, 1.1, HD - 0.85 + j * 0.17, ["#7a3b1c", "#8a4a22", "#3e7a2e", "#b8301e"][(i + j) % 4]);
  }
  // counter with a display chiller, gold trim
  ki.box("solid", 3.0, 1.05, 0.6, -2.7, 0.53, 0.45, "#2e1a10");
  ki.box("solid", 3.1, 0.05, 0.7, -2.7, 1.08, 0.45, GOLD);
  ki.box("solid", 2.8, 0.32, 0.5, -2.7, 1.28, 0.45, "#a8c4d0"); // display glass (tinted, lit)
  for (let i = 0; i < 6; i++) ki.box("solid", 0.38, 0.06, 0.32, -3.9 + i * 0.46, 1.15, 0.45, ["#b8442a", "#e8d6b0", "#6a8a3a", "#c4562a"][i % 4]);
  // the chef behind the counter, turning skewers
  ki.at(-2.5, 0, 1.15, Math.PI, () => {
    ki.box("solid", 0.36, 0.9, 0.24, 0, 0.45, 0, "#26282c"); // trousers
    ki.rbox("solid", 0.48, 0.66, 0.3, 0, 1.25, 0, "#f4f2ec", 0.08); // whites
    ki.box("solid", 0.5, 0.5, 0.02, 0, 1.0, 0.16, "#1a1a1a"); // apron
    ki.sphere("solid", 0.13, 12, 10, [0, 1.72, 0], "#c68a5e");
    ki.cyl("solid", 0.13, 0.12, 0.2, 12, [0, 1.9, 0], "#f4f2ec"); // chef's hat
    ki.box("solid", 0.11, 0.11, 0.5, -0.28, 1.35, -0.25, "#f4f2ec"); // arm reaching to the grill
    ki.box("solid", 0.11, 0.42, 0.11, 0.28, 1.2, 0, "#f4f2ec");
  });
  // tables of diners by the Boot St window
  const DINERS: [string, string, string][] = [
    ["#7a1f2b", "#e0ac83", "#2b2f3a"],
    ["#e8e2cf", "#7a4a2c", "#3a3f4b"],
    ["#2f4a6b", "#f1c9a5", "#1f2430"],
    ["#3e5e3a", "#a36a43", "#4a4036"],
    ["#1a1a1a", "#c68a5e", "#36454f"],
    ["#c9a24a", "#f1c9a5", "#2b2f3a"],
  ];
  [-0.4, 1.4, 3.2].forEach((x, i) => {
    ki.box("solid", 0.8, 0.05, 0.75, x, 0.76, -0.75, "#3a2214"); // table
    ki.box("solid", 0.08, 0.72, 0.08, x, 0.37, -0.75, "#1a100a");
    ki.box("solid", 0.42, 0.03, 0.26, x, 0.8, -0.75, "#7a4a28"); // wooden board of kebabs
    for (let j = 0; j < 3; j++) ki.box("solid", 0.36, 0.04, 0.05, x, 0.83, -0.83 + j * 0.08, "#8a3e1c");
    for (const s of [-0.28, 0.28]) ki.cyl("solid", 0.12, 0.12, 0.015, 14, [x + s, 0.79, -0.6], "#f4f2ec"); // plates
    seated(ki, x, -1.45, 1, ...DINERS[(i * 2) % 6]);
    seated(ki, x, -0.05, -1, ...DINERS[(i * 2 + 1) % 6]);
  });
  const intGeo = ki.bake({ ao: 1.2 }).solid ?? null;

  // coals: one emissive bed (flickers)
  const kc = new Kit();
  kc.box("solid", 2.6, 0.05, 0.62, -2.8, 0.99, HD - 0.55, "#ffffff");
  for (let i = 0; i < 26; i++) kc.box("solid", 0.12, 0.06, 0.1, -4.0 + ((i * 0.37) % 2.5), 1.02, HD - 0.8 + ((i * 0.23) % 0.5), "#ffffff");
  const coals = kc.bake().solid!;

  // glass on both faces (transparent): north face, west face beside the door, and the door glass
  const glass = mergeGeometries(
    [
      new PlaneGeometry(BEST_MANGAL.w - 0.6, 2.85).rotateY(Math.PI).translate(0, 1.85, -HD - 0.03),
      new PlaneGeometry(1.7, 2.85).rotateY(-Math.PI / 2).translate(-HW - 0.03, 1.85, 0.95),
      new PlaneGeometry(1.7, 2.6).rotateY(-Math.PI / 2).translate(-HW - 0.03, 1.4, -0.92),
    ],
    false,
  )!;

  // sign planes: fascia west + north, awning valance, blade sign (both sides), menu board by the door
  const signs = mergeGeometries(
    [
      signPlane(4.55, 0.98, [0, 0, 1024, 220]).rotateY(-Math.PI / 2).translate(-HW - 0.25, 3.82, 0),
      signPlane(5.6, 1.2, [0, 0, 1024, 220]).scale(1, 0.82, 1).rotateY(Math.PI).translate(0, 3.82, -HD - 0.25),
      signPlane(BEST_MANGAL.w - 0.5, 0.36, [0, 240, 1024, 330]).rotateY(Math.PI).translate(0, 2.6, -HD - 1.32),
      signPlane(0.84, 0.84, [0, 340, 172, 512]).rotateY(-Math.PI / 2).translate(-HW - 0.135, 4.7, -HD - 0.85),
      signPlane(0.84, 0.84, [0, 340, 172, 512]).rotateY(Math.PI / 2).translate(-HW - 0.065, 4.7, -HD - 0.85),
      signPlane(0.6, 0.32, [200, 340, 520, 512]).rotateY(-Math.PI / 2).translate(-HW - 0.08, 1.55, 0.6),
    ],
    false,
  )!;
  return { ext, int: intGeo, coals, glass, signs };
}

const QUEUE = 7;
const SMOKE = 28;

export default function BestMangal() {
  const parts = useMemo(build, []);
  const signTex = useMemo(signCanvas, []);
  const mats = useMemo(() => {
    const interior = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, emissive: new Color("#ffffff"), emissiveIntensity: 0.3 });
    interior.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vColor.rgb * vec3(1.0, 0.82, 0.6);");
    };
    interior.customProgramCacheKey = () => "best-mangal-interior";
    return {
      interior,
      coals: new MeshBasicMaterial({ color: "#ff6a1a", toneMapped: false }),
      glass: new MeshStandardMaterial({ color: "#9fb8c6", roughness: 0.05, metalness: 0.5, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide }),
      sign: new MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: new Color("#ffffff"), emissiveIntensity: 0.4, roughness: 0.45, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }),
      smoke: new PointsMaterial({ map: smokeTexture(), color: "#c9c6c0", size: 2.6, sizeAttenuation: true, transparent: true, opacity: 0.32, depthWrite: false, blending: NormalBlending }),
      shimmer: new PointsMaterial({ map: smokeTexture(), color: "#ff9a40", size: 0.9, transparent: true, opacity: 0.18, depthWrite: false, blending: AdditiveBlending }),
    };
  }, [signTex]);
  const hero = heroMaterials();

  const smoke = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(new Float32Array(SMOKE * 3), 3));
    return g;
  }, []);
  const shimmer = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(new Float32Array(10 * 3), 3));
    return g;
  }, []);

  const people = useMemo(() => createPeople(QUEUE, { emissive: 0.1 }), []);
  const queue = useMemo(
    () =>
      Array.from({ length: QUEUE }, (_, i) => ({
        shirt: new Color().setHSL((i * 0.137) % 1, 0.45, 0.42),
        trousers: TROUSERS[i % TROUSERS.length],
        skin: SKIN_TONES[(i * 3) % SKIN_TONES.length],
        jitter: (i * 0.37) % 0.3,
      })),
    [],
  );

  useEffect(
    () => () => {
      for (const g of [...Object.values(parts.ext), parts.int, parts.coals, parts.glass, parts.signs, smoke, shimmer]) g?.dispose();
      Object.values(mats).forEach((m) => m.dispose());
      signTex.dispose();
      people.dispose();
    },
    [parts, mats, signTex, smoke, shimmer, people],
  );

  const root = useRef<Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const simT = useSim.getState().t;
    const h = hourOf(simT);
    const night = nightLevel(h);
    const open = h >= 11.5 || h < 1;
    mats.interior.emissiveIntensity = open ? 0.28 + 0.75 * night : 0.04;
    mats.sign.emissiveIntensity = 0.35 + 1.6 * night;
    // charcoal flicker
    const f = open ? 0.75 + 0.25 * Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1) : 0.15;
    mats.coals.color.setRGB(1.6 * f + 0.4, 0.42 * f + 0.08, 0.06 * f);
    // smoke from the flue cowl (local coords)
    const sp = smoke.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < SMOKE; i++) {
      const k = ((t * 0.12 + i / SMOKE) % 1 + 1) % 1;
      sp.setXYZ(i, HW - 0.6 + Math.sin(i * 1.7 + t * 0.6) * 0.5 * k + k * 2.2, BEST_MANGAL.h + 2.6 + k * 7, HD - 0.5 - k * 1.2 + Math.cos(i * 2.3) * 0.4 * k);
    }
    sp.needsUpdate = true;
    mats.smoke.opacity = open ? 0.3 : 0.05;
    const hp = shimmer.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < 10; i++) {
      const k = ((t * 0.7 + i / 10) % 1 + 1) % 1;
      hp.setXYZ(i, -4 + (i % 5) * 0.6 + Math.sin(t * 3 + i) * 0.08, 1.15 + k * 1.3, HD - 0.55);
    }
    hp.needsUpdate = true;
    // Friday / Saturday evening queue along the Boot St pavement, heading for the door round the corner
    const dow = (dayOf(simT) - 1) % 7;
    const late = h < 1.5 ? (dow + 6) % 7 : dow; // after midnight still counts as the night before
    const busy = (late === 4 || late === 5) && (h >= 18.5 || h < 1.5);
    const n = busy ? (h >= 20 || h < 0.5 ? QUEUE : 4) : 0;
    const g = root.current;
    for (let i = 0; i < n; i++) {
      const q = queue[i];
      // local queue line: along the north pavement from the corner eastward
      const lx = -HW - 0.6 + i * 0.78 + q.jitter;
      const lz = -HD - 0.85 - (i % 2) * 0.12;
      const wx = (g?.position.x ?? 0) + lx;
      const wz = (g?.position.z ?? 0) + lz;
      people.set(i, wx, 0, wz, -Math.PI / 2, t * 0.7 + i, false, 1.75, q.shirt, q.trousers, q.skin);
    }
    people.commit(n);
  });

  return (
    <group name="landmark-bestmangal">
      <group ref={root} position={[BEST_MANGAL.x, 0, -BEST_MANGAL.z]}>
        {Object.entries(parts.ext).map(([slot, geo]) => (
          <mesh key={slot} geometry={geo} material={hero[slot as keyof typeof hero]} castShadow={slot !== "glow" && slot !== "glass"} receiveShadow />
        ))}
        {parts.int && <mesh geometry={parts.int} material={mats.interior} receiveShadow />}
        <mesh geometry={parts.coals} material={mats.coals} />
        <mesh geometry={parts.signs} material={mats.sign} />
        <mesh geometry={parts.glass} material={mats.glass} renderOrder={2} />
        <points geometry={smoke} material={mats.smoke} frustumCulled={false} />
        <points geometry={shimmer} material={mats.shimmer} frustumCulled={false} />
      </group>
      <primitive object={people.group} />
    </group>
  );
}

let smokeTex: CanvasTexture | null = null;
function smokeTexture() {
  if (smokeTex) return smokeTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  r.addColorStop(0, "rgba(255,255,255,0.9)");
  r.addColorStop(0.5, "rgba(255,255,255,0.35)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  smokeTex = new CanvasTexture(c);
  return smokeTex;
}

