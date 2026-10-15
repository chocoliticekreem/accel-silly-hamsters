#!/usr/bin/env python3
"""Fetch the Old Street junction (post-2024 layout) from OpenStreetMap and write apps/web/public/areas/oldstreet.json.

Usage: python3 apps/web/scripts/fetch-oldstreet.py [cached-overpass.json]   (needs `pip install shapely`)
Coordinates: contract metres from the Shoreditch High Street station node (x east, z north), the backend's
equirectangular projection (backend/pipeline/osm_map.py). Data (c) OpenStreetMap contributors, ODbL.
"""
import json, math, os, sys, urllib.parse, urllib.request

R = 6371008.8
LAT0, LON0 = 51.5232534, -0.0744674
C = (-909.0, 264.0)  # Old Street station node
QUERY = """[out:json][timeout:90];
(
  way(51.5236,-0.0912,51.5276,-0.0840);
  node(51.5236,-0.0912,51.5276,-0.0840)[railway];
  node(51.5236,-0.0912,51.5276,-0.0840)[highway];
  node(51.5236,-0.0912,51.5276,-0.0840)[amenity];
);
out body geom;"""

# Carriageway lanes through the junction, as chains of OSM way ids (walked in order, each way flipped to join).
# Two-way ways are listed in both directions; the module offsets them to the left (UK) by `off` metres.
LANES = {
    # Old Street from the west, east to the City Road junction, then south down City Road
    "oldW-cityS": {"off": 1.8, "ways": [596680097, 227387820, 1069111991, 657134509, 1168157114, 3076852, 693294644, 1168157113, 780411383, 890800651, 896867416, 2495401, 888020115, 888020120, 1176717544, 1176717545, 293598611]},
    "cityS-oldW": {"off": 1.8, "rev": True, "ways": [596680097, 227387820, 1069111991, 657134509, 1168157114, 3076852, 693294644, 1168157113, 780411383, 896847182, 888020120, 1176717544, 1176717545, 293598611]},
    # City Road northbound up the east side of the old roundabout and on to Angel
    "cityS-cityN": {"off": 1.6, "ways": [293598611, 1176717545, 1176717544, 888020120, 888020115, 2495401, 896867416, 890800651, 217063331, 886590029, 1482101909, 1264780819, 894935973, 894935974, 971510106, 1245969681, 894935977, 1245969682, 896847189, 1069697107, 38771996]},
    # Old Street from the west turning north (left) onto the east side
    "oldW-cityN": {"off": 1.8, "ways": [596680097, 227387820, 1069111991, 657134509, 1168157114, 3076852, 693294644, 1168157113, 780411383, 217063331, 886590029, 1482101909, 1264780819, 894935973, 894935974, 971510106, 1245969681, 894935977, 1245969682, 896847189, 1069697107, 38771996]},
    # City Road southbound from Angel, left into Old Street east
    "cityN-oldE": {"off": 1.6, "ways": [38771996, 1069697107, 896847189, 1069113134, 894935975, 886590028, 971510104, 971500064, 1264780821, 693628472, 993721223]},
    # City Road southbound, right turn down the east side to City Road south
    "cityN-cityS": {"off": 1.6, "ways": [38771996, 1069697107, 896847189, 1069113134, 894935975, 886590028, 894935976, 971510103, 1264780820, 1173185853, 971510105, 886590030, 886590033, 888020107, 888023668, 2495401, 888020115, 888020120, 1176717544, 1176717545, 293598611]},
    # Old Street from the east (Great Eastern St / Shoreditch) westbound, down the east side to City Road south
    "oldE-cityS": {"off": 1.6, "ways": [993721223, 693628472, 693628457, 1264780822, 972707730, 1173185853, 971510105, 886590030, 886590033, 888020107, 888023668, 2495401, 888020115, 888020120, 1176717544, 1176717545, 293598611]},
    # Old Street from the east, through to Old Street west (round the south-east corner)
    "oldE-oldW": {"off": 1.6, "ways": [993721223, 693628472, 693628457, 1264780822, 972707730, 1173185853, 971510105, 886590030, 886590033, 888020113, 780411383, 1168157113, 693294644, 3076852, 1168157114, 657134509, 1069111991, 227387820, 596680097]},
}


def P(lat, lon):
    return [round(math.radians(lon - LON0) * R * math.cos(math.radians(LAT0)), 2), round(math.radians(lat - LAT0) * R, 2)]


def dist(p):
    return math.hypot(p[0] - C[0], p[1] - C[1])


