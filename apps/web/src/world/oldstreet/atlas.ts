// One canvas atlas for every lit sign in the Old Street area (roundels, fascia lettering, shop signs, bus flags)
// so they all draw in a single call, plus the animated digital advertising screens (a second atlas redrawn
// when the ads rotate).
import { BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { drawRoundel, fitText, label } from "../models/materials";

type Draw = (c: CanvasRenderingContext2D, w: number, h: number) => void;
interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Shelf-packed canvas atlas; quads are merged into one mesh. */
export class Atlas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private x = 0;
  private y = 0;
  private row = 0;
  private cells = new Map<string, Cell>();
  private quads: BufferGeometry[] = [];

  constructor(readonly size = 2048) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Reserve and paint a cell (once per key). */
  cell(key: string, pw: number, ph: number, draw: Draw): Cell {
    const hit = this.cells.get(key);
    if (hit) return hit;
    if (this.x + pw > this.size) {
      this.x = 0;
      this.y += this.row + 2;
      this.row = 0;
    }
    const c = this.ctx;
    c.save();
    c.translate(this.x, this.y);
    c.beginPath();
    c.rect(0, 0, pw, ph);
    c.clip();
    draw(c, pw, ph);
    c.restore();
    const S = this.size;
    // half-texel inset against bleeding
    const cell = { u0: (this.x + 0.5) / S, u1: (this.x + pw - 0.5) / S, v0: 1 - (this.y + ph - 0.5) / S, v1: 1 - (this.y + 0.5) / S };
    this.x += pw + 2;
    this.row = Math.max(this.row, ph);
    this.cells.set(key, cell);
    return cell;
  }

  /** A w × h quad facing +z in the frame `m`, showing `cell`. */
  quad(cell: Cell, w: number, h: number, m: Matrix4) {
    const g = new PlaneGeometry(w, h);
    const uv = g.getAttribute("uv") as BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? cell.u1 : cell.u0, uv.getY(i) ? cell.v1 : cell.v0);
    g.applyMatrix4(m);
    this.quads.push(g);
  }

  mesh(name: string): Mesh | null {
    if (!this.quads.length) return null;
    const geo = mergeGeometries(this.quads, false)!;
    this.quads.forEach((q) => q.dispose());
    this.quads = [];
    const tex = new CanvasTexture(this.canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new MeshBasicMaterial({ map: tex, toneMapped: false, side: DoubleSide, alphaTest: 0.35, polygonOffset: true, polygonOffsetFactor: -2 });
    const mesh = new Mesh(geo, mat);
    mesh.name = name;
    return mesh;
  }
}

const JOHNSTON = "600 {px}px 'Johnston', 'Gill Sans', 'Helvetica Neue', Arial, sans-serif";

