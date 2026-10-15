"""Build data/processed/map.json (contract.MapData) from OpenStreetMap via the Overpass API.

One Overpass query (cached in data/raw/osm/) is turned into a cartoon map of the BOUNDS
rectangle (1.75 km x 1.5 km: west past Old Street roundabout, see BOUNDS) in local metres around
Shoreditch High Street station, which stays the origin (equirectangular projection, x east,
z north):

  streets    walkable highways as straight polylines. Junction clusters are merged, parallel
             one-way carriageways folded into one, every crossing split so that streets meeting
             or crossing share one exact vertex, everything clipped to the bounds, and only the
             largest connected piece kept (the sim builds its walk graph from shared points).
  buildings  axis-aligned boxes with the footprint's area, pulled back off the carriageways,
             at most MAX_BUILDINGS (the largest).
  stores     ~190 named venues in a balanced type mix plus 2-6 clubs (real nightclubs), each in
             its own building, plus LANDMARK_STORES inside the landmark buildings (art'otel,
             Boxpark, Encode Hub), with one typical daily window parsed from OSM opening_hours
             (else type defaults).
  entries    a street entry on every street that leaves the map edge, Shoreditch High Street
             (st1) and every other railway station inside the bounds (st2, ...); a station in
             ENTRANCE_STATIONS (Old Street) gets one entry per street entrance. Entries,
             station doors and every store's door are exact street vertices.
  landmarks  named places the frontend labels: every station, Encode Hub (the hackathon
             venue), art'otel London Hoxton and Boxpark Shoreditch, with their buildings.
  heights    OSM height, else (building:levels + roof:levels) x LEVEL_HEIGHT_M, raised to the
             tallest building:part inside the outline (towers are mapped that way), else a
             published height for a landmark (art'otel), else the default for the kind.

If Overpass is unreachable the hand-written layout from map_fallback is written instead, and the
step is not marked as built, so the next pipeline run tries OSM again.
"""

from __future__ import annotations

import argparse
import heapq
import math
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

import httpx

from backend import cache, store, timeutil
from backend.contract import (
    Bounds,
    Building,
    BuildingKind,
    EntryPoint,
    Landmark,
    LandmarkKind,
    MapData,
    MapStore,
    Source,
    StoreType,
    Street,
)
from backend.pipeline import common, map_fallback
from backend.pipeline.map_fallback import (
    DEFAULT_HEIGHT_M,
    DEFAULT_HOURS,
    FLOOR_AREA_RANGE_M2,
    LEVEL_HEIGHT_M,
    LICENSED_HOURS,
    STATION_NAME,
    STREET_WIDTH_M,
    clamp_floor_area,
    hours,
)

Point = tuple[float, float]
Box = tuple[float, float, float, float]  # centre x, centre z, w (x extent), d (z extent)

# The OSM map around Shoreditch High Street station (the origin): 1.5 km x 1.5 km, reaching
# west to -1050 m so that the whole Old Street roundabout (Silicon Roundabout, centre ~880 m
# west and ~255 m north: Old Street both ways, City Road, East Road, the station's entrances)
# is inside with ~170 m to spare; XOYO on Cowper Street, Encode Hub (~645 m W, ~480 m N) and
# art'otel (~600 m W, ~340 m N) too.
BOUNDS = Bounds(minX=-1050.0, maxX=700.0, minZ=-750.0, maxZ=750.0)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# Public Overpass instances tried in order when the main one is down (it was, 2026-10-15).
OVERPASS_MIRRORS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
_served_by: dict[str, str] = {}  # the instance that answered the last fetch_overpass()
OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright"
APPROX_ORIGIN = (51.5233, -0.0754)  # Shoreditch High Street station, refined from OSM
# Around BOUNDS (APPROX_ORIGIN is 65 m west of the station): room for edge clipping.
QUERY_MARGIN_M = 150.0
OVERPASS_TIMEOUT = httpx.Timeout(240.0, connect=15.0)  # the response is tens of MB
EARTH_RADIUS_M = 6_371_008.8
MAP_BUILDER_VERSION = 8  # bump when the processing changes, so the pipeline cache rebuilds

# Street network simplification, in metres.
JUNCTION_MERGE_M = 12.0  # junction nodes this close become one (dual carriageways, junction boxes)
PARALLEL_CARRIAGEWAY_M = 15.0  # a one-way carriageway this close to a same-name parallel is folded
SIMPLIFY_TOLERANCE_M = 2.5  # Douglas-Peucker tolerance for the straight-segment polylines
CROSSING_SNAP_M = 1.5  # a crossing this close to an existing vertex reuses it
CROSSING_TOUCH_M = 0.75  # an end this close to another street's line counts as touching it
DEAD_END_JOIN_M = 5.0  # a dead end this close to another street is joined to it
STUB_MAX_M = 8.0  # shorter dangling spurs left behind by junction merging are removed
DOOR_REUSE_M = 2.0  # a door this close to an existing vertex uses that vertex
ENTRY_MERGE_M = 30.0  # street ends closer than this along the edge are one entry (the widest)

ROAD_CLASSES = {
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "pedestrian",
}
# Minor paths are kept only when named: unnamed service roads and footpaths are mostly
# driveways, sidewalks and crossings that would clutter a cartoon map.
NAMED_PATH_CLASSES = {"service", "footway", "cycleway", "path", "steps"}
SKIPPED_FOOTWAYS = {"sidewalk", "crossing", "traffic_island", "link"}

# Buildings. The cap keeps the 3D scene light: the smallest footprints go first.
MAX_BUILDINGS = 2500
MAX_HEIGHT_M = 250.0  # tallest box allowed (Principal Tower, the tallest in the map, is ~173 m)
MIN_BUILDING_AREA_M2 = 25.0
MIN_BUILDING_SIDE_M = 3.0
# City boxes thinner than this, or longer than MAX_CITY_ASPECT times their width, are slivers
# (canopies, strips between footprints) and are dropped.
MIN_CITY_SIDE_M = 4.0
MAX_CITY_ASPECT = 6.0
STREET_CLEARANCE_M = 1.0  # boxes stop this far past the carriageway edge (the pavement)
CLEARANCE_STEP_M = 0.5
CITY_MIN_AREA_SHARE = 0.35  # a box that must lose more than this to clear the streets is dropped
STORE_MIN_AREA_SHARE = 0.25
SKIPPED_BUILDINGS = {"no", "roof", "construction", "ruins", "facade", "shelter"}
RESIDENTIAL_BUILDINGS = {
    "apartments",
    "house",
    "residential",
    "terrace",
    "detached",
    "semidetached_house",
    "dormitory",
    "bungalow",
}
RESIDENTIAL_LANDUSE = {"residential"}
WORK_LANDUSE = {"commercial", "retail", "industrial", "railway"}

# Stores.
TYPE_TARGETS: dict[StoreType, int] = {
    "cafe": 40,
    "restaurant": 40,
    "takeaway": 32,
    "bar": 32,
    "shop": 35,
    "offlicence": 12,
}
MIN_CLUBS, MAX_CLUBS = 2, 6  # late-opening bars are promoted when OSM has too few nightclubs
# Venues OpenStreetMap still lists that have closed, with the source that says so. OSM lags reality
# in nightlife; a closed club would fake a crowd at closing time and a demo venue judges can check.
CLOSED_VENUES: dict[str, str] = {
    "club aquarium": (
        "Closed by Islington Council (licence suspended Jan 2020, "
        "https://www.timeout.com/london/news/nightlife-news-old-streets-club-aquarium-has-had-its-"
        "licence-suspended-011720); the site was later relicensed as a different venue "
        "(https://www.islingtontribune.co.uk/article/former-aquarium-nightspot-gets-2am-licence)"
    ),
}
AMENITY_TYPES: dict[str, StoreType] = {
    "cafe": "cafe",
    "restaurant": "restaurant",
    "fast_food": "takeaway",
    "bar": "bar",
    "pub": "bar",
    "nightclub": "club",
}
OFFLICENCE_SHOPS = {"alcohol", "wine"}  # UK off-licences: shop=alcohol, and wine merchants
SKIPPED_SHOPS = {"mall", "vacant"}
SPREAD_CAP_M = 120.0  # spacing beyond this no longer matters when spreading stores out
MAX_DOOR_DISTANCE_M = 40.0  # venues further than this from any street are not used
SYNTHETIC_BOX_M = (10.0, 8.0)  # store box at the venue when OSM has no footprint for it
SYNTHETIC_STATION_BOX: Box = (0.0, 0.0, 40.0, 15.0)  # when OSM has no station building
DEMO_MAX_WALK_M = 80.0
DEMO_TRADE_UNTIL = "03:30"


class MapBuildError(RuntimeError):
    """The OSM response cannot produce a map that meets the brief (see the message)."""


# --- Overpass -------------------------------------------------------------------------------


def _query_bbox() -> tuple[float, float, float, float]:
    """(south, west, north, east) around APPROX_ORIGIN: BOUNDS plus QUERY_MARGIN_M."""
    lat0, lon0 = APPROX_ORIGIN
    m_per_lat = math.radians(1) * EARTH_RADIUS_M
    m_per_lon = m_per_lat * math.cos(math.radians(lat0))
    margin = QUERY_MARGIN_M
    return (
        round(lat0 + (BOUNDS.minZ - margin) / m_per_lat, 5),
        round(lon0 + (BOUNDS.minX - margin) / m_per_lon, 5),
        round(lat0 + (BOUNDS.maxZ + margin) / m_per_lat, 5),
        round(lon0 + (BOUNDS.maxX + margin) / m_per_lon, 5),
    )


def overpass_query() -> str:
    """The single Overpass QL query behind the map (streets, buildings, venues, station)."""
    s, w, n, e = _query_bbox()
    bbox = f"({s},{w},{n},{e})"
    venues = "^(cafe|restaurant|fast_food|bar|pub|nightclub)$"
    return (
        "[out:json][timeout:180];\n(\n"
        f'  way["highway"]{bbox};\n'
        f'  way["building"]{bbox};\n'
        f'  relation["building"]{bbox};\n'
        f'  way["building:part"]{bbox};\n'
        f'  nwr["amenity"~"{venues}"]{bbox};\n'
        f'  nwr["shop"]{bbox};\n'
        f'  nwr["railway"="station"]{bbox};\n'
        f'  nwr["public_transport"="station"]{bbox};\n'
        f'  node["railway"~"^(subway_entrance|train_station_entrance)$"]{bbox};\n'
        f'  node["name"~" - Exit "]{bbox};\n'
        f'  node["office"]{bbox};\n'
        f'  way["landuse"]{bbox};\n'
        ");\nout body;\n>;\nout skel qt;\n"
    )


def fetch_overpass() -> tuple[dict[str, Any], str]:
    """POST the query through the scrape cache, to OVERPASS_URL and then each public mirror
    (same API, same OSM data) until one answers. Raises common.FetchError when none does."""
    errors: list[str] = []
    for url in (OVERPASS_URL, *OVERPASS_MIRRORS):
        try:
            body, fetched_at = common.fetch(
                "osm",
                url,
                method="POST",
                data={"data": overpass_query()},
                timeout=OVERPASS_TIMEOUT,
            )
        except common.FetchError as e:
            errors.append(str(e))
            continue
        _served_by["url"] = url
        return body, fetched_at
    raise common.FetchError("; ".join(errors))


# --- OSM elements and projection ------------------------------------------------------------


@dataclass
class OsmWay:
    id: int
    nodes: list[int]
    tags: dict[str, str]


@dataclass
class OsmData:
    nodes: dict[int, tuple[float, float]]  # id -> (lat, lon)
    node_tags: dict[int, dict[str, str]]
    ways: dict[int, OsmWay]
    relations: list[dict[str, Any]]

    @classmethod
    def from_overpass(cls, body: dict[str, Any]) -> OsmData:
        remark = str(body.get("remark") or "")
        if "error" in remark.lower() or "timed out" in remark.lower():
            raise MapBuildError(f"Overpass answered with an error remark: {remark}")
        data = cls(nodes={}, node_tags={}, ways={}, relations=[])
        for element in body.get("elements", []):
            kind = element.get("type")
            if kind == "node":
                data.nodes[element["id"]] = (element["lat"], element["lon"])
                if element.get("tags"):
                    data.node_tags[element["id"]] = element["tags"]
            elif kind == "way":
                existing = data.ways.get(element["id"])
                tags = element.get("tags") or (existing.tags if existing else {})
                data.ways[element["id"]] = OsmWay(element["id"], element.get("nodes", []), tags)
            elif kind == "relation":
                data.relations.append(element)
        return data


