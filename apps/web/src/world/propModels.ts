// Merged, vertex-coloured street props (one draw call per prop kind when instanced). Ported and extended from
// hamyway-city's Streetscape/geo.ts. Local frame: y up, +z is the prop's front (the side facing the road).
import { BoxGeometry, BufferAttribute, Color, CylinderGeometry, IcosahedronGeometry, type BufferGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const tmp = new Color();

export function paint<T extends BufferGeometry>(geo: T, hex: string): T {
  tmp.set(hex);
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = tmp.r;
    arr[i * 3 + 1] = tmp.g;
    arr[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute("color", new BufferAttribute(arr, 3));
  return geo;
}

/** Merge painted parts (drops uvs so mixed primitives always merge). */
export function merge(parts: BufferGeometry[]): BufferGeometry {
  const ready = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    if (g.getAttribute("uv")) g.deleteAttribute("uv");
    return g;
  });
  const out = mergeGeometries(ready, false);
  for (const p of parts) p.dispose();
  for (const p of ready) p.dispose();
  if (!out) throw new Error("propModels: geometry merge failed");
  return out;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: string) {
  return paint(new BoxGeometry(w, h, d).translate(x, y, z), hex);
}
function cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, hex: string, seg = 8) {
  return paint(new CylinderGeometry(rt, rb, h, seg).translate(x, y, z), hex);
}
function blob(r: number, x: number, y: number, z: number, hex: string, sy = 1, detail = 0) {
  return paint(new IcosahedronGeometry(r, detail).scale(1, sy, 1).translate(x, y, z), hex);
}

/** London plane: pale mottled trunk, a couple of limbs, broad lumpy crown. Tinted per instance (crown green varies). */
export function treeGeometry() {
  return merge([
    cyl(0.2, 0.3, 3.4, 0, 1.7, 0, "#9c9078", 6),
    cyl(0.1, 0.14, 1.8, 0.5, 3.7, 0.2, "#8f8470", 5).rotateZ(-0.35),
    cyl(0.09, 0.13, 1.6, -0.45, 3.6, -0.2, "#8f8470", 5).rotateZ(0.4),
    blob(2.4, 0, 5.6, 0, "#5a8f3e", 0.85, 1),
    blob(1.8, 1.3, 5.0, 0.6, "#4f8536", 0.9),
    blob(1.7, -1.2, 5.3, -0.5, "#679b48", 0.9),
    blob(1.5, 0.2, 6.9, -0.3, "#6aa24a", 0.9),
    blob(1.3, -0.4, 5.0, 1.2, "#5d9440", 0.85),
    // tree pit grate
    box(1.3, 0.04, 1.3, 0, 0.02, 0, "#3a3d40"),
  ]);
}

/** Heritage lamp column: fluted base, slim column, lantern on top. Lantern glass is a separate mesh. */
export function lampColumnGeometry(h = 6) {
  return merge([
    cyl(0.22, 0.28, 0.7, 0, 0.35, 0, "#262b30", 8),
    cyl(0.16, 0.2, 0.25, 0, 0.82, 0, "#2f353b", 8),
    cyl(0.08, 0.12, h - 1, 0, 0.95 + (h - 1) / 2, 0, "#2f353b", 8),
    cyl(0.18, 0.12, 0.2, 0, h - 0.05, 0, "#262b30", 8), // lantern seat
    cyl(0.05, 0.32, 0.25, 0, h + 0.82, 0, "#262b30", 8), // lantern cap
    cyl(0.04, 0.04, 0.25, 0, h + 1.05, 0, "#262b30", 6),
  ]);
}
/** The lantern glass that glows at night (sits on the column above). */
export function lampGlassGeometry(h = 6) {
  return paint(new CylinderGeometry(0.26, 0.17, 0.62, 8).translate(0, h + 0.38, 0), "#fff1c9");
}

