"""Hand-written map defaults and the schematic fallback layout for data/processed/map.json.

Two jobs:
  * the type defaults every map build uses where OpenStreetMap has no data (opening hours,
    licence caps, street widths by class, building heights by kind), and
  * fallback_map(): a schematic Shoreditch layout written when Overpass is unreachable, so the
    sim never blocks on scraping. It is labelled as a hand-written fallback in `sources`; the
    venue names are generic and nothing in it is measured.

Run `python -m backend.pipeline.map_fallback` to write the fallback map on its own.
"""

from __future__ import annotations

import math
from itertools import pairwise

from backend.contract import (
    Bounds,
    Building,
    BuildingKind,
    EntryPoint,
    HoursWindow,
    Landmark,
    MapData,
    MapStore,
    Source,
    StoreType,
    Street,
)
from backend.pipeline.common import write_processed

HALF_SIZE_M = 250.0  # the schematic fallback stays the original 500 m square (osm_map.MAP_BOUNDS
# is the OSM map's rectangle)
BOUNDS = Bounds(minX=-HALF_SIZE_M, maxX=HALF_SIZE_M, minZ=-HALF_SIZE_M, maxZ=HALF_SIZE_M)
STATION_NAME = "Shoreditch High Street"

# Typical trading window per type, used when OSM has no parseable opening_hours.
DEFAULT_HOURS: dict[StoreType, tuple[str, str]] = {
    "cafe": ("07:00", "18:00"),
    "restaurant": ("12:00", "23:00"),
    "takeaway": ("11:00", "23:00"),
    "bar": ("16:00", "00:00"),
    "shop": ("10:00", "19:00"),
    "offlicence": ("08:00", "23:00"),
    "club": ("22:00", "03:00"),
}

# Default licence caps by type (the hard rules never let a store trade outside these).
LICENSED_HOURS: dict[StoreType, tuple[str, str]] = {
    "cafe": ("06:00", "23:00"),
    "restaurant": ("07:00", "00:30"),
    "takeaway": ("06:00", "04:00"),
    "bar": ("10:00", "02:00"),
    "shop": ("06:00", "23:00"),
    "offlicence": ("06:00", "23:00"),
    "club": ("21:00", "06:00"),
}

# Carriageway (or path) width in metres by OSM highway class.
STREET_WIDTH_M: dict[str, float] = {
    "trunk": 14.0,
    "primary": 14.0,
    "secondary": 12.0,
    "tertiary": 10.0,
    "unclassified": 8.0,
    "residential": 8.0,
    "living_street": 6.0,
    "pedestrian": 6.0,
    "service": 5.0,
    "footway": 3.0,
    "path": 3.0,
    "steps": 3.0,
    "cycleway": 3.0,
}

LEVEL_HEIGHT_M = 3.2
DEFAULT_HEIGHT_M: dict[BuildingKind, float] = {
    "store": 10.0,
    "club": 9.0,
    "office": 19.0,
    "residential": 13.0,
    "station": 12.0,
}

FLOOR_AREA_RANGE_M2 = (30.0, 600.0)


def hours(window: tuple[str, str]) -> HoursWindow:
    return HoursWindow(open=window[0], close=window[1])


def clamp_floor_area(area_m2: float) -> float:
    low, high = FLOOR_AREA_RANGE_M2
    return round(min(high, max(low, area_m2)), 1)


# --- schematic layout -----------------------------------------------------------------------

# Junctions are named once so every street through them uses the identical vertex (the sim
# builds its walk graph from shared points).
_J: dict[str, tuple[float, float]] = {
    "shs_s": (-150.0, -250.0),
    "shs_comm": (-150.0, -20.0),
    "shs_holy": (-150.0, 20.0),
    "shs_bgr": (-150.0, 70.0),
    "shs_red": (-150.0, 160.0),
    "shs_n": (-150.0, 250.0),
    "comm_quaker": (-80.0, -110.0),
    "comm_s": (-20.0, -250.0),
    "ges_w": (-250.0, 150.0),
    "holy_w": (-250.0, 20.0),
    "bgr_braith": (-40.0, 70.0),
    "bgr_club": (60.0, 70.0),
    "bgr_sclater": (130.0, 70.0),
    "bgr_brick": (230.0, 70.0),
    "bgr_e": (250.0, 70.0),
    "red_club": (60.0, 160.0),
    "red_brick": (230.0, 160.0),
    "station_door": (-40.0, 0.0),
    "braith_quaker": (-40.0, -110.0),
    "quaker_brick": (230.0, -110.0),
    "club_n": (60.0, 250.0),
    "sclater_brick": (230.0, 10.0),
    "brick_s": (230.0, -250.0),
    "brick_n": (230.0, 250.0),
}