@dataclass(frozen=True)
class Projection:
    """Equirectangular projection to local metres around an origin: x east, z north."""

    lat0: float
    lon0: float

    def to_local(self, lat: float, lon: float) -> Point:
        x = math.radians(lon - self.lon0) * EARTH_RADIUS_M * math.cos(math.radians(self.lat0))
        z = math.radians(lat - self.lat0) * EARTH_RADIUS_M
        return x, z


@dataclass
class Station:
    lat: float
    lon: float
    osm_id: str | None  # None when the station was not found and APPROX_ORIGIN is used
    name: str = STATION_NAME


def find_station(osm: OsmData) -> Station:
    """The Shoreditch High Street railway=station node (the map origin)."""
    for node_id, tags in sorted(osm.node_tags.items()):
        is_station = tags.get("railway") == "station" or tags.get("public_transport") == "station"
        if is_station and STATION_NAME.lower() in tags.get("name", "").lower():
            lat, lon = osm.nodes[node_id]
            return Station(lat, lon, f"node/{node_id}")
    return Station(*APPROX_ORIGIN, osm_id=None)


def station_name(osm_name: str) -> str:
    """One name per station: OSM maps a main-line station's node as "London Liverpool Street"
    and its Underground node as "Liverpool Street" (TfL's name for both)."""
    return osm_name.strip().removeprefix("London ").strip()


def other_stations(osm: OsmData, proj: Projection) -> list[Station]:
    """Every other railway=station node inside the bounds, one per station name, at the node
    nearest the map origin (the side of the station that faces into the area)."""
    nearest: dict[str, tuple[float, int]] = {}
    for node_id, tags in sorted(osm.node_tags.items()):
        name = station_name(tags.get("name", ""))
        if tags.get("railway") != "station" or not name or STATION_NAME.lower() in name.lower():
            continue
        x, z = proj.to_local(*osm.nodes[node_id])
        if not _inside((x, z)):
            continue
        distance = math.hypot(x, z)
        if name not in nearest or distance < nearest[name][0]:
            nearest[name] = (distance, node_id)
    return [
        Station(*osm.nodes[node_id], osm_id=f"node/{node_id}", name=name)
        for name, (_, node_id) in sorted(nearest.items())
    ]


# --- geometry -------------------------------------------------------------------------------


def _dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _project_on_segment(p: Point, a: Point, b: Point) -> tuple[float, Point]:
    dx, dz = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dz * dz
    if length2 == 0:
        return 0.0, a
    t = min(1.0, max(0.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length2))
    return t, (a[0] + t * dx, a[1] + t * dz)


def _douglas_peucker(points: list[Point], tolerance: float) -> list[int]:
    """Indices of the points to keep (always the first and the last)."""
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        best, best_dist = -1, tolerance
        for k in range(i + 1, j):
            _, foot = _project_on_segment(points[k], points[i], points[j])
            if _dist(points[k], foot) > best_dist:
                best, best_dist = k, _dist(points[k], foot)
        if best >= 0:
            keep.add(best)
            stack += [(i, best), (best, j)]
    return sorted(keep)


def _inside(p: Point, bounds: Bounds = BOUNDS, inset: float = 0.0) -> bool:
    """True when p lies inside the bounds shrunk by inset on every side."""
    return (
        bounds.minX + inset - 1e-9 <= p[0] <= bounds.maxX - inset + 1e-9
        and bounds.minZ + inset - 1e-9 <= p[1] <= bounds.maxZ - inset + 1e-9
    )


def _edges(bounds: Bounds) -> tuple[tuple[float, float], tuple[float, float]]:
    """The boundary coordinates per axis: (minX, maxX), (minZ, maxZ)."""
    return (bounds.minX, bounds.maxX), (bounds.minZ, bounds.maxZ)


def _edge_at(value: float, edges: tuple[float, float]) -> float | None:
    """The boundary coordinate within 1e-6 of value, if there is one."""
    return next((edge for edge in edges if abs(value - edge) < 1e-6), None)


def on_edge(p: Point, bounds: Bounds = BOUNDS) -> bool:
    """True when p lies on the map boundary."""
    return _inside(p, bounds) and any(
        _edge_at(value, edges) is not None for value, edges in zip(p, _edges(bounds), strict=True)
    )


def _snap_to_edge(p: Point, bounds: Bounds) -> Point:
    """p clamped into the bounds, a coordinate within 1e-6 of the boundary set exactly onto it."""
    snapped = []
    for value, edges in zip(p, _edges(bounds), strict=True):
        value = max(edges[0], min(edges[1], value))
        edge = _edge_at(value, edges)
        snapped.append(value if edge is None else edge)
    return snapped[0], snapped[1]


def _clip_to_rect(
    a: Point, b: Point, rect: tuple[float, float, float, float]
) -> tuple[float, float] | None:
    """Liang-Barsky: the (t0, t1) part of segment ab inside rect (x0, z0, x1, z1), or None."""
    x0, z0, x1, z1 = rect
    dx, dz = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dz, a[1] - z0), (dz, z1 - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return t0, t1


def _clip_segment(a: Point, b: Point, bounds: Bounds) -> tuple[Point, Point] | None:
    """Clip segment ab to the bounds."""
    span = _clip_to_rect(a, b, (bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ))
    if span is None:
        return None
    t0, t1 = span
    dx, dz = b[0] - a[0], b[1] - a[1]
    start = a if t0 == 0 else _snap_to_edge((a[0] + t0 * dx, a[1] + t0 * dz), bounds)
    end = b if t1 == 1 else _snap_to_edge((a[0] + t1 * dx, a[1] + t1 * dz), bounds)
    return start, end


def _intersection(a: Point, b: Point, c: Point, d: Point) -> tuple[float, float, Point] | None:
    """Where segments ab and cd cross or touch (within CROSSING_TOUCH_M): (t on ab, u on cd, p)."""
    rx, rz = b[0] - a[0], b[1] - a[1]
    sx, sz = d[0] - c[0], d[1] - c[1]
    len_r, len_s = math.hypot(rx, rz), math.hypot(sx, sz)
    denom = rx * sz - rz * sx
    if len_r == 0 or len_s == 0 or abs(denom) < 1e-9 * len_r * len_s:
        return None
    qx, qz = c[0] - a[0], c[1] - a[1]
    t = (qx * sz - qz * sx) / denom
    u = (qx * rz - qz * rx) / denom
    slack_t, slack_u = CROSSING_TOUCH_M / len_r, CROSSING_TOUCH_M / len_s
    if not (-slack_t <= t <= 1 + slack_t and -slack_u <= u <= 1 + slack_u):
        return None
    t, u = min(1.0, max(0.0, t)), min(1.0, max(0.0, u))
    return t, u, (a[0] + t * rx, a[1] + t * rz)


def _polygon_area(ring: list[Point]) -> float:
    total = 0.0
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1], strict=True):
        total += x1 * z2 - x2 * z1
    return abs(total) / 2


def _point_in_polygon(p: Point, ring: list[Point]) -> bool:
    x, z = p
    inside = False
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1], strict=True):
        if (z1 > z) != (z2 > z) and x < x1 + (z - z1) * (x2 - x1) / (z2 - z1):
            inside = not inside
    return inside


def _distance_to_ring(p: Point, ring: list[Point]) -> float:
    return min(
        _dist(p, _project_on_segment(p, a, b)[1])
        for a, b in zip(ring, ring[1:] + ring[:1], strict=True)
    )


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}

    def find(self, a: int) -> int:
        self.parent.setdefault(a, a)
        root = a
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[a] != root:
            self.parent[a], a = root, self.parent[a]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)

    def groups(self, items: Iterable[int]) -> list[list[int]]:
        by_root: dict[int, list[int]] = defaultdict(list)
        for item in items:
            by_root[self.find(item)].append(item)
        return [sorted(members) for _, members in sorted(by_root.items())]


def _components(nodes: Iterable[int], neighbours: Any) -> list[set[int]]:
    """Connected components; neighbours[n] lists (or maps) the nodes next to n."""
    seen: set[int] = set()
    found: list[set[int]] = []
    for start in nodes:
        if start in seen:
            continue
        stack, comp = [start], {start}
        while stack:
            for nxt in neighbours[stack.pop()]:
                if nxt not in comp:
                    comp.add(nxt)
                    stack.append(nxt)
        seen |= comp
        found.append(comp)
    return found


def _close_pairs(
    ids: Iterable[int], pos: dict[int, Point], radius: float
) -> Iterator[tuple[int, int]]:
    """Every pair of ids whose points are within radius (grid-bucketed)."""
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for n in ids:
        grid[(math.floor(pos[n][0] / radius), math.floor(pos[n][1] / radius))].append(n)
    for (gx, gz), members in grid.items():
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for a in members:
                    for b in grid.get((gx + dx, gz + dz), ()):
                        if a < b and _dist(pos[a], pos[b]) <= radius:
                            yield a, b


# --- street network -------------------------------------------------------------------------


@dataclass(frozen=True)
class _Way:
    """Street attributes carried by every segment."""

    name: str
    highway: str
    oneway: bool

    @property
    def width(self) -> float:
        return STREET_WIDTH_M[self.highway]


def _key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


class _Network:
    """Undirected street segments between numbered vertices: OSM node ids, or negative ids for
    vertices this builder creates (boundary crossings, intersections, doors)."""

    def __init__(self) -> None:
        self.pos: dict[int, Point] = {}
        self.segs: dict[tuple[int, int], _Way] = {}
        self._next_id = -1

    def add_node(self, p: Point) -> int:
        node = self._next_id
        self._next_id -= 1
        self.pos[node] = p
        return node

    def add_seg(self, a: int, b: int, way: _Way) -> None:
        if a == b:
            return
        key = _key(a, b)
        old = self.segs.get(key)
        if old is None or (way.width, way.name) > (old.width, old.name):
            self.segs[key] = way

    def adjacency(self) -> dict[int, list[int]]:
        adj: dict[int, list[int]] = defaultdict(list)
        for a, b in self.segs:
            adj[a].append(b)
            adj[b].append(a)
        return {n: sorted(nbrs) for n, nbrs in sorted(adj.items())}

    def drop_unused_nodes(self) -> None:
        used = {n for key in self.segs for n in key}
        self.pos = {n: p for n, p in self.pos.items() if n in used}

    def merge_into(self, node: int, target: int) -> None:
        """Move every segment of `node` onto `target` and forget `node`."""
        for key in [k for k in self.segs if node in k]:
            way = self.segs.pop(key)
            other = key[0] if key[1] == node else key[1]
            self.add_seg(target, other, way)
        self.pos.pop(node, None)

    def split(self, key: tuple[int, int], p: Point) -> int:
        """Make p (a point on segment `key`) a vertex; reuses an end within DOOR_REUSE_M."""
        a, b = key
        for end in (a, b):
            if _dist(self.pos[end], p) < DOOR_REUSE_M:
                return end
        way = self.segs.pop(key)
        node = self.add_node(p)
        self.add_seg(a, node, way)
        self.add_seg(node, b, way)
        return node

    def nearest_segment(
        self, p: Point, exclude: set[int] | None = None
    ) -> tuple[tuple[int, int], Point, float] | None:
        best: tuple[tuple[int, int], Point, float] | None = None
        for key in self.segs:
            if exclude and (key[0] in exclude or key[1] in exclude):
                continue
            _, foot = _project_on_segment(p, self.pos[key[0]], self.pos[key[1]])
            d = _dist(p, foot)
            if best is None or d < best[2]:
                best = (key, foot, d)
        return best

    def chains(self) -> list[list[int]]:
        """Maximal paths whose interior vertices have degree 2 and one set of attributes."""
        adj = self.adjacency()

        def is_break(n: int) -> bool:
            nbrs = adj[n]
            return len(nbrs) != 2 or self.segs[_key(n, nbrs[0])] != self.segs[_key(n, nbrs[1])]

        breaks = {n for n in adj if is_break(n)}
        seen: set[tuple[int, int]] = set()
        paths: list[list[int]] = []
        starts = sorted(breaks) + [a for a, _ in sorted(self.segs)]  # loops have no break
        for start in starts:
            for nxt in adj[start]:
                if _key(start, nxt) not in seen:
                    paths.append(_walk_chain(start, nxt, adj, breaks, seen))
        return paths

    def path_length(self, path: list[int]) -> float:
        return sum(_dist(self.pos[a], self.pos[b]) for a, b in pairwise(path))

    def segment_points(self) -> list[tuple[Point, Point]]:
        return [(self.pos[a], self.pos[b]) for a, b in sorted(self.segs)]


