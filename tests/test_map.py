"""Map pipeline (backend/pipeline/osm_map.py, map_fallback.py).

Unit tests for the projection, opening hours, licences and heights; the street network on small
synthetic OSM data (crossings share a vertex, dual carriageways fold into one street, clipping,
disconnected pieces dropped); build() with a mocked Overpass (no network): fallback when
unreachable, pipeline cache when built. Then the map invariants the sim and the frontend rely on,
checked on both data/processed/map.json and the hand-written fallback layout.
"""

from __future__ import annotations

import math
from collections import Counter
from itertools import combinations, pairwise
from pathlib import Path
from typing import Any

import pytest

from backend import cache, settings, timeutil
from backend.contract import Bounds, MapData, StoreType, Street, dump
from backend.pipeline import common, demand, map_fallback, osm_map
from backend.pipeline.osm_map import OsmData, Projection, WalkGraph

B = osm_map.BOUNDS
WEST, EAST, SOUTH, NORTH = B.minX, B.maxX, B.minZ, B.maxZ
# Synthetic roads run this far out in every direction, so the build clips them at the edge.
FAR = max(-WEST, EAST, -SOUTH, NORTH) + 150.0
ORIGIN = (51.5, -0.07)
NON_CLUB_TYPES: tuple[StoreType, ...] = (
    "cafe",
    "restaurant",
    "takeaway",
    "bar",
    "shop",
    "offlicence",
)
FETCHED_AT = "2026-10-15T08:53:55Z"
Point = tuple[float, float]


# --- synthetic OSM data ---------------------------------------------------------------------


def to_latlon(x: float, z: float) -> tuple[float, float]:
    """Inverse of Projection(*ORIGIN), to place synthetic OSM elements in local metres."""
    lat0, lon0 = ORIGIN
    lat = lat0 + math.degrees(z / osm_map.EARTH_RADIUS_M)
    lon = lon0 + math.degrees(x / (osm_map.EARTH_RADIUS_M * math.cos(math.radians(lat0))))
    return lat, lon


class FakeOverpass:
    """A tiny Overpass JSON response built in local metres around ORIGIN."""

    def __init__(self) -> None:
        self.elements: list[dict[str, Any]] = []
        self._next_id = 1

    def node(self, x: float, z: float, tags: dict[str, str] | None = None) -> int:
        node_id = self._next_id
        self._next_id += 1
        lat, lon = to_latlon(x, z)
        element: dict[str, Any] = {"type": "node", "id": node_id, "lat": lat, "lon": lon}
        if tags:
            element["tags"] = tags
        self.elements.append(element)
        return node_id

    def way(self, points: list[int | Point], tags: dict[str, str]) -> int:
        ids = [p if isinstance(p, int) else self.node(*p) for p in points]
        way_id = self._next_id
        self._next_id += 1
        self.elements.append({"type": "way", "id": way_id, "nodes": ids, "tags": tags})
        return way_id

    def box(self, x0: float, z0: float, x1: float, z1: float, tags: dict[str, str]) -> int:
        corners = [self.node(x0, z0), self.node(x1, z0), self.node(x1, z1), self.node(x0, z1)]
        return self.way([*corners, corners[0]], tags)

    def body(self) -> dict[str, Any]:
        return {"elements": self.elements}