_STREETS: list[tuple[str, str, str, list[str]]] = [
    (
        "shoreditch-high-st",
        "Shoreditch High St",
        "primary",
        ["shs_s", "shs_comm", "shs_holy", "shs_bgr", "shs_red", "shs_n"],
    ),
    ("commercial-st", "Commercial St", "primary", ["shs_comm", "comm_quaker", "comm_s"]),
    ("great-eastern-st", "Great Eastern St", "secondary", ["ges_w", "shs_bgr"]),
    ("holywell-ln", "Holywell Ln", "residential", ["holy_w", "shs_holy"]),
    (
        "bethnal-green-rd",
        "Bethnal Green Rd",
        "secondary",
        ["shs_bgr", "bgr_braith", "bgr_club", "bgr_sclater", "bgr_brick", "bgr_e"],
    ),
    ("redchurch-st", "Redchurch St", "residential", ["shs_red", "red_club", "red_brick"]),
    (
        "braithwaite-st",
        "Braithwaite St",
        "residential",
        ["bgr_braith", "station_door", "braith_quaker"],
    ),
    ("quaker-st", "Quaker St", "residential", ["comm_quaker", "braith_quaker", "quaker_brick"]),
    ("club-row", "Club Row", "residential", ["bgr_club", "red_club", "club_n"]),
    ("sclater-st", "Sclater St", "residential", ["bgr_sclater", "sclater_brick"]),
    (
        "brick-ln",
        "Brick Ln",
        "tertiary",
        ["brick_s", "quaker_brick", "sclater_brick", "bgr_brick", "red_brick", "brick_n"],
    ),
]

_EDGE_ENTRIES = [
    "shs_n",
    "shs_s",
    "holy_w",
    "ges_w",
    "bgr_e",
    "brick_n",
    "brick_s",
    "comm_s",
    "club_n",
]

# (id, name, type, centre x, centre z, w, d). Placed beside streets, clear of carriageways.
# c1 + s1 carry the demo story: the club spills out at ~03:00 and the takeaway next door
# (about 50 m walk) closes at 23:00 by default but is licensed until 04:00.
_VENUES: list[tuple[str, str, StoreType, float, float, float, float]] = [
    ("c1", "Holywell Lane Club", "club", -200.0, 33.0, 30.0, 16.0),
    ("c2", "Brick Lane Club", "club", 205.0, -140.0, 26.0, 20.0),
    ("s1", "Holywell Grill", "takeaway", -170.0, 30.0, 12.0, 10.0),
    ("s2", "Chicken Corner", "takeaway", -164.0, -60.0, 12.0, 10.0),
    ("s3", "Late Bagel", "takeaway", 100.0, 58.0, 12.0, 10.0),
    ("s4", "Brick Lane Curry House Takeaway", "takeaway", 218.0, -40.0, 12.0, 10.0),
    ("s5", "Quaker Fried Chicken", "takeaway", 140.0, -120.0, 12.0, 10.0),
    ("s6", "High Street Coffee", "cafe", -136.0, 110.0, 12.0, 10.0),
    ("s7", "Bethnal Green Rd Cafe", "cafe", -90.0, 82.0, 12.0, 10.0),
    ("s8", "Redchurch Cafe", "cafe", -100.0, 170.0, 12.0, 10.0),
    ("s9", "Brick Lane Coffee", "cafe", 218.0, 120.0, 12.0, 10.0),
    ("s10", "Station Cafe", "cafe", -51.0, -40.0, 12.0, 10.0),
    ("s11", "Shoreditch Kitchen", "restaurant", -164.0, 104.0, 12.0, 10.0),
    ("s12", "Curry House", "restaurant", 0.0, 82.0, 12.0, 10.0),
    ("s13", "Redchurch Bistro", "restaurant", 0.0, 149.0, 12.0, 10.0),
    ("s14", "Club Row Restaurant", "restaurant", 71.0, 120.0, 12.0, 10.0),
    ("s15", "Brick Lane Restaurant", "restaurant", 218.0, -180.0, 12.0, 10.0),
    ("s16", "The Old Station Bar", "bar", -164.0, 200.0, 12.0, 10.0),
    ("s17", "Rooftop Bar", "bar", 180.0, 82.0, 12.0, 10.0),
    ("s18", "Redchurch Tavern", "bar", 120.0, 170.0, 12.0, 10.0),
    ("s19", "Quaker Arms", "bar", 60.0, -100.0, 12.0, 10.0),
    ("s20", "Corner Shop", "shop", -136.0, 210.0, 12.0, 10.0),
    ("s21", "Vintage Shop", "shop", 20.0, 58.0, 12.0, 10.0),
    ("s22", "Redchurch Boutique", "shop", 170.0, 149.0, 12.0, 10.0),
    ("s23", "Night Off-Licence", "offlicence", -164.0, -150.0, 12.0, 10.0),
    ("s24", "Bethnal Green Rd Off-Licence", "offlicence", 200.0, 58.0, 12.0, 10.0),
]

_STATION_BOX = (0.0, 0.0, 50.0, 70.0)  # x, z, w, d: the elevated station, entrance on the west

FALLBACK_SOURCE = Source(
    label="Hand-written fallback layout (schematic Shoreditch; not OpenStreetMap data)",
    url="backend/pipeline/map_fallback.py",
)


def _point_box_distance(px: float, pz: float, box: tuple[float, float, float, float]) -> float:
    x, z, w, d = box
    dx = max(abs(px - x) - w / 2, 0.0)
    dz = max(abs(pz - z) - d / 2, 0.0)
    return math.hypot(dx, dz)


