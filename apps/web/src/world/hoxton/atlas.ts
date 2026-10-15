// One canvas atlas for every Hoxton shop fascia (top half) and street-art mural (bottom half), so all the signs are
// one draw call and all the murals another. Signs are painted per real OSM name in a style that fits the venue
// (pubs and bars: dark gloss boards with gilt serif letters; cafés and shops: painted boards in sans letters).
// Murals are procedural (no real artist's work copied): colour fields, bubble letters, faces, stripes and drips.
import { CanvasTexture, SRGBColorSpace } from "three";
import { rng } from "../../mock/rng";

export const ATLAS_W = 2048;
export const ATLAS_H = 4096;
const SIGN_COLS = 5;
const SIGN_CW = ATLAS_W / SIGN_COLS; // 409.6
const SIGN_CH = 80;
const SIGN_ROWS = Math.floor(2048 / SIGN_CH); // 25
export const MAX_SIGNS = SIGN_COLS * SIGN_ROWS;
export const MURALS = 16;
const MURAL_PX = 512;

export type SignStyle = "bar" | "pub" | "club" | "cafe" | "food" | "shop" | "venue";

export interface SignReq {
  text: string;
  style: SignStyle;
  /** Width / height of the board in metres: the painted region keeps this aspect. */
  aspect: number;
  seed: number;
}

/** UV rectangle [u0, v0, u1, v1] (v up, three.js convention, flipY texture). */
export type UVRect = [number, number, number, number];

const BAR_BG = ["#101214", "#1c2a22", "#2a1416", "#14203a", "#1a1a1a", "#3a2a1a"];
const CAFE_BG = ["#f2ede1", "#2f4a3a", "#c94f2c", "#e8c547", "#1f3f5c", "#f7f3ea", "#7a2f3f", "#335c4e"];
const SHOP_BG = ["#ffffff", "#111111", "#d9d4c7", "#22303c", "#a33a2c", "#2c5d4f", "#e9e2d0", "#5b3a6b"];

function contrast(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? "#1a1a1a" : "#f5f0e4";
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  signUV: UVRect[];
  muralUV: UVRect[];
}