def _walk_chain(
    start: int,
    nxt: int,
    adj: dict[int, list[int]],
    breaks: set[int],
    seen: set[tuple[int, int]],
) -> list[int]:
    path = [start, nxt]
    seen.add(_key(start, nxt))
    prev, cur = start, nxt
    while cur not in breaks and cur != start:
        a, b = adj[cur]
        following = b if a == prev else a
        if _key(cur, following) in seen:
            break
        seen.add(_key(cur, following))
        path.append(following)
        prev, cur = cur, following
    return path


def _walkable(tags: dict[str, str]) -> _Way | None:
    highway = tags.get("highway", "")
    base = highway.removesuffix("_link")
    name = tags.get("name", "").strip()
    if tags.get("area") == "yes":
        return None
    if tags.get("access") in ("private", "no") and tags.get("foot") not in (
        "yes",
        "designated",
        "permissive",
    ):
        return None
    if base in ROAD_CLASSES:
        return _Way(name, base, tags.get("oneway") in ("yes", "-1"))
    if base in NAMED_PATH_CLASSES and name and tags.get("footway") not in SKIPPED_FOOTWAYS:
        return _Way(name, base, tags.get("oneway") in ("yes", "-1"))
    return None


def _raw_network(osm: OsmData, proj: Projection) -> _Network:
    net = _Network()
    for way in sorted(osm.ways.values(), key=lambda w: w.id):
        attrs = _walkable(way.tags)
        if attrs is None:
            continue
        ids = [n for n in way.nodes if n in osm.nodes]
        for n in ids:
            net.pos.setdefault(n, proj.to_local(*osm.nodes[n]))
        for a, b in pairwise(ids):
            net.add_seg(a, b, attrs)
    net.drop_unused_nodes()
    return net


def _merge_junctions(net: _Network, radius: float) -> None:
    """Collapse clusters of junction vertices (dual carriageways, junction boxes) into one."""
    adj = net.adjacency()
    junctions = [n for n, nbrs in adj.items() if len(nbrs) >= 3]
    uf = _UnionFind()
    for a, b in _close_pairs(junctions, net.pos, radius):
        uf.union(a, b)
    cluster: dict[int, int] = {}
    centre: dict[int, Point] = {}
    for members in uf.groups(junctions):
        if len(members) > 1:
            root = members[0]
            centre[root] = (
                sum(net.pos[m][0] for m in members) / len(members),
                sum(net.pos[m][1] for m in members) / len(members),
            )
            cluster.update({m: root for m in members})
    if not cluster:
        return
    rebuilt: list[tuple[list[int], _Way]] = []
    for path in net.chains():
        first, last = cluster.get(path[0]), cluster.get(path[-1])
        if first is not None and first == last and net.path_length(path) < 3 * radius:
            continue  # a link inside one junction box
        near = [centre[c] for c in (first, last) if c is not None]
        interior = [
            n for n in path[1:-1] if all(_dist(net.pos[n], c) >= 0.75 * radius for c in near)
        ]
        start = path[0] if first is None else first
        end = path[-1] if last is None else last
        rebuilt.append(([start, *interior, end], net.segs[_key(path[0], path[1])]))
    net.segs = {}
    net.pos.update(centre)
    for path, way in rebuilt:
        for x, y in pairwise(path):
            net.add_seg(x, y, way)
    net.drop_unused_nodes()


def _sample(points: list[Point], step: float) -> Iterator[tuple[Point, Point]]:
    """Points every `step` metres along a polyline (interior only) with the local direction."""
    total = sum(_dist(a, b) for a, b in pairwise(points))
    walked = 0.0
    for a, b in pairwise(points):
        length = _dist(a, b)
        if length == 0:
            continue
        direction = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
        offset = step - (walked % step)
        while offset < length:
            if 0.1 * total < walked + offset < 0.9 * total:
                yield (a[0] + direction[0] * offset, a[1] + direction[1] * offset), direction
            offset += step
        walked += length


def _is_shadowed(net: _Network, path: list[int], others: list[tuple[int, int]]) -> bool:
    """True if every sample of `path` runs alongside (close, parallel) one of `others`."""
    samples = list(_sample([net.pos[n] for n in path], 4.0))
    if not samples:
        return False
    for p, direction in samples:
        alongside = False
        for a, b in others:
            pa, pb = net.pos[a], net.pos[b]
            seg_len = _dist(pa, pb)
            t, foot = _project_on_segment(p, pa, pb)
            if seg_len == 0 or not 0 < t < 1 or _dist(p, foot) > PARALLEL_CARRIAGEWAY_M:
                continue
            cos = abs(direction[0] * (pb[0] - pa[0]) + direction[1] * (pb[1] - pa[1])) / seg_len
            if cos > math.cos(math.radians(35)):
                alongside = True
                break
        if not alongside:
            return False
    return True


def _fold_parallel_carriageways(net: _Network) -> None:
    """Fold one-way carriageways that run alongside a same-name street (dual carriageways) into
    that street, one pass at a time until nothing is left to fold."""
    folded = True
    while folded:
        folded = False
        for path in sorted(net.chains(), key=lambda p: (-net.path_length(p), p)):
            if any(_key(a, b) not in net.segs for a, b in pairwise(path)):
                continue  # changed by a fold earlier in this pass
            way = net.segs[_key(path[0], path[1])]
            if not way.oneway or not way.name or net.path_length(path) < 10:
                continue
            own = {_key(a, b) for a, b in pairwise(path)}
            others = [k for k, w in net.segs.items() if w.name == way.name and k not in own]
            if _is_shadowed(net, path, others):
                _fold(net, path, way.name)
                folded = True
    net.drop_unused_nodes()


def _fold(net: _Network, path: list[int], name: str) -> None:
    """Remove one carriageway and move its end junctions onto the parallel one, so side
    streets and the street's own continuation stay connected."""
    into = {
        path[0]: _unit(net.pos[path[0]], net.pos[path[1]]),
        path[-1]: _unit(net.pos[path[-1]], net.pos[path[-2]]),
    }
    for a, b in pairwise(path):
        net.segs.pop(_key(a, b), None)
    for end, direction in into.items():
        attached = any(end in k for k in net.segs)
        if not attached or _has_fork_partner(net, end, name, direction):
            continue
        best: tuple[tuple[int, int], Point, float] | None = None
        for key, way in net.segs.items():
            if way.name != name or end in key:
                continue
            _, foot = _project_on_segment(net.pos[end], net.pos[key[0]], net.pos[key[1]])
            d = _dist(net.pos[end], foot)
            if d <= PARALLEL_CARRIAGEWAY_M and (best is None or d < best[2]):
                best = (key, foot, d)
        if best is not None:
            net.merge_into(end, net.split(best[0], best[1]))


def _unit(a: Point, b: Point) -> Point:
    length = _dist(a, b) or 1.0
    return (b[0] - a[0]) / length, (b[1] - a[1]) / length


def _has_fork_partner(net: _Network, node: int, name: str, direction: Point) -> bool:
    """True if a same-name segment leaves `node` in about `direction`: the node is where the
    two carriageways split, so it already lies on the surviving one."""
    for key, way in net.segs.items():
        if node not in key or way.name != name:
            continue
        other = key[0] if key[1] == node else key[1]
        d = _unit(net.pos[node], net.pos[other])
        if d[0] * direction[0] + d[1] * direction[1] > math.cos(math.radians(45)):
            return True
    return False


def _simplify(net: _Network, tolerance: float) -> None:
    for path in net.chains():
        if len(path) <= 2 or path[0] == path[-1]:
            continue
        keep = _douglas_peucker([net.pos[n] for n in path], tolerance)
        if len(keep) == len(path):
            continue
        way = net.segs[_key(path[0], path[1])]
        for a, b in pairwise(path):
            net.segs.pop(_key(a, b), None)
        kept = [path[i] for i in keep]
        for a, b in pairwise(kept):
            net.add_seg(a, b, way)
    net.drop_unused_nodes()


def _clip(net: _Network, bounds: Bounds) -> None:
    for (a, b), way in list(net.segs.items()):
        pa, pb = net.pos[a], net.pos[b]
        if _inside(pa, bounds) and _inside(pb, bounds):
            continue
        del net.segs[(a, b)]
        clipped = _clip_segment(pa, pb, bounds)
        if clipped is None or _dist(*clipped) < 0.05:
            continue
        na = a if _inside(pa, bounds) else net.add_node(clipped[0])
        nb = b if _inside(pb, bounds) else net.add_node(clipped[1])
        net.add_seg(na, nb, way)
    net.drop_unused_nodes()


def _crossing_node(net: _Network, p: Point, ends: tuple[int, ...], created: list[int]) -> int:
    near = [n for n in (*ends, *created) if _dist(net.pos[n], p) <= CROSSING_SNAP_M]
    if near:
        return min(near, key=lambda n: _dist(net.pos[n], p))
    node = net.add_node(p)
    created.append(node)
    return node


def _planarize(net: _Network) -> None:
    """Insert a shared vertex wherever two segments cross or touch."""
    keys = sorted(net.segs)
    pad = CROSSING_TOUCH_M
    boxes = []
    for a, b in keys:
        (x1, z1), (x2, z2) = net.pos[a], net.pos[b]
        boxes.append((min(x1, x2) - pad, min(z1, z2) - pad, max(x1, x2) + pad, max(z1, z2) + pad))
    cuts: dict[tuple[int, int], list[tuple[float, int]]] = defaultdict(list)
    created: list[int] = []
    for i, ka in enumerate(keys):
        for j in range(i + 1, len(keys)):
            kb = keys[j]
            ba, bb = boxes[i], boxes[j]
            if ba[0] > bb[2] or bb[0] > ba[2] or ba[1] > bb[3] or bb[1] > ba[3]:
                continue
            if set(ka) & set(kb):
                continue
            hit = _intersection(net.pos[ka[0]], net.pos[ka[1]], net.pos[kb[0]], net.pos[kb[1]])
            if hit is None:
                continue
            t, u, p = hit
            node = _crossing_node(net, p, (*ka, *kb), created)
            if node not in ka:
                cuts[ka].append((t, node))
            if node not in kb:
                cuts[kb].append((u, node))
    for key, points in cuts.items():
        way = net.segs.pop(key)
        ordered = [key[0], *[n for _, n in sorted(set(points))], key[1]]
        for x, y in pairwise(ordered):
            net.add_seg(x, y, way)


def _join_dead_ends(net: _Network, bounds: Bounds) -> None:
    """Join dead ends that stop just short of another street (mapping gaps, clipping)."""
    for node in list(net.adjacency()):
        adj = net.adjacency()
        if node not in adj or len(adj[node]) != 1 or on_edge(net.pos[node], bounds):
            continue
        neighbour = adj[node][0]
        exclude = {node, neighbour, *adj[neighbour]}
        nearest = net.nearest_segment(net.pos[node], exclude=exclude)
        if nearest is None or nearest[2] > DEAD_END_JOIN_M:
            continue
        target = net.split(nearest[0], nearest[1])
        if target != node:
            net.merge_into(node, target)


def _merge_close_nodes(net: _Network, radius: float, bounds: Bounds) -> None:
    nodes = list(net.adjacency())
    uf = _UnionFind()
    for a, b in _close_pairs(nodes, net.pos, radius):
        uf.union(a, b)
    for members in uf.groups(nodes):
        if len(members) == 1:
            continue
        root = members[0]
        on_boundary = [m for m in members if on_edge(net.pos[m], bounds)]
        if on_boundary:
            net.pos[root] = net.pos[on_boundary[0]]
        else:
            net.pos[root] = (
                sum(net.pos[m][0] for m in members) / len(members),
                sum(net.pos[m][1] for m in members) / len(members),
            )
        for m in members[1:]:
            net.merge_into(m, root)


def _drop_edge_runs(net: _Network, bounds: Bounds) -> None:
    """Remove segments lying on the boundary itself (a street clipped along the map edge)."""
    for a, b in list(net.segs):
        pa, pb = net.pos[a], net.pos[b]
        if any(
            _edge_at(pa[i], edges) is not None and abs(pa[i] - pb[i]) < 1e-6
            for i, edges in enumerate(_edges(bounds))
        ):
            del net.segs[(a, b)]
    net.drop_unused_nodes()


def _keep_largest_component(net: _Network) -> list[str]:
    """Drop every piece not connected to the largest one; returns the dropped street names."""
    adj = net.adjacency()
    components = _components(adj, adj)
    if len(components) <= 1:
        return []
    keep = max(components, key=len)
    dropped = sorted({w.name or w.highway for k, w in net.segs.items() if k[0] not in keep})
    net.segs = {k: w for k, w in net.segs.items() if k[0] in keep}
    net.drop_unused_nodes()
    return dropped