def synthetic_area() -> dict[str, Any]:
    """Two crossing roads with no shared node, a T-junction, a disconnected mews, paths that must
    be ignored, two nightclubs (and a "nightclub" that shuts at midnight), a takeaway next to one
    of them, a cafe, a bar, an off-licence, and a second station mapped as two nodes."""
    osm = FakeOverpass()
    osm.node(
        0,
        0,
        {"railway": "station", "public_transport": "station", "name": "Shoreditch High Street"},
    )
    osm.node(-310, -390, {"railway": "station", "name": "Far Street", "station": "subway"})
    osm.node(-300, -380, {"railway": "station", "name": "London Far Street"})
    osm.node(WEST - 40, 0, {"railway": "station", "name": "Outside Station"})
    junction = osm.node(-100, 0)
    osm.way([(-FAR, 0), junction, (FAR, 0)], {"highway": "primary", "name": "Main Road"})
    osm.way([(0, -FAR), (0, FAR)], {"highway": "residential", "name": "Cross Street"})
    osm.way([junction, (-100, 120)], {"highway": "residential", "name": "Side Lane"})
    osm.way([(-300, -380), (-300, 0)], {"highway": "residential", "name": "Station Approach"})
    osm.way([(200, 200), (230, 210)], {"highway": "residential", "name": "Lonely Mews"})
    osm.way([(50, 50), (60, 120)], {"highway": "footway"})
    osm.way(
        [(-300, 8), (300, 8)],
        {"highway": "footway", "footway": "sidewalk", "name": "Main Road"},
    )
    osm.node(50, 12, {"amenity": "nightclub", "name": "Club One"})
    osm.node(-150, -12, {"amenity": "nightclub", "name": "Club Two"})
    osm.node(
        250,
        -12,
        {"amenity": "nightclub", "name": "Day Cafe Club", "opening_hours": "Mo-Su 08:00-24:00"},
    )
    osm.node(80, 12, {"amenity": "fast_food", "name": "Late Kebab"})
    osm.node(
        -50,
        -12,
        {
            "amenity": "cafe",
            "name": "Morning Cafe",
            "opening_hours": "Mo-Fr 07:30-16:00; Sa-Su off",
        },
    )
    osm.box(
        115,
        10,
        125,
        20,
        {
            "building": "yes",
            "amenity": "bar",
            "name": "Corner Bar",
            "opening_hours": "Mo-Su 16:00-01:00",
        },
    )
    osm.node(-200, 12, {"shop": "alcohol", "name": "Night Off Licence"})
    osm.box(-60, 30, -40, 50, {"building": "apartments"})
    osm.box(20, -40, 40, -20, {"building": "office", "building:levels": "5"})
    return osm.body()


def dual_carriageway_area() -> dict[str, Any]:
    """A dual carriageway (two one-way ways 10 m apart) with a side street on each side."""
    osm = FakeOverpass()
    north_end = osm.node(0, 5)
    south_end = osm.node(30, -5)
    osm.way(
        [(-FAR, -5), south_end, (FAR, -5)],
        {"highway": "primary", "name": "Twin Road", "oneway": "yes"},
    )
    osm.way(
        [(FAR, 5), north_end, (-FAR, 5)],
        {"highway": "primary", "name": "Twin Road", "oneway": "yes"},
    )
    osm.way([north_end, (0, 200)], {"highway": "residential", "name": "North Street"})
    osm.way([south_end, (30, -200)], {"highway": "residential", "name": "South Street"})
    return osm.body()


def street(map_data: MapData, name: str) -> list[Street]:
    return [s for s in map_data.streets if s.name == name]


def points_of(streets: list[Street]) -> set[Point]:
    return {(p[0], p[1]) for s in streets for p in s.points}


# --- helpers --------------------------------------------------------------------------------