export const SIGNS = {
  roundel: (name: string): [string, number, number, Draw] => [`roundel:${name}`, 256, 256, (c, w, h) => drawRoundel(c, w, h, name.toUpperCase())],
  underground: (): [string, number, number, Draw] => [
    "underground",
    256,
    256,
    (c, w, h) => {
      drawRoundel(c, w, h, "UNDERGROUND");
    },
  ],
  /** Dark fascia band with white Johnston lettering and a roundel. */
  fascia: (text: string, pw = 1024, ph = 96, bg = "#26282b"): [string, number, number, Draw] => [
    `fascia:${text}:${pw}`,
    pw,
    ph,
    (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      const r = h * 0.3;
      c.lineWidth = r * 0.42;
      c.strokeStyle = "#dc241f";
      c.beginPath();
      c.arc(h * 0.75, h / 2, r, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "#0019a8";
      c.fillRect(h * 0.75 - r * 1.45, h / 2 - r * 0.28, r * 2.9, r * 0.56);
      label(c, text, w / 2 + h * 0.6, h / 2 + 2, w - h * 2, h * 0.56, "#ffffff", JOHNSTON);
    },
  ],
  /** White letters on transparent (for lettering cut into a canopy fascia). */
  letters: (text: string, pw = 1024, ph = 128, color = "#ffffff"): [string, number, number, Draw] => [
    `letters:${text}:${color}`,
    pw,
    ph,
    (c, w, h) => {
      c.clearRect(0, 0, w, h);
      label(c, text, w / 2, h / 2 + 2, w - 12, h * 0.78, color, JOHNSTON);
    },
  ],
  shop: (name: string, bg: string, fg = "#ffffff"): [string, number, number, Draw] => [
    `shop:${name}`,
    512,
    96,
    (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      label(c, name, w / 2, h / 2 + 2, w - 30, h * 0.6, fg, "700 {px}px 'Helvetica Neue', Arial, sans-serif");
    },
  ],
  busFlag: (ref: string): [string, number, number, Draw] => [
    `busflag:${ref}`,
    128,
    192,
    (c, w, h) => {
      c.fillStyle = "#f6f6f2";
      c.fillRect(0, 0, w, h);
      drawRoundel(c, w, w, "", "#dc241f", "#dc241f");
      c.fillStyle = "#dc241f";
      c.fillRect(0, w, w, h - w);
      label(c, ref, w / 2, w + (h - w) / 2 + 2, w - 20, (h - w) * 0.8, "#ffffff", "700 {px}px 'Helvetica Neue', Arial, sans-serif");
    },
  ],
  /** Light pool: soft radial gradient (white, tinted by the material). */
  pool: (): [string, number, number, Draw] => [
    "pool",
    128,
    128,
    (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.5, "rgba(255,255,255,0.45)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    },
  ],
};

// ---------------------------------------------------------------------------------------------------------
// Digital advertising screens: a 1024² atlas of up to 8 faces (1024 × 256 px each, 4:1 → for 16 × 4 m faces
// we use 2:1 halves). Each face shows one of a rotation of ads, swapped every few seconds.

const ADS: ((c: CanvasRenderingContext2D, w: number, h: number, t: number) => void)[] = [
  (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#1b1f6b");
    g.addColorStop(1, "#7b2ff7");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#ffd23f";
    c.beginPath();
    c.arc(w * 0.8, h * 0.5, h * 0.36, 0, Math.PI * 2);
    c.fill();
    label(c, "SHIP IT FASTER", w * 0.38, h * 0.42, w * 0.66, h * 0.26, "#ffffff");
    label(c, "Cloud for builders · EC1", w * 0.38, h * 0.7, w * 0.6, h * 0.12, "#d9d2ff", "500 {px}px 'Helvetica Neue', Arial, sans-serif");
  },
  (c, w, h) => {
    c.fillStyle = "#f4efe6";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#e4572e";
    c.fillRect(0, 0, w * 0.34, h);
    label(c, "NEW", w * 0.17, h * 0.5, w * 0.28, h * 0.3, "#ffffff");
    label(c, "Flat white. Fast wifi.", w * 0.67, h * 0.4, w * 0.6, h * 0.17, "#1a1a1a");
    label(c, "Open from 6am", w * 0.67, h * 0.66, w * 0.5, h * 0.11, "#555555", "500 {px}px 'Helvetica Neue', Arial, sans-serif");
  },
  (c, w, h) => {
    c.fillStyle = "#00c2a8";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 9; i++) {
      c.fillStyle = `rgba(255,255,255,${0.08 + (i % 3) * 0.05})`;
      c.fillRect(i * w * 0.12, 0, w * 0.05, h);
    }
    label(c, "TECH CITY WEEK", w / 2, h * 0.42, w * 0.86, h * 0.28, "#0b2e2a");
    label(c, "Talks · Demos · Hiring", w / 2, h * 0.72, w * 0.6, h * 0.12, "#0b2e2a", "600 {px}px 'Helvetica Neue', Arial, sans-serif");
  },
  (c, w, h) => {
    c.fillStyle = "#0d0d0f";
    c.fillRect(0, 0, w, h);
    const g = c.createRadialGradient(w * 0.25, h * 0.5, 4, w * 0.25, h * 0.5, h * 0.6);
    g.addColorStop(0, "#ff4f8b");
    g.addColorStop(1, "rgba(255,79,139,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    label(c, "LIVE TONIGHT", w * 0.62, h * 0.4, w * 0.6, h * 0.22, "#ffffff");
    label(c, "Hoxton · doors 22:00", w * 0.62, h * 0.68, w * 0.5, h * 0.12, "#ff9cc0", "500 {px}px 'Helvetica Neue', Arial, sans-serif");
  },
  (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#2f5bea");
    g.addColorStop(1, "#18e0d0");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "rgba(255,255,255,0.95)";
    c.fillRect(w * 0.06, h * 0.22, h * 0.56, h * 0.56);
    label(c, "Your next hire is here", w * 0.6, h * 0.42, w * 0.66, h * 0.16, "#ffffff");
    label(c, "Silicon Roundabout · since 2008", w * 0.6, h * 0.66, w * 0.6, h * 0.1, "#e8fbff", "500 {px}px 'Helvetica Neue', Arial, sans-serif");
  },
  (c, w, h) => {
    c.fillStyle = "#ffd23f";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#111111";
    fitText(c, "MIND THE GAP YEAR", w * 0.84, h * 0.3);
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("MIND THE GAP YEAR", w / 2, h * 0.45);
    label(c, "Travel more. Work anywhere.", w / 2, h * 0.75, w * 0.6, h * 0.11, "#333333", "500 {px}px 'Helvetica Neue', Arial, sans-serif");
  },
];

export class Screens {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private shown: number[] = [];
  constructor(readonly faces: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1024;
    this.canvas.height = 128 * Math.max(4, faces * 2);
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;
  }
  /** UV rect (v0, v1) of face i (1024 × 256 px band). */
  band(i: number): [number, number] {
    const H = this.canvas.height;
    return [1 - ((i + 1) * 256 - 1) / H, 1 - (i * 256 + 1) / H];
  }
  /** Re-paint faces whose ad changed (slot = floor(time / period)). */
  update(time: number) {
    let dirty = false;
    for (let i = 0; i < this.faces; i++) {
      const slot = Math.floor(time / 9 + i * 0.37);
      const ad = (slot * 7 + i * 3) % ADS.length;
      if (this.shown[i] === ad) continue;
      this.shown[i] = ad;
      const c = this.ctx;
      c.save();
      c.translate(0, i * 256);
      c.beginPath();
      c.rect(0, 0, 1024, 256);
      c.clip();
      ADS[ad](c, 1024, 256, time);
      c.restore();
      dirty = true;
    }
    if (dirty) this.texture.needsUpdate = true;
  }
  material() {
    return new MeshBasicMaterial({ map: this.texture, toneMapped: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  }
}

/** A quad for screen face i (uv band), in frame m. */
export function screenQuad(s: Screens, i: number, w: number, h: number, m: Matrix4): BufferGeometry {
  const g = new PlaneGeometry(w, h);
  const [v0, v1] = s.band(i);
  const uv = g.getAttribute("uv") as BufferAttribute;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k), uv.getY(k) ? v1 : v0);
  g.applyMatrix4(m);
  return g;
}
