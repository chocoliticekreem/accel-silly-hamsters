"""demand.json pipeline step: synthetic map + synthetic TfL NUMBAT workbooks, no network."""

from __future__ import annotations

import io
from collections.abc import Callable

import openpyxl
import pytest

from backend import cache, settings, store
from backend.contract import (
    Bounds,
    Building,
    EntryKind,
    EntryPoint,
    HoursWindow,
    MapData,
    MapStore,
    Street,
)
from backend.pipeline import common, demand
from backend.schemas import DemandFile

STATION_ROW_NAME = "Shoreditch High Street"


def _quarter_hour_labels() -> list[str]:
    labels = []
    for i in range(96):
        start = (5 * 60 + 15 * i) % 1440
        end = (start + 15) % 1440
        labels.append(f"{start // 60:02d}{start % 60:02d}-{end // 60:02d}{end % 60:02d}")
    return labels


def _hourly(peak_hour: int, peak: float, late: float = 0.0) -> list[float]:
    """Exits per clock hour over a traffic day: 40/h from 06:00, a peak, `late` for 01:00-04:59."""
    hours = [40.0 if h >= 6 else 0.0 for h in range(24)]
    hours[peak_hour] = peak
    for h in range(1, 5):
        hours[h] = late
    return hours


# Synthetic exits by NUMBAT day type: weekday AM peak, weekend lunch peak, night trains Fri/Sat.
SYNTHETIC_EXITS = {
    "MON": _hourly(8, 400.0),
    "TWT": _hourly(8, 400.0),
    "FRI": _hourly(8, 400.0, late=20.0),
    "SAT": _hourly(13, 300.0, late=20.0),
    "SUN": _hourly(13, 200.0),
}
# Liverpool Street's two NUMBAT rows: a bigger commuter station, AM peak 09:00 (LU) and PM
# peak 17:00 (NR) on weekdays.
LIVERPOOL_STREET_EXITS = {
    "Liverpool Street LU": {
        d: _hourly(9 if d in ("MON", "TWT", "FRI") else 14, 3000.0) for d in SYNTHETIC_EXITS
    },
    "Liverpool Street NR": {d: _hourly(17, 1000.0) for d in SYNTHETIC_EXITS},
}
# Old Street (Northern line): twice Shoreditch High Street's exits, peaking at 08:00 too.
OLD_STREET_EXITS = {d: [2 * v for v in SYNTHETIC_EXITS[d]] for d in SYNTHETIC_EXITS}


def numbat_workbook(
    hourly: list[float],
    station: str = STATION_ROW_NAME,
    others: dict[str, list[float]] | None = None,
) -> bytes:
    """A minimal NUMBAT-shaped workbook: title rows, header, another station, `station`, then
    `others` (more station rows by name)."""
    labels = _quarter_hour_labels()

    def row(name: str, by_hour: list[float]) -> list[object]:
        values = [by_hour[int(label[:2])] / 4 for label in labels]
        return [1024, "SDCr", name, 1, sum(values)] + [0] * 6 + values

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Station_Exits"
    sheet.append(["Station Exits"])
    sheet.append([None] * 10 + ["quarter hour (qhr)"])
    sheet.append(
        ["NLC", "ASC", "Station", "Fare Zone", "Total"]
        + ["Early", "AM Peak", "Midday", "PM Peak", "Evening", "Late", *labels]
    )
    sheet.append([1, "OTHx", "Other Station", 1, 0] + [0] * 6 + [999.0] * 96)
    sheet.append(row(station, hourly))
    for name, by_hour in (others or {}).items():
        sheet.append(row(name, by_hour))
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def synthetic_map(entry_points: list[EntryPoint] | None = None) -> MapData:
    return MapData(
        bounds=Bounds(minX=-100, maxX=100, minZ=-100, maxZ=100),
        streets=[
            Street(id="main", name="Main St", points=[(0, -100), (0, 100)], width=14),
            Street(id="side", name="Side St", points=[(-100, 50), (0, 50)], width=8),
        ],
        buildings=[
            Building(id="b1", kind="club", storeId="c1", x=20, z=20, w=20, d=15, h=8),
            Building(id="b2", kind="club", storeId="c2", x=-20, z=-20, w=30, d=20, h=8),
            Building(id="b3", kind="store", storeId="s1", x=20, z=-20, w=10, d=10, h=8),
        ],
        stores=[
            MapStore(
                id="c1",
                name="Club One",
                type="club",
                buildingId="b1",
                defaultHours=HoursWindow(open="23:00", close="04:00"),
                floorArea=400.0,
            ),
            MapStore(id="c2", name="Club Two", type="club", buildingId="b2"),
            MapStore(id="s1", name="Cafe", type="cafe", buildingId="b3"),
        ],
        entryPoints=entry_points
        if entry_points is not None
        else [
            EntryPoint(id="north", kind="street", x=0, z=100),
            EntryPoint(id="west", kind="street", x=-100, z=50),
            EntryPoint(id="st", kind="station", name="Shoreditch High Street", x=10, z=0),
        ],
    )