def _prune_stubs(net: _Network, bounds: Bounds) -> None:
    for _ in range(3):
        adj = net.adjacency()
        stubs = [
            (n, nbrs[0])
            for n, nbrs in adj.items()
            if len(nbrs) == 1
            and not on_edge(net.pos[n], bounds)
            and len(adj[nbrs[0]]) >= 3
            and _dist(net.pos[n], net.pos[nbrs[0]]) < STUB_MAX_M
        ]
        if not stubs:
            return
        for n, m in stubs:
            net.segs.pop(_key(n, m), None)
        net.drop_unused_nodes()


@dataclass
class StreetNetworkReport:
    dropped_disconnected: list[str]


def build_street_network(osm: OsmData, proj: Projection) -> tuple[_Network, StreetNetworkReport]:
    """Walkable OSM highways -> a connected, planar network inside the bounds."""
    net = _raw_network(osm, proj)
    _merge_junctions(net, JUNCTION_MERGE_M)
    _simplify(net, SIMPLIFY_TOLERANCE_M)
    _clip(net, BOUNDS)
    _fold_parallel_carriageways(net)
    _planarize(net)
    _join_dead_ends(net, BOUNDS)
    _merge_close_nodes(net, CROSSING_SNAP_M, BOUNDS)
    _drop_edge_runs(net, BOUNDS)
    dropped = _keep_largest_component(net)
    _prune_stubs(net, BOUNDS)
    if not net.segs:
        raise MapBuildError("no walkable streets inside the bounds")
    return net, StreetNetworkReport(dropped_disconnected=dropped)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _turn(prev: Point, at: Point, nxt: Point) -> float:
    """Turn angle in degrees at `at` (0 = straight on)."""
    a = math.atan2(at[1] - prev[1], at[0] - prev[0])
    b = math.atan2(nxt[1] - at[1], nxt[0] - at[0])
    return abs(math.degrees((b - a + math.pi) % (2 * math.pi) - math.pi))


def _assemble_streets(net: _Network) -> list[Street]:
    """Join chains of the same street (name and width) through junctions, straightest first."""
    chains = net.chains()
    keys = [(net.segs[_key(p[0], p[1])].name, net.segs[_key(p[0], p[1])].width) for p in chains]
    joiner = _ChainJoiner(net, chains, keys)
    order = sorted(
        range(len(chains)), key=lambda i: (-keys[i][1], keys[i][0], -net.path_length(chains[i]))
    )
    streets: list[Street] = []
    counts: Counter[str] = Counter()
    for i in order:
        line = joiner.street_through(i)
        if line is None:
            continue
        name, width = keys[i]
        base = _slug(name) or "unnamed"
        counts[base] += 1
        sid = base if counts[base] == 1 else f"{base}-{counts[base]}"
        streets.append(Street(id=sid, name=name, points=[net.pos[n] for n in line], width=width))
    return streets


class _ChainJoiner:
    """Greedy street assembly: each chain is used once, extended at both ends by the
    straightest unused chain of the same street."""

    def __init__(
        self, net: _Network, chains: list[list[int]], keys: list[tuple[str, float]]
    ) -> None:
        self.net, self.chains, self.keys = net, chains, keys
        self.used = [False] * len(chains)
        self.by_end: dict[int, list[int]] = defaultdict(list)
        for i, path in enumerate(chains):
            self.by_end[path[0]].append(i)
            self.by_end[path[-1]].append(i)

    def street_through(self, i: int) -> list[int] | None:
        if self.used[i]:
            return None
        self.used[i] = True
        line = list(self.chains[i])
        for _ in range(2):
            line = self._extend(line, self.keys[i])
            line.reverse()
        return line

    def _extend(self, line: list[int], key: tuple[str, float]) -> list[int]:
        pos = self.net.pos
        while True:
            end, prev = line[-1], line[-2]
            best: tuple[float, int, list[int]] | None = None
            for j in self.by_end[end]:
                if self.used[j] or self.keys[j] != key:
                    continue
                path = self.chains[j] if self.chains[j][0] == end else self.chains[j][::-1]
                angle = _turn(pos[prev], pos[end], pos[path[1]])
                if angle <= 100 and (best is None or angle < best[0]):
                    best = (angle, j, path)
            if best is None:
                return line
            self.used[best[1]] = True
            line = line + best[2][1:]


# --- walk graph (the sim's view of map.json streets) ----------------------------------------


class WalkGraph:
    """Walk graph built the way the sim builds it from map.json: one node per distinct street
    point, one edge per consecutive pair of points, so streets connect only at shared points."""

    def __init__(self, segments: Iterable[tuple[Point, Point]]) -> None:
        self.points: list[Point] = []
        self.adj: list[dict[int, float]] = []
        self.edges: list[tuple[int, int]] = []
        self._index: dict[Point, int] = {}
        for a, b in segments:
            i, j = self._node(a), self._node(b)
            if i != j:
                length = _dist(a, b)
                self.adj[i][j] = self.adj[j][i] = length
                self.edges.append((i, j))

    @classmethod
    def from_streets(cls, streets: Iterable[Street]) -> WalkGraph:
        return cls(((a[0], a[1]), (b[0], b[1])) for s in streets for a, b in pairwise(s.points))

    def _node(self, p: Point) -> int:
        if p not in self._index:
            self._index[p] = len(self.points)
            self.points.append(p)
            self.adj.append({})
        return self._index[p]

    def components(self) -> list[set[int]]:
        return _components(range(len(self.points)), self.adj)

    def nearest(self, p: Point) -> tuple[int, int, Point, float]:
        """Closest point of the network to p: (edge end i, edge end j, foot, distance)."""
        best: tuple[int, int, Point, float] | None = None
        for i, j in self.edges:
            _, foot = _project_on_segment(p, self.points[i], self.points[j])
            d = _dist(p, foot)
            if best is None or d < best[3]:
                best = (i, j, foot, d)
        if best is None:
            raise ValueError("empty walk graph")
        return best

    def walk_distance(self, p: Point, q: Point) -> float:
        """Metres along streets between the doors of p and q (each door = nearest street point)."""
        i, j, foot_p, _ = self.nearest(p)
        k, m, foot_q, _ = self.nearest(q)
        if {i, j} == {k, m}:
            return _dist(foot_p, foot_q)
        dist = {i: _dist(foot_p, self.points[i]), j: _dist(foot_p, self.points[j])}
        heap = [(d, n) for n, d in dist.items()]
        heapq.heapify(heap)
        targets = {k: _dist(self.points[k], foot_q), m: _dist(self.points[m], foot_q)}
        best = math.inf
        while heap:
            d, n = heapq.heappop(heap)
            if d > dist.get(n, math.inf) or d >= best:
                continue
            if n in targets:
                best = min(best, d + targets[n])
            for nxt, length in self.adj[n].items():
                if d + length < dist.get(nxt, math.inf):
                    dist[nxt] = d + length
                    heapq.heappush(heap, (d + length, nxt))
        return best


# --- buildings ------------------------------------------------------------------------------


@dataclass
class Footprint:
    key: str  # "way/123" or "relation/456#0"
    tags: dict[str, str]
    ring: list[Point]
    area: float
    part_height: float | None = None  # tallest building:part inside the outline, in metres

    @property
    def centroid(self) -> Point:
        minx, minz, maxx, maxz = self.bbox
        return (minx + maxx) / 2, (minz + maxz) / 2

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.ring]
        zs = [p[1] for p in self.ring]
        return min(xs), min(zs), max(xs), max(zs)

    def box(self) -> Box | None:
        """Axis-aligned box with the footprint's area, clipped to the bounds (None if too thin).

        A rotated footprint's bounding box can be twice its area; scaling the box down to the
        true area keeps neighbouring boxes from swallowing each other and the streets.
        """
        minx, minz, maxx, maxz = self.bbox
        bw, bd = maxx - minx, maxz - minz
        scale = min(1.0, math.sqrt(self.area / (bw * bd))) if bw * bd > 0 else 1.0
        cx, cz = (minx + maxx) / 2, (minz + maxz) / 2
        if not _inside((cx, cz)):
            return None
        return _clip_box((cx, cz, bw * scale, bd * scale))


Corridor = tuple[Point, Point, float]  # street segment and how far buildings must keep from it


def _street_corridors(net: _Network) -> list[Corridor]:
    return [
        (net.pos[a], net.pos[b], way.width / 2 + STREET_CLEARANCE_M)
        for (a, b), way in sorted(net.segs.items())
    ]


def segment_box_distance(a: Point, b: Point, box: Box) -> float:
    """Shortest distance between segment ab and an axis-aligned box (0 when they overlap)."""
    cx, cz, w, d = box
    x0, z0, x1, z1 = cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2
    if _clip_to_rect(a, b, (x0, z0, x1, z1)) is not None:
        return 0.0

    def to_box(p: Point) -> float:
        return math.hypot(max(x0 - p[0], 0.0, p[0] - x1), max(z0 - p[1], 0.0, p[1] - z1))

    corners = ((x0, z0), (x1, z0), (x1, z1), (x0, z1))
    return min(to_box(a), to_box(b), *(_dist(c, _project_on_segment(c, a, b)[1]) for c in corners))


def _shrink(box: Box, side: int, step: float) -> Box:
    """Move one side inwards by step: 0 west, 1 east, 2 south, 3 north."""
    cx, cz, w, d = box
    if side < 2:
        return cx + (step / 2 if side == 0 else -step / 2), cz, w - step, d
    return cx, cz + (step / 2 if side == 2 else -step / 2), w, d - step


def clear_of_streets(box: Box, corridors: list[Corridor], min_area_share: float) -> Box | None:
    """Pull the box's sides back until no carriageway (plus pavement) runs into it.

    Axis-aligned boxes for buildings along diagonal streets otherwise sit on the road. Each step
    moves the side that best frees the worst-hit street by CLEARANCE_STEP_M. Returns None when
    the box would keep less than min_area_share of its area or get thinner than a building.
    """
    reach_max = max((r for _, _, r in corridors), default=0.0)
    cx, cz, w, d = box
    near = [
        c
        for c in corridors
        if min(c[0][0], c[1][0]) - reach_max <= cx + w / 2
        and max(c[0][0], c[1][0]) + reach_max >= cx - w / 2
        and min(c[0][1], c[1][1]) - reach_max <= cz + d / 2
        and max(c[0][1], c[1][1]) + reach_max >= cz - d / 2
    ]
    area = w * d
    for _ in range(400):
        hits = [(segment_box_distance(a, b, box) - r, a, b) for a, b, r in near]
        worst = min(hits, default=None)
        if worst is None or worst[0] >= -1e-9:
            return box
        _, a, b = worst
        options = [_shrink(box, side, CLEARANCE_STEP_M) for side in range(4)]
        box = max(options, key=lambda o: (segment_box_distance(a, b, o), -_side_gap(box, o, a, b)))
        if min(box[2], box[3]) < MIN_BUILDING_SIDE_M or box[2] * box[3] < min_area_share * area:
            return None
    return None


def _side_gap(before: Box, after: Box, a: Point, b: Point) -> float:
    """Distance from the street to the strip a shrink removed (smaller = facing the street)."""
    bx, bz, bw, bd = before
    ax, az, aw, ad = after
    if aw != bw:
        strip_x = bx - bw / 2 + 0.25 if ax > bx else bx + bw / 2 - 0.25
        strip = (strip_x, bz, 0.5, bd)
    else:
        strip_z = bz - bd / 2 + 0.25 if az > bz else bz + bd / 2 - 0.25
        strip = (bx, strip_z, bw, 0.5)
    return segment_box_distance(a, b, strip)


