// Procedural canvas textures (no image assets): a window grid for facades and a soft radial glow.
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, Vector2, type Texture } from "three";
import { rng } from "../mock/rng";

/** One tile = COLS × ROWS windows. Facades repeat it by building size (≈4 m per window, 3.5 m per floor). */
export const TILE_COLS = 8;
export const TILE_ROWS = 8;
export const WINDOW_W = 4;
export const FLOOR_H = 3.5;

const px = 32;
/** Canvas pixels per layout pixel (layout stays in 32-px window cells; textures are drawn at 2× for crisp frames). */
const RES = 2;

export interface FacadeTextures {
  map: Texture;
  emissive: Texture;
  /** Tangent-space normals: recessed glass, raised sills, a little wall texture. */
  normal: Texture;
  /** Roughness in G (wall rough, glass glossy), metalness in B (glass reflects the sky): use as both maps. */
  orm: Texture;
}

/** Material params that make a facade's glass reflect the environment and its windows read as inset. */
export function facadeMaterialParams(t: FacadeTextures) {
  return { normalMap: t.normal, normalScale: new Vector2(0.9, 0.9), roughnessMap: t.orm, metalnessMap: t.orm, roughness: 1, metalness: 1 };
}

/** Wall + glass map, an emissive mask where ~40% of windows are lit (variant = different lit pattern), normal + ORM. */
export function windowTextures(wall: string, variant: number, frame?: string): FacadeTextures {
  const r = rng(1000 + variant);
  const canvas = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = TILE_COLS * px * RES;
    c.height = TILE_ROWS * px * RES;
    const g = c.getContext("2d")!;
    g.scale(RES, RES);
    draw(g);
    return c;
  };
  const tex = (c: HTMLCanvasElement, srgb = true) => {
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    if (srgb) t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const mk = (draw: (g: CanvasRenderingContext2D) => void) => tex(canvas(draw));
  // window cell geometry (layout px): pane, frame (sash/mullion), sill below, lintel above
  const pane = (i: number, j: number) => [i * px + 7, j * px + 8, px - 14, px - 13] as const;
  const frameRect = (i: number, j: number) => [i * px + 5, j * px + 6, px - 10, px - 9] as const;
  const sill = (i: number, j: number) => [i * px + 4, j * px + px - 5, px - 8, 2] as const;
  const lintel = (i: number, j: number) => [i * px + 5, j * px + 4, px - 10, 2] as const;
  const each = (f: (i: number, j: number) => void) => {
    for (let i = 0; i < TILE_COLS; i++) for (let j = 0; j < TILE_ROWS; j++) f(i, j);
  };
  const grain = (g: CanvasRenderingContext2D, alpha: number) => {
    // brick/render speckle so walls aren't flat colour
    const n = TILE_COLS * TILE_ROWS * 40;
    for (let k = 0; k < n; k++) {
      g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${alpha * r()})` : `rgba(255,255,255,${alpha * 0.7 * r()})`;
      g.fillRect(r() * TILE_COLS * px, r() * TILE_ROWS * px, 1.5 + r() * 2, 0.8);
    }
  };
  const heightMap = canvas((g) => {
    g.fillStyle = "rgb(150,150,150)";
    g.fillRect(0, 0, TILE_COLS * px, TILE_ROWS * px);
    grain(g, 0.25);
    each((i, j) => {
      g.fillStyle = "rgb(210,210,210)";
      g.fillRect(...sill(i, j));
      g.fillRect(...lintel(i, j));
      g.fillStyle = "rgb(95,95,95)";
      g.fillRect(...frameRect(i, j));
      g.fillStyle = "rgb(40,40,40)";
      g.fillRect(...pane(i, j));
    });
  });
  const ormCanvas = canvas((g) => {
    // R unused (1), G roughness, B metalness
    g.fillStyle = "rgb(255,232,0)";
    g.fillRect(0, 0, TILE_COLS * px, TILE_ROWS * px);
    each((i, j) => {
      g.fillStyle = "rgb(255,150,0)";
      g.fillRect(...frameRect(i, j));
      g.fillStyle = "rgb(255,28,150)";
      g.fillRect(...pane(i, j));
    });
  });
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
    g.fillRect(0, 0, TILE_COLS * px, TILE_ROWS * px);
    grain(g, 0.12);
    each((i, j) => {
      // stone sill and lintel, then the frame (white sash on terraces, dark metal on offices)
      g.fillStyle = "rgba(235,228,214,0.85)";
      g.fillRect(...sill(i, j));
      g.fillStyle = "rgba(0,0,0,0.18)";
      g.fillRect(...lintel(i, j));
      g.fillStyle = frame ?? "#3b4250";
      g.fillRect(...frameRect(i, j));
      // glass: darker at the bottom (interior), a sky sheen at the top; the env map adds real reflections
      const [x, y, w, h] = pane(i, j);
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, "#7e8ea6");
      grad.addColorStop(1, "#3d4758");
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
      if (frame) {
        // glazing bar across the sash
        g.fillStyle = frame;
        g.fillRect(x, y + h * 0.48, w, 1);
      }
    });
  });
  const emissive = mk((g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, TILE_COLS * px, TILE_ROWS * px);
    cells(g, (i, j) => (lit[i * TILE_ROWS + j] ? (r() < 0.25 ? "#ffe6b0" : "#ffc857") : null));
  });
  return { map, emissive, normal: tex(normalFromHeight(heightMap, 2.2), false), orm: tex(ormCanvas, false) };
}

/** Sobel normal map (tangent space, OpenGL convention) from a greyscale height canvas. */
function normalFromHeight(src: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const hd = src.getContext("2d")!.getImageData(0, 0, w, h).data;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const og = out.getContext("2d")!;
  const img = og.createImageData(w, h);
  const H = (x: number, y: number) => hd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x - 1, y) - H(x - 1, y + 1)) * strength;
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x, y - 1) - H(x + 1, y - 1)) * strength;
      // canvas y runs down, texture v runs up: flip dy for OpenGL-style normals
      const nx = -dx;
      const ny = dy;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const k = (y * w + x) * 4;
      img.data[k] = (nx * inv * 0.5 + 0.5) * 255;
      img.data[k + 1] = (ny * inv * 0.5 + 0.5) * 255;
      img.data[k + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  og.putImageData(img, 0, 0);
  return out;
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
