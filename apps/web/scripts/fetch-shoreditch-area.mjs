// One-off: fetch the Shoreditch High Street station area from OpenStreetMap (Overpass API) and write the small
// JSON the ShoreditchStation module reads (public/areas/shoreditch-station.json). Run: node scripts/fetch-shoreditch-area.mjs
// Coordinates are metres from the map origin (the station's railway=station node), x east / z north, with the
// backend's equirectangular projection (backend/pipeline/osm_map.py). Data © OpenStreetMap contributors, ODbL.
import { writeFileSync } from "node:fs";

const LAT0 = 51.5232534;
const LON0 = -0.0744674;
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const xz = (lat, lon) => [+(rad(lon - LON0) * R * Math.cos(rad(LAT0))).toFixed(1), +(rad(lat - LAT0) * R).toFixed(1)];

const AROUND = `around:280,${LAT0},${LON0}`;
const query = `[out:json][timeout:60];
(
  node(${AROUND})["highway"~"traffic_signals|bus_stop|crossing"];
  way(${AROUND})["building"="train_station"];
  way(${AROUND})["railway"="platform"];
  way(${AROUND})["railway"="abandoned"]["name"="Braithwaite Viaduct"];
  way(${AROUND})["landuse"="construction"]["name"="The Goodsyard"];
);
out geom tags;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "User-Agent": "shoreditch-sim/1.0 (area fetch)", "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`overpass ${res.status}`);
const osm = await res.json();

const out = {
  source: "OpenStreetMap contributors (ODbL) via Overpass API",
  fetchedAt: new Date().toISOString(),
  signals: [],
  crossings: [],
  busStops: [],
  station: null,
  platforms: [],
  braithwaiteViaduct: null,
  goodsyard: null,
};
for (const e of osm.elements) {
  const t = e.tags ?? {};
  if (e.type === "node") {
    const p = xz(e.lat, e.lon);
    if (t.highway === "traffic_signals") out.signals.push({ x: p[0], z: p[1], crossing: t.crossing !== "no" });
    else if (t.highway === "crossing") out.crossings.push({ x: p[0], z: p[1], kind: t.crossing ?? "unmarked" });
    else if (t.highway === "bus_stop") out.busStops.push({ x: p[0], z: p[1], name: t.name ?? "", ref: t.local_ref ?? "" });
    continue;
  }
  const line = (e.geometry ?? []).map((g) => xz(g.lat, g.lon));
  if (t.building === "train_station") out.station = line;
  else if (t.railway === "platform") out.platforms.push(line);
  else if (t.railway === "abandoned") out.braithwaiteViaduct = line;
  else if (t.landuse === "construction") out.goodsyard = line;
}
writeFileSync(new URL("../public/areas/shoreditch-station.json", import.meta.url), JSON.stringify(out));
console.log(`signals ${out.signals.length}, crossings ${out.crossings.length}, bus stops ${out.busStops.length}`);