def _clip_box(box: Box) -> Box | None:
    cx, cz, w, d = box
    x0, x1 = max(BOUNDS.minX, cx - w / 2), min(BOUNDS.maxX, cx + w / 2)
    z0, z1 = max(BOUNDS.minZ, cz - d / 2), min(BOUNDS.maxZ, cz + d / 2)
    if x1 - x0 < MIN_BUILDING_SIDE_M or z1 - z0 < MIN_BUILDING_SIDE_M:
        return None
    return (x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0


def _ring(node_ids: list[int], osm: OsmData, proj: Projection) -> list[Point] | None:
    if len(node_ids) < 4 or node_ids[0] != node_ids[-1]:
        return None
    if any(n not in osm.nodes for n in node_ids):
        return None
    return [proj.to_local(*osm.nodes[n]) for n in node_ids[:-1]]


def _join_rings(parts: list[list[int]]) -> list[list[int]]:
    """Join open member ways that share end nodes into closed rings."""
    rings: list[list[int]] = []
    open_parts = [list(p) for p in parts if p]
    while open_parts:
        ring = open_parts.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for part in open_parts:
                if part[0] == ring[-1]:
                    ring += part[1:]
                elif part[-1] == ring[-1]:
                    ring += part[::-1][1:]
                else:
                    continue
                open_parts.remove(part)
                changed = True
                break
        if ring[0] == ring[-1]:
            rings.append(ring)
    return rings


def footprints(osm: OsmData, proj: Projection) -> list[Footprint]:
    """Building outlines (closed ways and multipolygon outer rings) in local metres."""
    found: list[Footprint] = []
    for way in sorted(osm.ways.values(), key=lambda w: w.id):
        if "building" not in way.tags or way.tags["building"] in SKIPPED_BUILDINGS:
            continue
        ring = _ring(way.nodes, osm, proj)
        if ring:
            found.append(Footprint(f"way/{way.id}", way.tags, ring, _polygon_area(ring)))
    for relation in osm.relations:
        tags = relation.get("tags", {})
        if "building" not in tags or tags["building"] in SKIPPED_BUILDINGS:
            continue
        outers = [
            osm.ways[m["ref"]].nodes
            for m in relation.get("members", [])
            if m.get("type") == "way" and m.get("role") == "outer" and m["ref"] in osm.ways
        ]
        for index, node_ids in enumerate(_join_rings(outers)):
            ring = _ring(node_ids, osm, proj)
            if ring:
                key = f"relation/{relation['id']}#{index}"
                found.append(Footprint(key, tags, ring, _polygon_area(ring)))
    _attach_part_heights(found, osm, proj)
    return found


def _attach_part_heights(found: list[Footprint], osm: OsmData, proj: Projection) -> None:
    """Towers are often mapped as a low outline plus building:part ways carrying the real
    height: give each outline the height of the tallest part whose centre lies inside it."""
    cell = 50.0
    grid: dict[tuple[int, int], list[tuple[Point, float]]] = defaultdict(list)
    for way in osm.ways.values():
        if way.tags.get("building:part", "no") in SKIPPED_BUILDINGS:
            continue
        height = tagged_height(way.tags)
        ring = _ring(way.nodes, osm, proj)
        if height is None or not ring:
            continue
        centre = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
        grid[(math.floor(centre[0] / cell), math.floor(centre[1] / cell))].append((centre, height))
    if not grid:
        return
    for fp in found:
        minx, minz, maxx, maxz = fp.bbox
        best: float | None = None
        for gx in range(math.floor(minx / cell), math.floor(maxx / cell) + 1):
            for gz in range(math.floor(minz / cell), math.floor(maxz / cell) + 1):
                for centre, height in grid.get((gx, gz), ()):
                    if (best is None or height > best) and _point_in_polygon(centre, fp.ring):
                        best = height
        fp.part_height = best


def _landuse_areas(osm: OsmData, proj: Projection) -> list[tuple[str, list[Point]]]:
    areas = []
    for way in sorted(osm.ways.values(), key=lambda w: w.id):
        use = way.tags.get("landuse")
        ring = _ring(way.nodes, osm, proj) if use else None
        if use and ring:
            areas.append((use, ring))
    return areas


def _number(value: str | None) -> float | None:
    match = re.match(r"\s*(\d+(?:\.\d+)?)", value or "")
    return float(match.group(1)) if match else None


def tagged_height(tags: dict[str, str]) -> float | None:
    """height tag, else (building:levels + roof:levels) x LEVEL_HEIGHT_M, else None."""
    height = _number(tags.get("height"))
    if height is None:
        levels = _number(tags.get("building:levels"))
        roof = _number(tags.get("roof:levels")) or 0.0
        height = (levels + roof) * LEVEL_HEIGHT_M if levels else None
    return height or None


def building_height(
    tags: dict[str, str], kind: BuildingKind, part_height: float | None = None
) -> float:
    """The taller of the outline's own height (tagged_height) and its tallest building:part,
    else the default for the kind; clamped to 3 m .. MAX_HEIGHT_M."""
    heights = [h for h in (tagged_height(tags), part_height) if h]
    height = max(heights) if heights else DEFAULT_HEIGHT_M[kind]
    return round(min(MAX_HEIGHT_M, max(3.0, height)), 1)


def _building_kind(
    fp: Footprint, landuse: list[tuple[str, list[Point]]], office_points: list[Point]
) -> BuildingKind:
    tag = fp.tags.get("building", "yes")
    if tag in RESIDENTIAL_BUILDINGS:
        return "residential"
    if tag != "yes":
        return "office"  # office, commercial, retail, industrial, hotel, school, ...
    if any(_point_in_polygon(p, fp.ring) for p in office_points):
        return "office"
    box = fp.box()
    centre = (box[0], box[1]) if box else fp.ring[0]
    for use, ring in landuse:
        if _point_in_polygon(centre, ring):
            if use in RESIDENTIAL_LANDUSE:
                return "residential"
            if use in WORK_LANDUSE:
                return "office"
    return "office"


# --- opening hours and licences -------------------------------------------------------------

_DAY_TOKENS = ("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su")
_DAY = r"(?:Mo|Tu|We|Th|Fr|Sa|Su)"
_DAY_SELECTOR = re.compile(
    rf"^({_DAY}(?:\s*-\s*{_DAY})?(?:\s*,\s*{_DAY}(?:\s*-\s*{_DAY})?)*)\b(.*)$"
)
_TIME_SPAN = re.compile(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})")
# Rules are separated by ";", and some mappers use ", " before the next day selector.
_RULE_SPLIT = re.compile(r";|(?<=\d),\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)")


def _days(selector: str) -> list[int]:
    days: list[int] = []
    for part in selector.split(","):
        bounds = [s.strip() for s in part.split("-")]
        first = _DAY_TOKENS.index(bounds[0])
        last = _DAY_TOKENS.index(bounds[-1])
        days += [(first + k) % 7 for k in range((last - first) % 7 + 1)]
    return days


def _parse_rule(rule: str) -> tuple[list[int], list[tuple[int, int]]] | None:
    rule = rule.strip()
    match = _DAY_SELECTOR.match(rule)
    if match:
        days, rest = _days(match.group(1)), match.group(2)
    elif rule[:1].isdigit():
        days, rest = list(range(7)), rule
    else:
        return None  # public holidays, months, week numbers: not modelled
    if re.search(r"\b(off|closed)\b", rest):
        return days, []
    spans = []
    for h1, m1, h2, m2 in _TIME_SPAN.findall(rest):
        start, end = int(h1) * 60 + int(m1), int(h2) * 60 + int(m2)
        if start >= timeutil.MINUTES_PER_DAY or end > timeutil.MINUTES_PER_DAY:
            continue
        spans.append((start, end + timeutil.MINUTES_PER_DAY if end <= start else end))
    return (days, spans) if spans else None


def _daily_window(spans: list[tuple[int, int]]) -> tuple[int, int]:
    spans = sorted(spans)
    # "00:00-01:00,18:00-24:00": the early span is the previous night's tail; fold it into the
    # evening so the window reads 18:00-01:00.
    if len(spans) > 1 and spans[0][0] == 0 and spans[0][1] <= 360 and spans[-1][1] == 1440:
        tail = spans.pop(0)
        spans[-1] = (spans[-1][0], 1440 + tail[1])
    return spans[0][0], max(end for _, end in spans)


def _week(text: str) -> dict[int, list[tuple[int, int]]]:
    """Opening spans per weekday (0 = Monday); later rules override earlier ones, as in OSM."""
    week: dict[int, list[tuple[int, int]]] = {}
    for rule in _RULE_SPLIT.split(text.strip().replace("\u2013", "-")):
        parsed = _parse_rule(rule)
        if parsed is not None:
            for day in parsed[0]:
                week[day] = parsed[1]
    return week


def _round_half_hour(minutes: int) -> int:
    return math.floor(minutes / 30 + 0.5) * 30


def parse_opening_hours(value: str | None) -> tuple[str, str] | None:
    """One typical daily window ("HH:MM", "HH:MM") from an OSM opening_hours value.

    Takes the window that applies on the most days (ties: the earliest such day in the week),
    joins split shifts (12:00-15:00,17:00-22:00 -> 12:00-22:00) and rounds to 30-minute steps.
    open == close means 24 hours (timeutil). Returns None when nothing usable is found.
    """
    text = (value or "").strip().replace("–", "-")
    if not text:
        return None
    if text.lower() == "24/7":
        return "00:00", "00:00"
    week = _week(text)
    windows = Counter(_daily_window(spans) for _, spans in sorted(week.items()) if spans)
    if not windows:
        return None
    (start, end), _ = windows.most_common(1)[0]
    open_m, close_m = _round_half_hour(start), _round_half_hour(end)
    if close_m - open_m < 60:
        return None
    if close_m - open_m >= timeutil.MINUTES_PER_DAY:
        close_m = open_m
    return timeutil.to_hhmm(open_m), timeutil.to_hhmm(close_m)


def _window_span(window: tuple[str, str]) -> tuple[int, int]:
    start = timeutil.to_minutes(window[0])
    length = (timeutil.to_minutes(window[1]) - start) % timeutil.MINUTES_PER_DAY
    return start, start + (length or timeutil.MINUTES_PER_DAY)


def widen_licence(licence: tuple[str, str], trading: tuple[str, str]) -> tuple[str, str]:
    """The licence window, widened as little as possible so it contains the trading window."""
    if timeutil.window_within(trading, licence):
        return licence
    l_start, l_end = _window_span(licence)
    t_start, t_end = _window_span(trading)
    options = []
    for shift in (-timeutil.MINUTES_PER_DAY, 0, timeutil.MINUTES_PER_DAY):
        start, end = min(l_start, t_start + shift), max(l_end, t_end + shift)
        options.append((end - start, start, end))
    _, start, end = min(options)
    if end - start >= timeutil.MINUTES_PER_DAY:
        return timeutil.to_hhmm(start), timeutil.to_hhmm(start)
    return timeutil.to_hhmm(start), timeutil.to_hhmm(end)


def closes_before_midnight(window: tuple[str, str]) -> bool:
    start, end = timeutil.to_minutes(window[0]), timeutil.to_minutes(window[1])
    return 0 < end and start < end


def _latest_close(value: str | None) -> tuple[int, int] | None:
    """(latest close in minutes after noon, days reaching it) across the week, from OSM hours."""
    closes = [_daily_window(spans)[1] - 720 for spans in _week(value or "").values() if spans]
    if not closes:
        return None
    latest = max(closes)
    return latest, closes.count(latest)


# --- venues and stores ----------------------------------------------------------------------


@dataclass
class Venue:
    osm_key: str
    name: str
    type: StoreType
    opening_hours: str | None
    footprint: Footprint | None  # None -> synthetic box at the venue
    shares_building: bool  # nested inside another building, or one tenant of a big one
    box: Box

    @property
    def centre(self) -> Point:
        return self.box[0], self.box[1]

    @property
    def floor_area(self) -> float:
        return self.footprint.area if self.footprint else self.box[2] * self.box[3]


def _venue_type(tags: dict[str, str]) -> StoreType | None:
    amenity = tags.get("amenity")
    if amenity in AMENITY_TYPES:
        return AMENITY_TYPES[amenity]
    shop = tags.get("shop")
    if not shop or shop in SKIPPED_SHOPS:
        return None
    return "offlicence" if shop in OFFLICENCE_SHOPS else "shop"


def _venue_elements(
    osm: OsmData, proj: Projection
) -> Iterator[tuple[str, dict[str, str], Point, list[Point] | None]]:
    for node_id, tags in sorted(osm.node_tags.items()):
        yield f"node/{node_id}", tags, proj.to_local(*osm.nodes[node_id]), None
    for way in sorted(osm.ways.values(), key=lambda w: w.id):
        if _venue_type(way.tags) is None:
            continue
        ring = _ring(way.nodes, osm, proj)
        points = ring or [proj.to_local(*osm.nodes[n]) for n in way.nodes if n in osm.nodes]
        if points:
            centre = (
                sum(p[0] for p in points) / len(points),
                sum(p[1] for p in points) / len(points),
            )
            yield f"way/{way.id}", way.tags, centre, ring


def _resolve_footprint(
    key: str,
    tags: dict[str, str],
    point: Point,
    ring: list[Point] | None,
    buildings: list[Footprint],
) -> tuple[Footprint | None, bool]:
    """The venue's outline: its own area, else the building containing it, else the nearest
    building within 4 m. Returns (footprint or None, shares a building?): a venue nested inside
    another building, or one in a building bigger than any store (a tenant mapped on the whole
    block), would turn a block into one shop, so those are used only when nothing else is left."""
    if ring:
        own = Footprint(key, tags, ring, _polygon_area(ring))
        nested = "building" not in tags and any(
            _point_in_polygon(point, fp.ring) for fp in buildings
        )
        return own, nested or own.area > FLOOR_AREA_RANGE_M2[1]
    containing = [fp for fp in buildings if _point_in_polygon(point, fp.ring)]
    if containing:
        fp = min(containing, key=lambda fp: fp.area)
        return fp, fp.area > FLOOR_AREA_RANGE_M2[1]
    near = [(d, fp.key, fp) for fp in buildings if (d := _distance_to_ring(point, fp.ring)) <= 4]
    if near:
        fp = min(near)[2]
        return fp, fp.area > FLOOR_AREA_RANGE_M2[1]
    return None, False