def _boxes_overlap(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float], gap: float
) -> bool:
    return abs(a[0] - b[0]) < (a[2] + b[2]) / 2 + gap and abs(a[1] - b[1]) < (a[3] + b[3]) / 2 + gap


def _clear_of_streets(
    box: tuple[float, float, float, float], streets: list[Street], margin: float
) -> bool:
    # Sampling every metre is plenty for a hand-written layout.
    for street in streets:
        reach = street.width / 2 + margin
        for (ax, az), (bx, bz) in pairwise(street.points):
            steps = max(1, int(math.dist((ax, az), (bx, bz))))
            for k in range(steps + 1):
                f = k / steps
                if _point_box_distance(ax + (bx - ax) * f, az + (bz - az) * f, box) < reach:
                    return False
    return True


def _filler_buildings(
    streets: list[Street], occupied: list[tuple[float, float, float, float]], first_index: int
) -> list[Building]:
    """Offices west of Braithwaite St (City fringe), mostly homes to the east; deterministic."""
    buildings: list[Building] = []
    taken = list(occupied)
    index = first_index
    for i, gx in enumerate(range(-237, 238, 26)):
        for j, gz in enumerate(range(-237, 238, 26)):
            w, d = (18.0, 14.0) if (i + j) % 2 == 0 else (14.0, 18.0)
            box = (float(gx), float(gz), w, d)
            inside = abs(gx) + w / 2 <= HALF_SIZE_M and abs(gz) + d / 2 <= HALF_SIZE_M
            if not inside or not _clear_of_streets(box, streets, margin=1.5):
                continue
            if any(_boxes_overlap(box, other, gap=2.0) for other in taken):
                continue
            kind: BuildingKind = "office" if gx < -40 or (i + j) % 3 == 0 else "residential"
            h = (
                16.0 + 4.0 * ((i * 7 + j * 3) % 4)
                if kind == "office"
                else 12.0 + 3.0 * ((i + j) % 3)
            )
            buildings.append(Building(id=f"b{index}", kind=kind, x=box[0], z=box[1], w=w, d=d, h=h))
            taken.append(box)
            index += 1
    return buildings


def fallback_map() -> MapData:
    """Schematic Shoreditch: 11 streets, 24 stores, 2 clubs, 1 station, 9 edge entries."""
    streets = [
        Street(id=sid, name=name, points=[_J[p] for p in pts], width=STREET_WIDTH_M[cls])
        for sid, name, cls, pts in _STREETS
    ]
    buildings: list[Building] = []
    stores: list[MapStore] = []
    occupied: list[tuple[float, float, float, float]] = []
    for index, (store_id, name, store_type, x, z, w, d) in enumerate(_VENUES, start=1):
        kind: BuildingKind = "club" if store_type == "club" else "store"
        building_id = f"b{index}"
        buildings.append(
            Building(
                id=building_id,
                kind=kind,
                storeId=store_id,
                x=x,
                z=z,
                w=w,
                d=d,
                h=DEFAULT_HEIGHT_M[kind],
            )
        )
        stores.append(
            MapStore(
                id=store_id,
                name=name,
                type=store_type,
                buildingId=building_id,
                licensedHours=hours(LICENSED_HOURS[store_type]),
                defaultHours=hours(DEFAULT_HOURS[store_type]),
                floorArea=clamp_floor_area(w * d),
            )
        )
        occupied.append((x, z, w, d))
    sx, sz, sw, sd = _STATION_BOX
    station_index = len(buildings) + 1
    buildings.append(
        Building(
            id=f"b{station_index}",
            kind="station",
            x=sx,
            z=sz,
            w=sw,
            d=sd,
            h=DEFAULT_HEIGHT_M["station"],
        )
    )
    occupied.append(_STATION_BOX)
    buildings += _filler_buildings(streets, occupied, first_index=station_index + 1)

    entry_points = [
        EntryPoint(id=f"e{n}", kind="street", x=_J[p][0], z=_J[p][1])
        for n, p in enumerate(_EDGE_ENTRIES, start=1)
    ]
    door_x, door_z = _J["station_door"]
    entry_points.append(EntryPoint(id="st1", kind="station", name=STATION_NAME, x=door_x, z=door_z))
    landmark = Landmark(
        id="shoreditch-high-street",
        name=STATION_NAME,
        kind="station",
        buildingId=f"b{station_index}",
        x=sx,
        z=sz,
        h=DEFAULT_HEIGHT_M["station"],
        note="Schematic station (hand-written fallback layout)",
    )
    return MapData(
        bounds=BOUNDS,
        streets=streets,
        buildings=buildings,
        stores=stores,
        entryPoints=entry_points,
        sources=[FALLBACK_SOURCE],
        landmarks=[landmark],
    )


def main() -> None:
    data = fallback_map()
    write_processed("map.json", data)
    print(
        f"map (fallback): {len(data.streets)} streets, {len(data.buildings)} buildings, "
        f"{len(data.stores)} stores, {len(data.entryPoints)} entry points"
    )


if __name__ == "__main__":
    main()
