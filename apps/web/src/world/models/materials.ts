// Shared materials for hero models (one per slot, all vertex-coloured), canvas textures for signs and murals,
// and `heroObject` which turns a HeroModel into a ready-to-add THREE.Group (nodes become named child meshes so
// wheels can spin, doors slide and lamps flash). Instancing consumers use model.parts directly with these
// same materials. Night: call setHeroNight(0..1) once a frame (or when the hour changes).
import {
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Material,
} from "three";
import type { HeroModel, SignSpec, Slot } from "./kit";

let mats: Record<Slot, MeshStandardMaterial> | null = null;

function brickTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  // 1 tile = 1 m: 13 courses (75 mm) tall, 4.5 bricks (225 mm) wide. Greyscale, tinted by vertex colour.
  g.fillStyle = "#8a8a8a";
  g.fillRect(0, 0, 256, 256);
  const rows = 13;
  const rh = 256 / rows;
  const bw = 256 / 4.5;
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < rows + 1; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let x = -bw; x < 256 + bw; x += bw) {
      const v = 200 + Math.floor((rand() - 0.5) * 70);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x + off + 1.5, r * rh + 1.5, bw - 3, rh - 3);
    }
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function heroMaterials(): Record<Slot, MeshStandardMaterial> {
  if (mats) return mats;
  const base = { vertexColors: true, color: "#ffffff" } as const;
  mats = {
    solid: new MeshStandardMaterial({ ...base, roughness: 0.82, metalness: 0 }),
    paint: new MeshStandardMaterial({ ...base, roughness: 0.32, metalness: 0.15 }),
    metal: new MeshStandardMaterial({ ...base, roughness: 0.28, metalness: 0.85 }),
    glass: new MeshStandardMaterial({ ...base, roughness: 0.08, metalness: 0.4, emissive: new Color("#ffcf8a"), emissiveIntensity: 0 }),
    glow: new MeshStandardMaterial({ ...base, roughness: 0.5, emissive: new Color("#ffffff"), emissiveIntensity: 1.6 }),
    brick: new MeshStandardMaterial({ ...base, roughness: 0.95, map: typeof document !== "undefined" ? brickTexture() : null }),
  };
  // glow: emissive takes the vertex colour, not white
  mats.glow.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vColor.rgb;",
    );
  };
  mats.glow.customProgramCacheKey = () => "hero-glow";
  mats.glass.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      // lit windows: brighter glass colours glow more, so dark tinted glass stays dark
      "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 0.25 + 2.5 * max(vColor.r, max(vColor.g, vColor.b));",
    );
  };
  mats.glass.customProgramCacheKey = () => "hero-glass";
  return mats;
}

/** 0 = day, 1 = deep night: windows light up, signs get punchier. */
export function setHeroNight(level: number) {
  const m = heroMaterials();
  m.glass.emissiveIntensity = 0.55 * level;
  m.glow.emissiveIntensity = 1.1 + 1.4 * level;
}

const signTex = new Map<string, CanvasTexture>();
const signMat = new Map<string, Material>();

export function signMaterial(s: SignSpec): Material {
  const hit = signMat.get(s.key);
  if (hit) return hit;
  let t = signTex.get(s.key);
  if (!t) {
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;
    const g = c.getContext("2d");
    if (g) s.draw(g, s.w, s.h);
    t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    signTex.set(s.key, t);
  }
  const m = s.glow
    ? new MeshBasicMaterial({ map: t, toneMapped: false, side: DoubleSide, alphaTest: 0.3, polygonOffset: true, polygonOffsetFactor: -2 })
    : new MeshStandardMaterial({ map: t, roughness: 0.7, alphaTest: 0.3, polygonOffset: true, polygonOffsetFactor: -2 });
  signMat.set(s.key, m);
  return m;
}

/** A THREE.Group for one hero model. Nodes are child meshes named after the node (group.getObjectByName). */
export function heroObject(model: HeroModel, opts: { shadows?: boolean } = {}): Group {
  const m = heroMaterials();
  const shadows = opts.shadows ?? true;
  const root = new Group();
  root.name = model.name;
  const addParts = (parent: Group, parts: HeroModel["parts"]) => {
    for (const [slot, geo] of Object.entries(parts)) {
      if (!geo) continue;
      const mesh = new Mesh(geo, m[slot as Slot]);
      mesh.name = `${parent.name}:${slot}`;
      mesh.castShadow = shadows && slot !== "glow" && slot !== "glass";
      mesh.receiveShadow = shadows;
      parent.add(mesh);
    }
  };
  addParts(root, model.parts);
  for (const n of model.nodes) {
    const g = new Group();
    g.name = n.name;
    g.position.set(n.pivot[0], n.pivot[1], n.pivot[2]);
    addParts(g, n.parts);
    root.add(g);
  }
  for (const s of model.signs) {
    const mesh = new Mesh(s.geo, signMaterial(s));
    mesh.name = `sign:${s.key}`;
    root.add(mesh);
  }
  return root;
}

// ---------- canvas helpers shared by sign painters ----------

export function fitText(c: CanvasRenderingContext2D, text: string, maxW: number, px: number, font = "800 {px}px 'Helvetica Neue', Arial, sans-serif") {
  let size = px;
  c.font = font.replace("{px}", String(size));
  while (c.measureText(text).width > maxW && size > 8) {
    size -= 2;
    c.font = font.replace("{px}", String(size));
  }
  return size;
}

/** Centred text that shrinks to fit. */
export function label(c: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, px: number, color: string, font?: string) {
  fitText(c, text, maxW, px, font);
  c.fillStyle = color;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(text, x, y);
}

/** TfL roundel: red (or other) ring with a blue bar and white text. */
export function drawRoundel(c: CanvasRenderingContext2D, w: number, h: number, text: string, ring = "#dc241f", bar = "#0019a8") {
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w * 0.36, h * 0.48);
  c.lineWidth = R * 0.36;
  c.strokeStyle = ring;
  c.beginPath();
  c.arc(cx, cy, R * 0.82, 0, Math.PI * 2);
  c.stroke();
  const bh = R * 0.42;
  c.fillStyle = bar;
  c.fillRect(cx - R * 1.32, cy - bh / 2, R * 2.64, bh);
  label(c, text, cx, cy + 1, R * 2.4, bh * 0.78, "#ffffff", "700 {px}px 'Johnston', 'Gill Sans', 'Helvetica Neue', Arial, sans-serif");
}