def _synthetic_box(point: Point, net: _Network) -> Box | None:
    """A small store box at the venue, pushed back so it does not sit on the carriageway."""
    w, d = SYNTHETIC_BOX_M
    nearest = net.nearest_segment(point)
    if nearest is None:
        return _clip_box((point[0], point[1], w, d))
    key, foot, dist = nearest
    clearance = net.segs[key].width / 2 + 1 + max(w, d) / 2
    if 0 < dist < clearance:
        scale = clearance / dist
        point = (foot[0] + (point[0] - foot[0]) * scale, foot[1] + (point[1] - foot[1]) * scale)
    return _clip_box((point[0], point[1], w, d))


def venue_candidates(
    osm: OsmData,
    proj: Projection,
    buildings: list[Footprint],
    station_fp: Footprint | None,
    net: _Network,
    reserved: frozenset[str] = frozenset(),
) -> list[Venue]:
    """Named cafes, restaurants, takeaways, bars, shops, off-licences and clubs in the bounds.
    Venues in the station's or a `reserved` footprint (a landmark's building) are skipped."""
    corridors = _street_corridors(net)
    reserved_fps = [fp for fp in buildings if fp.key in reserved]
    venues: list[Venue] = []
    for key, tags, point, ring in _venue_elements(osm, proj):
        store_type = _venue_type(tags)
        name = tags.get("name", "").strip()
        if store_type is None or not name or not _inside(point, inset=5.0):
            continue
        if name.lower() in CLOSED_VENUES:
            continue
        fp, shares_building = _resolve_footprint(key, tags, point, ring, buildings)
        if fp is not None and station_fp is not None and fp.key == station_fp.key:
            continue
        if (fp is not None and fp.key in reserved) or any(
            _point_in_polygon(point, r.ring) for r in reserved_fps
        ):
            continue
        box = fp.box() if fp else _synthetic_box(point, net)
        box = clear_of_streets(box, corridors, STORE_MIN_AREA_SHARE) if box else None
        nearest = net.nearest_segment((box[0], box[1])) if box else None
        if box is None or nearest is None or nearest[2] > MAX_DOOR_DISTANCE_M:
            continue
        hours_tag = tags.get("opening_hours")
        venues.append(Venue(key, name, store_type, hours_tag, fp, shares_building, box))
    return venues


def _conflicts(a: Venue, b: Venue) -> bool:
    """Two venues cannot both be stores if they would share or nest one building."""
    if a.footprint and b.footprint and a.footprint.key == b.footprint.key:
        return True
    if a.footprint and _point_in_polygon(b.centre, a.footprint.ring):
        return True
    if b.footprint and _point_in_polygon(a.centre, b.footprint.ring):
        return True
    return _boxes_overlap(a.box, b.box)


def _boxes_overlap(a: Box, b: Box) -> bool:
    return abs(a[0] - b[0]) < (a[2] + b[2]) / 2 and abs(a[1] - b[1]) < (a[3] + b[3]) / 2


@dataclass
class StoreSelection:
    clubs: list[Venue]
    stores: list[Venue]  # non-club stores, demo store included
    demo: Venue
    demo_club: Venue
    demo_walk_m: float
    promoted_bars: bool


def _effective_hours(venue: Venue) -> tuple[str, str]:
    return parse_opening_hours(venue.opening_hours) or DEFAULT_HOURS[venue.type]


def _licence(venue_type: StoreType, trading: tuple[str, str]) -> tuple[str, str]:
    return widen_licence(LICENSED_HOURS[venue_type], trading)


def _is_club_night(venue: Venue) -> bool:
    """A nightclub whose OSM hours never pass midnight trades as a cafe or bar (Café 1001 on
    Dray Walk: 08:00-24:00), so it would fake a 03:00 spill-out; unknown hours count as nights."""
    latest = _latest_close(venue.opening_hours)
    return latest is None or latest[0] > 720


def _pick_clubs(venues: list[Venue]) -> tuple[list[Venue], bool]:
    """Real nightclubs, largest first (the club crowd scales with floor area); late-opening
    bars stand in only when OSM has fewer than MIN_CLUBS."""
    nightclubs = [v for v in venues if v.type == "club" and _is_club_night(v)]
    clubs: list[Venue] = []
    for venue in sorted(nightclubs, key=lambda v: (-v.floor_area, v.osm_key)):
        if len(clubs) < MAX_CLUBS and not any(_conflicts(venue, c) for c in clubs):
            clubs.append(venue)
    if len(clubs) >= MIN_CLUBS:
        return clubs, False
    late: list[tuple[tuple[int, int, int], Venue]] = []
    for venue in venues:
        if venue.type != "bar":
            continue
        latest = _latest_close(venue.opening_hours)
        hours_window = parse_opening_hours(venue.opening_hours)
        if latest is None or hours_window is None or latest[0] < 720:
            continue  # only bars whose OSM hours reach midnight count as late-opening
        # Latest close first, then most late days, then the later (more club-like) opening.
        late.append(((latest[0], latest[1], timeutil.to_minutes(hours_window[0])), venue))
    late.sort(key=lambda item: (-item[0][0], -item[0][1], -item[0][2], item[1].osm_key))
    for _, venue in late:
        if len(clubs) >= MIN_CLUBS:
            break
        if not any(_conflicts(venue, c) for c in clubs):
            clubs.append(venue)
    return clubs, True


def _pick_demo(
    venues: list[Venue], clubs: list[Venue], walk: WalkGraph
) -> tuple[Venue, Venue, float] | None:
    """A takeaway that shuts before midnight but is licensed to trade until DEMO_TRADE_UNTIL,
    within DEMO_MAX_WALK_M on foot of a club: the dark shop next to the club in the demo. The
    biggest club with such a takeaway wins (its crowd makes the spill-out), then the nearest."""
    best: tuple[float, float, str, Venue, Venue] | None = None
    for venue in venues:
        if venue.type != "takeaway" or any(_conflicts(venue, c) for c in clubs):
            continue
        trading = _effective_hours(venue)
        licence = _licence(venue.type, trading)
        late_ok = timeutil.window_within((trading[0], DEMO_TRADE_UNTIL), licence)
        if not closes_before_midnight(trading) or not late_ok:
            continue
        for club in clubs:
            walk_m = walk.walk_distance(club.centre, venue.centre)
            rank = (-club.floor_area, walk_m, venue.osm_key)
            if walk_m <= DEMO_MAX_WALK_M and (best is None or rank < best[:3]):
                best = (*rank, venue, club)
    return None if best is None else (best[3], best[4], best[1])


def _fill_types(venues: list[Venue], chosen: list[Venue], taken: list[Venue]) -> list[Venue]:
    """Round-robin over the store types, each time taking the venue that best spreads the
    stores out (own building first, then spacing, then known opening hours)."""
    picked = list(chosen)
    counts = Counter(v.type for v in picked)
    progress = True
    while progress:
        progress = False
        for store_type, target in TYPE_TARGETS.items():
            if counts[store_type] >= target:
                continue
            occupied = taken + picked
            options = [
                v
                for v in venues
                if v.type == store_type and not any(_conflicts(v, o) for o in occupied)
            ]
            if not options:
                continue
            best = min(options, key=lambda v: _spread_rank(v, occupied))
            picked.append(best)
            counts[store_type] += 1
            progress = True
    return picked


def _spread_rank(venue: Venue, occupied: list[Venue]) -> tuple[bool, float, bool, str]:
    spacing = min((_dist(venue.centre, o.centre) for o in occupied), default=SPREAD_CAP_M)
    has_hours = parse_opening_hours(venue.opening_hours) is not None
    return venue.shares_building, -min(spacing, SPREAD_CAP_M), not has_hours, venue.osm_key


def select_stores(venues: list[Venue], walk: WalkGraph) -> StoreSelection:
    clubs, promoted = _pick_clubs(venues)
    if len(clubs) < MIN_CLUBS:
        raise MapBuildError(f"only {len(clubs)} club(s) or late-opening bar(s) in the bounds")
    demo = _pick_demo(venues, clubs, walk)
    if demo is None:
        raise MapBuildError(
            f"no takeaway within {DEMO_MAX_WALK_M:.0f} m of a club that closes before midnight "
            f"and is licensed until {DEMO_TRADE_UNTIL}"
        )
    stores = _fill_types([v for v in venues if v.type != "club"], [demo[0]], clubs)
    return StoreSelection(
        clubs=clubs,
        stores=stores,
        demo=demo[0],
        demo_club=demo[1],
        demo_walk_m=round(demo[2], 1),
        promoted_bars=promoted,
    )


# --- assembling map.json --------------------------------------------------------------------


def _station_footprint(buildings: list[Footprint]) -> Footprint | None:
    """The station building: a train_station footprint containing (or nearest) the origin."""
    candidates = [
        fp
        for fp in buildings
        if fp.tags.get("building") == "train_station"
        or STATION_NAME.lower() in fp.tags.get("name", "").lower()
    ]
    if not candidates:
        return None
    containing = [fp for fp in candidates if _point_in_polygon((0.0, 0.0), fp.ring)]
    if containing:
        return containing[0]
    nearest = min(candidates, key=lambda fp: _distance_to_ring((0.0, 0.0), fp.ring))
    return nearest if _distance_to_ring((0.0, 0.0), nearest.ring) < 150 else None


def _round_box(box: Box) -> Box:
    """Snap the edges inwards to a 0.2 m grid so the rounded box (centre on 0.1 m) never grows
    past the edges it had, e.g. out of the bounds after clipping."""
    cx, cz, w, d = box
    x0, x1 = math.ceil((cx - w / 2) / 0.2) * 0.2, math.floor((cx + w / 2) / 0.2) * 0.2
    z0, z1 = math.ceil((cz - d / 2) / 0.2) * 0.2, math.floor((cz + d / 2) / 0.2) * 0.2
    return round((x0 + x1) / 2, 1), round((z0 + z1) / 2, 1), round(x1 - x0, 1), round(z1 - z0, 1)


def _make_building(
    building_id: str, kind: BuildingKind, box: Box, height: float, store_id: str | None = None
) -> Building:
    x, z, w, d = _round_box(box)
    return Building(id=building_id, kind=kind, storeId=store_id, x=x, z=z, w=w, d=d, h=height)


def _store_entries(selection: StoreSelection) -> list[tuple[str, Venue]]:
    type_order = list(TYPE_TARGETS)
    stores = sorted(selection.stores, key=lambda v: (type_order.index(v.type), v.name))
    clubs = sorted(selection.clubs, key=lambda v: v.name)
    return [(f"s{i}", v) for i, v in enumerate(stores, start=1)] + [
        (f"c{i}", v) for i, v in enumerate(clubs, start=1)
    ]


def _map_store(store_id: str, building_id: str, venue: Venue) -> MapStore:
    store_type: StoreType = "club" if store_id.startswith("c") else venue.type
    parsed = parse_opening_hours(venue.opening_hours)
    trading = parsed or DEFAULT_HOURS[store_type]
    return MapStore(
        id=store_id,
        name=venue.name,
        type=store_type,
        buildingId=building_id,
        licensedHours=hours(_licence(store_type, trading)),
        defaultHours=hours(trading),
        floorArea=clamp_floor_area(venue.floor_area),
        osmId=venue.osm_key,
    )


def _other_buildings(
    buildings: list[Footprint], used: set[str], corridors: list[Corridor], budget: int
) -> list[tuple[Footprint, Box]]:
    """Non-store buildings clear of the streets, without slivers, largest first, up to budget."""
    keep: list[tuple[Footprint, Box]] = []
    for fp in buildings:
        if fp.key in used or fp.area < MIN_BUILDING_AREA_M2:
            continue
        box = fp.box()
        box = clear_of_streets(box, corridors, CITY_MIN_AREA_SHARE) if box else None
        if box is not None and not _is_sliver(box):
            keep.append((fp, box))
    keep.sort(key=lambda item: (-item[0].area, item[0].key))
    return sorted(keep[:budget], key=lambda item: item[0].key)


def _is_sliver(box: Box) -> bool:
    short, long = sorted(box[2:])
    return short < MIN_CITY_SIDE_M or long > MAX_CITY_ASPECT * short