class FakeTfl:
    """Stands in for the network: NUMBAT workbook downloads and the Night route API call."""

    def __init__(self) -> None:
        self.downloads: list[str] = []
        self.numbat_down = False
        self.zero_exits = False
        self.api_down = False

    def download(self, url: str) -> bytes:
        self.downloads.append(url)
        if self.numbat_down:
            raise common.FetchError(f"tfl: GET {url} failed: offline")
        day_type = url.rsplit("NBT25", 1)[1].split("_", 1)[0]
        return numbat_workbook(
            [0.0] * 24 if self.zero_exits else SYNTHETIC_EXITS[day_type],
            others={
                **{name: rows[day_type] for name, rows in LIVERPOOL_STREET_EXITS.items()},
                "Old Street": OLD_STREET_EXITS[day_type],
            },
        )

    def fetch(self, source: str, url: str, **kwargs: object) -> tuple[object, str]:
        if self.api_down:
            raise common.FetchError(f"{source}: GET {url} failed: offline")
        body = {"stopPointSequences": [{"stopPoint": [{"id": "910GSHRDHST"}, {"id": "x"}]}]}
        return body, "2026-10-15T00:00:00Z"


@pytest.fixture
def tfl(tmp_path, monkeypatch) -> FakeTfl:
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "RAW_DIR", tmp_path / "raw")
    monkeypatch.setattr(cache, "policy", cache.CachePolicy(disabled=False))
    fake = FakeTfl()
    monkeypatch.setattr(demand, "_download", fake.download)
    monkeypatch.setattr(common, "fetch", fake.fetch)
    return fake


SHS_INTO_AREA = demand.RAIL_STATIONS[STATION_ROW_NAME].into_area
LIVERPOOL_STREET_INTO_AREA = demand.RAIL_STATIONS["Liverpool Street"].into_area


def _expected_rail() -> dict[str, list[float]]:
    return demand.calendar_profiles(SYNTHETIC_EXITS)


def _expected_liverpool_street() -> dict[str, list[float]]:
    rows = list(LIVERPOOL_STREET_EXITS.values())
    summed = {d: [sum(r[d][h] for r in rows) for h in range(24)] for d in SYNTHETIC_EXITS}
    return demand.calendar_profiles(summed)


def two_station_map() -> MapData:
    """The synthetic map plus a Liverpool Street station entry."""
    return synthetic_map(
        [
            EntryPoint(id="north", kind="street", x=0, z=100),
            EntryPoint(id="west", kind="street", x=-100, z=50),
            EntryPoint(id="st1", kind="station", name="Shoreditch High Street", x=10, z=0),
            EntryPoint(id="st2", kind="station", name="Liverpool Street", x=0, z=-100),
        ]
    )


def _station_hours(result: DemandFile, day_type: str) -> list[float]:
    return getattr(result.entryPoints["st"], day_type)


# --- end to end -----------------------------------------------------------------------------


