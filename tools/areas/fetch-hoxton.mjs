// Fetches the real Hoxton (Old St / Pitfield St / Hoxton Sq / Rivington St) from OpenStreetMap via Overpass once and
// writes a compact JSON the Hoxton world module reads: apps/web/public/areas/hoxton.json.
// Contract coords (x east, z north, metres from Shoreditch High Street station), same projection as the backend.
// Run: node tools/areas/fetch-hoxton.mjs
import { writeFileSync, mkdirSync } from "node:fs";

const LAT0 = 51.5232534;
const LON0 = -0.0744674;
const R = 6_371_008.8;
const MLAT = (Math.PI / 180) * R;
const MLON = MLAT * Math.cos((LAT0 * Math.PI) / 180);
// area box in contract metres, with a margin
const BOX = { minX: -940, maxX: -180, minZ: 240, maxZ: 790 };
const s = LAT0 + BOX.minZ / MLAT;
const n = LAT0 + BOX.maxZ / MLAT;
const w = LON0 + BOX.minX / MLON;
const e = LON0 + BOX.maxX / MLON;
const bb = `${s},${w},${n},${e}`;

const q = `[out:json][timeout:120];
(
  way["building"](${bb});
  relation["building"](${bb});
  way["landuse"](${bb});
  way["leisure"](${bb});
  relation["leisure"](${bb});
  way["amenity"](${bb});
  way["highway"](${bb});
  way["barrier"](${bb});
  node["natural"="tree"](${bb});
  node["amenity"](${bb});
  node["shop"](${bb});
  node["tourism"](${bb});
  node["craft"](${bb});
  node["highway"~"street_lamp|crossing|traffic_signals|bus_stop"](${bb});
  node["leisure"](${bb});
);
out body geom qt;`;

const URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
let body;
for (const url of URLS) {
  try {
    const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "silly-hamsters-hoxton/1.0" } });
    if (!r.ok) throw new Error(`${r.status}`);
    body = await r.json();
    console.log("from", url);
    break;
  } catch (err) {
    console.warn("failed", url, err.message);
  }
}
if (!body) process.exit(1);

const P = (lat, lon) => [Math.round((lon - LON0) * MLON * 10) / 10, Math.round((lat - LAT0) * MLAT * 10) / 10];
const ring = (geom) => geom.map((g) => P(g.lat, g.lon));
const levels = (t) => {
  const h = parseFloat(t.height ?? "");
  if (h > 0) return { h };
  const l = parseFloat(t["building:levels"] ?? "");
  const rl = parseFloat(t["roof:levels"] ?? "0") || 0;
  if (l > 0) return { l: l + rl * 0.5 };
  return {};
};
const pick = (t, keys) => Object.fromEntries(keys.filter((k) => t[k] != null).map((k) => [k, t[k]]));

const out = { origin: [LAT0, LON0], box: BOX, source: "© OpenStreetMap contributors (ODbL), via Overpass", fetched: new Date().toISOString().slice(0, 10), buildings: [], areas: [], ways: [], barriers: [], trees: [], pois: [] };
const isClosed = (g) => g.length > 3 && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon;

for (const el of body.elements) {
  const t = el.tags ?? {};
  if (el.type === "way" && el.geometry) {
    const g = el.geometry;
    if (t.building && isClosed(g)) {
      out.buildings.push({ id: el.id, r: ring(g).slice(0, -1), ...levels(t), ...pick(t, ["building", "name", "amenity", "shop", "addr:street", "addr:housenumber", "building:colour", "building:material", "roof:shape", "min_height", "building:min_level"]) });
    } else if (t.highway) {
      out.ways.push({ id: el.id, p: ring(g), ...pick(t, ["highway", "name", "width", "lanes", "oneway", "cycleway", "cycleway:left", "cycleway:right", "cycleway:both", "sidewalk", "footway", "crossing", "surface", "service", "area"]) });
    } else if (t.barrier) {
      out.barriers.push({ id: el.id, p: ring(g), barrier: t.barrier, ...pick(t, ["height", "material"]) });
    } else if ((t.landuse || t.leisure || t.amenity) && isClosed(g)) {
      out.areas.push({ id: el.id, r: ring(g).slice(0, -1), ...pick(t, ["landuse", "leisure", "amenity", "name", "surface", "parking", "access"]) });
    }
  } else if (el.type === "relation" && el.members) {
    const outers = el.members.filter((m) => m.role === "outer" && m.geometry);
    for (const m of outers) {
      const g = m.geometry;
      if (!isClosed(g)) continue;
      if (t.building) out.buildings.push({ id: el.id, r: ring(g).slice(0, -1), ...levels(t), ...pick(t, ["building", "name", "amenity", "shop"]) });
      else out.areas.push({ id: el.id, r: ring(g).slice(0, -1), ...pick(t, ["landuse", "leisure", "amenity", "name"]) });
    }
  } else if (el.type === "node") {
    const p = P(el.lat, el.lon);
    if (t.natural === "tree") out.trees.push(p);
    else out.pois.push({ p, ...pick(t, ["amenity", "shop", "name", "highway", "leisure", "crossing", "cuisine", "bicycle_parking", "capacity", "tourism", "crossing_ref", "shelter"]) });
  }
}
const inBox = (p) => p[0] > BOX.minX - 60 && p[0] < BOX.maxX + 60 && p[1] > BOX.minZ - 60 && p[1] < BOX.maxZ + 60;
out.ways = out.ways.filter((w) => w.p.some(inBox));
mkdirSync("apps/web/public/areas", { recursive: true });
writeFileSync("apps/web/public/areas/hoxton.json", JSON.stringify(out));
console.log({ buildings: out.buildings.length, areas: out.areas.length, ways: out.ways.length, barriers: out.barriers.length, trees: out.trees.length, pois: out.pois.length });
