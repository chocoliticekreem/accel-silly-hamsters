// Procedural canvas textures (no image assets): a window grid for facades and a soft radial glow.
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from "three";
import { rng } from "../mock/rng";

/** One tile = COLS × ROWS windows. Facades repeat it by building size (≈4 m per window, 3.5 m per floor). */
export const TILE_COLS = 8;
export const TILE_ROWS = 8;
export const WINDOW_W = 4;
export const FLOOR_H = 3.5;

const px = 32;

/** Wall + glass map, and an emissive mask where ~40% of windows are lit (variant = different lit pattern). */
export function windowTextures(wall: string, variant: number, frame?: string): { map: Texture; emissive: Texture } {
  const r = rng(1000 + variant);
  const mk = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = TILE_COLS * px;
    c.height = TILE_ROWS * px;
    const g = c.getContext("2d")!;
    draw(g);
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const cells = (g: CanvasRenderingContext2D, color: (i: number, j: number) => string | null) => {
    for (let i = 0; i < TILE_COLS; i++)
      for (let j = 0; j < TILE_ROWS; j++) {
        const fill = color(i, j);
        if (!fill) continue;
        g.fillStyle = fill;
        g.fillRect(i * px + 7, j * px + 8, px - 14, px - 13);
      }
  };
  const lit = Array.from({ length: TILE_COLS * TILE_ROWS }, () => r() < 0.4);
  const map = mk((g) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    if (frame) {
      // white-painted sash frames around each pane: the London terrace look
      g.fillStyle = frame;
      for (let i = 0; i < TILE_COLS; i++) for (let j = 0; j < TILE_ROWS; j++) g.fillRect(i * px + 5, j * px + 6, px - 10, px - 9);
    }
    cells(g, () => "#5d6b80");
  });
  const emissive = mk((g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    cells(g, (i, j) => (lit[i * TILE_ROWS + j] ? (r() < 0.25 ? "#ffe6b0" : "#ffc857") : null));
  });
  return { map, emissive };
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
