// Real ground height under a scene point, for modules that place things on the street (people, cars, glow pools).
// Stylised mode: always 0 (the flat slab). Photoreal mode: the Photoreal module raycasts the Google 3D Tiles road
// surface at street samples and writes them here; lookups read the nearest known cell (O(1), no allocation), so
// per-instance calls every frame are fine. Unknown areas fall back to 0 (= the street level at the station).

const CELL = 6; // m
const SEARCH = 3; // cells: how far a lookup looks for a known neighbour (stores sit back from the street)

let grid: Float32Array | null = null;
let x0 = 0;
let z0 = 0;
let nx = 0;
let nz = 0;

/** Height (m) of the real ground at scene (x, z), relative to street level at the station. */
export function groundY(x: number, z: number): number {
  if (!grid) return 0;
  const cx = Math.floor((x - x0) / CELL);
  const cz = Math.floor((z - z0) / CELL);
  if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) return 0;
  const v = grid[cz * nx + cx];
  if (v === v) return v; // not NaN
  for (let r = 1; r <= SEARCH; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const ix = cx + dx;
        const iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
        const w = grid[iz * nx + ix];
        if (w === w) return w;
      }
    }
  }
  return 0;
}

/** Writer side, used by the Photoreal module only. */
export const groundField = {
  /** Start an empty field covering the scene rectangle [minX, maxX] × [minZ, maxZ]. */
  reset(minX: number, maxX: number, minZ: number, maxZ: number) {
    x0 = minX;
    z0 = minZ;
    nx = Math.max(1, Math.ceil((maxX - minX) / CELL));
    nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
    grid = new Float32Array(nx * nz).fill(NaN);
  },
  set(x: number, z: number, h: number) {
    if (!grid) return;
    const cx = Math.floor((x - x0) / CELL);
    const cz = Math.floor((z - z0) / CELL);
    if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) return;
    // latest sample wins: tiles refine as they stream in, so newer hits are better (kerb-height noise is ~0.15 m)
    grid[cz * nx + cx] = h;
  },
  /** Back to the flat world (stylised mode). */
  clear() {
    grid = null;
  },
};