def test_build_writes_a_valid_file_keyed_by_the_map(tfl: FakeTfl) -> None:
    result = demand.build(map_data=synthetic_map())

    assert set(result.entryPoints) == {"north", "west", "st"}
    assert [n.clubId for n in result.clubNights] == ["c1", "c2"]
    assert result.fallback is False
    assert store.load_demand() == result
    numbat = [s for s in result.sources if "NUMBAT" in s.label]
    assert len(numbat) == 5 and all(s.fetchedAt for s in numbat)
    assert any("Night route" in s.label for s in result.sources)
    assert any(n.startswith("Units: sim agents per hour") for n in result.notes)


def test_daily_totals_fit_the_sim_budget(tfl: FakeTfl) -> None:
    result = demand.build(map_data=synthetic_map())

    weekday, weekend = demand.daily_totals(result)
    rail = _expected_rail()
    assert weekday == pytest.approx(demand.SIM_WEEKDAY_ARRIVALS, abs=0.5)
    assert weekend == pytest.approx(weekday * sum(rail["weekend"]) / sum(rail["weekday"]), abs=0.5)
    assert 2000 <= weekday <= 4000 and 1000 <= weekend <= 4000  # BUILD_NOTES, 1.5 km map


def test_station_entry_follows_numbat_exits_on_calendar_days(tfl: FakeTfl) -> None:
    result = demand.build(map_data=synthetic_map())

    weekday, weekend = _station_hours(result, "weekday"), _station_hours(result, "weekend")
    assert max(range(24), key=weekday.__getitem__) == 8
    assert max(range(24), key=weekend.__getitem__) == 13
    assert weekday[1:5] == [0.0] * 4  # no night trains Sun-Thu nights
    assert all(v > 0 for v in weekend[1:5])  # Fri/Sat night trains land on Sat/Sun mornings
    station_share = demand.STATION_SHARE * demand.SIM_WEEKDAY_ARRIVALS
    assert sum(weekday) == pytest.approx(station_share, abs=0.5)


def test_calendar_profiles_move_late_bands_to_the_next_morning() -> None:
    by_workbook = {d: [0.0] * 24 for d in demand.NUMBAT_DAY_TYPES}
    by_workbook["FRI"][2] = 10.0  # Friday night, 02:00 Saturday
    by_workbook["SUN"][2] = 5.0  # Sunday night, 02:00 Monday
    by_workbook["SAT"][12] = 4.0  # Saturday midday

    profiles = demand.calendar_profiles(by_workbook)

    assert profiles["weekend"][2] == pytest.approx(10.0 / 2)
    assert profiles["weekday"][2] == pytest.approx(5.0 / 5)
    assert profiles["weekend"][12] == pytest.approx(4.0 / 2)


def test_street_entries_split_by_street_width(tfl: FakeTfl) -> None:
    result = demand.build(map_data=synthetic_map())

    north, west = sum(result.entryPoints["north"].weekday), sum(result.entryPoints["west"].weekday)
    assert north / west == pytest.approx(14 / 8, rel=2e-3)
    street_total = (1 - demand.STATION_SHARE) * demand.SIM_WEEKDAY_ARRIVALS
    assert north + west == pytest.approx(street_total, abs=0.5)
    # Weekend night-time-economy walk-ins keep the streets busy after the trains stop.
    assert result.entryPoints["north"].weekend[2] > 0