export function buildAtlas(signs: SignReq[]): Atlas {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#202020";
  g.fillRect(0, 0, ATLAS_W, ATLAS_H);
  const signUV: UVRect[] = [];
  signs.slice(0, MAX_SIGNS).forEach((s, i) => {
    const col = i % SIGN_COLS;
    const row = Math.floor(i / SIGN_COLS);
    // painted region of the cell with the board's aspect
    let w = SIGN_CW - 4;
    let h = w / s.aspect;
    if (h > SIGN_CH - 4) {
      h = SIGN_CH - 4;
      w = h * s.aspect;
    }
    const x0 = col * SIGN_CW + (SIGN_CW - w) / 2;
    const y0 = row * SIGN_CH + (SIGN_CH - h) / 2;
    paintSign(g, s, x0, y0, w, h);
    signUV.push([x0 / ATLAS_W, 1 - (y0 + h) / ATLAS_H, (x0 + w) / ATLAS_W, 1 - y0 / ATLAS_H]);
  });
  const muralUV: UVRect[] = [];
  for (let m = 0; m < MURALS; m++) {
    const x0 = (m % 4) * MURAL_PX;
    const y0 = 2048 + Math.floor(m / 4) * MURAL_PX;
    paintMural(g, m, x0, y0, MURAL_PX);
    const e = 2;
    muralUV.push([(x0 + e) / ATLAS_W, 1 - (y0 + MURAL_PX - e) / ATLAS_H, (x0 + MURAL_PX - e) / ATLAS_W, 1 - (y0 + e) / ATLAS_H]);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return { canvas, texture, signUV, muralUV };
}

function paintSign(g: CanvasRenderingContext2D, s: SignReq, x: number, y: number, w: number, h: number) {
  const r = rng(s.seed);
  const pickFrom = (a: string[]) => a[Math.floor(r() * a.length)];
  const serif = s.style === "pub" || s.style === "bar" ? r() < 0.75 : r() < 0.2;
  const bg = s.style === "pub" || s.style === "bar" || s.style === "club" ? pickFrom(BAR_BG) : s.style === "cafe" || s.style === "food" ? pickFrom(CAFE_BG) : pickFrom(SHOP_BG);
  const gilt = (s.style === "pub" || s.style === "bar") && r() < 0.7;
  const fg = s.style === "club" ? pickFrom(["#ff3b8d", "#38e1ff", "#f7f052"]) : gilt ? "#d8b25a" : contrast(bg);
  g.save();
  g.fillStyle = bg;
  g.fillRect(x, y, w, h);
  // moulding / border line
  g.strokeStyle = gilt ? "#a8843a" : fg;
  g.globalAlpha = 0.55;
  g.lineWidth = Math.max(1.5, h * 0.04);
  const inset = h * 0.1;
  g.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
  g.globalAlpha = 1;
  let text = s.text;
  if (!serif && r() < 0.55) text = text.toUpperCase();
  const weight = serif ? "700" : r() < 0.5 ? "800" : "600";
  const family = serif ? "Georgia, 'Times New Roman', serif" : r() < 0.5 ? "'Helvetica Neue', Arial, sans-serif" : "Futura, 'Trebuchet MS', sans-serif";
  let px = h * 0.6;
  g.font = `${weight} ${px}px ${family}`;
  const maxW = w - h * 0.6;
  const tw = g.measureText(text).width;
  if (tw > maxW) {
    px *= maxW / tw;
    g.font = `${weight} ${px}px ${family}`;
  }
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (gilt) {
    g.shadowColor = "rgba(0,0,0,0.6)";
    g.shadowOffsetY = px * 0.05;
  }
  if (s.style === "club") {
    g.shadowColor = fg;
    g.shadowBlur = px * 0.35;
  }
  g.fillText(text, x + w / 2, y + h / 2 + px * 0.04);
  g.restore();
}

const MURAL_PALETTES = [
  ["#ff4f79", "#ffd23f", "#3bceac", "#0e1428", "#ffffff"],
  ["#f25f5c", "#ffe066", "#247ba0", "#70c1b3", "#50514f"],
  ["#ff6b35", "#004e89", "#1a659e", "#f7c59f", "#efefd0"],
  ["#8338ec", "#ff006e", "#fb5607", "#ffbe0b", "#3a86ff"],
  ["#2b2d42", "#8d99ae", "#edf2f4", "#ef233c", "#d90429"],
  ["#06d6a0", "#118ab2", "#073b4c", "#ffd166", "#ef476f"],
  ["#e9c46a", "#f4a261", "#e76f51", "#264653", "#2a9d8f"],
  ["#111111", "#f5f5f5", "#ff1654", "#247ba0", "#f3ffbd"],
];
const WORDS = ["HOXTON", "N1", "RIVINGTON", "E2", "SHORE", "HOX", "LDN", "CURTAIN", "FRESH", "DREAM", "ZINE", "WILD", "OK", "NOW", "BLOOM", "GLOW"];

function paintMural(g: CanvasRenderingContext2D, m: number, x0: number, y0: number, S: number) {
  const r = rng(9001 + m * 131);
  const pal = MURAL_PALETTES[m % MURAL_PALETTES.length];
  const pick = () => pal[Math.floor(r() * pal.length)];
  g.save();
  g.beginPath();
  g.rect(x0, y0, S, S);
  g.clip();
  // background field (gradient or flat)
  const grad = g.createLinearGradient(x0, y0, x0 + S * r(), y0 + S);
  grad.addColorStop(0, pick());
  grad.addColorStop(1, pick());
  g.fillStyle = r() < 0.7 ? grad : pick();
  g.fillRect(x0, y0, S, S);
  const kind = m % 4;
  if (kind === 0 || kind === 2) {
    // big organic blobs
    for (let i = 0; i < 7; i++) {
      g.fillStyle = pick();
      g.beginPath();
      const cx = x0 + r() * S;
      const cy = y0 + r() * S;
      const rad = S * (0.08 + r() * 0.22);
      for (let a = 0; a <= 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const rr = rad * (0.75 + r() * 0.5);
        const px = cx + Math.cos(ang) * rr;
        const py = cy + Math.sin(ang) * rr;
        if (a === 0) g.moveTo(px, py);
        else g.quadraticCurveTo(cx + Math.cos(ang - 0.26) * rr * 1.2, cy + Math.sin(ang - 0.26) * rr * 1.2, px, py);
      }
      g.fill();
    }
  }
  if (kind === 1 || kind === 3) {
    // stripes / geometric bands
    const n = 5 + Math.floor(r() * 6);
    g.save();
    g.translate(x0 + S / 2, y0 + S / 2);
    g.rotate((r() - 0.5) * 1.2);
    for (let i = 0; i < n; i++) {
      g.fillStyle = pick();
      g.fillRect(-S, -S + (i * 2 * S) / n, S * 2, ((2 * S) / n) * 0.55);
    }
    g.restore();
  }
  if (kind === 2 || kind === 3) {
    // a cartoon face: head, eyes, grin
    const cx = x0 + S * (0.3 + r() * 0.4);
    const cy = y0 + S * (0.35 + r() * 0.2);
    const rad = S * (0.18 + r() * 0.1);
    g.fillStyle = pick();
    g.strokeStyle = "#111";
    g.lineWidth = S * 0.018;
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    for (const s of [-1, 1]) {
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(cx + s * rad * 0.38, cy - rad * 0.15, rad * 0.22, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = "#111";
      g.beginPath();
      g.arc(cx + s * rad * 0.38 + rad * 0.05, cy - rad * 0.12, rad * 0.09, 0, Math.PI * 2);
      g.fill();
    }
    g.beginPath();
    g.arc(cx, cy + rad * 0.15, rad * 0.5, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
  }
  // bubble letters
  const word = WORDS[Math.floor(r() * WORDS.length)];
  let px = S * 0.3;
  g.font = `900 ${px}px 'Arial Black', Impact, sans-serif`;
  const tw = g.measureText(word).width;
  if (tw > S * 0.92) {
    px *= (S * 0.92) / tw;
    g.font = `900 ${px}px 'Arial Black', Impact, sans-serif`;
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  const ty = y0 + S * (kind === 2 || kind === 3 ? 0.78 : 0.5);
  g.lineJoin = "round";
  g.lineWidth = px * 0.22;
  g.strokeStyle = "#111";
  g.strokeText(word, x0 + S / 2, ty);
  g.lineWidth = px * 0.1;
  g.strokeStyle = "#fff";
  g.strokeText(word, x0 + S / 2, ty);
  g.fillStyle = pick();
  g.fillText(word, x0 + S / 2, ty);
  // drips
  g.fillStyle = pick();
  for (let i = 0; i < 9; i++) {
    const dx = x0 + r() * S;
    const len = S * (0.05 + r() * 0.15);
    g.fillRect(dx, ty + px * 0.3, S * 0.012, len);
  }
  // weathering: speckle + grime at the bottom
  g.globalAlpha = 0.08;
  g.fillStyle = "#000";
  for (let i = 0; i < 300; i++) g.fillRect(x0 + r() * S, y0 + r() * S, 2, 2);
  const grime = g.createLinearGradient(0, y0 + S * 0.8, 0, y0 + S);
  grime.addColorStop(0, "rgba(0,0,0,0)");
  grime.addColorStop(1, "rgba(0,0,0,0.6)");
  g.globalAlpha = 1;
  g.fillStyle = grime;
  g.fillRect(x0, y0 + S * 0.8, S, S * 0.2);
  g.restore();
}
