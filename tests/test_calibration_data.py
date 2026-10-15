"""calibration_data: anchor choice, placeholder labelling, BestTime and Outscraper parsing with
mocked HTTP (never the real APIs), API-key hygiene on disk, and the pipeline cache."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend import cache, settings, store
from backend.contract import Bounds, Building, MapData, MapStore, StoreType
from backend.pipeline import calibration_data as cal

BESTTIME_KEY = "pri_test_secret_besttime_0123456789"
OUTSCRAPER_KEY = "test-secret-outscraper-key-9876"

StoreRow = tuple[str, str, StoreType, float, float]  # id, name, type, x, z

STORES: list[StoreRow] = [
    ("c1", "Holywell Lane Club", "club", -200.0, 33.0),
    ("c2", "Brick Lane Club", "club", 205.0, -140.0),
    ("s1", "Holywell Grill", "takeaway", -170.0, 30.0),
    ("s2", "Late Bagel", "takeaway", 100.0, 58.0),
    ("s6", "High Street Coffee", "cafe", -136.0, 110.0),
    ("s10", "Station Cafe", "cafe", -51.0, -40.0),
    ("s12", "Curry House", "restaurant", 0.0, 82.0),
    ("s19", "Quaker Arms", "bar", 60.0, -100.0),
    ("s20", "Corner Shop", "shop", 10.0, 10.0),
]
EXPECTED_ANCHORS = [
    ("cafe", "s10"),
    ("restaurant", "s12"),
    ("bar", "s19"),
    ("club", "c1"),
    ("takeaway", "s1"),
]

Handler = Callable[[str, str, dict[str, Any]], tuple[int, Any]]


def make_map(stores: list[StoreRow] = STORES, *, osm: bool = False) -> MapData:
    buildings = [
        Building(
            id=f"b-{sid}",
            kind="club" if kind == "club" else "store",
            storeId=sid,
            x=x,
            z=z,
            w=10,
            d=10,
            h=8,
        )
        for sid, _, kind, x, z in stores
    ]
    map_stores = [
        MapStore(
            id=sid,
            name=name,
            type=kind,
            buildingId=f"b-{sid}",
            osmId=f"node/{i}" if osm else None,
        )
        for i, (sid, name, kind, _, _) in enumerate(stores)
    ]
    return MapData(
        bounds=Bounds(minX=-250, maxX=250, minZ=-250, maxZ=250),
        streets=[],
        buildings=buildings,
        stores=map_stores,
        entryPoints=[],
    )


def no_network(method: str, url: str, **kwargs: Any) -> httpx.Response:
    raise AssertionError(f"unexpected HTTP call: {method} {url}")


class FakeHttp:
    """Stands in for httpx.request: records each call and answers from a handler."""

    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        self.calls.append((method, url))
        status, payload = self.handler(method, url, kwargs)
        return httpx.Response(status, json=payload, request=httpx.Request(method, url))


@pytest.fixture(autouse=True)
def workdir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Processed and raw dirs in tmp, default cache policy, no keys, and no network."""
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "RAW_DIR", tmp_path / "raw")
    monkeypatch.setattr(cache.policy, "refresh", False)
    monkeypatch.setattr(cache.policy, "fresh", False)
    monkeypatch.setattr(cache.policy, "disabled", False)
    monkeypatch.delenv(cal.BESTTIME_KEY_ENV, raising=False)
    monkeypatch.delenv(cal.OUTSCRAPER_KEY_ENV, raising=False)
    monkeypatch.setattr(httpx, "request", no_network)
    return tmp_path


def everything_written(root: Path) -> str:
    return "".join(p.read_text() for p in root.rglob("*") if p.is_file())


def besttime_body(name: str, day_raw: dict[int, list[int]] | None = None) -> dict[str, Any]:
    """A BestTime new-forecast response as documented at documentation.besttime.app."""
    raw = day_raw or {}
    return {
        "status": "OK",
        "venue_info": {
            "venue_id": "ven_0",
            "venue_name": name,
            "venue_address": "1 Test St, London E1 6AA, United Kingdom",
            "venue_timezone": "Europe/London",
        },
        "analysis": [
            {
                "day_info": {"day_int": d, "day_text": cal.WEEKDAY_NAMES[d].title()},
                "day_raw": raw.get(d, [0] * 24),
            }
            for d in range(7)
        ],
        "epoch_analysis": "1760000000",
    }


