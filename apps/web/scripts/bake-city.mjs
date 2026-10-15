#!/usr/bin/env node
// Bakes the real Shoreditch into compact JSON for the 3D city (apps/web/public/city/*.json).
//
//   node apps/web/scripts/bake-city.mjs            (uses cached downloads in data/raw/ when present)
//   node apps/web/scripts/bake-city.mjs --refresh  (re-download from Overpass / Esri)
//
// Sources (free, keyless, fetched once and cached in data/raw/, which git ignores):
//  - OpenStreetMap via the Overpass API: two queries. Inner = the sim map bounds + 300 m, everything (building
//    footprints and parts, roads, crossings, rail, land use, trees). Outer = bounds + OUTER m, only buildings, roads,
//    rail and green/water areas, so the horizon is real London instead of a generated grid.
//  - Esri World Imagery tiles, only as a *colour source*: each roof's median colour (zoom 18 inside, 16 outside) and
//    the median ground tint of parks, grass and plazas. No imagery is shipped, only colours.
//
// Frame: the contract frame (x = east, z = north, metres from Shoreditch High St station, equirectangular on the
// sphere of radius 6 371 008.8 m), identical to world/freemap/mosaic.ts toXZ. Coordinates are quantised to 0.1 m and
// rings delta-encoded (integers), which gzips well.
//
// © OpenStreetMap contributors (ODbL). Imagery colours sampled from Esri World Imagery.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const RAW = join(ROOT, "data/raw/city");
const OUT = resolve(HERE, "../public/city");
const REFRESH = process.argv.includes("--refresh");

// ---------------------------------------------------------------- frame (must match world/photoreal/frame.ts)
const ORIGIN_LAT = 51.5232534;
const ORIGIN_LON = -0.0744674;
const R = 6_371_008.8;
const D = Math.PI / 180;
const cosLat0 = Math.cos(ORIGIN_LAT * D);
const toXZ = (lat, lon) => [(lon - ORIGIN_LON) * D * R * cosLat0, (lat - ORIGIN_LAT) * D * R];
const toLatLon = (x, z) => [ORIGIN_LAT + z / R / D, ORIGIN_LON + x / (R * cosLat0) / D];