def test_each_station_takes_its_own_exits_times_its_share_walking_into_the_area(
    tfl: FakeTfl,
) -> None:
    result = demand.build(map_data=two_station_map())

    shs, lst = demand.calendar_profiles(SYNTHETIC_EXITS), _expected_liverpool_street()
    for day_type in ("weekday", "weekend"):
        into_shs = sum(shs[day_type]) * SHS_INTO_AREA
        into_lst = sum(lst[day_type]) * LIVERPOOL_STREET_INTO_AREA
        st1, st2 = (sum(getattr(result.entryPoints[e], day_type)) for e in ("st1", "st2"))
        assert st1 / st2 == pytest.approx(into_shs / into_lst, rel=2e-3)
    stations = sum(result.entryPoints["st1"].weekday) + sum(result.entryPoints["st2"].weekday)
    station_budget = demand.SIM_WEEKDAY_ARRIVALS * demand.STATION_SHARE
    assert stations == pytest.approx(station_budget, abs=0.5)
    weekday_lst = result.entryPoints["st2"].weekday
    assert max(range(24), key=weekday_lst.__getitem__) == 9, "Liverpool Street's own AM peak"
    weekday_shs = result.entryPoints["st1"].weekday
    assert max(range(24), key=weekday_shs.__getitem__) == 8
    numbat = [s for s in result.sources if "NUMBAT" in s.label]
    assert len(numbat) == 5 and all("Liverpool Street NR" in s.label for s in numbat)
    assert len(tfl.downloads) == 5, "one download per workbook for all three station rows"
    assert any("Liverpool Street 20%" in n for n in result.notes)


def test_two_station_snapshot_fallback_keeps_both_stations(tfl: FakeTfl) -> None:
    tfl.numbat_down = True

    result = demand.build(map_data=two_station_map())

    assert result.fallback is True
    snapshot = demand.SNAPSHOT_EXITS
    into_weekday = sum(snapshot[STATION_ROW_NAME]["weekday"]) * SHS_INTO_AREA
    into_lst = sum(snapshot["Liverpool Street"]["weekday"]) * LIVERPOOL_STREET_INTO_AREA
    st1, st2 = (sum(result.entryPoints[e].weekday) for e in ("st1", "st2"))
    assert st1 / st2 == pytest.approx(into_weekday / into_lst, rel=2e-3)
    weekday, _ = demand.daily_totals(result)
    assert weekday == pytest.approx(demand.SIM_WEEKDAY_ARRIVALS, abs=0.5)


@pytest.mark.parametrize("kind", ["station", "street"])
def test_single_kind_maps_take_every_arrival(tfl: FakeTfl, kind: EntryKind) -> None:
    entries = [
        EntryPoint(id="a", kind=kind, x=0, z=100),
        EntryPoint(id="b", kind=kind, x=0, z=-100),
    ]

    result = demand.build(map_data=synthetic_map(entries))

    weekday, _ = demand.daily_totals(result)
    assert set(result.entryPoints) == {"a", "b"}
    assert weekday == pytest.approx(demand.SIM_WEEKDAY_ARRIVALS, abs=0.5)


def test_club_nights_take_map_hours_else_default_and_scale_capacity(tfl: FakeTfl) -> None:
    result = demand.build(map_data=synthetic_map())

    c1, c2 = result.clubNights
    assert (c1.open, c1.close, c1.days) == ("23:00", "04:00", ["thu", "fri", "sat"])
    assert (c2.open, c2.close) == demand.CLUB_DEFAULT_HOURS
    into_area = sum(_expected_rail()["weekday"]) * SHS_INTO_AREA
    agents_per_person = demand.SIM_WEEKDAY_ARRIVALS * demand.STATION_SHARE / into_area
    assert c1.capacity == round(400 / 0.5 * demand.CLUB_PEAK_FILL * agents_per_person)
    assert c2.capacity == round(30 * 20 / 0.5 * demand.CLUB_PEAK_FILL * agents_per_person)


def test_club_real_capacity_clamps_and_defaults() -> None:
    def club(area: float | None) -> MapStore:
        return MapStore(id="c", name="C", type="club", buildingId="missing", floorArea=area)

    assert demand.club_real_capacity(club(None), None) == demand.CLUB_DEFAULT_REAL_CAPACITY
    assert demand.club_real_capacity(club(10.0), None) == demand.CLUB_REAL_CAPACITY_RANGE[0]
    assert demand.club_real_capacity(club(1e6), None) == demand.CLUB_REAL_CAPACITY_RANGE[1]
    assert (
        demand.club_hours(
            MapStore(
                id="c",
                name="C",
                type="club",
                buildingId="b",
                defaultHours=HoursWindow(open="00:00", close="00:00"),
            )
        )
        == demand.CLUB_DEFAULT_HOURS
    )


