#!/usr/bin/env node
// Bakes every real, named business in the sim map bounds into apps/web/public/city/pois.json, so the 3D city can
// show (and let you click) the shops, cafés, pubs and restaurants the simulation doesn't model.
//
//   node apps/web/scripts/bake-pois.mjs            (uses the cached download in data/raw/city/pois.json when present)
//   node apps/web/scripts/bake-pois.mjs --refresh  (re-download from Overpass)
//
// Source: OpenStreetMap via Overpass, one query: named nodes/ways/relations with amenity=cafe|restaurant|fast_food|
// bar|pub|nightclub or any shop=*, inside the sim map bounds (data/processed/map.json, x −1050..700, z ±750).
// Each POI is snapped onto the nearest street-facing wall of its building (public/city/buildings.json, which
// bake-city.mjs writes) so its sign hangs on the facade; the wall's outward normal is stored as an angle.
// Sim stores are NOT removed here: the app drops POIs that match a map.stores entry at runtime, so a bigger
// backend store list never shows the same shop twice.
//
// Output (contract frame: x = east, z = north, decimetres):
//   { v, bakedAt, attribution, types: string[],
//     p: [osmId, name, typeIdx, x, z, facadeAngleMrad | null, hours, website, cuisine, address, unitAreaM2, levels][] }
//
// © OpenStreetMap contributors (ODbL).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const RAW = join(ROOT, "data/raw/city");
const OUT = resolve(HERE, "../public/city");
const REFRESH = process.argv.includes("--refresh");

// frame: must match bake-city.mjs / world/photoreal/frame.ts
const ORIGIN_LAT = 51.5232534;
const ORIGIN_LON = -0.0744674;
const R = 6_371_008.8;
const D = Math.PI / 180;
const cosLat0 = Math.cos(ORIGIN_LAT * D);
const toXZ = (lat, lon) => [(lon - ORIGIN_LON) * D * R * cosLat0, (lat - ORIGIN_LAT) * D * R];
const toLatLon = (x, z) => [ORIGIN_LAT + z / R / D, ORIGIN_LON + x / (R * cosLat0) / D];

const map = JSON.parse(readFileSync(join(ROOT, "data/processed/map.json"), "utf8"));
const B = map.bounds;
const [s, w] = toLatLon(B.minX, B.minZ);
const [n, e] = toLatLon(B.maxX, B.maxZ);
const BBOX = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;

const AMENITIES = ["cafe", "restaurant", "fast_food", "bar", "pub", "nightclub"];
const QL = `[out:json][timeout:180][bbox:${BBOX}];
(
  nwr["name"]["amenity"~"^(${AMENITIES.join("|")})$"];
  nwr["name"]["shop"];
);
out center tags qt;`;

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://z.overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const UA = "silly-hamsters-shoreditch-sim/1.0 (bake-pois; one-off bake, cached)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass() {
  const file = join(RAW, "pois.json");
  if (!REFRESH && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  mkdirSync(RAW, { recursive: true });
  for (let attempt = 0; attempt < 30; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    console.log(`overpass pois: ${url} (attempt ${attempt + 1})`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "application/json" },
        body: "data=" + encodeURIComponent(QL),
      });
      if (res.ok) {
        const text = await res.text();
        const data = JSON.parse(text);
        if (data.remark && /error|timed out|runtime/i.test(data.remark)) throw new Error(data.remark);
        writeFileSync(file, text);
        return data;
      }
      console.log(`  ${res.status}`);
    } catch (err) {
      console.log(`  failed: ${err.message}`);
    }
    await sleep(Math.min(60_000, 8_000 + attempt * 4_000));
  }
  throw new Error("overpass pois failed");
}

// ---------------------------------------------------------------- buildings (for facade snapping)
function decodeRing(enc) {
  const out = [];
  let x = 0;
  let z = 0;
  for (let i = 0; i + 1 < enc.length; i += 2) {
    x = i ? x + enc[i] : enc[i];
    z = i ? z + enc[i + 1] : enc[i + 1];
    out.push([x / 10, z / 10]);
  }
  return out;
}
function inRing(x, z, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

const bj = JSON.parse(readFileSync(join(OUT, "buildings.json"), "utf8"));
// outlines only (parts sit inside them; the outer ring is far away)
const ringArea = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
};
const outlines = bj.b.filter((e) => !(e[7] & 1) && !(e[7] & 4)).map((e) => {
  const ring = decodeRing(e[1][0]);
  return { ring, area: ringArea(ring), levels: e[6] || 0, pois: 0 };
});
const CELL = 40;
const grid = new Map();
const key = (i, j) => `${i},${j}`;
for (const o of outlines) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of o.ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
    for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const k = key(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(o);
    }
}
function near(x, z, r) {
  const set = new Set();
  for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++)
    for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) for (const o of grid.get(key(i, j)) ?? []) set.add(o);
  return [...set];
}
const insideAny = (x, z, list) => list.some((o) => inRing(x, z, o.ring));