@dataclass
class MapBuildReport:
    """What build_map did, for the console summary (map.json has no field for notes)."""

    origin: str
    demo: str
    dropped_streets: list[str]
    store_hours_from_osm: int
    notes: list[str]
    stations: list[str]


def build_map(overpass: dict[str, Any], fetched_at: str | None) -> tuple[MapData, MapBuildReport]:
    """Overpass JSON -> contract.MapData (pure: no network, no files)."""
    osm = OsmData.from_overpass(overpass)
    station = find_station(osm)
    proj = Projection(station.lat, station.lon)
    others = other_stations(osm, proj)
    net, net_report = build_street_network(osm, proj)
    buildings = footprints(osm, proj)
    station_fp = _station_footprint(buildings)
    landmark_fps, landmark_notes = _landmark_footprints(buildings)
    reserved = frozenset(fp.key for fp in landmark_fps.values())
    walk = WalkGraph(net.segment_points())
    venues = venue_candidates(osm, proj, buildings, station_fp, net, reserved)
    selection = select_stores(venues, walk)

    entries = _store_entries(selection)
    map_buildings, map_stores = _store_buildings(entries, net)
    used = {v.footprint.key for _, v in entries if v.footprint} | reserved
    station_box = station_fp.box() if station_fp else None
    station_box = station_box or SYNTHETIC_STATION_BOX
    station_height = building_height(
        station_fp.tags if station_fp else {},
        "station",
        station_fp.part_height if station_fp else None,
    )
    station_building = _make_building(
        f"b{len(map_buildings) + 1}", "station", station_box, station_height
    )
    map_buildings.append(station_building)
    if station_fp:
        used.add(station_fp.key)
    corridors = _street_corridors(net)
    city = _CityContext.of(osm, proj)
    landmark_buildings, extra_sources = _landmark_buildings(
        landmark_fps, city, corridors, net, first_index=len(map_buildings) + 1
    )
    map_buildings += list(landmark_buildings.values())
    regular = [st for st in map_stores if st.type != "club"]
    landmark_stores, landmark_store_notes, landmark_sources = _landmark_stores(
        osm, proj, landmark_fps, landmark_buildings, first_number=len(regular) + 1
    )
    map_stores = regular + landmark_stores + [st for st in map_stores if st.type == "club"]
    extra_sources += landmark_sources
    landmark_notes += landmark_store_notes
    map_buildings += _city_buildings(
        buildings, used, corridors, city, first_index=len(map_buildings) + 1
    )

    station_doors = [(STATION_NAME, _door(net, (station_box[0], station_box[1])))]
    for other in others:
        for point in _station_doors(osm, proj, other):
            door = _door(net, point)
            if (other.name, door) not in station_doors:
                station_doors.append((other.name, door))
    edge_entries = _edge_entries(net)
    for node in net.pos:
        net.pos[node] = (round(net.pos[node][0], 1), round(net.pos[node][1], 1))
    entry_points = [
        EntryPoint(id=f"e{i}", kind="street", name=name or None, x=net.pos[n][0], z=net.pos[n][1])
        for i, (n, name) in enumerate(edge_entries, start=1)
    ]
    entry_points += [
        EntryPoint(id=f"st{i}", kind="station", name=name, x=net.pos[n][0], z=net.pos[n][1])
        for i, (name, n) in enumerate(station_doors, start=1)
    ]
    data = MapData(
        bounds=BOUNDS,
        streets=_assemble_streets(net),
        buildings=map_buildings,
        stores=map_stores,
        entryPoints=entry_points,
        sources=_osm_sources(fetched_at) + extra_sources,
        landmarks=_landmarks(station_building, landmark_buildings, others, proj),
    )
    report = _report(station, others, selection, net_report, entries)
    report.notes += landmark_notes
    return data, report


def _store_buildings(
    entries: list[tuple[str, Venue]], net: _Network
) -> tuple[list[Building], list[MapStore]]:
    """One building per store (b1, b2, ...) and a door vertex on the street nearest to it."""
    buildings: list[Building] = []
    stores: list[MapStore] = []
    for index, (store_id, venue) in enumerate(entries, start=1):
        kind: BuildingKind = "club" if store_id.startswith("c") else "store"
        fp = venue.footprint
        if fp is not None and "building" in fp.tags:
            height = building_height(fp.tags, kind, fp.part_height)
        else:
            height = building_height({}, kind)
        buildings.append(_make_building(f"b{index}", kind, venue.box, height, store_id))
        stores.append(_map_store(store_id, f"b{index}", venue))
        _door(net, venue.centre)
    return buildings, stores


@dataclass
class _CityContext:
    """Land use areas and office points, for telling offices from homes (bbox-prefiltered so a
    few thousand buildings stay quick)."""

    landuse: list[tuple[str, list[Point], tuple[float, float, float, float]]]
    office_points: list[Point]

    @classmethod
    def of(cls, osm: OsmData, proj: Projection) -> _CityContext:
        office_points = [
            proj.to_local(*osm.nodes[n]) for n, tags in osm.node_tags.items() if "office" in tags
        ]
        landuse = []
        for use, ring in _landuse_areas(osm, proj):
            xs, zs = [p[0] for p in ring], [p[1] for p in ring]
            landuse.append((use, ring, (min(xs), min(zs), max(xs), max(zs))))
        return cls(landuse, office_points)

    def kind(self, fp: Footprint) -> BuildingKind:
        minx, minz, maxx, maxz = fp.bbox
        offices = [p for p in self.office_points if minx <= p[0] <= maxx and minz <= p[1] <= maxz]
        landuse = [
            (use, ring)
            for use, ring, (x0, z0, x1, z1) in self.landuse
            if x0 <= maxx and minx <= x1 and z0 <= maxz and minz <= z1
        ]
        return _building_kind(fp, landuse, offices)


def _city_buildings(
    buildings: list[Footprint],
    used: set[str],
    corridors: list[Corridor],
    city: _CityContext,
    first_index: int,
) -> list[Building]:
    """Every other building as an office or residential box, up to MAX_BUILDINGS in total."""
    out: list[Building] = []
    budget = MAX_BUILDINGS - first_index + 1
    others = _other_buildings(buildings, used, corridors, budget)
    for index, (fp, box) in enumerate(others, start=first_index):
        kind = city.kind(fp)
        out.append(
            _make_building(f"b{index}", kind, box, building_height(fp.tags, kind, fp.part_height))
        )
    return out


# --- landmarks and station entrances --------------------------------------------------------


@dataclass(frozen=True)
class LandmarkSpec:
    """A real building the frontend labels; found in OSM by its name."""

    id: str
    name: str
    kind: LandmarkKind
    note: str
    height_m: float | None = None  # a published height, used when OSM has no height tag
    height_source: Source | None = None


ARTOTEL_HEIGHT_SOURCE = Source(
    label="The Skyscraper Center (CTBUH): art'otel London Hoxton, 92.2 m, 26 storeys "
    "(static reference, checked 2026-10-15)",
    url="https://www.skyscrapercenter.com/building/artotel-london-hoxton/39457",
)
LANDMARK_BUILDINGS: tuple[LandmarkSpec, ...] = (
    LandmarkSpec(
        "encode-hub",
        "Encode Hub",
        "venue",
        "Hackathon venue, 41 Pitfield Street, N1 6DA",
    ),
    LandmarkSpec(
        "artotel-london-hoxton",
        "art'otel London Hoxton",
        "hotel",
        "26-storey hotel tower, 1-3 Rivington Street at Old Street, EC2A 3DT",
        height_m=92.2,
        height_source=ARTOTEL_HEIGHT_SOURCE,
    ),
    LandmarkSpec(
        "boxpark-shoreditch",
        "Boxpark Shoreditch",
        "market",
        "Shipping-container food and retail market, 2-10 Bethnal Green Road",
    ),
)


@dataclass(frozen=True)
class LandmarkStoreSpec:
    """A simulated store inside a landmark building (its MapStore.buildingId is the landmark's
    building). `osm_key` names the OSM element of the unit (its name, hours and outline), else
    the store is described here and `source` says where from."""

    landmark_id: str
    name: str
    type: StoreType
    osm_key: str | None = None
    floor_area_m2: float | None = None  # when OSM has no outline for the unit
    hours_from_landmark: bool = False  # no unit hours in OSM -> the landmark's opening_hours
    source: Source | None = None


SOLAYA_SOURCE = Source(
    label="Solaya, the 25th-floor restaurant and bar of art'otel London Hoxton (Hot Dinners, "
    "July 2025; static reference, checked 2026-10-15)",
    url="https://www.hot-dinners.com/2025071514342/Gastroblog/Latest-news/"
    "solaya-rooftop-restaurant-arthotel-hoxton-shoreditch-london",
)
# Landmark stores are on top of TYPE_TARGETS: venues inside a landmark's building are never
# picked by the spread (the landmark keeps its own building), so these put them back as stores.
LANDMARK_STORES: tuple[LandmarkStoreSpec, ...] = (
    # Encode Hub is a coworking space (office=coworking, OSM 24/7); its café is what trades with
    # passers-by, so it is simulated as a cafe on cafe hours, sized to the building's outline.
    LandmarkStoreSpec("encode-hub", "Encode Hub", "cafe", "way/191324423"),
    # art'otel: The Brush, the ground-floor grand café-restaurant (OSM), and Solaya on the roof.
    LandmarkStoreSpec(
        "artotel-london-hoxton", "The Brush", "restaurant", "node/14106027984", floor_area_m2=300
    ),
    LandmarkStoreSpec(
        "artotel-london-hoxton", "Solaya", "bar", floor_area_m2=400, source=SOLAYA_SOURCE
    ),
    # Boxpark Shoreditch: container units mapped in OSM, on Boxpark's hours when a unit has none.
    LandmarkStoreSpec(
        "boxpark-shoreditch", "Beatbox", "takeaway", "way/637312524", hours_from_landmark=True
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch", "Greekos Gyros", "takeaway", "way/637312528", hours_from_landmark=True
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch",
        "Black Bear Burger",
        "takeaway",
        "way/744553833",
        hours_from_landmark=True,
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch",
        "Thunderbird Strip Shack",
        "takeaway",
        "way/744553830",
        hours_from_landmark=True,
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch",
        "Satay Street Thai",
        "takeaway",
        "way/813652259",
        hours_from_landmark=True,
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch", "Avirex", "shop", "way/637312531", hours_from_landmark=True
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch", "Aigoo", "shop", "way/637312543", hours_from_landmark=True
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch",
        "After School Cookie Club",
        "shop",
        "way/637312565",
        hours_from_landmark=True,
    ),
    LandmarkStoreSpec(
        "boxpark-shoreditch", "Lavender Flowers", "shop", "way/637312551", hours_from_landmark=True
    ),
)
STATION_NOTES: dict[str, str] = {
    STATION_NAME: "London Overground (Windrush line), on the viaduct; the map origin",
    "Old Street": "Northern line (underground) and Great Northern, under Old Street roundabout",
    "Liverpool Street": "Elizabeth, Central, Circle, Hammersmith & City, Metropolitan lines "
    "and National Rail",
    "Moorgate": "Northern, Circle, Hammersmith & City, Metropolitan lines and Great Northern",
}
# Stations whose street entrances each become an entry point (named after the station). Other
# stations get one entry at the station node nearest the origin.
ENTRANCE_STATIONS = frozenset({"Old Street"})
STATION_ENTRANCE_RADIUS_M = 200.0  # entrances this close to the station node belong to it
ENTRANCE_MERGE_M = 10.0  # entrances closer than this are one entry
LANDMARK_MIN_AREA_SHARE = 0.1  # a landmark box may shrink this far to clear the streets


def _plain_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.replace("’", "'").strip().lower())


def _landmark_footprints(buildings: list[Footprint]) -> tuple[dict[str, Footprint], list[str]]:
    """Landmark id -> its building outline (the largest one with that name inside the bounds)."""
    found: dict[str, Footprint] = {}
    notes: list[str] = []
    for spec in LANDMARK_BUILDINGS:
        named = [
            fp
            for fp in buildings
            if _plain_name(fp.tags.get("name", "")) == _plain_name(spec.name)
            and _inside(fp.centroid)
        ]
        if named:
            found[spec.id] = max(named, key=lambda fp: (fp.area, fp.key))
        else:
            notes.append(f"landmark {spec.name!r} not found as a building inside the bounds")
    return found, notes