@pytest.mark.parametrize(
    ("opens", "closes", "night"),
    [
        ("22:00", "03:00", True),
        ("18:00", "00:30", True),
        ("17:00", "00:00", False),  # OSM bar trade hours on a venue tagged nightclub
        ("12:00", "00:00", False),
        ("22:00", "22:00", False),  # 24 h
        ("21:00", "09:00", False),
    ],
)
def test_club_map_hours_count_only_when_they_describe_a_night(
    opens: str, closes: str, night: bool
) -> None:
    club = MapStore(
        id="c",
        name="C",
        type="club",
        buildingId="b",
        defaultHours=HoursWindow(open=opens, close=closes),
    )

    expected = (opens, closes) if night else demand.CLUB_DEFAULT_HOURS
    assert demand.club_hours(club) == expected


def test_returning_pool_covers_the_busiest_day(tfl: FakeTfl) -> None:
    result = demand.build(map_data=synthetic_map())

    weekday, weekend = demand.daily_totals(result)
    assert 0 < result.returningShare < 1
    assert result.returningPoolSize >= result.returningShare * max(weekday, weekend)


# --- fallbacks and caching ------------------------------------------------------------------


def test_unreachable_numbat_falls_back_to_the_labelled_snapshot(tfl: FakeTfl) -> None:
    tfl.numbat_down = True

    result = demand.build(map_data=synthetic_map())

    assert result.fallback is True
    assert result.notes[0].startswith("FALLBACK: TfL NUMBAT unavailable")
    snapshot = [s for s in result.sources if "snapshot" in s.label]
    assert len(snapshot) == 1 and snapshot[0].fetchedAt is None
    assert set(result.entryPoints) == {"north", "west", "st"}
    weekday, weekend = demand.daily_totals(result)
    shs = demand.SNAPSHOT_EXITS[STATION_ROW_NAME]
    ratio = sum(shs["weekend"]) / sum(shs["weekday"])
    assert weekday == pytest.approx(demand.SIM_WEEKDAY_ARRIVALS, abs=0.5)
    assert weekend == pytest.approx(weekday * ratio, abs=0.5)


def test_a_station_row_of_zeros_falls_back_instead_of_dividing_by_zero(tfl: FakeTfl) -> None:
    tfl.zero_exits = True

    result = demand.build(map_data=synthetic_map())

    assert result.fallback is True
    assert "has no exits" in result.notes[0]


def test_a_fallback_build_is_retried_on_the_next_run(tfl: FakeTfl) -> None:
    tfl.numbat_down = True
    assert demand.build(map_data=synthetic_map()).fallback is True

    tfl.numbat_down = False
    assert demand.build(map_data=synthetic_map()).fallback is False


