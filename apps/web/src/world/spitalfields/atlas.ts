// Canvas atlases for the Spitalfields module: shop signs (curry-house fascias, Truman's chimney lettering, the
// market and station names) and Brick Lane street art. Drawn once in code, so nothing to download.
// Each atlas hands out UV rects ([u0, v0, u1, v1], v up as three.js samples a flipped canvas).
import { CanvasTexture, SRGBColorSpace } from "three";
import { rng } from "../../mock/rng";

export type UvRect = [number, number, number, number];

interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shelf-packs rectangles into a square canvas. */
function packer(size: number) {
  let x = 0;
  let y = 0;
  let row = 0;
  return (w: number, h: number): Slot => {
    if (x + w > size) {
      x = 0;
      y += row + 2;
      row = 0;
    }
    if (y + h > size) throw new Error("spitalfields atlas full");
    const s = { x, y, w, h };
    x += w + 2;
    row = Math.max(row, h);
    return s;
  };
}

const uv = (s: Slot, size: number): UvRect => [s.x / size, 1 - (s.y + s.h) / size, (s.x + s.w) / size, 1 - s.y / size];

export interface SignStyle {
  bg: string;
  fg: string;
  sub?: string;
  font?: string;
}

/** Real Brick Lane curry houses and cafes (Banglatown), for the fascias the map doesn't name. */
export const CURRY_HOUSES = [
  "Aladin",
  "Sheba",
  "Preem & Prithi",
  "Shampan",
  "Bengal Village",
  "Monsoon",
  "Cinnamon",
  "City Spice",
  "Taj Stores",
  "Café Naz",
  "Shalimar",
  "Brick Lane Brasserie",
  "Saffron",
  "Nazrul",
  "Eastern Eye",
  "Papadoms",
  "Le Taj",
  "Bangla Town",
  "Masala House",
  "Standard Balti",
];

export const SIGN_STYLES: SignStyle[] = [
  { bg: "#7a1020", fg: "#f6d27a", sub: "Indian & Bangladeshi Cuisine" },
  { bg: "#0f4d2c", fg: "#f4e3b0", sub: "Balti House · Licensed" },
  { bg: "#151515", fg: "#ff5fa2", sub: "Curry House · Est. 1978" },
  { bg: "#3c1a5b", fg: "#f9d55a", sub: "Tandoori Restaurant" },
  { bg: "#c8201e", fg: "#ffffff", sub: "Bring Your Own" },
  { bg: "#0d2a4a", fg: "#7ef0ff", sub: "Bangladeshi Kitchen" },
  { bg: "#e8b400", fg: "#3a1300", sub: "Sweets · Grocery" },
  { bg: "#1b1b1b", fg: "#ffd28a", sub: "Award Winning Curry" },
];

export interface SignAtlas {
  texture: CanvasTexture;
  sign(name: string, style: SignStyle): UvRect;
  /** Vertical white letters on brick, top to bottom (Truman's chimney). */
  vertical: UvRect;
  market: UvRect;
  station: UvRect;
  truman: UvRect;
  bangla: UvRect;
  clock: UvRect;
}

