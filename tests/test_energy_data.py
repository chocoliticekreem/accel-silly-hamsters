"""Energy pipeline: per-type derivations, carbon parsing, and the live and fallback builds.

No test touches the network: the Carbon Intensity API is replaced by a stub.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, get_args
from zoneinfo import ZoneInfo

import pytest

from backend import cache, settings
from backend.contract import LightingLevel, StoreType
from backend.pipeline import energy
from backend.pipeline.common import FetchError
from backend.schemas import EnergyFile
from backend.store import read_json
from backend.timeutil import open_hours_fraction

STORE_TYPES: tuple[StoreType, ...] = get_args(StoreType)
LONDON = ZoneInfo("Europe/London")
NOW = datetime(2026, 10, 15, 9, 0, tzinfo=UTC)
HALF_HOUR = timedelta(minutes=30)


def cafe_baseline_lighting(hour: int) -> LightingLevel:
    """BUILD_NOTES baseline for a store open 07:00-18:00: open 07-17 low, open 17-07 high,
    closed 18-24 low (window display), closed 00-07 off."""
    if hour < 7:
        return "off"
    if hour == 17:
        return "high"
    return "low"


CAFE_BASELINE_LIGHTING = [cafe_baseline_lighting(hour) for hour in range(24)]


def day_kwh(
    e: EnergyFile,
    store_type: StoreType,
    floor_area: float,
    hours: tuple[str, str],
    lighting: list[LightingLevel] | None = None,
) -> float:
    """One day of store energy with the BUILD_NOTES formula, hour by hour."""
    total = 0.0
    for hour, open_fraction in enumerate(open_hours_fraction(*hours)):
        total += open_fraction * floor_area * e.kwhPerM2PerOpenHour[store_type]
        total += (1 - open_fraction) * floor_area * e.standbyKwhPerM2PerHour[store_type]
        if lighting is not None:
            total += e.lightingKw[lighting[hour]]
    return total


def api_time(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%MZ")


def api_row(start: datetime, forecast: float | None) -> dict[str, Any]:
    return {
        "from": api_time(start),
        "to": api_time(start + HALF_HOUR),
        "intensity": {"forecast": forecast, "index": "moderate"},
    }


def half_hours(start: datetime, days: int) -> list[datetime]:
    return [start + i * HALF_HOUR for i in range(days * 48)]


def unreachable(source: str, url: str, **kwargs: Any) -> tuple[Any, str]:
    raise FetchError(f"{source}: GET {url} failed: connection refused")


class StubCarbonApi:
    """Answers regional from/to URLs like the live API: `data` is one region object and the first
    row is the half-hour ending at `from`, given an outlier value so a missed filter shows up.
    Every in-window reading is 100 + its London clock hour."""

    def __init__(self) -> None:
        self.urls: list[str] = []

    def __call__(self, source: str, url: str, **kwargs: Any) -> tuple[Any, str]:
        self.urls.append(url)
        parts = url.split("/")
        at = parts.index("intensity")
        start = datetime.strptime(parts[at + 1], "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC)
        end = datetime.strptime(parts[at + 2], "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC)
        rows = [api_row(start - HALF_HOUR, 9999.0)]
        t = start
        while t < end:
            rows.append(api_row(t, 100.0 + t.astimezone(LONDON).hour))
            t += HALF_HOUR
        return {"data": {"regionid": 13, "shortname": "London", "data": rows}}, "2026-10-15T09:00Z"


@pytest.fixture
def offline_energy(monkeypatch: pytest.MonkeyPatch) -> EnergyFile:
    monkeypatch.setattr(energy, "fetch", unreachable)
    return energy.energy_file(NOW)


@pytest.fixture
def isolated_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "RAW_DIR", tmp_path / "raw")
    monkeypatch.setattr(cache.policy, "refresh", False)
    monkeypatch.setattr(cache.policy, "disabled", False)
    return tmp_path


# --- store energy ---------------------------------------------------------------------------


def test_cafe_100m2_open_11h_uses_30_to_100_kwh_per_day(offline_energy: EnergyFile) -> None:
    base = day_kwh(offline_energy, "cafe", 100.0, ("07:00", "18:00"))
    lit = day_kwh(offline_energy, "cafe", 100.0, ("07:00", "18:00"), CAFE_BASELINE_LIGHTING)
    assert 30 <= base < lit <= 100


@pytest.mark.parametrize("store_type", STORE_TYPES)
def test_rates_reproduce_the_annual_benchmark_at_typical_hours(store_type: StoreType) -> None:
    basis = energy.TYPE_BASES[store_type]
    open_rate, standby_rate = energy.type_rates(basis)
    open_hours = energy.typical_open_hours(basis)
    annual = open_rate * open_hours + standby_rate * (energy.HOURS_PER_YEAR - open_hours)
    assert annual == pytest.approx(basis.annual_kwh_per_m2)
    assert 0 < standby_rate < open_rate


def test_every_store_type_has_rates_club_included(offline_energy: EnergyFile) -> None:
    assert set(offline_energy.kwhPerM2PerOpenHour) == set(STORE_TYPES)
    assert set(offline_energy.standbyKwhPerM2PerHour) == set(STORE_TYPES)
    assert all(len(energy.TYPE_BASES[t].benchmark) > 0 for t in STORE_TYPES)


def test_refrigerated_types_have_the_highest_standby(offline_energy: EnergyFile) -> None:
    standby = offline_energy.standbyKwhPerM2PerHour
    refrigerated = min(standby["takeaway"], standby["offlicence"])
    assert all(standby[t] < refrigerated for t in ("cafe", "restaurant", "bar", "shop", "club"))


def test_lighting_levels_and_price(offline_energy: EnergyFile) -> None:
    lighting = offline_energy.lightingKw
    assert lighting["off"] == 0 < lighting["low"] < lighting["high"]
    assert offline_energy.priceGbpPerKwh == [pytest.approx(0.3201)] * 24


# --- carbon intensity -----------------------------------------------------------------------


def test_carbon_window_is_the_last_28_whole_utc_days() -> None:
    assert energy.carbon_window(NOW) == (
        datetime(2026, 9, 17, tzinfo=UTC),
        datetime(2026, 10, 15, tzinfo=UTC),
    )
    just_after_local_midnight = datetime(2026, 10, 15, 0, 30, tzinfo=timezone(timedelta(hours=1)))
    assert energy.carbon_window(just_after_local_midnight)[1] == datetime(2026, 10, 14, tzinfo=UTC)


def test_parse_regional_rows_accepts_the_live_and_the_documented_shape() -> None:
    start = datetime(2026, 10, 1, tzinfo=UTC)
    rows = [api_row(start, 120), api_row(start + HALF_HOUR, None)]
    live = {"data": {"regionid": 13, "data": rows}}
    documented = {"data": [{"regionid": 13, "data": rows}]}
    expected = [(start, 120.0)]
    assert energy.parse_regional_rows(live) == expected
    assert energy.parse_regional_rows(documented) == expected


@pytest.mark.parametrize(
    ("week_start", "utc_hour_at_local_13"),
    [(datetime(2026, 7, 1, tzinfo=UTC), 12), (datetime(2026, 1, 5, tzinfo=UTC), 13)],
)
def test_hourly_profile_groups_by_london_clock_hour(
    week_start: datetime, utc_hour_at_local_13: int
) -> None:
    readings = {t: float(t.hour) for t in half_hours(week_start, 7)}
    profile = energy.hourly_profile(readings)
    assert len(profile) == 24
    assert profile[13] == utc_hour_at_local_13


def test_hourly_profile_rejects_thin_coverage() -> None:
    readings = {t: 150.0 for t in half_hours(datetime(2026, 10, 1, tzinfo=UTC), 6)}
    with pytest.raises(ValueError, match="fewer than"):
        energy.hourly_profile(readings)


# --- build ----------------------------------------------------------------------------------


def test_build_live_averages_the_api_and_reuses_its_output(
    isolated_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = StubCarbonApi()
    monkeypatch.setattr(energy, "fetch", api)

    built = energy.build()

    assert built.fallback is False
    assert built.carbonGPerKwh == [100.0 + h for h in range(24)]
    assert len(api.urls) == 2
    cited = {s.url: s.fetchedAt for s in built.sources}
    assert all(cited[url] == "2026-10-15T09:00Z" for url in api.urls)
    assert built.notes[0].startswith("carbonGPerKwh: live.")
    on_disk = EnergyFile.model_validate(read_json(settings.PROCESSED_DIR / "energy.json"))
    assert on_disk == built

    assert energy.build() == built
    assert len(api.urls) == 2


def test_build_writes_the_labelled_snapshot_and_retries_when_unreachable(
    isolated_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    def refused(source: str, url: str, **kwargs: Any) -> tuple[Any, str]:
        calls.append(url)
        return unreachable(source, url)

    monkeypatch.setattr(energy, "fetch", refused)

    built = energy.build()

    assert built.fallback is True
    assert built.carbonGPerKwh == list(energy.CARBON_FALLBACK)
    assert built.notes[0].startswith("carbonGPerKwh: FALLBACK.")
    assert any(s.label.startswith("FALLBACK") for s in built.sources)
    energy.build()
    assert len(calls) == 2


def test_build_falls_back_on_an_error_body(
    isolated_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def error_body(source: str, url: str, **kwargs: Any) -> tuple[Any, str]:
        return {"error": {"code": "400 Bad Request", "message": "bad range"}}, "2026-10-15T09:00Z"

    monkeypatch.setattr(energy, "fetch", error_body)

    assert energy.build().fallback is True


def test_processed_energy_json_is_valid_and_sane() -> None:
    path = settings.PROCESSED_DIR / "energy.json"
    if not path.exists():
        pytest.skip("data/processed/energy.json not built yet")
    e = EnergyFile.model_validate(read_json(path))
    assert set(e.kwhPerM2PerOpenHour) == set(STORE_TYPES)
    assert all(0 < g < 1000 for g in e.carbonGPerKwh)
    assert 30 <= day_kwh(e, "cafe", 100.0, ("07:00", "18:00"), CAFE_BASELINE_LIGHTING) <= 100
