// Free, keyless map tiles stitched once into one canvas texture covering the map (+ a margin), aligned to the
// contract frame (origin = Shoreditch High St station, x east, z north, equirectangular metres: see photoreal/frame.ts).
// Web Mercator tile maths; over ~1–2 km the Mercator stretch varies by < 0.05 %, so a linear UV map onto a plane whose
// corners are the mosaic's exact corner lat/lons is accurate to well under a metre.
import type { Bounds } from "../../api/contract";
import { EARTH_RADIUS, ORIGIN_LAT, ORIGIN_LON } from "../photoreal/frame";

export type TileSource = "satellite" | "light" | "dark";

const URLS: Record<TileSource, (z: number, x: number, y: number) => string> = {
  satellite: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  light: (z, x, y) => `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
  dark: (z, x, y) => `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
};

export const ATTRIBUTION: Record<TileSource, string> = {
  satellite: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  light: "© OpenStreetMap contributors © CARTO",
  dark: "© OpenStreetMap contributors © CARTO",
};

const TILE = 256;
const MAX_PX = 4096; // one texture, safe on every GPU
const MAX_ZOOM = 18;
const MIN_ZOOM = 15;
/** Imagery reaches this far past the sim bounds (the Infill ring and the camera's usual view). */
export const MARGIN = 260;

const D = Math.PI / 180;
const cosLat0 = Math.cos(ORIGIN_LAT * D);

export function toLatLon(x: number, z: number): [number, number] {
  return [ORIGIN_LAT + z / EARTH_RADIUS / D, ORIGIN_LON + x / (EARTH_RADIUS * cosLat0) / D];
}
export function toXZ(lat: number, lon: number): [number, number] {
  return [(lon - ORIGIN_LON) * D * EARTH_RADIUS * cosLat0, (lat - ORIGIN_LAT) * D * EARTH_RADIUS];
}
const tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat: number, z: number) => ((1 - Math.log(Math.tan(lat * D) + 1 / Math.cos(lat * D)) / Math.PI) / 2) * 2 ** z;
const lonOf = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latOf = (y: number, z: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)))  / D;

export interface Mosaic {
  canvas: HTMLCanvasElement;
  /** Contract-frame rectangle the canvas covers (x east, z north). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  zoom: number;
  tiles: number;
}

/** Tile range covering bounds + margin at the highest zoom that fits one MAX_PX texture. */
export function plan(bounds: Bounds) {
  const [south, west] = toLatLon(bounds.minX - MARGIN, bounds.minZ - MARGIN);
  const [north, east] = toLatLon(bounds.maxX + MARGIN, bounds.maxZ + MARGIN);
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom--) {
    const x0 = Math.floor(tileX(west, zoom));
    const x1 = Math.floor(tileX(east, zoom));
    const y0 = Math.floor(tileY(north, zoom));
    const y1 = Math.floor(tileY(south, zoom));
    const nx = x1 - x0 + 1;
    const ny = y1 - y0 + 1;
    if ((nx * TILE <= MAX_PX && ny * TILE <= MAX_PX) || zoom === MIN_ZOOM) return { zoom, x0, y0, nx, ny };
  }
  throw new Error("unreachable");
}

function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const abort = () => {
      img.src = "";
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile failed: ${url}`));
    img.src = url;
  });
}

/** Fetch (browser-cached) and stitch the mosaic. Rejects on any tile failure, so the caller can fall back. */
export async function buildMosaic(source: TileSource, bounds: Bounds, signal: AbortSignal): Promise<Mosaic> {
  const { zoom, x0, y0, nx, ny } = plan(bounds);
  const canvas = document.createElement("canvas");
  canvas.width = nx * TILE;
  canvas.height = ny * TILE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const jobs: (() => Promise<void>)[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      jobs.push(async () => {
        const url = URLS[source](zoom, x0 + i, y0 + j);
        let img: HTMLImageElement;
        try {
          img = await loadImage(url, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          img = await loadImage(url, signal); // one retry, then give up
        }
        ctx.drawImage(img, i * TILE, j * TILE);
      });
  // a few at a time: polite to free tile servers
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const [minX, minZ] = toXZ(latOf(y0 + ny, zoom), lonOf(x0, zoom));
  const [maxX, maxZ] = toXZ(latOf(y0, zoom), lonOf(x0 + nx, zoom));
  return { canvas, minX, maxX, minZ, maxZ, zoom, tiles: nx * ny };
}
