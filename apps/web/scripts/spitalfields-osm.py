#!/usr/bin/env python3
"""Fetch OpenStreetMap features for the Spitalfields / Brick Lane / Bishopsgate area (south-east of Shoreditch
High Street station) from the Overpass API and write a compact JSON for the Spitalfields module:
  apps/web/public/areas/spitalfields.json
Coordinates: metres from the Shoreditch High Street station OSM node (51.5232534, -0.0744674), x east, z north,
same equirectangular projection as the backend. Run: python3 apps/web/scripts/spitalfields-osm.py [raw.json], then the same with --sites (writes
src/sim/spitalfieldsSites.ts, the keep-out outlines for the generic infill)
(Data (c) OpenStreetMap contributors, ODbL.)"""
import json, math, os, sys, urllib.parse, urllib.request

LAT0, LON0 = 51.5232534, -0.0744674
R = 6371008.8
KX = math.radians(1) * R * math.cos(math.radians(LAT0))
KZ = math.radians(1) * R
BBOX = "51.5150,-0.0840,51.5232,-0.0635"

Q = f"""[out:json][timeout:120];
(
  way["building"]({BBOX});
  relation["building"]({BBOX});
  way["building:part"]({BBOX});
  way["leisure"]({BBOX});
  way["landuse"]({BBOX});
  way["amenity"~"parking|marketplace|place_of_worship"]({BBOX});
  way["area:highway"]({BBOX});
  way["highway"]({BBOX});
  way["railway"]({BBOX});
  node["natural"="tree"]({BBOX});
  node["amenity"]({BBOX});
  node["shop"]({BBOX});
  node["highway"~"street_lamp|crossing|traffic_signals"]({BBOX});
  node["tourism"]({BBOX});
  node["man_made"]({BBOX});
  way["man_made"]({BBOX});
);
out body geom;"""


def xy(lat, lon):
    return [round((lon - LON0) * KX, 1), round((lat - LAT0) * KZ, 1)]


def ring(geom):
    return [xy(p["lat"], p["lon"]) for p in geom]


def height(t):
    for k in ("height", "est_height"):
        if k in t:
            try:
                return float(t[k].split()[0].replace("m", ""))
            except ValueError:
                pass
    if "building:levels" in t:
        try:
            return float(t["building:levels"].split(";")[0]) * 3.4 + (1.5 if t.get("roof:shape") not in (None, "flat") else 0)
        except ValueError:
            pass
    return None