const map = JSON.parse(readFileSync(join(ROOT, "data/processed/map.json"), "utf8"));
const B = map.bounds;
const INNER = 400; // reaches Old Street roundabout (x ≈ −880) and City Road west of the sim map
const OUTER = 1100;
const inner = { minX: B.minX - INNER, maxX: B.maxX + INNER, minZ: B.minZ - INNER, maxZ: B.maxZ + INNER };
const outer = { minX: B.minX - OUTER, maxX: B.maxX + OUTER, minZ: B.minZ - OUTER, maxZ: B.maxZ + OUTER };
const inBox = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
const bboxQL = (b) => {
  const [s, w] = toLatLon(b.minX, b.minZ);
  const [n, e] = toLatLon(b.maxX, b.maxZ);
  return `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
};

// ---------------------------------------------------------------- downloads (cached)
mkdirSync(RAW, { recursive: true });
mkdirSync(join(RAW, "esri"), { recursive: true });
mkdirSync(OUT, { recursive: true });
const UA = "silly-hamsters-shoreditch-sim/1.0 (bake-city; one-off bake, cached)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENDPOINTS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter", "https://z.overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

async function overpass(name, ql) {
  const file = join(RAW, `${name}.json`);
  if (!REFRESH && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  // free public servers are often at capacity: back off politely and rotate mirrors
  for (let attempt = 0; attempt < 60; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    console.log(`overpass ${name}: ${url} (attempt ${attempt + 1})`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "application/json" },
        body: "data=" + encodeURIComponent(ql),
      });
      if (res.ok) {
        const text = await res.text();
        const data = JSON.parse(text);
        if (data.remark && /error|timed out|runtime/i.test(data.remark)) throw new Error(data.remark);
        writeFileSync(file, text);
        return data;
      }
      console.log(`  ${res.status}`);
    } catch (e) {
      console.log(`  failed: ${e.message}`);
    }
    await sleep(Math.min(90_000, 15_000 + attempt * 5_000));
  }
  throw new Error(`overpass ${name} failed`);
}

const INNER_QL = `[out:json][timeout:240][maxsize:1073741824][bbox:${bboxQL(inner)}];
(
  way["building"]; relation["building"];
  way["building:part"]; relation["building:part"];
  way["highway"]; way["area:highway"];
  node["highway"="crossing"]; node["crossing"];
  way["railway"]; relation["railway"="platform"];
  way["landuse"]; relation["landuse"];
  way["leisure"]; relation["leisure"];
  way["natural"]; relation["natural"]; node["natural"="tree"];
  way["amenity"="parking"]; way["place"="square"]; way["amenity"="grave_yard"];
  way["water"]; relation["water"]; way["waterway"];
);
out body geom qt;`;

// The outer ring is fetched as four strips around the inner box (lighter queries for busy public servers).
const OUTER_QL = (b) => `[out:json][timeout:240][maxsize:1073741824][bbox:${bboxQL(b)}];
(
  way["building"]; relation["building"]["type"="multipolygon"];
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];
  way["railway"~"^(rail|light_rail|narrow_gauge)$"];
  way["leisure"~"^(park|garden|pitch|playground|common|recreation_ground)$"]; relation["leisure"="park"];
  way["landuse"~"^(grass|recreation_ground|cemetery|village_green|meadow|allotments|railway|construction)$"];
  way["natural"~"^(water|wood|scrub|grassland)$"]; relation["natural"="water"];
  way["water"]; relation["water"]; way["waterway"~"^(river|canal|riverbank|dock)$"]; way["amenity"="grave_yard"];
  way["place"="square"];
);
out body geom qt;`;
const OUTER_STRIPS = () => [
  { minX: outer.minX, maxX: outer.maxX, minZ: inner.maxZ, maxZ: outer.maxZ },
  { minX: outer.minX, maxX: outer.maxX, minZ: outer.minZ, maxZ: inner.minZ },
  { minX: outer.minX, maxX: inner.minX, minZ: inner.minZ, maxZ: inner.maxZ },
  { minX: inner.maxX, maxX: outer.maxX, minZ: inner.minZ, maxZ: inner.maxZ },
];

// Esri tiles: decoded on demand, cached on disk.
const tileCache = new Map();
const TILE = 256;
const tileXf = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileYf = (lat, z) => ((1 - Math.log(Math.tan(lat * D) + 1 / Math.cos(lat * D)) / Math.PI) / 2) * 2 ** z;

function tilesFor(b, z) {
  const [s, w] = toLatLon(b.minX, b.minZ);
  const [n, e] = toLatLon(b.maxX, b.maxZ);
  const out = [];
  for (let y = Math.floor(tileYf(n, z)); y <= Math.floor(tileYf(s, z)); y++)
    for (let x = Math.floor(tileXf(w, z)); x <= Math.floor(tileXf(e, z)); x++) out.push([z, x, y]);
  return out;
}

async function downloadTiles(list) {
  const todo = list.filter(([z, x, y]) => REFRESH || !existsSync(join(RAW, "esri", `${z}_${x}_${y}.jpg`)));
  console.log(`esri: ${list.length} tiles, ${todo.length} to download`);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const [z, x, y] = todo[next++];
      const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      for (let a = 0; a < 3; a++) {
        try {
          const res = await fetch(url, { headers: { "user-agent": UA } });
          if (!res.ok) throw new Error(String(res.status));
          writeFileSync(join(RAW, "esri", `${z}_${x}_${y}.jpg`), Buffer.from(await res.arrayBuffer()));
          break;
        } catch (e) {
          if (a === 2) console.log(`  tile ${z}/${x}/${y} failed: ${e.message}`);
          await sleep(1000);
        }
      }
      if (++done % 100 === 0) console.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

function tile(z, x, y) {
  const k = `${z}_${x}_${y}`;
  if (tileCache.has(k)) return tileCache.get(k);
  let img = null;
  const file = join(RAW, "esri", `${k}.jpg`);
  if (existsSync(file)) {
    const buf = readFileSync(file);
    try {
      img = buf[0] === 0x89 ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    } catch {
      img = null;
    }
  }
  tileCache.set(k, img);
  return img;
}

/** RGB at contract (x, z) from the zoom-z imagery, or null. */
function pixel(x, z, zoom) {
  const [lat, lon] = toLatLon(x, z);
  const fx = tileXf(lon, zoom);
  const fy = tileYf(lat, zoom);
  const tx = Math.floor(fx);
  const ty = Math.floor(fy);
  const img = tile(zoom, tx, ty);
  if (!img) return null;
  const px = Math.min(TILE - 1, Math.floor((fx - tx) * TILE));
  const py = Math.min(TILE - 1, Math.floor((fy - ty) * TILE));
  const i = (py * img.width + px) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

// ---------------------------------------------------------------- geometry helpers
const q = (v) => Math.round(v * 10);
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 = counter-clockwise (x east, z north)
}
function inRing(p, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const inPoly = (p, rings) => inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h));
function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
}
function edgeDist(p, rings) {
  let d = Infinity;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) d = Math.min(d, segDist(p, r[j], r[i]));
  return d;
}
function centroid(r) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f;
    cx += (r[j][0] + r[i][0]) * f;
    cz += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return r[0];
  return [cx / (3 * a), cz / (3 * a)];
}
function bboxOf(r) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of r) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}
/** Drops the closing duplicate and near-duplicate points; returns null when degenerate. */
function cleanRing(pts) {
  const out = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.15) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.15) out.pop();
  return out.length >= 3 && Math.abs(ringArea(out)) > 0.5 ? out : null;
}
/** Points inside the polygon, away from its edges (for colour sampling). */
function innerPoints(rings, max = 25) {
  const b = bboxOf(rings[0]);
  const area = Math.abs(ringArea(rings[0]));
  const step = Math.max(1.2, Math.sqrt(area / max));
  const pts = [];
  const margin = Math.min(1.5, step * 0.4);
  for (let x = b.minX + step / 2; x < b.maxX; x += step)
    for (let z = b.minZ + step / 2; z < b.maxZ; z += step) {
      const p = [x, z];
      if (inPoly(p, rings) && edgeDist(p, rings) > margin) pts.push(p);
    }
  if (!pts.length) {
    const c = centroid(rings[0]);
    if (inPoly(c, rings)) pts.push(c);
  }
  return pts.slice(0, max * 2);
}
function sampleColour(rings, zoom) {
  const px = innerPoints(rings)
    .map((p) => pixel(p[0], p[1], zoom))
    .filter(Boolean);
  if (!px.length) return null;
  const med = (k) => {
    const v = px.map((c) => c[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return hex([med(0), med(1), med(2)]);
}
const hex = (c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/** Delta-encoded decimetre ring: [x0, z0, dx1, dz1, ...]. */
function encRing(r) {
  const out = [];
  let px = 0;
  let pz = 0;
  r.forEach(([x, z], i) => {
    const ix = q(x);
    const iz = q(z);
    out.push(i ? ix - px : ix, i ? iz - pz : iz);
    px = ix;
    pz = iz;
  });
  return out;
}

// ---------------------------------------------------------------- OSM parsing
function geomOf(el) {
  return (el.geometry ?? []).filter(Boolean).map((g) => toXZ(g.lat, g.lon));
}
/** Joins way segments into closed rings (multipolygon assembly). */
function assemble(segments) {
  const key = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const rings = [];
  const open = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  while (open.length) {
    let cur = open.shift();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 500) {
      const end = key(cur[cur.length - 1]);
      const i = open.findIndex((s) => key(s[0]) === end || key(s[s.length - 1]) === end);
      if (i < 0) break;
      const s = open.splice(i, 1)[0];
      cur = cur.concat(key(s[0]) === end ? s.slice(1) : s.reverse().slice(1));
    }
    if (key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}
/** [[outer, ...holes], ...] for a closed way or a multipolygon relation. */
function polygonsOf(el) {
  if (el.type === "way") {
    const g = geomOf(el);
    if (g.length < 4) return [];
    const a = g[0];
    const b = g[g.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.5) return [];
    const r = cleanRing(g);
    return r ? [[r]] : [];
  }
  if (el.type === "relation") {
    const outers = assemble((el.members ?? []).filter((m) => m.type === "way" && m.role !== "inner").map(geomOf))
      .map(cleanRing)
      .filter(Boolean);
    const inners = assemble((el.members ?? []).filter((m) => m.type === "way" && m.role === "inner").map(geomOf))
      .map(cleanRing)
      .filter(Boolean);
    return outers.map((o) => [o, ...inners.filter((h) => inRing(h[0], o))]);
  }
  return [];
}
/** Outer CCW, holes CW. */
function orient(rings) {
  return rings.map((r, i) => {
    const ccw = ringArea(r) > 0;
    return (i === 0) === ccw ? r : [...r].reverse();
  });
}

const num = (v) => {
  if (v == null) return null;
  const m = String(v).replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(String(v))) n *= 0.3048;
  return Number.isFinite(n) ? n : null;
};

const NAMED = {
  white: "f2f0ea", black: "2a2a2a", grey: "8f9296", gray: "8f9296", darkgrey: "5d6064", darkgray: "5d6064", lightgrey: "c4c6c8",
  lightgray: "c4c6c8", silver: "c0c2c4", red: "9a3b30", darkred: "6e2a24", brown: "7a5236", beige: "d8cdb4", cream: "e9dfc6",
  yellow: "d9c46a", orange: "c8743a", tan: "c2a27c", maroon: "6b2a26", green: "5f7d55", darkgreen: "3c5236", blue: "4f6f96",
  navy: "2f3b56", sandstone: "c9b48a", gold: "c9a64a", pink: "d9a7a0", ivory: "efe9d8", khaki: "bfb07a", olive: "7a7a46",
  teal: "3f7f7a", purple: "6a4f80", copper: "a8693e", bronze: "8c6a3e", terracotta: "b5603e",
};
function colourTag(v) {
  if (!v) return "";
  const s = String(v).trim().toLowerCase().replace(/[\s_-]/g, "");
  if (/^#?[0-9a-f]{6}$/.test(s)) return s.replace("#", "");
  if (/^#?[0-9a-f]{3}$/.test(s)) return s.replace("#", "").split("").map((c) => c + c).join("");
  return NAMED[s] ?? "";
}

const MATERIALS = ["", "brick", "stone", "concrete", "glass", "metal", "wood", "plaster", "render", "sandstone", "limestone", "steel", "tiles", "slate"];
const matCode = (v) => Math.max(0, MATERIALS.indexOf(String(v ?? "").toLowerCase().split(/[;,]/)[0].trim()));
const ROOFS = ["flat", "gabled", "hipped", "pyramidal", "skillion", "dome", "round", "mansard", "gambrel", "onion", "half-hipped", "saltbox"];
const roofCode = (v) => Math.max(0, ROOFS.indexOf(String(v ?? "flat").toLowerCase()));
const TYPES = ["yes", "house", "terrace", "residential", "apartments", "commercial", "office", "retail", "industrial", "warehouse", "church", "school", "university", "hotel", "train_station", "civic", "public", "roof", "garage", "shed", "construction", "hospital", "college", "semidetached_house", "detached", "dormitory", "kiosk", "service", "transportation"];
const typeCode = (v) => Math.max(0, TYPES.indexOf(String(v ?? "yes").toLowerCase()));

const LEVELS_DEFAULT = { house: 2.5, terrace: 3, semidetached_house: 2.5, detached: 2.5, residential: 4, apartments: 5, commercial: 4, office: 5, retail: 2, industrial: 2.5, warehouse: 2.5, church: 4, school: 3, hotel: 6, garage: 1, shed: 1, kiosk: 1, roof: 1, train_station: 2, construction: 3, hospital: 5, university: 5, college: 4 };

// ---------------------------------------------------------------- bake
function bakeBuildings(elements, region, zoom, isOuter) {
  const all = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const isPart = !!t["building:part"] && t["building:part"] !== "no";
    const isBuilding = !!t.building && t.building !== "no";
    if (!isPart && !isBuilding) continue;
    if (el.type === "relation" && t.type !== "multipolygon" && t.type !== "building") continue;
    if (t.location === "underground" || t["building:levels:underground"] && !t["building:levels"] && !t.height) continue;
    if ((num(t.layer) ?? 0) < 0 && !isPart) continue;
    if (t.building === "construction" && !t.height && !t["building:levels"]) continue;
    for (const poly of polygonsOf(el)) {
      const rings = orient(poly);
      const c = centroid(rings[0]);
      if (!inBox(region, c[0], c[1])) continue;
      const kind = isPart ? t["building:part"] : t.building;
      const levels = num(t["building:levels"]);
      const roofLevels = num(t["roof:levels"]) ?? 0;
      const roofShape = roofCode(t["roof:shape"]);
      let roofH = num(t["roof:height"]);
      const short = Math.sqrt(Math.abs(ringArea(rings[0])));
      if (roofH == null) roofH = roofShape ? Math.min(roofLevels ? roofLevels * 3 : 3.2, Math.max(1.5, short * 0.35)) : 0;
      let h = num(t.height);
      if (h == null) {
        const lv = levels ?? LEVELS_DEFAULT[kind] ?? (isPart ? 3 : 3);
        h = lv * 3.2 + (roofShape ? roofH : roofLevels * 3);
      }
      let mh = num(t.min_height);
      if (mh == null) mh = (num(t["building:min_level"]) ?? 0) * 3.2;
      if (kind === "roof" && mh === 0) mh = Math.max(0, h - 0.6);
      if (h - mh < 0.5) h = mh + 0.5;
      roofH = Math.min(roofH, (h - mh) * 0.7);
      all.push({
        id: `${el.type[0]}${el.id}`,
        rings,
        c,
        area: Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0),
        bb: bboxOf(rings[0]),
        h,
        mh,
        roofShape,
        roofH,
        levels: levels ?? 0,
        part: isPart,
        wall: colourTag(t["building:colour"] ?? t.colour),
        roof: colourTag(t["roof:colour"]),
        mat: matCode(t["building:material"] ?? t["building:facade:material"]),
        roofMat: matCode(t["roof:material"]),
        type: typeCode(isPart ? t.building ?? kind : kind),
        name: t.name ?? "",
        outer: isOuter,
      });
    }
  }
  // grid for overlap tests
  const CELL = 50;
  const grid = new Map();
  const cells = (bb) => {
    const out = [];
    for (let i = Math.floor(bb.minX / CELL); i <= Math.floor(bb.maxX / CELL); i++)
      for (let j = Math.floor(bb.minZ / CELL); j <= Math.floor(bb.maxZ / CELL); j++) out.push(`${i},${j}`);
    return out;
  };
  all.forEach((b, i) => cells(b.bb).forEach((k) => (grid.get(k) ?? grid.set(k, []).get(k)).push(i)));
  const near = (b) => {
    const s = new Set();
    for (const k of cells(b.bb)) for (const i of grid.get(k) ?? []) s.add(i);
    return [...s].map((i) => all[i]).filter((o) => o !== b);
  };
  // outlines with parts are not drawn (the parts are); exact duplicates are dropped
  const drop = new Set();
  for (const b of all) {
    if (b.part) continue;
    const parts = near(b).filter((o) => o.part && inPoly(o.c, b.rings));
    if (parts.length) b.hasParts = true;
  }
  for (const b of all) {
    if (drop.has(b) || b.hasParts) continue;
    for (const o of near(b)) {
      if (drop.has(o) || o.part !== b.part || o.hasParts) continue;
      if (inPoly(o.c, b.rings) && inPoly(b.c, o.rings) && o.area > b.area * 0.75 && o.area < b.area * 1.33 && o.area <= b.area) drop.add(o);
    }
  }
  const kept = all.filter((b) => !drop.has(b));
  // roof colour from the imagery (parts and outlines alike)
  let n = 0;
  for (const b of kept) {
    if (b.hasParts) continue;
    b.sat = sampleColour(b.rings, zoom) ?? "";
    if (++n % 2000 === 0) console.log(`  sampled ${n} roofs`);
  }
  return { kept, dropped: drop.size };
}

const ROAD_CLASS = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 7,
  service: 8, pedestrian: 9, footway: 10, path: 11, cycleway: 12, steps: 13, track: 14, bridleway: 11, corridor: -1,
  motorway_link: 0, trunk_link: 1, primary_link: 2, secondary_link: 3, tertiary_link: 4, busway: 5, bus_guideway: 5,
};
const DEFAULT_WIDTH = [16, 13, 11, 10, 8.5, 7, 6.5, 5.5, 4, 6, 2.2, 1.8, 2, 2, 3];

function bakeRoads(elements, region) {
  const roads = [];
  const nodeWays = new Map(); // node id -> [road index, vertex index]
  for (const el of elements) {
    if (el.type !== "way") continue;
    const t = el.tags ?? {};
    const cls = ROAD_CLASS[t.highway];
    if (cls == null || cls < 0) continue;
    if (t.area === "yes") continue; // drawn as an area
    if (t.tunnel && t.tunnel !== "no" && t.tunnel !== "building_passage") continue;
    if ((num(t.layer) ?? 0) < 0 && !t.bridge) continue;
    if (t.indoor === "yes" || t.level && (num(t.level) ?? 0) < 0) continue;
    const pts = geomOf(el);
    if (pts.length < 2) continue;
    if (!pts.some((p) => inBox(region, p[0], p[1]))) continue;
    const lanes = num(t.lanes);
    let w = num(t.width) ?? num(t["width:carriageway"]);
    if (w == null || w < 1 || w > 40) {
      w = DEFAULT_WIDTH[cls];
      if (lanes && cls <= 8) w = Math.max(lanes * 3.1 + 0.6, cls <= 4 ? 6 : 4.5);
    }
    if (cls <= 8 && t.oneway === "yes" && !lanes) w = Math.max(4, w * 0.62);
    let flags = 0;
    if (t.oneway === "yes" || t.oneway === "-1" || t.junction === "roundabout") flags |= 1;
    const sw = t.sidewalk ?? (t["sidewalk:both"] ? "both" : t["sidewalk:left"] || t["sidewalk:right"] ? (t["sidewalk:left"] && t["sidewalk:left"] !== "no" && t["sidewalk:left"] !== "separate" ? (t["sidewalk:right"] && t["sidewalk:right"] !== "no" && t["sidewalk:right"] !== "separate" ? "both" : "left") : t["sidewalk:right"] !== "no" && t["sidewalk:right"] !== "separate" ? "right" : "no") : undefined);
    const swDefault = cls >= 2 && cls <= 7;
    const left = sw ? sw === "both" || sw === "left" || sw === "yes" : swDefault;
    const right = sw ? sw === "both" || sw === "right" || sw === "yes" : swDefault;
    if (left) flags |= 2;
    if (right) flags |= 4;
    if (t.bridge && t.bridge !== "no") flags |= 8;
    if (t.footway === "sidewalk" || t.footway === "crossing" || t.cycleway === "crossing") flags |= 16;
    if (t.footway === "crossing" || t.cycleway === "crossing") flags |= 32;
    if (/^(asphalt|paved)$/.test(t.surface ?? "") && cls >= 9) flags |= 64;
    if (/(sett|cobblestone|paving_stones|brick)/.test(t.surface ?? "")) flags |= 128;
    if (t["cycleway"] === "lane" || t["cycleway:left"] === "lane" || t["cycleway:right"] === "lane" || t["cycleway:both"] === "lane") flags |= 256;
    if (t.highway === "bus_guideway" || t.highway === "busway") flags |= 512;
    const idx = roads.length;
    roads.push({ cls, w, lanes: lanes ?? 0, flags, layer: num(t.layer) ?? 0, pts, name: t.name ?? "" });
    (el.nodes ?? []).forEach((nid, vi) => {
      if (cls <= 8) (nodeWays.get(nid) ?? nodeWays.set(nid, []).get(nid)).push([idx, vi]);
    });
  }
  return { roads, nodeWays };
}

function bakeCrossings(elements, roads, nodeWays, region) {
  const out = [];
  for (const el of elements) {
    if (el.type !== "node") continue;
    const t = el.tags ?? {};
    if (t.highway !== "crossing" && !t.crossing) continue;
    const c = t.crossing ?? "";
    const ref = t.crossing_ref ?? "";
    let type = 0;
    if (ref === "zebra" || c === "zebra" || c === "marked" || c === "uncontrolled") type = 1;
    else if (c === "traffic_signals" || ref === "pelican" || ref === "toucan" || ref === "puffin" || ref === "pegasus") type = 2;
    if (!type) continue;
    const [x, z] = toXZ(el.lat, el.lon);
    if (!inBox(region, x, z)) continue;
    const hits = nodeWays.get(el.id);
    if (!hits) continue;
    const [ri, vi] = hits.sort((a, b) => roads[a[0]].cls - roads[b[0]].cls)[0];
    const r = roads[ri];
    const a = r.pts[Math.max(0, vi - 1)];
    const b = r.pts[Math.min(r.pts.length - 1, vi + 1)];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    out.push([q(x), q(z), Math.round(ang * 1000), q(r.w), type]);
  }
  return out;
}

const LAND = {
  park: 1, garden: 1, common: 1, recreation_ground: 1, village_green: 2, grass: 2, meadow: 2, grassland: 2, pitch: 3,
  playground: 4, water: 5, basin: 5, river: 5, canal: 5, riverbank: 5, dock: 5, wood: 6, scrub: 6, cemetery: 7, grave_yard: 7,
  plaza: 8, parking: 9, railway: 10, construction: 11, allotments: 2, sports_centre: 3, brownfield: 11, flowerbed: 2,
};
// area:highway values
const AREA_HW = { footway: 12, pedestrian: 12, cycleway: 13, primary: 14, secondary: 14, tertiary: 14, residential: 14, service: 14, unclassified: 14, trunk: 14, living_street: 14, emergency: 14, bus_stop: 12, traffic_island: 15, crossing: 14, prohibited: 15 };

function bakeLand(elements, region, zoom) {
  const areas = [];
  const trees = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (el.type === "node") {
      if (t.natural === "tree") {
        const [x, z] = toXZ(el.lat, el.lon);
        if (inBox(region, x, z)) trees.push([q(x), q(z), Math.round((num(t.height) ?? 0) * 10)]);
      }
      continue;
    }
    if (t.natural === "tree_row" && el.type === "way") {
      const g = geomOf(el);
      for (let i = 0; i < g.length - 1; i++) {
        const [ax, az] = g[i];
        const [bx, bz] = g[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.round(L / 8));
        for (let k = 0; k < n; k++) {
          const x = ax + ((bx - ax) * k) / n;
          const z = az + ((bz - az) * k) / n;
          if (inBox(region, x, z)) trees.push([q(x), q(z), 0]);
        }
      }
      continue;
    }
    if (t.building || t["building:part"]) continue;
    let kind = 0;
    if (t["area:highway"]) kind = AREA_HW[t["area:highway"]] ?? 0;
    else if (t.highway === "pedestrian" || t.highway === "footway" || t.place === "square") kind = t.area === "yes" || t.place === "square" || el.type === "relation" ? 8 : 0;
    else if (t.amenity === "parking") kind = t.parking && t.parking !== "surface" ? 0 : 9;
    else if (t.amenity === "grave_yard") kind = 7;
    else if (t.leisure) kind = LAND[t.leisure] ?? 0;
    else if (t.natural) kind = LAND[t.natural] ?? (t.natural === "water" ? 5 : 0);
    else if (t.water || t.waterway === "riverbank" || t.waterway === "dock") kind = 5;
    else if (t.landuse) kind = LAND[t.landuse] ?? 0;
    if (!kind) continue;
    if (t.leisure === "pitch" && t.surface && /(asphalt|concrete|tartan|artificial|paved)/.test(t.surface) && !/turf|grass/.test(t.surface)) kind = 16; // hard court
    if (t.layer && (num(t.layer) ?? 0) < 0) continue;
    if (t.indoor === "yes") continue;
    for (const poly of polygonsOf(el)) {
      const rings = orient(poly);
      const bb = bboxOf(rings[0]);
      if (bb.maxX < region.minX || bb.minX > region.maxX || bb.maxZ < region.minZ || bb.minZ > region.maxZ) continue;
      const area = Math.abs(ringArea(rings[0]));
      if (area < 4) continue;
      // sampled tint for green and paved spaces (not for land use that is mostly buildings or roofs)
      const tint = [1, 2, 3, 4, 6, 7, 8, 16].includes(kind) && area < 200000 ? sampleColour(rings, zoom) ?? "" : "";
      areas.push({ kind, rings, area, tint });
    }
  }
  // big areas first, so smaller ones draw over them
  areas.sort((a, b) => b.area - a.area);
  return { areas, trees };
}

function bakeRail(elements, region) {
  const out = [];
  for (const el of elements) {
    if (el.type !== "way") continue;
    const t = el.tags ?? {};
    if (!/^(rail|light_rail|narrow_gauge|disused|construction|preserved)$/.test(t.railway ?? "")) continue;
    if (t.tunnel && t.tunnel !== "no") continue;
    const pts = geomOf(el);
    if (pts.length < 2 || !pts.some((p) => inBox(region, p[0], p[1]))) continue;
    let flags = 0;
    if (t.bridge && t.bridge !== "no") flags |= 1;
    if (t.embankment === "yes") flags |= 2;
    if (t.cutting === "yes") flags |= 4;
    if (t.service) flags |= 8; // siding / yard / spur
    if (/overground|east london/i.test(`${t.name ?? ""} ${t.operator ?? ""} ${t.line ?? ""}`)) flags |= 16;
    if (t.railway !== "rail" && t.railway !== "light_rail") flags |= 32; // disused / construction
    out.push({ flags, layer: num(t.layer) ?? 0, pts, name: t.name ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------- main
const innerData = await overpass("osm-inner", INNER_QL);
await sleep(5000);
const outerData = { elements: [] };
if (!process.argv.includes("--no-outer")) {
  const seen = new Set();
  const strips = OUTER_STRIPS();
  for (let i = 0; i < strips.length; i++) {
    const d = await overpass(`osm-outer-${i}`, OUTER_QL(strips[i]));
    for (const el of d.elements) {
      const k = `${el.type}${el.id}`;
      if (!seen.has(k)) seen.add(k), outerData.elements.push(el);
    }
    await sleep(5000);
  }
}
console.log(`osm: inner ${innerData.elements.length} elements, outer ${outerData.elements.length}`);

await downloadTiles([...tilesFor(inner, 18), ...tilesFor(outer, 16)]);

const isInner = (x, z) => inBox(inner, x, z);
const ringRegion = { ...outer };
// buildings: inner at z18; outer ring (centroid outside the inner box) at z16
const bi = bakeBuildings(innerData.elements, inner, 18, false);
const outerOnly = outerData.elements.filter((el) => {
  const g = el.geometry ?? el.members?.flatMap((m) => m.geometry ?? []) ?? [];
  if (!g.length) return false;
  const [x, z] = toXZ(g[0].lat, g[0].lon);
  return !isInner(x, z) || el.tags?.highway || el.tags?.railway; // roads/rail de-duplicated below by id
});
const bo = bakeBuildings(outerOnly, ringRegion, 16, true);
const boKept = bo.kept.filter((b) => !isInner(b.c[0], b.c[1]));
const buildings = [...bi.kept, ...boKept];
console.log(`buildings: ${bi.kept.length} inner (+${bi.dropped} duplicates dropped), ${boKept.length} outer; ${buildings.filter((b) => b.hasParts).length} outlines replaced by parts`);

const encB = buildings.map((b) => {
  let flags = 0;
  if (b.part) flags |= 1;
  if (b.hasParts) flags |= 2;
  if (b.outer) flags |= 4;
  return [b.id, b.rings.map(encRing), Math.round(b.h * 10), Math.round(b.mh * 10), b.roofShape, Math.round(b.roofH * 10), Math.round(b.levels), flags, b.wall, b.roof || b.sat || "", b.mat, b.type, b.name, b.roofMat];
});

// roads (inner detail + outer car roads not already in the inner set)
const ri = bakeRoads(innerData.elements, inner);
const innerIds = new Set(innerData.elements.filter((e) => e.type === "way").map((e) => e.id));
const ro = bakeRoads(outerData.elements.filter((e) => e.type === "way" && !innerIds.has(e.id)), outer);
const roads = [...ri.roads, ...ro.roads];
const crossings = bakeCrossings(innerData.elements, ri.roads, ri.nodeWays, inner);
const encRoads = roads.map((r) => [r.cls, Math.round(r.w * 10), r.flags, r.layer, r.lanes, encRing(r.pts), r.name]);

const li = bakeLand(innerData.elements, inner, 18);
const lo = bakeLand(outerData.elements.filter((e) => !innerIds.has(e.id) && !(e.type === "relation" && innerData.elements.some((x) => x.type === "relation" && x.id === e.id))), outer, 16);
const areas = [...lo.areas, ...li.areas].sort((a, b) => b.area - a.area);
const encAreas = areas.map((a) => [a.kind, a.rings.map(encRing), a.tint]);
const trees = li.trees;

const rail = [...bakeRail(innerData.elements, inner), ...bakeRail(outerData.elements.filter((e) => !innerIds.has(e.id)), outer)];
const encRail = rail.map((r) => [r.flags, r.layer, encRing(r.pts), r.name]);

const meta = {
  v: 1,
  q: 0.1,
  origin: [ORIGIN_LAT, ORIGIN_LON],
  inner: [inner.minX, inner.minZ, inner.maxX, inner.maxZ],
  outer: [outer.minX, outer.minZ, outer.maxX, outer.maxZ],
  bakedAt: new Date().toISOString(),
  attribution: "© OpenStreetMap contributors (ODbL); roof and ground colours sampled from Esri World Imagery",
  enums: { materials: MATERIALS, roofs: ROOFS, types: TYPES },
};
const files = {
  "buildings.json": { ...meta, fields: ["id", "rings", "h", "minH", "roof", "roofH", "levels", "flags(1 part,2 hasParts,4 outer)", "wallHex", "roofHex", "material", "type", "name", "roofMaterial"], b: encB },
  "roads.json": { ...meta, fields: { r: ["class", "width", "flags", "layer", "lanes", "points", "name"], x: ["x", "z", "angle(mrad)", "roadWidth", "type(1 zebra,2 signal)"], rail: ["flags", "layer", "points", "name"] }, r: encRoads, x: crossings, rail: encRail },
  "land.json": { ...meta, fields: { a: ["kind", "rings", "tintHex"], t: ["x", "z", "height"] }, a: encAreas, t: trees },
};
let total = 0;
let totalGz = 0;
for (const [name, data] of Object.entries(files)) {
  const s = JSON.stringify(data);
  writeFileSync(join(OUT, name), s);
  const gz = gzipSync(s).length;
  total += s.length;
  totalGz += gz;
  console.log(`${name}: ${(s.length / 1e6).toFixed(2)} MB (${(gz / 1e6).toFixed(2)} MB gzip)`);
}
console.log(`total ${(total / 1e6).toFixed(2)} MB, gzip ${(totalGz / 1e6).toFixed(2)} MB; roads ${roads.length}, crossings ${crossings.length}, areas ${areas.length}, trees ${trees.length}, rail ${rail.length}`);
