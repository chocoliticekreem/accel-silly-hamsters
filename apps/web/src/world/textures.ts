// Procedural canvas textures (no image assets): facades with real-looking walls and recessed windows, and a soft
// radial glow. Brick buildings (a frame colour given) get stock-brick courses with mortar, gauged-brick lintels,
// stone sills and painted sash frames; frameless buildings (offices) get concrete panels with spandrels and
// mullions. Each facade also has a bump map (mortar and window reveals sit back) and an emissive lit-window mask.
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from "three";
import { rng } from "../mock/rng";

/** One tile = COLS × ROWS windows. Facades repeat it by building size (≈4 m per window, 3.5 m per floor). */
export const TILE_COLS = 8;
export const TILE_ROWS = 8;
export const WINDOW_W = 4;
export const FLOOR_H = 3.5;

/** Pixels per window cell (one cell = 4 m × 3.5 m of facade). */
const px = 64;

// window opening inside a cell, in pixels
const WX = 15;
const WY = 12;
const WW = px - 30;
const WH = px - 22;

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Wall + glass map, a bump map and an emissive mask where ~40% of windows are lit (variant = lit pattern). */
export function windowTextures(wall: string, variant: number, frame?: string): { map: Texture; emissive: Texture; bump: Texture } {
  const r = rng(1000 + variant);
  const W = TILE_COLS * px;
  const H = TILE_ROWS * px;
  const mk = (draw: (g: CanvasRenderingContext2D) => void, color = true) => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    draw(g);
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    if (color) t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const brick = !!frame;
  const lit = Array.from({ length: TILE_COLS * TILE_ROWS }, () => r() < 0.4);
  const warm = lit.map(() => r() < 0.25);
  // some windows have blinds half down: they read as lived-in
  const blind = lit.map(() => r() < 0.3);
  const each = (fn: (x: number, y: number, k: number) => void) => {
    for (let i = 0; i < TILE_COLS; i++) for (let j = 0; j < TILE_ROWS; j++) fn(i * px, j * px, i * TILE_ROWS + j);
  };

  // bricks: 64 px per 3.5 m floor -> ~14 courses per cell (a little chunky so it reads at distance)
  const drawBrick = (g: CanvasRenderingContext2D, height: boolean) => {
    const course = 4.5;
    const len = 10;
    g.fillStyle = height ? "#606060" : shade(wall, 1.18); // mortar
    g.fillRect(0, 0, W, H);
    for (let y = 0, row = 0; y < H; y += course, row++) {
      const off = row % 2 ? len / 2 : 0;
      for (let x = -off; x < W; x += len) {
        const k = 0.86 + r() * 0.24 + (r() < 0.05 ? -0.15 : 0);
        const v = 170 + Math.round((k - 0.86) * 120);
        g.fillStyle = height ? `rgb(${v},${v},${v})` : shade(wall, k);
        g.fillRect(x + 0.6, y + 0.6, len - 1.2, course - 1.2);
      }
    }
  };
  const drawPanels = (g: CanvasRenderingContext2D, height: boolean) => {
    g.fillStyle = height ? "#9a9a9a" : wall;
    g.fillRect(0, 0, W, H);
    // spandrel band per floor and a panel joint grid
    for (let j = 0; j < TILE_ROWS; j++) {
      g.fillStyle = height ? "#b0b0b0" : shade(wall, 0.9);
      g.fillRect(0, j * px + WY + WH + 2, W, px - WH - WY - 2);
      g.fillStyle = height ? "#505050" : shade(wall, 0.78);
      g.fillRect(0, j * px, W, 1.5);
    }
    for (let i = 0; i < TILE_COLS; i++) {
      g.fillStyle = height ? "#505050" : shade(wall, 0.8);
      g.fillRect(i * px, 0, 1.5, H);
    }
  };

  const map = mk((g) => {
    if (brick) drawBrick(g, false);
    else drawPanels(g, false);
    each((x, y, k) => {
      if (brick) {
        // gauged-brick lintel and a stone sill
        g.fillStyle = shade(wall, 0.82);
        g.fillRect(x + WX - 3, y + WY - 6, WW + 6, 6);
        g.fillStyle = "#d9d3c4";
        g.fillRect(x + WX - 4, y + WY + WH, WW + 8, 4);
      }
      // reveal: the window sits back from the wall, so a dark band on the top and left
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(x + WX - 2, y + WY - 2, WW + 4, WH + 2);
      // frame
      g.fillStyle = frame ?? shade(wall, 0.55);
      g.fillRect(x + WX, y + WY, WW, WH);
      // glass: sky reflection fading down
      const grad = g.createLinearGradient(0, y + WY, 0, y + WY + WH);
      grad.addColorStop(0, "#9fb3c8");
      grad.addColorStop(0.45, "#5d6e84");
      grad.addColorStop(1, "#3a4556");
      g.fillStyle = grad;
      const f = brick ? 3 : 2;
      if (brick) {
        // two-over-two sash: four panes
        const hw = (WW - f * 3) / 2;
        const hh = (WH - f * 3) / 2;
        for (const a of [0, 1]) for (const b of [0, 1]) g.fillRect(x + WX + f + a * (hw + f), y + WY + f + b * (hh + f), hw, hh);
      } else {
        g.fillRect(x + WX + f, y + WY + f, WW - f * 2, WH - f * 2);
        g.fillStyle = shade(wall, 0.55);
        g.fillRect(x + WX + WW / 2 - 1, y + WY, 2, WH); // mullion
      }
      if (blind[k]) {
        g.fillStyle = r() < 0.5 ? "#e8e1cf" : "#cfc6b0";
        g.fillRect(x + WX + f, y + WY + f, WW - f * 2, (WH - f * 2) * (0.25 + r() * 0.35));
      }
    });
  });

  const bump = mk((g) => {
    if (brick) drawBrick(g, true);
    else drawPanels(g, true);
    each((x, y) => {
      g.fillStyle = "#202020"; // window reveal sits back
      g.fillRect(x + WX - 2, y + WY - 2, WW + 4, WH + 2);
      g.fillStyle = "#383838";
      g.fillRect(x + WX, y + WY, WW, WH);
      if (brick) {
        g.fillStyle = "#e0e0e0"; // sill stands proud
        g.fillRect(x + WX - 4, y + WY + WH, WW + 8, 4);
      }
    });
  }, false);

  const emissive = mk((g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    each((x, y, k) => {
      if (!lit[k]) return;
      g.fillStyle = warm[k] ? "#ffe6b0" : "#ffc857";
      g.fillRect(x + WX + 2, y + WY + 2, WW - 4, WH - 4);
      if (blind[k]) {
        g.fillStyle = "rgba(0,0,0,0.55)";
        g.fillRect(x + WX + 2, y + WY + 2, WW - 4, (WH - 4) * 0.4);
      }
    });
  });
  return { map, emissive, bump };
}

let glow: Texture | null = null;
/** Shared soft radial gradient for additive ground glows. */
export function glowTexture(): Texture {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glow = new CanvasTexture(c);
  return glow;
}