def main():
    raw_path = sys.argv[1] if len(sys.argv) > 1 else None
    if raw_path and os.path.exists(raw_path):
        data = json.load(open(raw_path))
    else:
        req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=urllib.parse.urlencode({"data": Q}).encode(), headers={"User-Agent": "silly-hamsters-sim/1.0"})
        data = json.load(urllib.request.urlopen(req, timeout=200))
        if raw_path:
            json.dump(data, open(raw_path, "w"))
    out = {"source": "OpenStreetMap contributors (ODbL), via Overpass", "origin": [LAT0, LON0], "buildings": [], "areas": [], "ways": [], "points": []}
    for e in data["elements"]:
        t = e.get("tags", {})
        if e["type"] == "node":
            p = xy(e["lat"], e["lon"])
            kind = None
            if t.get("natural") == "tree":
                kind = "tree"
            elif t.get("highway") in ("street_lamp",):
                kind = "lamp"
            elif t.get("highway") in ("crossing", "traffic_signals"):
                kind = "crossing"
            elif t.get("amenity") in ("restaurant", "fast_food", "cafe", "pub", "bar"):
                kind = t["amenity"]
            elif t.get("amenity") in ("bicycle_parking", "bicycle_rental", "bench", "waste_basket", "post_box", "telephone", "toilets", "drinking_water"):
                kind = t["amenity"]
            elif "shop" in t:
                kind = "shop"
            elif t.get("tourism") in ("artwork",):
                kind = "artwork"
            if not kind:
                continue
            pt = {"k": kind, "p": p}
            if t.get("name"):
                pt["n"] = t["name"]
            if t.get("cuisine"):
                pt["c"] = t["cuisine"]
            out["points"].append(pt)
            continue
        if e["type"] == "relation":
            # outer rings of multipolygon buildings
            outers = [m for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
            for m in outers:
                h = height(t)
                out["buildings"].append({"id": f"r{e['id']}", "n": t.get("name"), "b": t.get("building"), "h": h, "a": t.get("amenity"), "r": ring(m["geometry"])})
            continue
        geom = e.get("geometry")
        if not geom:
            continue
        r = ring(geom)
        closed = len(geom) > 3 and geom[0] == geom[-1]
        if "building" in t or "building:part" in t:
            if not closed:
                continue
            b = {"id": f"w{e['id']}", "r": r[:-1]}
            for src, dst in (("name", "n"), ("building", "b"), ("amenity", "a"), ("building:part", "part"), ("roof:shape", "roof"), ("building:colour", "col"), ("building:material", "mat"), ("historic", "hist")):
                if t.get(src):
                    b[dst] = t[src]
            h = height(t)
            if h:
                b["h"] = round(h, 1)
            if t.get("min_height"):
                try:
                    b["mh"] = float(t["min_height"])
                except ValueError:
                    pass
            out["buildings"].append(b)
        elif closed and ("leisure" in t or "landuse" in t or t.get("amenity") in ("parking", "marketplace", "place_of_worship") or "area:highway" in t or (t.get("highway") in ("pedestrian", "footway") and t.get("area") == "yes")):
            kind = t.get("leisure") or t.get("landuse") or t.get("amenity") or t.get("area:highway") or t.get("highway")
            out["areas"].append({"id": f"w{e['id']}", "k": kind, "n": t.get("name"), "r": r[:-1]})
        elif "highway" in t or "railway" in t:
            w = {"id": f"w{e['id']}", "k": t.get("highway") or ("rail:" + t["railway"]), "r": r}
            if t.get("name"):
                w["n"] = t["name"]
            if t.get("layer"):
                w["l"] = t["layer"]
            if t.get("tunnel"):
                w["tun"] = 1
            if t.get("bridge"):
                w["br"] = 1
            out["ways"].append(w)
    trimmed = trim(out)
    os.makedirs("apps/web/public/areas", exist_ok=True)
    with open("apps/web/public/areas/spitalfields.json", "w") as f:
        json.dump(trimmed, f, separators=(",", ":"))
    print({k: len(v) for k, v in trimmed.items() if isinstance(v, (list, dict))})


# The area this module owns (contract coords) plus a margin; everything else is left to the city-wide layers.
AREA = (-640, 720, -770, -50)
HEROES = {
    "church": "w420026096",  # Christ Church Spitalfields (Hawksmoor, 1729)
    "market": "w16306646",  # Old Spitalfields Market hall (Horner, 1887-93)
    "station": "w4959629",  # Liverpool Street station trainshed
    "masjid": "w126483845",  # Brick Lane Jamme Masjid
    "boiler": "w136161373",  # Truman Brewery boiler house (the chimney stands on it)
}
AREA_KINDS = {"park", "garden", "grass", "parking", "pedestrian", "playground", "pitch", "marketplace", "food_court", "recreation_ground"}
POINT_KINDS = {"tree", "lamp", "crossing", "restaurant", "fast_food", "cafe", "bar", "pub", "bicycle_parking", "bicycle_rental", "bench", "waste_basket", "artwork"}


def inside_area(p, pad=0):
    return AREA[0] - pad <= p[0] <= AREA[1] + pad and AREA[2] - pad <= p[1] <= AREA[3] + pad


def trim(out):
    by = {b["id"]: b for b in out["buildings"]}
    heroes = {k: by[v]["r"] for k, v in HEROES.items() if v in by}
    truman = [a["r"] for a in out["areas"] if (a.get("n") or "").startswith("The Old Truman Brewery")]
    areas = [{"k": a["k"], **({"n": a["n"]} if a.get("n") else {}), "r": a["r"]} for a in out["areas"] if a["k"] in AREA_KINDS and any(inside_area(p) for p in a["r"])]
    points = [p for p in out["points"] if p["k"] in POINT_KINDS and inside_area(p["p"])]
    for p in points:
        p.pop("c", None)
        if p["k"] not in ("restaurant", "fast_food", "cafe", "bar", "pub"):
            p.pop("n", None)
    return {"source": out["source"], "origin": out["origin"], "heroes": heroes, "truman": truman, "areas": areas, "points": points}


if __name__ == "__main__" and "--sites" not in sys.argv:
    main()


def write_sites(path="apps/web/public/areas/spitalfields.json", out="apps/web/src/sim/spitalfieldsSites.ts"):
    """Keep-out outlines for the generic Infill/StreetDressing layers: the hero sites and the OSM open spaces this
    module draws (so no made-up blocks land on a churchyard, a market yard or a car park)."""
    d = json.load(open(path))

    def area(r):
        return abs(sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))) / 2

    sites = [("Christ Church", d["heroes"]["church"]), ("Christ Church forecourt", [[3, -446], [22, -446], [22, -475], [3, -475]])]
    sites += [(k, d["heroes"][k]) for k in ("market", "station")]
    for a in d["areas"]:
        if a["k"] in ("park", "garden", "grass", "parking", "pedestrian", "playground", "pitch", "marketplace", "food_court", "recreation_ground") and area(a["r"]) >= 120:
            sites.append((a.get("n") or a["k"], a["r"]))
    lines = ["// Generated by apps/web/scripts/spitalfields-osm.py from OpenStreetMap (ODbL): the sites the Spitalfields module",
             "// draws itself (hero buildings and OSM open spaces), kept free of generic infill. Contract coords (x east, z north).",
             "export const SPITALFIELDS_SITES: { name: string; poly: [number, number][] }[] = ["]
    for n, r in sites:
        pts = ", ".join(f"[{p[0]}, {p[1]}]" for p in r)
        lines.append(f"  {{ name: {json.dumps(n)}, poly: [{pts}] }},")
    lines.append("];")
    open(out, "w").write("\n".join(lines) + "\n")
    print("sites", len(sites))


if __name__ == "__main__" and "--sites" in sys.argv:
    write_sites()