export function signAtlas(names: { name: string; style: SignStyle }[]): SignAtlas {
  const size = 2048;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const pack = packer(size);
  const cache = new Map<string, UvRect>();

  const fascia = (name: string, st: SignStyle): UvRect => {
    const key = `${name}|${st.bg}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (cache.size >= 32) return cache.values().next().value!; // keep room for the banners below
    const s = pack(508, 112);
    g.fillStyle = st.bg;
    g.fillRect(s.x, s.y, s.w, s.h);
    g.strokeStyle = st.fg;
    g.lineWidth = 4;
    g.strokeRect(s.x + 6, s.y + 6, s.w - 12, s.h - 12);
    g.fillStyle = st.fg;
    g.textAlign = "center";
    g.textBaseline = "middle";
    let px = 58;
    g.font = `700 ${px}px Georgia, 'Times New Roman', serif`;
    while (g.measureText(name).width > s.w - 40 && px > 24) g.font = `700 ${(px -= 2)}px Georgia, serif`;
    g.fillText(name, s.x + s.w / 2, s.y + (st.sub ? 46 : 56));
    if (st.sub) {
      g.font = "500 20px 'Helvetica Neue', Arial, sans-serif";
      g.fillText(st.sub.toUpperCase(), s.x + s.w / 2, s.y + 88);
    }
    const r = uv(s, size);
    cache.set(key, r);
    return r;
  };
  for (const n of names) fascia(n.name, n.style);

  // Truman chimney: TRUMAN in white glazed brick, letters stacked
  const v = pack(96, 640);
  g.fillStyle = "#7a3b2a";
  g.fillRect(v.x, v.y, v.w, v.h);
  g.fillStyle = "#f2efe6";
  g.font = "800 88px 'Helvetica Neue', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  [..."TRUMAN"].forEach((ch, i) => g.fillText(ch, v.x + v.w / 2, v.y + 56 + i * 105));

  const banner = (text: string, bg: string, fg: string, w0: number, h: number, font: string, frame = true) => {
    const w = Math.min(w0, 1020);
    const s = pack(w, h);
    g.fillStyle = bg;
    g.fillRect(s.x, s.y, s.w, s.h);
    if (frame) {
      g.strokeStyle = fg;
      g.lineWidth = 3;
      g.strokeRect(s.x + 5, s.y + 5, s.w - 10, s.h - 10);
    }
    g.fillStyle = fg;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = font;
    g.fillText(text, s.x + s.w / 2, s.y + s.h / 2 + 2);
    return uv(s, size);
  };
  const market = banner("OLD SPITALFIELDS MARKET", "#1f3b2d", "#f1e6c8", 1024, 96, "700 64px Georgia, serif");
  const station = banner("LIVERPOOL STREET STATION", "#f3efe4", "#1b2a5a", 1024, 96, "700 60px Georgia, serif");
  const truman = banner("THE OLD TRUMAN BREWERY", "#141414", "#f2efe6", 1024, 96, "800 60px 'Helvetica Neue', Arial, sans-serif");
  const bangla = banner("BANGLA TOWN  ·  বাংলা টাউন", "#0f5a2e", "#f8d44c", 1024, 96, "700 56px Georgia, serif");
  // a clock face
  const k = pack(256, 256);
  g.fillStyle = "#f6f1e2";
  g.beginPath();
  g.arc(k.x + 128, k.y + 128, 124, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#1a1a1a";
  g.lineWidth = 8;
  g.stroke();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(k.x + 128 + Math.sin(a) * 100, k.y + 128 - Math.cos(a) * 100);
    g.lineTo(k.x + 128 + Math.sin(a) * 116, k.y + 128 - Math.cos(a) * 116);
    g.stroke();
  }
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(k.x + 128, k.y + 128);
  g.lineTo(k.x + 128 + 55, k.y + 128 - 30);
  g.moveTo(k.x + 128, k.y + 128);
  g.lineTo(k.x + 128 - 10, k.y + 128 - 90);
  g.stroke();

  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return {
    texture,
    sign: fascia,
    vertical: uv(v, size),
    market,
    station,
    truman,
    bangla,
    clock: uv(k, size),
  };
}

/** Brick Lane street art: big colourful murals, a black-and-white crane (after ROA's on Hanbury Street), tags. */
export function muralAtlas(): { texture: CanvasTexture; tiles: UvRect[] } {
  const size = 2048;
  const n = 4;
  const t = size / n;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const r = rng(1729);
  const pal = ["#ff3d7f", "#ffd23f", "#3bceac", "#0ead69", "#540d6e", "#ee4266", "#1b98e0", "#f46036", "#2e294e", "#e2c044", "#00a6a6", "#f2f2f2", "#111111"];
  const pick = () => pal[Math.floor(r() * pal.length)];
  const tiles: UvRect[] = [];
  for (let i = 0; i < n * n; i++) {
    const x = (i % n) * t;
    const y = Math.floor(i / n) * t;
    g.save();
    g.beginPath();
    g.rect(x, y, t, t);
    g.clip();
    const kind = i % 6;
    if (kind === 0) {
      // ROA-style monochrome bird on a pale wall
      g.fillStyle = "#e9e6df";
      g.fillRect(x, y, t, t);
      g.strokeStyle = "#141414";
      g.fillStyle = "#141414";
      g.lineWidth = 6;
      g.beginPath();
      g.ellipse(x + t * 0.5, y + t * 0.55, t * 0.28, t * 0.16, -0.3, 0, Math.PI * 2);
      g.stroke();
      for (let k = 0; k < 26; k++) {
        g.beginPath();
        const a = r() * Math.PI * 2;
        const rr = r() * 0.24;
        g.moveTo(x + t * (0.5 + Math.cos(a) * rr), y + t * (0.55 + Math.sin(a) * rr * 0.6));
        g.lineTo(x + t * (0.5 + Math.cos(a) * rr) + 30, y + t * (0.55 + Math.sin(a) * rr * 0.6) + 8);
        g.stroke();
      }
      g.lineWidth = 10;
      g.beginPath();
      g.moveTo(x + t * 0.3, y + t * 0.45);
      g.quadraticCurveTo(x + t * 0.2, y + t * 0.2, x + t * 0.28, y + t * 0.1);
      g.stroke();
      g.beginPath();
      g.moveTo(x + t * 0.28, y + t * 0.1);
      g.lineTo(x + t * 0.08, y + t * 0.16);
      g.stroke();
      g.beginPath();
      g.moveTo(x + t * 0.55, y + t * 0.7);
      g.lineTo(x + t * 0.5, y + t * 0.95);
      g.moveTo(x + t * 0.62, y + t * 0.7);
      g.lineTo(x + t * 0.66, y + t * 0.95);
      g.stroke();
    } else if (kind === 1) {
      // bold geometric blocks
      g.fillStyle = pick();
      g.fillRect(x, y, t, t);
      for (let k = 0; k < 9; k++) {
        g.fillStyle = pick();
        g.beginPath();
        g.moveTo(x + r() * t, y + r() * t);
        g.lineTo(x + r() * t, y + r() * t);
        g.lineTo(x + r() * t, y + r() * t);
        g.fill();
      }
    } else if (kind === 2) {
      // concentric circles / eye
      g.fillStyle = pick();
      g.fillRect(x, y, t, t);
      for (let k = 6; k > 0; k--) {
        g.fillStyle = pick();
        g.beginPath();
        g.arc(x + t * 0.5, y + t * 0.5, (k / 6) * t * 0.45, 0, Math.PI * 2);
        g.fill();
      }
    } else if (kind === 3) {
      // a big face in flat colour
      g.fillStyle = pick();
      g.fillRect(x, y, t, t);
      g.fillStyle = pick();
      g.beginPath();
      g.ellipse(x + t * 0.5, y + t * 0.5, t * 0.3, t * 0.38, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#111";
      g.beginPath();
      g.arc(x + t * 0.4, y + t * 0.42, t * 0.05, 0, Math.PI * 2);
      g.arc(x + t * 0.6, y + t * 0.42, t * 0.05, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 12;
      g.strokeStyle = "#111";
      g.beginPath();
      g.arc(x + t * 0.5, y + t * 0.55, t * 0.14, 0.2, Math.PI - 0.2);
      g.stroke();
    } else if (kind === 4) {
      // wild-style lettering
      const grad = g.createLinearGradient(x, y, x + t, y + t);
      grad.addColorStop(0, pick());
      grad.addColorStop(1, pick());
      g.fillStyle = grad;
      g.fillRect(x, y, t, t);
      g.font = `900 ${Math.floor(t * 0.32)}px Impact, 'Arial Black', sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineWidth = 14;
      g.strokeStyle = "#111";
      const word = ["E1", "BRICK", "LANE", "SHOREDITCH", "LOVE", "ART"][Math.floor(r() * 6)];
      g.save();
      g.translate(x + t / 2, y + t / 2);
      g.rotate(-0.12);
      g.strokeText(word, 0, 0, t * 0.9);
      g.fillStyle = pick();
      g.fillText(word, 0, 0, t * 0.9);
      g.restore();
    } else {
      // stripes and drips
      for (let k = 0; k < 10; k++) {
        g.fillStyle = pick();
        g.fillRect(x, y + (k * t) / 10, t, t / 10 + 1);
      }
      for (let k = 0; k < 18; k++) {
        g.fillStyle = pick();
        g.fillRect(x + r() * t, y + r() * t * 0.5, 8, r() * t * 0.5);
      }
    }
    // grime at the bottom, a few tags over everything
    const grime = g.createLinearGradient(x, y + t * 0.75, x, y + t);
    grime.addColorStop(0, "rgba(40,30,20,0)");
    grime.addColorStop(1, "rgba(40,30,20,0.35)");
    g.fillStyle = grime;
    g.fillRect(x, y, t, t);
    g.restore();
    tiles.push([x / size, 1 - (y + t) / size, (x + t) / size, 1 - y / size]);
  }
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, tiles };
}