/** K6 phone box: red body with glazing bars, domed roof, crown sign panels. */
export function phoneBoxGeometry() {
  const red = "#c8201e";
  const parts: BufferGeometry[] = [
    box(1.0, 0.12, 1.0, 0, 0.06, 0, "#7d1414"), // plinth
    box(0.94, 2.3, 0.94, 0, 1.27, 0, "#3c2a2a"), // dark interior seen through the glass
    box(0.98, 0.18, 0.98, 0, 2.48, 0, red), // sign band
    box(1.02, 0.08, 1.02, 0, 2.62, 0, red),
    paint(new CylinderGeometry(0.4, 0.55, 0.16, 4, 1).rotateY(Math.PI / 4).translate(0, 2.74, 0), red), // roof dome
  ];
  // corner posts
  for (const sx of [-0.45, 0.45]) for (const sz of [-0.45, 0.45]) parts.push(box(0.1, 2.36, 0.1, sx, 1.3, sz, red));
  // glazing bars: three horizontal rails per side and a middle frame, plus a white "TELEPHONE" panel each side
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    const along = (w: number, h: number, y: number) => (nx === 0 ? box(w, h, 0.05, 0, y, nz * 0.47, red) : box(0.05, h, w, nx * 0.47, y, 0, red));
    for (const y of [0.25, 0.75, 1.15, 1.55, 1.95, 2.3]) parts.push(along(0.9, 0.07, y));
    parts.push(nx === 0 ? box(0.08, 2.1, 0.05, 0, 1.25, nz * 0.47, red) : box(0.05, 2.1, 0.08, nx * 0.47, 1.25, 0, red));
    parts.push(nx === 0 ? box(0.6, 0.1, 0.03, 0, 2.48, nz * 0.5, "#f2efe2") : box(0.03, 0.1, 0.6, nx * 0.5, 2.48, 0, "#f2efe2"));
  }
  return merge(parts);
}

/** Royal Mail pillar box: red column, black base, domed cap, posting slot. */
export function pillarBoxGeometry() {
  return merge([
    cyl(0.3, 0.32, 0.12, 0, 0.06, 0, "#151515", 12),
    cyl(0.27, 0.27, 1.22, 0, 0.73, 0, "#c8201e", 12),
    cyl(0.3, 0.3, 0.08, 0, 1.36, 0, "#b01a19", 12),
    blob(0.28, 0, 1.4, 0, "#c8201e", 0.45, 1),
    box(0.22, 0.04, 0.05, 0, 1.18, 0.27, "#111111"),
    box(0.16, 0.12, 0.02, 0, 0.98, 0.275, "#f2efe2"),
  ]);
}

/** Litter bin: dark green drum with a gold band. */
export function binGeometry() {
  return merge([cyl(0.3, 0.27, 0.95, 0, 0.48, 0, "#2d3e2f", 10), cyl(0.33, 0.33, 0.1, 0, 0.98, 0, "#c9a227", 10), cyl(0.31, 0.31, 0.05, 0, 0.7, 0, "#c9a227", 10)]);
}

/** Park/pavement bench facing +z: timber slats on black cast-iron ends. */
export function benchGeometry() {
  const parts: BufferGeometry[] = [];
  for (const x of [-0.75, 0.75]) {
    parts.push(box(0.07, 0.45, 0.5, x, 0.23, 0, "#1d1f22"));
    parts.push(box(0.07, 0.5, 0.07, x, 0.7, -0.24, "#1d1f22"));
  }
  for (const z of [-0.15, 0, 0.15]) parts.push(box(1.7, 0.04, 0.12, 0, 0.46, z, "#8a5a32"));
  for (const y of [0.62, 0.78]) parts.push(box(1.7, 0.1, 0.03, 0, y, -0.25, "#8a5a32"));
  return merge(parts);
}

/** TfL bus shelter facing +z (the road): steel frame, glass back and side panels, roof, roundel flag, bench. */
export function busShelterGeometry() {
  const steel = "#4b5560";
  const parts: BufferGeometry[] = [
    box(3.6, 0.08, 1.5, 0, 2.5, 0, steel), // roof
    box(3.5, 2.2, 0.04, 0, 1.3, -0.65, "#a9c1cf"), // back glass (light tint so it reads)
    box(0.04, 2.0, 1.1, -1.75, 1.3, -0.1, "#a9c1cf"), // end glass
    box(1.4, 0.06, 0.3, 0.6, 0.55, -0.48, "#2f3439"), // perch seat
    box(0.12, 0.85, 0.24, -1.75, 2.0, 0.65, "#c8201e"), // roundel flag post
    box(0.04, 0.38, 0.38, -1.75, 2.85, 0.65, "#c8201e"),
    box(0.05, 0.12, 0.5, -1.75, 2.85, 0.65, "#1d3fb8"),
    box(1.1, 1.6, 0.06, 1.2, 1.3, -0.6, "#e9e4d6"), // ad panel
  ];
  for (const x of [-1.75, 1.75]) for (const z of [-0.65, 0.6]) parts.push(box(0.08, 2.5, 0.08, x, 1.25, z, steel));
  return merge(parts);
}

/** Black bollard with a white band. */
export function bollardGeometry() {
  return merge([cyl(0.1, 0.12, 0.95, 0, 0.48, 0, "#1d1f22", 6), cyl(0.105, 0.105, 0.08, 0, 0.82, 0, "#e9e4d6", 6)]);
}