def outscraper_day(day: int, values: dict[int, int]) -> dict[str, Any]:
    """One popular_times entry: ISO day 1 = Monday, hours in chart order 06:00 to 02:00."""
    hours = [*range(6, 24), 0, 1, 2]
    return {
        "day": day,
        "day_text": cal.WEEKDAY_NAMES[day - 1].title(),
        "popular_times": [
            {"hour": h, "percentage": values.get(h, 0), "title": "", "time": f"{h}h"} for h in hours
        ],
    }


# --- placeholders (what runs without keys) --------------------------------------------------


def test_placeholders_are_matched_by_type_and_labelled_not_measured() -> None:
    map_data = make_map()
    result = cal.build(map_data)

    assert [(v.type, v.storeId) for v in result.venues] == EXPECTED_ANCHORS
    assert {v.storeId for v in result.venues} <= {s.id for s in map_data.stores}
    assert all(not v.measured and v.source is None for v in result.venues)
    assert [v.name for v in result.venues] == [
        "Typical cafe",
        "Typical restaurant",
        "Typical bar",
        "Typical club",
        "Typical late-night takeaway",
    ]
    assert result.fallback is True
    assert result.sources == []
    assert result.notes[0].startswith("PLACEHOLDER, NOT MEASURED: 5 of 5 venues")
    assert any("BESTTIME_API_KEY and OUTSCRAPER_API_KEY are not set" in n for n in result.notes)
    assert any(n.startswith("London Datastore checked") for n in result.notes)
    assert store.load_calibration() == result


def test_placeholder_shapes_use_clock_hours_and_the_0_to_100_scale() -> None:
    for slot, shape in cal.PLACEHOLDER_SHAPES.items():
        for sparse in (shape.weekday, shape.weekend):
            assert set(sparse) <= set(range(24)), slot
            assert all(0 <= value <= 100 for value in sparse.values()), slot


def test_the_takeaway_nearest_a_club_is_paired_with_that_club() -> None:
    stores: list[StoreRow] = [
        ("c1", "Club A", "club", -200.0, 0.0),
        ("c2", "Club B", "club", 200.0, 0.0),
        ("t1", "Grill", "takeaway", 0.0, 5.0),
        ("t2", "Kebab", "takeaway", 190.0, 10.0),
    ]
    anchors = cal.select_anchors(make_map(stores))

    assert [(a.slot, a.store.id) for a in anchors] == [
        ("club", "c2"),
        ("late-night takeaway", "t2"),
    ]
    assert anchors[1].reason == "the takeaway nearest a club (Club B, 14 m)"


def test_a_sparse_map_gives_fewer_venues_and_says_so() -> None:
    stores: list[StoreRow] = [
        ("k1", "Cafe One", "cafe", 0.0, 10.0),
        ("t1", "Grill", "takeaway", 20.0, 0.0),
    ]
    result = cal.build(make_map(stores))

    assert [v.storeId for v in result.venues] == ["k1", "t1"]
    assert any(n.startswith("Only 2 anchor venues") for n in result.notes)
    assert any("(no club in map)" in n for n in result.notes)


# --- BestTime -------------------------------------------------------------------------------


def test_besttime_hours_after_midnight_move_to_the_next_calendar_day() -> None:
    raw = {d: [0] * 24 for d in range(7)}
    raw[0][0] = 50  # Monday's BestTime day starts at 06:00 Monday
    raw[4][19] = 80  # Friday's BestTime day, index 19 = 01:00 on Saturday
    raw[6][18] = 30  # Sunday's BestTime day, index 18 = 00:00 on Monday
    week = cal.besttime_week(besttime_body("X", raw))
    weekday, weekend = cal.weekday_weekend(week)

    assert (week[5][1], week[4][1], week[0][0]) == (80, 0, 30)
    assert weekday[6] == 10.0  # Monday 06:00 = 50, averaged over five weekdays
    assert weekday[0] == 6.0  # Sunday night's 00:00 belongs to Monday
    assert weekend[1] == 40.0  # Friday night's 01:00 belongs to Saturday


@pytest.mark.parametrize(
    "body",
    [
        {"status": "Error", "message": "Venue not found"},
        {"status": "OK", "analysis": []},
        {**besttime_body("X"), "analysis": [{"day_raw": [0] * 23}] * 7},
        {**besttime_body("X"), "analysis": [{"day_raw": [101] * 24}] * 7},
    ],
)
def test_besttime_rejects_unusable_forecasts(body: dict[str, Any]) -> None:
    with pytest.raises(cal.ProviderDataError):
        cal.besttime_week(body)