def test_projection_is_local_metres_east_and_north() -> None:
    proj = Projection(51.5232534, -0.0744674)
    assert proj.to_local(51.5232534, -0.0744674) == (0.0, 0.0)
    x, z = proj.to_local(51.5232534, -0.0734674)  # 0.001 degrees east
    assert x == pytest.approx(69.2, abs=0.2) and z == pytest.approx(0.0, abs=1e-9)
    x, z = proj.to_local(51.5242534, -0.0744674)  # 0.001 degrees north
    assert z == pytest.approx(111.2, abs=0.2) and x == pytest.approx(0.0, abs=1e-9)
    west, south = proj.to_local(51.5222534, -0.0754674)
    assert west < 0 and south < 0


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Mo-Fr 08:00-18:00; Sa-Su 09:00-17:00", ("08:00", "18:00")),
        ("Tu-Sa 12:00-15:00, 17:00-22:00", ("12:00", "22:00")),
        ("Mo-Th 10:00-20:00, Fr-Sa 10:00-19:00, Su 12:00-18:00", ("10:00", "20:00")),
        ("Tu, We 10:00-19:00; Th-Sa 10:00-20:00; Su 11:00-17:00", ("10:00", "20:00")),
        ("We 09:00-22:00; Th-Tu 09:00-23:00", ("09:00", "23:00")),
        ("Mo-Th 18:00-24:00; Fr-Su 00:00-01:00,18:00-24:00", ("18:00", "00:00")),
        ("Fr-Su 00:00-01:00,18:00-24:00", ("18:00", "01:00")),
        ("Mo-Sa 12:00-02:00", ("12:00", "02:00")),
        ("Mo-Fr 08:00-16:20", ("08:00", "16:30")),
        ("10:00-22:00", ("10:00", "22:00")),
        ("24/7", ("00:00", "00:00")),
        ("Sa-Su 00:00-24:00", ("00:00", "00:00")),
        ("PH off", None),
        ("sunrise-sunset", None),
        ("Mo-Fr 10:00-10:15", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_opening_hours(value: str | None, expected: tuple[str, str] | None) -> None:
    assert osm_map.parse_opening_hours(value) == expected


@pytest.mark.parametrize(
    ("licence", "trading", "expected"),
    [
        (("10:00", "02:00"), ("12:00", "00:00"), ("10:00", "02:00")),
        (("06:00", "23:00"), ("05:00", "23:30"), ("05:00", "23:30")),
        (("21:00", "06:00"), ("17:00", "00:00"), ("17:00", "06:00")),
        (("07:00", "00:30"), ("12:00", "01:00"), ("07:00", "01:00")),
        (("06:00", "23:00"), ("00:00", "00:00"), ("00:00", "00:00")),
    ],
)
def test_widen_licence_contains_trading(
    licence: tuple[str, str], trading: tuple[str, str], expected: tuple[str, str]
) -> None:
    widened = osm_map.widen_licence(licence, trading)
    assert widened == expected
    assert timeutil.window_within(trading, widened)
    assert timeutil.window_within(licence, widened)


def test_closes_before_midnight() -> None:
    assert osm_map.closes_before_midnight(("11:00", "23:00"))
    assert osm_map.closes_before_midnight(("17:00", "23:30"))
    assert not osm_map.closes_before_midnight(("17:00", "00:00"))
    assert not osm_map.closes_before_midnight(("12:00", "02:00"))
    assert not osm_map.closes_before_midnight(("00:00", "00:00"))


def test_building_height() -> None:
    assert osm_map.building_height({"height": "12.5 m"}, "office") == 12.5
    assert osm_map.building_height({"building:levels": "4"}, "office") == 12.8
    assert osm_map.building_height({"building:levels": "4", "roof:levels": "1"}, "office") == 16.0
    # A tower mapped as a low outline plus a tall building:part keeps the part's height.
    assert osm_map.building_height({"building:levels": "2"}, "office", part_height=86.4) == 86.4
    assert osm_map.building_height({}, "office", part_height=172.8) == 172.8
    assert osm_map.building_height({"height": "400"}, "office") == osm_map.MAX_HEIGHT_M
    assert (
        osm_map.building_height({}, "residential") == map_fallback.DEFAULT_HEIGHT_M["residential"]
    )


def test_walk_distance_follows_streets() -> None:
    graph = WalkGraph([((0.0, 0.0), (100.0, 0.0)), ((100.0, 0.0), (100.0, 100.0))])
    assert graph.walk_distance((10.0, 5.0), (40.0, -5.0)) == pytest.approx(30.0)
    assert graph.walk_distance((10.0, 5.0), (95.0, 90.0)) == pytest.approx(180.0)
    assert len(graph.components()) == 1


# --- street network and build_map on synthetic OSM ------------------------------------------


def test_build_map_on_synthetic_osm() -> None:
    data, report = osm_map.build_map(synthetic_area(), FETCHED_AT)
    MapData.model_validate(dump(data))

    main_road, cross_street = street(data, "Main Road"), street(data, "Cross Street")
    side_lane = street(data, "Side Lane")
    assert main_road and cross_street and side_lane
    assert (0.0, 0.0) in points_of(main_road) & points_of(cross_street), "crossing not shared"
    assert (-100.0, 0.0) in points_of(main_road) & points_of(side_lane), "T-junction not shared"
    assert {(WEST, 0.0), (EAST, 0.0)} <= points_of(main_road), "Main Road not clipped at the edge"
    assert not street(data, "Lonely Mews"), "disconnected street kept"
    assert report.dropped_streets == ["Lonely Mews"]
    assert {s.name for s in data.streets} == {
        "Main Road",
        "Cross Street",
        "Side Lane",
        "Station Approach",
    }

    entries = {(e.x, e.z) for e in data.entryPoints if e.kind == "street"}
    assert entries == {(WEST, 0.0), (EAST, 0.0), (0.0, SOUTH), (0.0, NORTH)}
    stations = [(e.id, e.name, e.x, e.z) for e in data.entryPoints if e.kind == "station"]
    # "London Far Street" and "Far Street" are one station, entered on the side nearest the
    # origin; the station outside the bounds is left out.
    assert stations == [
        ("st1", "Shoreditch High Street", 0.0, 0.0),
        ("st2", "Far Street", -300.0, -380.0),
    ]
    assert report.stations[1].startswith("st2 Far Street")

    by_name = {s.name: s for s in data.stores}
    # A nightclub whose OSM hours end at midnight is not a club night.
    assert {s.name for s in data.stores if s.type == "club"} == {"Club One", "Club Two"}
    assert "Day Cafe Club" not in by_name
    assert by_name["Late Kebab"].type == "takeaway"
    assert by_name["Night Off Licence"].type == "offlicence"
    assert by_name["Morning Cafe"].defaultHours is not None
    assert (
        by_name["Morning Cafe"].defaultHours.open,
        by_name["Morning Cafe"].defaultHours.close,
    ) == (
        "07:30",
        "16:00",
    )
    corner_bar = by_name["Corner Bar"]
    assert corner_bar.osmId and corner_bar.osmId.startswith("way/")
    assert corner_bar.licensedHours is not None
    assert (corner_bar.licensedHours.open, corner_bar.licensedHours.close) == ("10:00", "02:00")
    assert "Late Kebab" in report.demo and "Club One" in report.demo
    assert data.sources[0].url == osm_map.OVERPASS_URL
    assert data.sources[0].fetchedAt == FETCHED_AT
    kinds = Counter(b.kind for b in data.buildings)
    assert kinds["residential"] == 1 and kinds["office"] == 1 and kinds["station"] == 1
    assert len(WalkGraph.from_streets(data.streets).components()) == 1


def test_a_door_inside_a_narrow_fork_goes_on_the_fork_vertex() -> None:
    """Splitting one prong of a narrow fork near its tip would leave the new vertex touching
    the other prong without a shared vertex (Broadgate Link / Sun Street Passage)."""
    net = osm_map._Network()
    path = osm_map._Way("Path", "footway", False)
    fork, west, east = (net.add_node(p) for p in ((0.0, 0.0), (0.0, -50.0), (3.0, -50.0)))
    net.add_seg(fork, west, path)
    net.add_seg(fork, east, path)
    assert osm_map._door(net, (10.0, -3.0)) == fork
    door = osm_map._door(net, (10.0, -40.0))
    assert door not in (fork, west, east), "a door clear of the fork splits its segment"


def _club_venue(name: str, x: float, area: float, hours: str | None = None) -> osm_map.Venue:
    side = math.sqrt(area)
    return osm_map.Venue(
        osm_key=f"node/{name}",
        name=name,
        type="club",
        opening_hours=hours,
        footprint=None,
        shares_building=False,
        box=(x, 20.0, side, side),
    )


def test_clubs_are_real_nightclubs_largest_first() -> None:
    venues = [
        _club_venue("Small", 0, 100),
        _club_venue("Huge but shuts at midnight", 100, 900, "Mo-Su 08:00-24:00"),
        _club_venue("Big", 200, 400, "Fr-Sa 22:00-04:00"),
        _club_venue("Medium", 300, 200),
        _club_venue("Large", 400, 300),
        _club_venue("Tiny", 500, 50),
    ]
    clubs, promoted = osm_map._pick_clubs(venues)
    assert [c.name for c in clubs] == ["Big", "Large", "Medium", "Small"]
    assert len(clubs) == osm_map.MAX_CLUBS and not promoted


def test_demo_prefers_the_biggest_club_with_a_late_takeaway_nearby() -> None:
    walk = WalkGraph([((-200.0, 0.0), (400.0, 0.0))])

    def takeaway(name: str, x: float) -> osm_map.Venue:
        return osm_map.Venue(f"node/{name}", name, "takeaway", None, None, False, (x, 12, 10, 8))

    small, big = _club_venue("Small Club", 0, 100), _club_venue("Big Club", 300, 400)
    venues = [small, big, takeaway("Next To Small", 20), takeaway("Near Big", 360)]
    demo = osm_map._pick_demo(venues, [small, big], walk)
    assert demo is not None
    assert (demo[0].name, demo[1].name) == ("Near Big", "Big Club")
    assert demo[2] == pytest.approx(60.0)


def test_dual_carriageway_folds_into_one_street() -> None:
    osm = OsmData.from_overpass(dual_carriageway_area())
    net, _ = osm_map.build_street_network(osm, Projection(*ORIGIN))
    twin = [k for k, way in net.segs.items() if way.name == "Twin Road"]
    twin_length = sum(math.dist(net.pos[a], net.pos[b]) for a, b in twin)
    assert twin_length == pytest.approx(EAST - WEST, abs=2.0), "both carriageways kept"
    twin_nodes = {n for key in twin for n in key}
    for name in ("North Street", "South Street"):
        side = [k for k, way in net.segs.items() if way.name == name]
        assert side and {n for key in side for n in key} & twin_nodes, f"{name} cut off"
    assert len(WalkGraph(net.segment_points()).components()) == 1


# --- build(): fallback and pipeline cache, with Overpass mocked -----------------------------


@pytest.fixture
def processed_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path)
    monkeypatch.setattr(cache.policy, "refresh", False)
    monkeypatch.setattr(cache.policy, "disabled", False)
    return tmp_path


