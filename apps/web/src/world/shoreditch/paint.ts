// Canvas textures for the area: the Goodsyard developer's printed hoarding (one 16 m panel that repeats) and an
// atlas of four Shoreditch street-art walls (rows, each 4:1), painted procedurally: wildstyle letters with outlines,
// highlights and drips, big character faces, paste-ups, throw-ups and tags. Deterministic (seeded).
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import { rng } from "../../mock/rng";

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
}

function texture(c: HTMLCanvasElement) {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function hoardingTexture() {
  const [c, g] = canvas(1024, 192);
  const W = 1024;
  const H = 192;
  g.fillStyle = "#17362b";
  g.fillRect(0, 0, W, H);
  // a skyline-ish illustration band of the future scheme in pale lines
  g.strokeStyle = "rgba(220,235,225,0.35)";
  g.lineWidth = 2;
  const r = rng(77);
  let x = 380;
  while (x < W - 20) {
    const w = 30 + r() * 60;
    const h = 40 + r() * 110;
    g.strokeRect(x, H - 18 - h, w, h);
    for (let y = H - 18 - h + 8; y < H - 24; y += 10) {
      g.beginPath();
      g.moveTo(x + 4, y);
      g.lineTo(x + w - 4, y);
      g.stroke();
    }
    x += w + 6;
  }
  // brand block
  g.fillStyle = "#e9efe8";
  g.font = "800 58px 'Helvetica Neue', Arial, sans-serif";
  g.textBaseline = "alphabetic";
  g.fillText("THE GOODSYARD", 26, 82);
  g.font = "500 22px 'Helvetica Neue', Arial, sans-serif";
  g.fillStyle = "#b9d3c4";
  g.fillText("Homes, offices, shops and a new park for Shoreditch", 28, 118);
  g.fillStyle = "#f2c230";
  g.fillRect(28, 136, 60, 6);
  g.font = "600 18px 'Helvetica Neue', Arial, sans-serif";
  g.fillStyle = "#e9efe8";
  g.fillText("Considerate Constructors · Site entrance on Braithwaite St", 28, 170);
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.fillRect(0, H - 10, W, 10);
  return texture(c);
}

const SPRAY = ["#ff3b6b", "#ffd23a", "#2fd0ff", "#7cff6b", "#ff8a1f", "#b06bff", "#ffffff", "#ff4fd8", "#25e0b4"];

function drips(g: CanvasRenderingContext2D, x: number, y: number, w: number, color: string, r: () => number) {
  g.fillStyle = color;
  for (let i = 0; i < 6; i++) {
    const dx = x + r() * w;
    const len = 8 + r() * 40;
    g.fillRect(dx, y, 3, len);
    g.beginPath();
    g.arc(dx + 1.5, y + len, 3, 0, Math.PI * 2);
    g.fill();
  }
}

function wildLetters(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, r: () => number) {
  const fill = SPRAY[Math.floor(r() * SPRAY.length)];
  const fill2 = SPRAY[Math.floor(r() * SPRAY.length)];
  g.save();
  g.translate(x, y);
  g.rotate((r() - 0.5) * 0.12);
  g.font = `900 ${size}px 'Arial Black', 'Helvetica Neue', Arial, sans-serif`;
  g.textBaseline = "middle";
  g.lineJoin = "round";
  // 3D drop
  g.fillStyle = "#111";
  for (let i = 8; i > 0; i--) g.fillText(text, i, i);
  // outline
  g.strokeStyle = "#111";
  g.lineWidth = size * 0.16;
  g.strokeText(text, 0, 0);
  g.strokeStyle = "#fff";
  g.lineWidth = size * 0.07;
  g.strokeText(text, 0, 0);
  const grad = g.createLinearGradient(0, -size / 2, 0, size / 2);
  grad.addColorStop(0, fill);
  grad.addColorStop(1, fill2);
  g.fillStyle = grad;
  g.fillText(text, 0, 0);
  // highlights
  g.fillStyle = "rgba(255,255,255,0.7)";
  const w = g.measureText(text).width;
  for (let i = 0; i < 5; i++) g.fillRect(r() * w, -size * 0.3 + r() * size * 0.2, 6 + r() * 12, 3);
  g.restore();
  drips(g, x, y + size * 0.4, g.measureText(text).width, fill2, r);
}

function face(g: CanvasRenderingContext2D, x: number, y: number, s: number, r: () => number) {
  const skin = SPRAY[Math.floor(r() * SPRAY.length)];
  g.fillStyle = "#111";
  g.beginPath();
  g.ellipse(x, y, s * 0.55, s * 0.62, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = skin;
  g.beginPath();
  g.ellipse(x, y, s * 0.5, s * 0.57, 0, 0, Math.PI * 2);
  g.fill();
  // eyes
  for (const ex of [-1, 1]) {
    g.fillStyle = "#fff";
    g.beginPath();
    g.ellipse(x + ex * s * 0.18, y - s * 0.1, s * 0.13, s * 0.17, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#111";
    g.beginPath();
    g.arc(x + ex * s * 0.18 + s * 0.03, y - s * 0.07, s * 0.06, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "#111";
  g.lineWidth = s * 0.05;
  g.beginPath();
  g.arc(x, y + s * 0.15, s * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
}

function tags(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, r: () => number) {
  g.lineWidth = 3;
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = r() < 0.5 ? "#111" : SPRAY[Math.floor(r() * SPRAY.length)];
    let x = x0 + r() * w;
    let y = y0 + r() * h;
    g.beginPath();
    g.moveTo(x, y);
    for (let j = 0; j < 9; j++) {
      x += 6 + r() * 10;
      y += (r() - 0.5) * 22;
      g.quadraticCurveTo(x - 4, y - 12 * (r() - 0.5), x, y);
    }
    g.stroke();
  }
}

function pasteUps(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, r: () => number) {
  for (let i = 0; i < 10; i++) {
    const pw = 30 + r() * 60;
    const ph = 40 + r() * 60;
    const x = x0 + r() * (w - pw);
    const y = y0 + r() * (h - ph);
    g.fillStyle = ["#f4efe2", "#ffe14d", "#ff6b9a", "#cfd8dc", "#222"][Math.floor(r() * 5)];
    g.fillRect(x, y, pw, ph);
    g.fillStyle = "#111";
    for (let k = 0; k < 4; k++) g.fillRect(x + 5, y + 8 + k * (ph / 5), pw * (0.4 + r() * 0.5), 3);
  }
}

/** 1024×1024 atlas: four 1024×256 walls stacked (row 0 at the top = v 0.75..1). */
export function muralTexture() {
  const [c, g] = canvas(1024, 1024);
  const r = rng(4242);
  const walls = ["#7b5b4c", "#4a4d52", "#2b2b30", "#8a7f74"];
  const words = [["SHOREDITCH", "E1"], ["EAST LDN", "★"], ["LOVE", "HATE"], ["E2", "SHOW"]];
  for (let row = 0; row < 4; row++) {
    const y0 = row * 256;
    g.fillStyle = walls[row];
    g.fillRect(0, y0, 1024, 256);
    // older layers: faded rollered blocks
    for (let i = 0; i < 8; i++) {
      g.fillStyle = `${SPRAY[Math.floor(r() * SPRAY.length)]}55`;
      g.fillRect(r() * 1024, y0 + r() * 200, 80 + r() * 200, 30 + r() * 120);
    }
    g.save();
    g.beginPath();
    g.rect(0, y0, 1024, 256);
    g.clip();
    if (row === 1) {
      // a character wall: big faces and a word
      face(g, 180, y0 + 128, 190, r);
      face(g, 840, y0 + 120, 170, r);
      wildLetters(g, words[row][0], 330, y0 + 120, 92, r);
    } else if (row === 3) {
      // paste-ups and tags over a throw-up (the hoarding along Shoreditch High Street)
      wildLetters(g, words[row][1], 40, y0 + 130, 150, r);
      wildLetters(g, words[row][0], 560, y0 + 120, 130, r);
      pasteUps(g, 0, y0 + 10, 1024, 236, r);
    } else {
      wildLetters(g, words[row][0], 40, y0 + 120, row === 0 ? 120 : 140, r);
      face(g, 900, y0 + 128, 160, r);
      if (row === 2) wildLetters(g, words[row][1], 520, y0 + 150, 110, r);
    }
    tags(g, 0, y0 + 160, 1024, 90, r);
    g.restore();
  }
  return texture(c);
}