def test_besttime_key_gives_measured_venues_and_never_reaches_disk(
    monkeypatch: pytest.MonkeyPatch, workdir: Path
) -> None:
    monkeypatch.setenv(cal.BESTTIME_KEY_ENV, BESTTIME_KEY)
    friday_night = [0] * 24
    friday_night[19] = 80

    def handler(method: str, url: str, kwargs: dict[str, Any]) -> tuple[int, Any]:
        assert (method, url) == ("POST", cal.BESTTIME_FORECAST_URL)
        params = kwargs["params"]
        assert params["api_key_private"] == BESTTIME_KEY
        assert params["venue_address"] == cal.VENUE_AREA
        return 200, besttime_body(params["venue_name"] + " Shoreditch", {4: friday_night})

    fake = FakeHttp(handler)
    monkeypatch.setattr(httpx, "request", fake)
    result = cal.build(make_map(osm=True))

    assert len(fake.calls) == 5
    assert [(v.type, v.storeId) for v in result.venues] == EXPECTED_ANCHORS
    assert all(v.measured for v in result.venues)
    assert result.fallback is False
    assert len(result.sources) == 5 and all(s.fetchedAt for s in result.sources)
    assert not any(n.startswith("PLACEHOLDER") for n in result.notes)
    takeaway = result.venues[-1]
    assert takeaway.name == "Holywell Grill Shoreditch"
    assert takeaway.weekend[1] == 40.0
    assert list((workdir / "raw" / "besttime").glob("*.json"))
    assert BESTTIME_KEY not in everything_written(workdir)

    # The key is not part of the scrape-cache key: a rotated key reuses the cached forecasts.
    monkeypatch.setenv(cal.BESTTIME_KEY_ENV, "pri_rotated_key")
    monkeypatch.setattr(httpx, "request", no_network)
    again = cal.build(make_map(osm=True), refresh=True)
    assert again.venues == result.venues


def test_a_besttime_error_falls_back_to_placeholders_with_redacted_notes(
    monkeypatch: pytest.MonkeyPatch, workdir: Path
) -> None:
    monkeypatch.setenv(cal.BESTTIME_KEY_ENV, BESTTIME_KEY)
    rejected = {"status": "Error", "message": f"Invalid api_key_private {BESTTIME_KEY}"}
    monkeypatch.setattr(httpx, "request", FakeHttp(lambda m, u, k: (401, rejected)))
    result = cal.build(make_map(osm=True))

    assert not any(v.measured for v in result.venues)
    assert result.fallback is True
    failures = [n for n in result.notes if "BestTime gave no usable data" in n]
    assert len(failures) == 5
    assert "HTTP 401" in failures[0] and "***" in failures[0]
    assert BESTTIME_KEY not in everything_written(workdir)


def test_a_provider_venue_with_another_name_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(cal.BESTTIME_KEY_ENV, BESTTIME_KEY)
    monkeypatch.setattr(httpx, "request", FakeHttp(lambda m, u, k: (200, besttime_body("Pret"))))
    result = cal.build(make_map(osm=True))

    assert not any(v.measured for v in result.venues)
    assert any("found 'Pret', not 'Station Cafe'" in n for n in result.notes)