def _landmark_buildings(
    landmark_fps: dict[str, Footprint],
    city: _CityContext,
    corridors: list[Corridor],
    net: _Network,
    first_index: int,
) -> tuple[dict[str, Building], list[Source]]:
    """One building per landmark, always kept (outside the MAX_BUILDINGS largest-first cut)."""
    specs = {spec.id: spec for spec in LANDMARK_BUILDINGS}
    out: dict[str, Building] = {}
    sources: list[Source] = []
    for landmark_id, fp in landmark_fps.items():
        spec = specs[landmark_id]
        box = fp.box()
        box = clear_of_streets(box, corridors, LANDMARK_MIN_AREA_SHARE) if box else None
        box = box or _synthetic_box(fp.centroid, net)
        if box is None:
            continue
        kind = city.kind(fp)
        height = building_height(fp.tags, kind, fp.part_height)
        if spec.height_m and _number(fp.tags.get("height")) is None:
            # A published height beats one estimated from building:levels.
            height = spec.height_m
            if spec.height_source:
                sources.append(spec.height_source)
        building_id = f"b{first_index + len(out)}"
        out[landmark_id] = _make_building(building_id, kind, box, height)
    return out, sources


def _landmark_stores(
    osm: OsmData,
    proj: Projection,
    landmark_fps: dict[str, Footprint],
    landmark_buildings: dict[str, Building],
    first_number: int,
) -> tuple[list[MapStore], list[str], list[Source]]:
    """MapStores for LANDMARK_STORES (s{first_number}, ...) inside their landmark's building.
    Several stores share that building, which keeps its own kind and no storeId (osmId: the
    unit, else the landmark's building). A spec whose landmark or OSM unit is missing is
    skipped with a note."""
    elements = {key: (tags, ring) for key, tags, _, ring in _venue_elements(osm, proj)}
    for fp in landmark_fps.values():
        elements.setdefault(fp.key, (fp.tags, fp.ring))
    stores: list[MapStore] = []
    notes: list[str] = []
    sources: list[Source] = []
    for spec in LANDMARK_STORES:
        building = landmark_buildings.get(spec.landmark_id)
        if building is None:
            notes.append(f"landmark store {spec.name!r}: no {spec.landmark_id} building")
            continue
        tags: dict[str, str] = {}
        ring: list[Point] | None = None
        if spec.osm_key is not None:
            if spec.osm_key not in elements:
                notes.append(f"landmark store {spec.name!r}: {spec.osm_key} not in OSM")
                continue
            tags, ring = elements[spec.osm_key]
        hours_tag = tags.get("opening_hours") if spec.landmark_id != "encode-hub" else None
        if hours_tag is None and spec.hours_from_landmark:
            hours_tag = landmark_fps[spec.landmark_id].tags.get("opening_hours")
        trading = parse_opening_hours(hours_tag) or DEFAULT_HOURS[spec.type]
        area = spec.floor_area_m2 or (_polygon_area(ring) if ring else building.w * building.d)
        stores.append(
            MapStore(
                id=f"s{first_number + len(stores)}",
                name=spec.name,
                type=spec.type,
                buildingId=building.id,
                licensedHours=hours(_licence(spec.type, trading)),
                defaultHours=hours(trading),
                floorArea=clamp_floor_area(area),
                osmId=spec.osm_key or landmark_fps[spec.landmark_id].key,
            )
        )
        if spec.source is not None:
            sources.append(spec.source)
    if stores:
        notes.append(
            "landmark stores: "
            + ", ".join(f"{st.id} {st.name} ({st.type}, {st.buildingId})" for st in stores)
        )
    return stores, notes, sources


def _station_doors(osm: OsmData, proj: Projection, station: Station) -> list[Point]:
    """Where a station's entries go: each street entrance of an ENTRANCE_STATIONS station
    (inside the bounds), else (or when none is mapped) the station node."""
    centre = proj.to_local(station.lat, station.lon)
    if station.name not in ENTRANCE_STATIONS:
        return [centre]
    entrances = [p for p in station_entrances(osm, proj, station.name, centre) if _inside(p)]
    return entrances or [centre]


def station_entrances(osm: OsmData, proj: Projection, name: str, centre: Point) -> list[Point]:
    """Entrances of a station: railway=subway_entrance / train_station_entrance nodes, and nodes
    named "<station> - Exit N", within STATION_ENTRANCE_RADIUS_M of the station node. One per
    ref (the railway-tagged node first); entrances within ENTRANCE_MERGE_M are one."""
    found: list[tuple[bool, str, int, Point]] = []
    exit_name = re.compile(rf"^{re.escape(_plain_name(name))}\b.*\bexit\b")
    for node_id, tags in sorted(osm.node_tags.items()):
        tagged = tags.get("railway") in ("subway_entrance", "train_station_entrance")
        if not tagged and not exit_name.match(_plain_name(tags.get("name", ""))):
            continue
        point = proj.to_local(*osm.nodes[node_id])
        if _dist(point, centre) <= STATION_ENTRANCE_RADIUS_M:
            found.append((not tagged, tags.get("ref", ""), node_id, point))
    kept: list[Point] = []
    refs: set[str] = set()
    for _, ref, _, point in sorted(found):
        if (ref and ref in refs) or any(_dist(point, k) < ENTRANCE_MERGE_M for k in kept):
            continue
        refs.add(ref)
        kept.append(point)
    return kept


def _landmarks(
    station_building: Building,
    landmark_buildings: dict[str, Building],
    others: list[Station],
    proj: Projection,
) -> list[Landmark]:
    """Shoreditch High Street (its building), every other station (underground or not drawn:
    no building, street level) and the LANDMARK_BUILDINGS that were found."""
    landmarks = [
        Landmark(
            id=_slug(STATION_NAME),
            name=STATION_NAME,
            kind="station",
            buildingId=station_building.id,
            x=station_building.x,
            z=station_building.z,
            h=station_building.h,
            note=STATION_NOTES[STATION_NAME],
        )
    ]
    for other in others:
        x, z = proj.to_local(other.lat, other.lon)
        landmarks.append(
            Landmark(
                id=_slug(other.name),
                name=other.name,
                kind="station",
                buildingId=None,
                x=round(x, 1),
                z=round(z, 1),
                h=0.0,
                note=STATION_NOTES.get(other.name),
            )
        )
    for spec in LANDMARK_BUILDINGS:
        building = landmark_buildings.get(spec.id)
        if building is not None:
            landmarks.append(
                Landmark(
                    id=spec.id,
                    name=spec.name,
                    kind=spec.kind,
                    buildingId=building.id,
                    x=building.x,
                    z=building.z,
                    h=building.h,
                    note=spec.note,
                )
            )
    return landmarks


def _osm_sources(fetched_at: str | None) -> list[Source]:
    return [
        Source(
            label="OpenStreetMap data © OpenStreetMap contributors, ODbL 1.0 (via Overpass API"
            + (
                f", served by the mirror {_served_by['url']}"
                if _served_by.get("url", OVERPASS_URL) != OVERPASS_URL
                else ""
            )
            + ")",
            url=OVERPASS_URL,
            fetchedAt=fetched_at,
        ),
        Source(label="OpenStreetMap copyright and licence (ODbL 1.0)", url=OSM_COPYRIGHT_URL),
    ]


def _door(net: _Network, centre: Point) -> int:
    """Make the street point nearest a building centre a vertex (the building's door).

    A point within CROSSING_TOUCH_M of another street (inside a narrow fork) would touch it
    without sharing a vertex, so that door goes on the nearer end of its segment instead.
    """
    nearest = net.nearest_segment(centre)
    if nearest is None:
        raise MapBuildError("no street to put a door on")
    seg, foot, _ = nearest
    for other in net.segs:
        if other == seg:
            continue
        _, touch = _project_on_segment(foot, net.pos[other[0]], net.pos[other[1]])
        if _dist(touch, foot) <= CROSSING_TOUCH_M:
            return min(seg, key=lambda n: _dist(net.pos[n], foot))
    return net.split(seg, foot)


def _edge_entries(net: _Network) -> list[tuple[int, str]]:
    """An entry on every street that leaves the map edge; street ends within ENTRY_MERGE_M of a
    wider one (the other carriageway, a path beside a road) share its entry. Ordered clockwise
    from north."""
    adj = net.adjacency()
    candidates: list[tuple[float, Point, int, str]] = []
    for node, nbrs in adj.items():
        if on_edge(net.pos[node]):
            way = net.segs[_key(node, nbrs[0])]
            candidates.append((-way.width, net.pos[node], node, way.name))
    chosen: list[tuple[int, str]] = []
    for _, p, node, name in sorted(candidates):
        if all(_dist(p, net.pos[c]) > ENTRY_MERGE_M for c, _ in chosen):
            chosen.append((node, name))
    return sorted(
        chosen,
        key=lambda c: math.atan2(net.pos[c[0]][0], net.pos[c[0]][1]) % (2 * math.pi),
    )


def _report(
    station: Station,
    others: list[Station],
    selection: StoreSelection,
    net_report: StreetNetworkReport,
    entries: list[tuple[str, Venue]],
) -> MapBuildReport:
    ids = {v.osm_key: sid for sid, v in entries}
    notes = []
    if station.osm_id is None:
        notes.append(f"station not found in OSM; origin = approximate {APPROX_ORIGIN}")
    clubs = ", ".join(f"{ids[c.osm_key]} {c.name} ({c.osm_key})" for c in selection.clubs)
    if selection.promoted_bars:
        notes.append(
            f"fewer than {MIN_CLUBS} amenity=nightclub open past midnight in the bounds; "
            f"clubs with promoted late-opening bars: {clubs}"
        )
    else:
        notes.append(f"clubs (amenity=nightclub, largest first): {clubs}")
    demo = (
        f"{ids[selection.demo.osm_key]} {selection.demo.name} is {selection.demo_walk_m} m "
        f"on foot from {ids[selection.demo_club.osm_key]} {selection.demo_club.name}"
    )
    with_hours = sum(parse_opening_hours(v.opening_hours) is not None for _, v in entries)
    return MapBuildReport(
        origin=station.osm_id or "approximate",
        demo=demo,
        dropped_streets=net_report.dropped_disconnected,
        store_hours_from_osm=with_hours,
        notes=notes,
        stations=[f"st1 {STATION_NAME} ({station.osm_id or 'approximate'})"]
        + [f"st{i} {s.name} ({s.osm_id})" for i, s in enumerate(others, start=2)],
    )


# --- pipeline step --------------------------------------------------------------------------


def _pipeline_inputs() -> dict[str, Any]:
    return {
        "builder": MAP_BUILDER_VERSION,
        "query": overpass_query(),
        "bounds": BOUNDS.model_dump(),
        "landmarks": [spec.name for spec in LANDMARK_BUILDINGS],
        "landmarkStores": [(s.landmark_id, s.name, s.type, s.osm_key) for s in LANDMARK_STORES],
        "entrances": sorted(ENTRANCE_STATIONS),
        "maxBuildings": MAX_BUILDINGS,
        "targets": TYPE_TARGETS,
        "clubs": (MIN_CLUBS, MAX_CLUBS),
    }


@contextmanager
def _refresh_policy(refresh: bool) -> Iterator[None]:
    previous = cache.policy.refresh
    if refresh:
        cache.set_policy(refresh=True)
    try:
        yield
    finally:
        cache.set_policy(refresh=previous)


def build(refresh: bool = False) -> MapData:
    """Build data/processed/map.json from OSM (fallback layout when Overpass is unreachable)."""
    inputs = _pipeline_inputs()
    with _refresh_policy(refresh):
        if cache.pipeline_up_to_date("map", inputs):
            return store.load_map()
        try:
            overpass, fetched_at = fetch_overpass()
            data, report = build_map(overpass, fetched_at)
        except (common.FetchError, MapBuildError) as error:
            print(f"map: {error}; writing the hand-written fallback layout (retry with --refresh)")
            data = map_fallback.fallback_map()
            common.write_processed("map.json", data)
            return data
        common.write_processed("map.json", data)
        cache.pipeline_mark("map", inputs)
    _print_summary(data, report)
    return data


def _print_summary(data: MapData, report: MapBuildReport) -> None:
    types = Counter(s.type for s in data.stores)
    print(
        f"map (OSM, origin {report.origin}): {len(data.streets)} streets, "
        f"{len(data.buildings)} buildings, {len(data.stores)} stores {dict(types)}, "
        f"entries {[e.id for e in data.entryPoints]}"
    )
    print(f"  store hours from OSM opening_hours: {report.store_hours_from_osm}/{len(data.stores)}")
    print(f"  stations: {'; '.join(report.stations)}")
    print(f"  demo: {report.demo}")
    for note in report.notes:
        print(f"  note: {note}")
    if report.dropped_streets:
        print(f"  dropped (not connected inside the bounds): {', '.join(report.dropped_streets)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true", help="re-query Overpass")
    build(refresh=parser.parse_args().refresh)


if __name__ == "__main__":
    main()