def test_build_writes_fallback_when_overpass_is_unreachable(
    processed_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unreachable() -> tuple[dict[str, Any], str]:
        raise common.FetchError("osm: POST failed: connection refused")

    monkeypatch.setattr(osm_map, "fetch_overpass", unreachable)
    data = osm_map.build()
    assert data == map_fallback.fallback_map()
    written = MapData.model_validate_json((processed_dir / "map.json").read_text())
    assert any("fallback" in s.label.lower() for s in written.sources)
    assert not (processed_dir / ".hashes.json").exists(), "fallback must not mark the step built"


def test_build_from_osm_marks_pipeline_and_then_skips(
    processed_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(osm_map, "fetch_overpass", lambda: (synthetic_area(), FETCHED_AT))
    data = osm_map.build()
    assert data.sources[0].url == osm_map.OVERPASS_URL
    assert (processed_dir / "map.json").exists()

    def must_not_fetch() -> tuple[dict[str, Any], str]:
        raise AssertionError("an up-to-date map must not be rebuilt")

    monkeypatch.setattr(osm_map, "fetch_overpass", must_not_fetch)
    assert osm_map.build() == data


# --- invariants on the real map and on the fallback -----------------------------------------


def processed_map() -> MapData:
    path = Path(__file__).resolve().parent.parent / "data" / "processed" / "map.json"
    if not path.exists():
        pytest.skip("data/processed/map.json is not built yet")
    return MapData.model_validate_json(path.read_text())


def is_fallback(map_data: MapData) -> bool:
    return any("fallback" in s.label.lower() for s in map_data.sources)


@pytest.fixture(params=["processed", "fallback"])
def map_data(request: pytest.FixtureRequest) -> MapData:
    return processed_map() if request.param == "processed" else map_fallback.fallback_map()


def expected_bounds(map_data: MapData) -> Bounds:
    """The OSM map is 1.5 km across; the hand-written fallback stays a 500 m schematic."""
    return map_fallback.BOUNDS if is_fallback(map_data) else osm_map.BOUNDS


def test_contract_round_trip(map_data: MapData) -> None:
    assert MapData.model_validate(dump(map_data)) == map_data


def test_everything_inside_bounds(map_data: MapData) -> None:
    b = map_data.bounds
    assert b == expected_bounds(map_data)

    def inside(x: float, z: float, slack: float = 0.0) -> bool:
        return b.minX - slack <= x <= b.maxX + slack and b.minZ - slack <= z <= b.maxZ + slack

    for s in map_data.streets:
        assert all(inside(x, z) for x, z in s.points), s.id
    for bl in map_data.buildings:
        corners = ((bl.x - bl.w / 2, bl.z - bl.d / 2), (bl.x + bl.w / 2, bl.z + bl.d / 2))
        assert all(inside(x, z, 1e-6) for x, z in corners), bl.id
        assert bl.w > 0 and bl.d > 0 and bl.h > 0
    for e in map_data.entryPoints:
        assert inside(e.x, e.z), e.id


def test_ids_are_unique(map_data: MapData) -> None:
    for items in (map_data.streets, map_data.buildings, map_data.stores, map_data.entryPoints):
        ids = [item.id for item in items]
        assert len(ids) == len(set(ids))


def test_every_store_has_exactly_one_building_and_back(map_data: MapData) -> None:
    buildings = {b.id: b for b in map_data.buildings}
    for s in map_data.stores:
        assert buildings[s.buildingId].storeId == s.id, s.id
    owners = Counter(b.storeId for b in map_data.buildings if b.storeId)
    assert set(owners) == {s.id for s in map_data.stores}
    assert all(count == 1 for count in owners.values())


def test_building_kinds_match_store_types(map_data: MapData) -> None:
    buildings = {b.id: b for b in map_data.buildings}
    for s in map_data.stores:
        assert buildings[s.buildingId].kind == ("club" if s.type == "club" else "store"), s.id
    for b in map_data.buildings:
        if b.storeId is None:
            assert b.kind in ("office", "residential", "station"), b.id
    assert sum(b.kind == "station" for b in map_data.buildings) == 1


def test_entry_points(map_data: MapData) -> None:
    bounds = map_data.bounds
    street_entries = [e for e in map_data.entryPoints if e.kind == "street"]
    assert len(street_entries) >= 4
    assert [e.id for e in street_entries] == [f"e{i}" for i in range(1, len(street_entries) + 1)]
    for e in street_entries:
        assert osm_map.on_edge((e.x, e.z), bounds), f"{e.id} is not on the map edge"
    stations = [e for e in map_data.entryPoints if e.kind == "station"]
    assert [e.id for e in stations] == [f"st{i}" for i in range(1, len(stations) + 1)]
    assert stations[0].name == map_fallback.STATION_NAME
    # One entry per station, except one per street entrance for ENTRANCE_STATIONS (Old Street),
    # whose entries are consecutive.
    names = [e.name for e in stations]
    for name in set(names):
        positions = [i for i, n in enumerate(names) if n == name]
        assert positions == list(range(positions[0], positions[0] + len(positions))), name
        assert len(positions) == 1 or name in osm_map.ENTRANCE_STATIONS, name
    vertices = points_of(map_data.streets)
    for e in map_data.entryPoints:
        assert (e.x, e.z) in vertices, f"{e.id} is not a street vertex"
    # Every street that leaves the map is a way in: each edge vertex is (next to) an entry.
    for p in (v for v in vertices if osm_map.on_edge(v, bounds)):
        assert any(math.dist(p, (e.x, e.z)) <= osm_map.ENTRY_MERGE_M for e in street_entries), (
            f"street end {p} on the edge has no entry"
        )


# (non-club stores, stores per non-club type): the OSM map spreads ~68 venues over 1.5 km, the
# fallback schematic keeps its 24.
STORE_MIX = {"processed": ((60, 80), (5, 16)), "fallback": ((20, 30), (2, 8))}


def test_clubs_and_balanced_store_mix(map_data: MapData) -> None:
    (low, high), (type_low, type_high) = STORE_MIX[
        "fallback" if is_fallback(map_data) else "processed"
    ]
    types = Counter(s.type for s in map_data.stores)
    assert 2 <= types["club"] <= 4
    non_club = sum(n for t, n in types.items() if t != "club")
    assert low <= non_club <= high
    for store_type in NON_CLUB_TYPES:
        assert type_low <= types[store_type] <= type_high, (store_type, types)


def test_street_graph_is_connected(map_data: MapData) -> None:
    components = WalkGraph.from_streets(map_data.streets).components()
    assert len(components) == 1, f"{len(components)} pieces"


def _segment_gap(a: Point, b: Point, c: Point, d: Point) -> float:
    def orient(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def point_gap(p: Point, s0: Point, s1: Point) -> float:
        dx, dz = s1[0] - s0[0], s1[1] - s0[1]
        t = ((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dz) / (dx * dx + dz * dz)
        t = min(1.0, max(0.0, t))
        return math.dist(p, (s0[0] + t * dx, s0[1] + t * dz))

    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    if o1 * o2 < 0 and o3 * o4 < 0:
        return 0.0
    return min(point_gap(a, c, d), point_gap(b, c, d), point_gap(c, a, b), point_gap(d, a, b))


Rect = tuple[float, float, float, float]  # x0, z0, x1, z1
GRID_CELL_M = 50.0


def _segment_rect(a: Point, b: Point, pad: float) -> Rect:
    (x0, x1), (z0, z1) = sorted((a[0], b[0])), sorted((a[1], b[1]))
    return x0 - pad, z0 - pad, x1 + pad, z1 + pad


def _cells(rect: Rect) -> list[tuple[int, int]]:
    x0, z0, x1, z1 = (math.floor(v / GRID_CELL_M) for v in rect)
    return [(gx, gz) for gx in range(x0, x1 + 1) for gz in range(z0, z1 + 1)]


def _grid(rects: list[Rect]) -> dict[tuple[int, int], list[int]]:
    """Grid cells -> indices of the rectangles that overlap them (a broad phase: only items in
    a shared cell can be close, so the exact checks below skip the all-pairs loop)."""
    grid: dict[tuple[int, int], list[int]] = {}
    for i, rect in enumerate(rects):
        for cell in _cells(rect):
            grid.setdefault(cell, []).append(i)
    return grid


def test_streets_meet_only_at_shared_vertices(map_data: MapData) -> None:
    """The sim joins streets only at identical points, so no two segments may cross or touch
    anywhere except at a vertex they share."""
    segments = [
        ((a[0], a[1]), (b[0], b[1]), s.id) for s in map_data.streets for a, b in pairwise(s.points)
    ]
    grid = _grid([_segment_rect(a, b, 0.25) for a, b, _ in segments])
    pairs = {pair for members in grid.values() for pair in combinations(sorted(members), 2)}
    problems = []
    for i, j in sorted(pairs):
        (a, b, sa), (c, d, sb) = segments[i], segments[j]
        if {a, b} & {c, d}:
            continue
        if _segment_gap(a, b, c, d) < 0.25:
            problems.append((sa, a, b, sb, c, d))
    assert not problems, problems[:5]


def test_buildings_stay_off_the_carriageways(map_data: MapData) -> None:
    """Boxes never sit on a road (the station is exempt: Braithwaite Street runs under it)."""
    segments = [(a, b, s.width / 2) for s in map_data.streets for a, b in pairwise(s.points)]
    grid = _grid([_segment_rect(a, b, half) for a, b, half in segments])
    on_road = []
    for bl in map_data.buildings:
        if bl.kind == "station":
            continue
        box = (bl.x, bl.z, bl.w, bl.d)
        rect = (bl.x - bl.w / 2, bl.z - bl.d / 2, bl.x + bl.w / 2, bl.z + bl.d / 2)
        near = sorted({i for cell in _cells(rect) for i in grid.get(cell, [])})
        gaps = [osm_map.segment_box_distance(*segments[i][:2], box) - segments[i][2] for i in near]
        gap = min(gaps, default=math.inf)
        if gap < -0.05:
            on_road.append((bl.id, round(gap, 2)))
    assert not on_road


def test_demo_takeaway_next_to_a_club(map_data: MapData) -> None:
    graph = WalkGraph.from_streets(map_data.streets)
    centre = {b.id: (b.x, b.z) for b in map_data.buildings}
    clubs = [s for s in map_data.stores if s.type == "club"]
    found = []
    for s in map_data.stores:
        if s.type != "takeaway" or s.defaultHours is None or s.licensedHours is None:
            continue
        trading = (s.defaultHours.open, s.defaultHours.close)
        licence = (s.licensedHours.open, s.licensedHours.close)
        if not osm_map.closes_before_midnight(trading):
            continue
        if not timeutil.window_within((trading[0], osm_map.DEMO_TRADE_UNTIL), licence):
            continue
        for club in clubs:
            walk = graph.walk_distance(centre[club.buildingId], centre[s.buildingId])
            if walk <= osm_map.DEMO_MAX_WALK_M:
                found.append((s.id, club.id, round(walk, 1)))
    assert found, "no takeaway near a club that shuts before midnight but may trade till 03:30"


def test_hours_and_floor_areas(map_data: MapData) -> None:
    low, high = map_fallback.FLOOR_AREA_RANGE_M2
    for s in map_data.stores:
        assert s.defaultHours is not None and s.licensedHours is not None, s.id
        trading = (s.defaultHours.open, s.defaultHours.close)
        licence = (s.licensedHours.open, s.licensedHours.close)
        assert all(timeutil.is_half_hour_step(t) for t in (*trading, *licence)), s.id
        assert timeutil.window_within(trading, licence), s.id
        assert s.floorArea is not None and low <= s.floorArea <= high, s.id


def test_stores_are_reachable_from_a_street(map_data: MapData) -> None:
    graph = WalkGraph.from_streets(map_data.streets)
    centre = {b.id: (b.x, b.z) for b in map_data.buildings}
    for s in map_data.stores:
        assert graph.nearest(centre[s.buildingId])[3] <= osm_map.MAX_DOOR_DISTANCE_M, s.id


def test_processed_map_is_the_osm_build() -> None:
    data = processed_map()
    if is_fallback(data):
        pytest.skip(
            "data/processed/map.json is the hand-written fallback (Overpass was unreachable)"
        )
    osm_source = data.sources[0]
    assert osm_source.url == osm_map.OVERPASS_URL and osm_source.fetchedAt
    assert "OpenStreetMap" in osm_source.label and "ODbL" in osm_source.label
    assert all(s.osmId for s in data.stores)
    station = next(b for b in data.buildings if b.kind == "station")
    assert abs(station.z) < 30 and station.x - station.w / 2 < 0 < station.x + station.w / 2

    def mean_point(name: str) -> Point:
        pts = [p for s in street(data, name) for p in s.points]
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)

    # Real geography around the station: catches flipped or swapped axes.
    assert mean_point("Brick Lane")[0] > 150
    assert mean_point("Shoreditch High Street")[0] < -150
    assert mean_point("Redchurch Street")[1] > 80
    assert mean_point("Quaker Street")[1] < -80
    stations = {e.name: e for e in data.entryPoints if e.kind == "station"}
    assert list(stations) == [
        map_fallback.STATION_NAME,
        "Liverpool Street",
        "Moorgate",  # just inside the south-west corner since the map reaches Old Street
        "Old Street",
    ]
    assert all(name in demand.RAIL_STATIONS for name in stations), "demand knows every station"
    liverpool_street = stations["Liverpool Street"]
    assert liverpool_street.x < -300 and liverpool_street.z < -300, "near the south-west corner"
    clubs = {s.name for s in data.stores if s.type == "club"}
    assert "Village Underground" in clubs, "the real nightclub on Holywell Lane"
    assert "XOYO" in clubs, "the Cowper Street nightclub, just inside the west edge"
    assert not {s.name.lower() for s in data.stores} & set(osm_map.CLOSED_VENUES), "closed venue"
    assert 2000 <= len(data.buildings) <= osm_map.MAX_BUILDINGS


def test_fallback_is_labelled_as_hand_written() -> None:
    data = map_fallback.fallback_map()
    assert is_fallback(data)
    assert all("not openstreetmap" in s.label.lower() for s in data.sources)
    assert all(s.osmId is None for s in data.stores)


# --- landmarks and Old Street ---------------------------------------------------------------


def osm_processed_map() -> MapData:
    data = processed_map()
    if is_fallback(data):
        pytest.skip("data/processed/map.json is the hand-written fallback")
    return data


def test_landmarks_are_real_places_inside_the_bounds() -> None:
    """Encode Hub, art'otel, Boxpark and the stations, where they really are (metres from
    Shoreditch High Street station, which is still the origin), inside the bounds."""
    data = osm_processed_map()
    landmarks = {lm.id: lm for lm in data.landmarks or []}
    expected = {
        "shoreditch-high-street": ("station", 0, 0),
        "old-street": ("station", -910, 265),
        "encode-hub": ("venue", -645, 480),
        "artotel-london-hoxton": ("hotel", -600, 340),
        "boxpark-shoreditch": ("market", -125, 25),
    }
    assert set(expected) <= set(landmarks)
    buildings = {b.id: b for b in data.buildings}
    b = data.bounds
    for landmark_id, (kind, x, z) in expected.items():
        lm = landmarks[landmark_id]
        assert lm.kind == kind, landmark_id
        assert math.dist((lm.x, lm.z), (x, z)) < 60, (landmark_id, lm.x, lm.z)
        assert b.minX < lm.x < b.maxX and b.minZ < lm.z < b.maxZ, landmark_id
        if lm.buildingId is not None:
            building = buildings[lm.buildingId]
            assert (building.x, building.z, building.h) == (lm.x, lm.z, lm.h), landmark_id
            assert building.storeId is None, f"{landmark_id} must not be a store"
    assert landmarks["encode-hub"].name == "Encode Hub"
    assert landmarks["old-street"].buildingId is None  # underground
    assert landmarks["artotel-london-hoxton"].h > 80  # the 92 m tower
    origin = buildings[landmarks["shoreditch-high-street"].buildingId or ""]
    assert origin.kind == "station" and abs(origin.x) < 60 and abs(origin.z) < 30


def test_old_street_roundabout_is_inside_with_its_streets_and_entrances() -> None:
    data = osm_processed_map()
    roundabout = (-880.0, 255.0)
    assert data.bounds.minX <= roundabout[0] - 150, "room west of Old Street roundabout"
    near = {s.name for s in data.streets if any(math.dist(p, roundabout) < 120 for p in s.points)}
    assert {"Old Street", "City Road"} <= near
    names = {s.name for s in data.streets}
    assert {"East Road", "Great Eastern Street", "Old Street Roundabout"} <= names
    entrances = [e for e in data.entryPoints if e.kind == "station" and e.name == "Old Street"]
    assert len(entrances) >= 2, "Old Street's street entrances"
    assert all(math.dist((e.x, e.z), roundabout) < 150 for e in entrances)
    assert sum(math.dist((b.x, b.z), roundabout) < 200 for b in data.buildings) >= 40