/** The outline the POI sits in (else the one whose wall it snapped to). */
const hostOf = (px, pz, f) => near(px, pz, 2).find((o) => inRing(px, pz, o.ring)) ?? f?.o ?? null;

/** Nearest open wall (one with street, not a neighbour, outside it) within 18 m: [x, z, outward angle] or null. */
function snap(px, pz) {
  const cands = near(px, pz, 30);
  let best = null;
  for (const o of cands) {
    const r = o.ring;
    for (let i = 0; i < r.length; i++) {
      const [ax, az] = r[i];
      const [bx, bz] = r[(i + 1) % r.length];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 2.5) continue;
      let t = ((px - ax) * dx + (pz - az) * dz) / (len * len);
      // keep the sign off the corners
      const m = Math.min(0.45, 1.2 / len);
      t = Math.max(m, Math.min(1 - m, t));
      const qx = ax + dx * t;
      const qz = az + dz * t;
      const d = Math.hypot(px - qx, pz - qz);
      if (d > 18 || (best && d >= best.d)) continue;
      // outward normal: the side that isn't inside this building
      let nx = dz / len;
      let nz = -dx / len;
      if (inRing(qx + nx * 0.4, qz + nz * 0.4, r)) {
        nx = -nx;
        nz = -nz;
      }
      // a party wall (another building right outside it) isn't a shopfront
      if (insideAny(qx + nx * 1.5, qz + nz * 1.5, cands)) continue;
      best = { d, x: qx, z: qz, a: Math.atan2(nz, nx), o };
    }
  }
  return best;
}

// ---------------------------------------------------------------- bake
const raw = await overpass();
const TYPES = [];
const typeIdx = (t) => {
  let i = TYPES.indexOf(t);
  if (i < 0) i = TYPES.push(t) - 1;
  return i;
};
const seen = new Set();
const rows = [];
let snapped = 0;
for (const el of raw.elements) {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || !t.name) continue;
  const amenity = AMENITIES.includes(t.amenity) ? t.amenity : null;
  const shop = t.shop && t.shop !== "no" && t.shop !== "vacant" ? t.shop : null;
  const type = amenity ?? (shop ? `shop:${shop}` : null);
  if (!type) continue;
  const [x, z] = toXZ(lat, lon);
  if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ) continue;
  const id = `${el.type}/${el.id}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const f = snap(x, z);
  if (f) snapped++;
  const host = hostOf(x, z, f);
  if (host) host.pois++;
  const addr = [[t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), t["addr:postcode"]].filter(Boolean).join(", ");
  rows.push([
    id,
    t.name,
    typeIdx(type),
    Math.round((f?.x ?? x) * 10),
    Math.round((f?.z ?? z) * 10),
    f ? Math.round(f.a * 1000) : null,
    t.opening_hours ?? "",
    t.website ?? t["contact:website"] ?? "",
    (t.cuisine ?? "").replace(/_/g, " ").replace(/;/g, ", "),
    addr,
    host,
  ]);
}
// floor area of the unit: the host's footprint shared between the businesses in it (ground floor; the app clamps it
// to the backend's 30–600 m² like map.json), and the host's levels (0 = unknown)
for (const r of rows) {
  const host = r.pop();
  r.push(host ? Math.round(host.area / host.pois) : 0, host?.levels ?? 0);
}
rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
const out = {
  v: 1,
  bakedAt: new Date().toISOString(),
  attribution: "© OpenStreetMap contributors (ODbL)",
  types: TYPES,
  p: rows,
};
const json = JSON.stringify(out);
writeFileSync(join(OUT, "pois.json"), json);
console.log(`pois.json: ${rows.length} businesses (${snapped} on a facade), ${TYPES.length} types, ${(json.length / 1024).toFixed(0)} KB (${(gzipSync(json).length / 1024).toFixed(0)} KB gz)`);