def test_no_lookup_for_made_up_fallback_map_venues(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(cal.BESTTIME_KEY_ENV, BESTTIME_KEY)
    result = cal.build(make_map(osm=False))  # no_network fails the test on any request

    assert not any(v.measured for v in result.venues)
    assert sum("provider lookup skipped" in n for n in result.notes) == 5


# --- Outscraper -----------------------------------------------------------------------------


def test_outscraper_hours_after_the_chart_wraps_move_to_the_next_day() -> None:
    popular_times = [outscraper_day(d, {}) for d in range(1, 8)]
    popular_times[4] = outscraper_day(5, {20: 50, 1: 70})  # Friday
    popular_times.append({"day": "live", "percentage": 99, "title": "Busier than usual"})
    weekday, weekend = cal.weekday_weekend(cal.outscraper_week(popular_times))

    assert weekday[20] == 10.0  # Friday 20:00, averaged over five weekdays
    assert weekend[1] == 35.0  # Friday night's 01:00 belongs to Saturday
    assert weekday[1] == 0.0


def test_outscraper_key_gives_measured_venues(
    monkeypatch: pytest.MonkeyPatch, workdir: Path
) -> None:
    monkeypatch.setenv(cal.OUTSCRAPER_KEY_ENV, OUTSCRAPER_KEY)

    def handler(method: str, url: str, kwargs: dict[str, Any]) -> tuple[int, Any]:
        assert (method, url) == ("GET", cal.OUTSCRAPER_SEARCH_URL)
        assert kwargs["headers"]["X-API-KEY"] == OUTSCRAPER_KEY
        assert kwargs["params"]["async"] == "false"
        place = {
            "name": kwargs["params"]["query"].split(",")[0],
            "full_address": "1 Test St, London E1 6AA",
            "place_id": "ChIJtest",
            "popular_times": [outscraper_day(d, {12: 40}) for d in range(1, 8)],
        }
        return 200, {"id": "request-id", "status": "Success", "data": [[place]]}

    monkeypatch.setattr(httpx, "request", FakeHttp(handler))
    result = cal.build(make_map(osm=True))

    assert all(v.measured for v in result.venues) and result.fallback is False
    assert result.venues[0].weekday[12] == 40.0 and result.venues[0].weekend[12] == 40.0
    assert result.sources[0].label == "Google Popular Times via Outscraper: Station Cafe"
    assert result.sources[0].url.endswith("&query_place_id=ChIJtest")
    assert OUTSCRAPER_KEY not in everything_written(workdir)


def test_outscraper_is_tried_when_besttime_has_no_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(cal.BESTTIME_KEY_ENV, BESTTIME_KEY)
    monkeypatch.setenv(cal.OUTSCRAPER_KEY_ENV, OUTSCRAPER_KEY)

    def handler(method: str, url: str, kwargs: dict[str, Any]) -> tuple[int, Any]:
        if url == cal.BESTTIME_FORECAST_URL:
            return 404, {"status": "Error", "message": "Venue not found"}
        name = kwargs["params"]["query"].split(",")[0]
        days = [outscraper_day(d, {18: 60}) for d in range(1, 8)]
        return 200, {"status": "Success", "data": [[{"name": name, "popular_times": days}]]}

    monkeypatch.setattr(httpx, "request", FakeHttp(handler))
    result = cal.build(make_map(osm=True))

    assert all(v.measured for v in result.venues)
    assert all(s.label.startswith("Google Popular Times via Outscraper") for s in result.sources)
    assert sum("HTTP 404: Venue not found" in n for n in result.notes) == 5


def test_outscraper_errors_and_empty_results_are_unusable() -> None:
    for body in (
        {"error": True, "errorMessage": "Please close past due invoices"},
        {"id": "request-id", "status": "Pending"},
        {"status": "Success", "data": [[]]},
    ):
        with pytest.raises(cal.ProviderDataError):
            cal._outscraper_place(body)
    with pytest.raises(cal.ProviderDataError):
        cal.outscraper_week(None)


# --- names, caching, main -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b", "same"),
    [
        ("Ozone Coffee", "Ozone Coffee Roasters", True),
        ("Dishoom Shoreditch", "Dishoom", True),
        ("The Old Station Bar", "Old Station Bar", True),
        ("Café Nero", "Cafe Nero", True),
        ("Cafe", "Cafe Nero", False),
        ("Station Cafe", "Pret A Manger", False),
        ("", "Anything", False),
    ],
)
def test_names_match(a: str, b: str, same: bool) -> None:
    assert cal.names_match(a, b) is same


def test_rebuilds_only_when_map_stores_or_code_change(
    monkeypatch: pytest.MonkeyPatch, workdir: Path
) -> None:
    map_data = make_map()
    first = cal.build(map_data)

    def rebuilt(*args: Any) -> None:
        raise AssertionError("rebuilt")

    monkeypatch.setattr(cal, "assemble", rebuilt)
    assert cal.build(map_data) == first
    renamed = make_map(
        [("s99" if sid == "s10" else sid, name, kind, x, z) for sid, name, kind, x, z in STORES]
    )
    with pytest.raises(AssertionError, match="rebuilt"):
        cal.build(renamed)
    with pytest.raises(AssertionError, match="rebuilt"):
        cal.build(map_data, refresh=True)
    edited = workdir / "calibration_data_edited.py"
    edited.write_text(Path(cal.__file__).read_text() + "\n# an edited shape\n")
    monkeypatch.setattr(cal, "__file__", str(edited))
    with pytest.raises(AssertionError, match="rebuilt"):
        cal.build(map_data)


def test_main_builds_from_map_json(capsys: pytest.CaptureFixture[str]) -> None:
    store.write_json(settings.PROCESSED_DIR / "map.json", make_map())
    cal.main()

    out = capsys.readouterr().out
    assert "calibration.json: 5 venues, fallback=True" in out
    assert "s1     takeaway   measured=False Typical late-night takeaway\n" in out