def test_pipeline_cache_skips_an_unchanged_map_and_rebuilds_on_change(
    tfl: FakeTfl, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[MapData] = []
    real_build: Callable[[MapData], DemandFile] = demand.build_demand

    def counting_build(map_data: MapData) -> DemandFile:
        calls.append(map_data)
        return real_build(map_data)

    monkeypatch.setattr(demand, "build_demand", counting_build)

    demand.build(map_data=synthetic_map())
    demand.build(map_data=synthetic_map())
    assert len(calls) == 1

    renamed = synthetic_map()
    renamed.entryPoints[0].id = "north-2"
    result = demand.build(map_data=renamed)
    assert len(calls) == 2
    assert "north-2" in result.entryPoints and "north" not in result.entryPoints
    assert len(tfl.downloads) == 5  # the rebuild read the NUMBAT extracts from the scrape cache


def test_refresh_redownloads_and_restores_the_cache_policy(tfl: FakeTfl) -> None:
    demand.build(map_data=synthetic_map())
    demand.build(map_data=synthetic_map(), refresh=True)

    assert len(tfl.downloads) == 10
    assert cache.policy.refresh is False


def test_unreachable_night_route_is_noted_not_cited(tfl: FakeTfl) -> None:
    tfl.api_down = True

    result = demand.build(map_data=synthetic_map())

    assert result.fallback is False
    assert not any("Night route" in s.label for s in result.sources)
    assert any("not checked this build" in n for n in result.notes)


def test_build_reads_the_processed_map_by_default(tfl: FakeTfl) -> None:
    store.write_json(settings.PROCESSED_DIR / "map.json", synthetic_map())

    result = demand.build()

    assert set(result.entryPoints) == {e.id for e in store.load_map().entryPoints}


def test_a_map_without_entry_points_is_rejected(tfl: FakeTfl) -> None:
    with pytest.raises(ValueError, match="no entry points"):
        demand.build(map_data=synthetic_map(entry_points=[]))


# --- NUMBAT parsing -------------------------------------------------------------------------


def test_parse_station_exits_reads_96_quarter_hours_per_station() -> None:
    lu = LIVERPOOL_STREET_EXITS["Liverpool Street LU"]["TWT"]
    parsed = demand.parse_station_exits(
        numbat_workbook(SYNTHETIC_EXITS["TWT"], others={"Liverpool Street LU": lu}),
        ["Shoreditch High Street", "Liverpool Street LU"],
    )

    assert set(parsed) == {"Shoreditch High Street", "Liverpool Street LU"}
    assert all(len(quarter_hours) == 96 for quarter_hours in parsed.values())
    shs = demand.hourly_from_quarter_hours(parsed["Shoreditch High Street"])
    assert shs == pytest.approx(SYNTHETIC_EXITS["TWT"])
    assert demand.hourly_from_quarter_hours(parsed["Liverpool Street LU"]) == pytest.approx(lu)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (b"not a workbook", "unreadable"),
        (numbat_workbook(SYNTHETIC_EXITS["TWT"], station="Elsewhere"), "not found"),
    ],
)
def test_parse_station_exits_rejects_unexpected_files(payload: bytes, message: str) -> None:
    with pytest.raises(demand.SourceFormatError, match=message):
        demand.parse_station_exits(payload, ["Shoreditch High Street"])


def test_old_street_entrances_share_its_arrivals(tfl: FakeTfl) -> None:
    """Old Street's street entrances are several station entries with one name: the station's
    budget (its exits x its into-area share) is split equally between them."""
    entries = [
        EntryPoint(id="north", kind="street", x=0, z=100),
        EntryPoint(id="st1", kind="station", name="Shoreditch High Street", x=10, z=0),
        EntryPoint(id="st2", kind="station", name="Old Street", x=-50, z=50),
        EntryPoint(id="st3", kind="station", name="Old Street", x=-60, z=50),
        EntryPoint(id="st4", kind="station", name="Old Street", x=-70, z=50),
    ]

    result = demand.build(map_data=synthetic_map(entries))

    shs = sum(result.entryPoints["st1"].weekday)
    old_street = [sum(result.entryPoints[e].weekday) for e in ("st2", "st3", "st4")]
    assert max(old_street) - min(old_street) < 0.05, "entrances share equally"
    old_street_share = demand.RAIL_STATIONS["Old Street"].into_area
    expected = 2 * old_street_share / SHS_INTO_AREA
    assert sum(old_street) / shs == pytest.approx(expected, rel=2e-3)
    station_budget = demand.SIM_WEEKDAY_ARRIVALS * demand.STATION_SHARE
    assert shs + sum(old_street) == pytest.approx(station_budget, abs=0.5)
    assert any("Old Street 50%" in n for n in result.notes)


def test_old_street_has_a_snapshot_for_the_fallback(tfl: FakeTfl) -> None:
    tfl.numbat_down = True
    entries = [
        EntryPoint(id="st1", kind="station", name="Shoreditch High Street", x=10, z=0),
        EntryPoint(id="st2", kind="station", name="Old Street", x=-50, z=50),
    ]

    result = demand.build(map_data=synthetic_map(entries))

    assert result.fallback is True
    assert sum(result.entryPoints["st2"].weekday) > 0