def main():
    if len(sys.argv) > 1:
        data = json.load(open(sys.argv[1]))
    else:
        req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=urllib.parse.urlencode({"data": QUERY}).encode(), headers={"User-Agent": "silly-hamsters-sim/1.0"})
        data = json.load(urllib.request.urlopen(req, timeout=120))
    els = data["elements"]
    ways = {e["id"]: e for e in els if e["type"] == "way"}
    geom = lambda w: [P(g["lat"], g["lon"]) for g in w["geometry"]]

    def chain(ids, rev=False):
        pts = []
        for i in ids:
            g = geom(ways[i])
            if pts:
                # orient to join the chain end
                if math.dist(pts[-1], g[-1]) < math.dist(pts[-1], g[0]):
                    g = g[::-1]
                if math.dist(pts[-1], g[0]) < 0.5:
                    g = g[1:]
            elif len(ids) > 1:
                n = geom(ways[ids[1]])
                if min(math.dist(g[0], n[0]), math.dist(g[0], n[-1])) < min(math.dist(g[-1], n[0]), math.dist(g[-1], n[-1])):
                    g = g[::-1]
            pts += g
        return pts[::-1] if rev else pts

    lanes = {k: {"off": v["off"], "pts": chain(v["ways"], v.get("rev", False))} for k, v in LANES.items()}

    # The public realm inside the junction (the old gyratory's peninsula, its pavements and the Promenade of
    # Light): a coarse hull minus every carriageway (buffered by its lane count) minus the sunken walk.
    from shapely.geometry import LineString, Polygon, Point
    from shapely.ops import unary_union
    roads = []
    for w in ways.values():
        t = w.get("tags", {})
        if t.get("highway") not in ("trunk", "primary", "secondary", "trunk_link", "primary_link"):
            continue
        g = geom(w)
        if min(map(dist, g)) > 220:
            continue
        nl = int(t.get("lanes", "2").split(";")[0]) if t.get("lanes", "2").split(";")[0].isdigit() else 2
        oneway = t.get("oneway") == "yes"
        half = (max(nl, 1) * 3.1) / 2 + (0.4 if oneway else 0.9)
        if not oneway and nl <= 2:
            half = 5.6  # two-way, a lane each way + cycle lanes
        roads.append(LineString(g).buffer(half, cap_style=1, join_style=1))
    carriage = unary_union(roads)
    hull = Polygon([(-1012, 236), (-905, 212), (-870, 232), (-850, 288), (-880, 300), (-918, 324), (-928.6, 306.6), (-930.6, 304.6),
                    (-934.4, 299.2), (-936.8, 295.6), (-938.5, 293.2), (-940.6, 290.1), (-943.3, 287.2), (-947.4, 284.9), (-959.0, 282.8),
                    (-969.5, 280.75), (-971.1, 280.4), (-983.6, 277.2), (-1012, 271.5)])
    realm = hull.difference(carriage)
    parts = list(realm.geoms) if hasattr(realm, "geoms") else [realm]
    pav = Polygon(geom(ways[157247473]))
    main = max(parts, key=lambda g: g.intersection(pav.buffer(30)).area).simplify(0.15)
    realm_pts = [[round(x, 2), round(z, 2)] for x, z in list(main.exterior.coords)[:-1]]
    # carriageway edges facing the realm (for cycle tracks): realm boundary segments within 1 m of a carriageway
    edge = carriage.buffer(0.6)

    out = {
        "source": "OpenStreetMap contributors (ODbL), Overpass API, " + data.get("osm3s", {}).get("timestamp_osm_base", ""),
        "centre": C,
        "pavilion": geom(ways[157247473])[:-1],
        "peninsula": geom(ways[694572327])[:-1],
        "promenade": [p for p in geom(ways[596678288])[:-1]],
        "whiteCollar": geom(ways[532318205])[:-1],
        "grind": geom(ways[154856449])[:-1],
        "liftHouses": [geom(ways[i])[:-1] for i in (971020141, 971020142)],
        "exit2House": geom(ways[971973854])[:-1],
        "retaining": [geom(ways[i]) for i in (693364829, 693364830, 693364831, 693364832, 971980203)],
        "steps": {str(i): geom(ways[i]) for i in (971980202, 1564645361, 227387818, 657140110, 1091350764, 157247483, 157247486)},
        "island": geom(ways[1264780823])[:-1],
        "realm": realm_pts,
        "realmRoadEdge": [1 if edge.contains(Point(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))) else 0 for a, b in zip(realm_pts, realm_pts[1:] + realm_pts[:1])],
        "lanes": lanes,
        "kerbs": [],
        "signals": [],
        "crossings": [],
        "busStops": [],
        "lamps": [],
        "benches": [],
        "cycleHire": [],
        "entrances": [],
    }
    for w in ways.values():
        t = w.get("tags", {})
        g = geom(w)
        if t.get("barrier") == "kerb" and min(map(dist, g)) < 150:
            out["kerbs"].append(g)
    for e in els:
        if e["type"] != "node":
            continue
        t = e.get("tags", {})
        p = P(e["lat"], e["lon"])
        d = dist(p)
        if t.get("highway") == "traffic_signals" and d < 150:
            out["signals"].append(p)
        elif t.get("highway") == "crossing" and d < 150:
            out["crossings"].append(p + [t.get("crossing", "")])
        elif t.get("highway") == "bus_stop" and d < 230:
            out["busStops"].append({"x": p[0], "z": p[1], "ref": t.get("local_ref", ""), "name": t.get("name", ""), "bearing": t.get("naptan:Bearing", "")})
        elif t.get("highway") == "street_lamp" and d < 200:
            out["lamps"].append(p)
        elif t.get("amenity") == "bench" and d < 150:
            out["benches"].append(p)
        elif t.get("amenity") == "bicycle_rental" and d < 200:
            out["cycleHire"].append(p)
        elif t.get("railway") == "subway_entrance":
            out["entrances"].append({"x": p[0], "z": p[1], "name": t.get("name", ""), "ref": t.get("ref", "")})
    dst = os.path.join(os.path.dirname(__file__), "..", "public", "areas", "oldstreet.json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(dst, os.path.getsize(dst), "bytes;", {k: len(v) for k, v in out.items() if isinstance(v, (list, dict))})


if __name__ == "__main__":
    main()
