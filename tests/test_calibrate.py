"""Calibration scoring: peak-normalised hourly shapes; placeholder targets never count."""

from __future__ import annotations

from backend.contract import Source
from backend.pipeline import run_all
from backend.schemas import CalibrationVenue, StoreStats
from backend.sim import calibrate

FLAT = [0.0] * 24


def evening_peak(scale: float) -> list[float]:
    return [scale * (1.0 if 18 <= h <= 21 else 0.1) for h in range(24)]


def stats(weekday: list[float], weekend: list[float]) -> StoreStats:
    return StoreStats(
        visitsByHourWeekday=weekday,
        visitsByHourWeekend=weekend,
        footfallNearbyByHour=FLAT,
        foundClosedByHour=FLAT,
        kwhByHour=FLAT,
        uniqueVisitors=1,
        repeatVisitors=0,
        visitsByPersona={},
        energyCostGbp=0.0,
        co2Kg=0.0,
    )


def venue(store_id: str | None, measured: bool) -> CalibrationVenue:
    return CalibrationVenue(
        name="Typical bar",
        storeId=store_id,
        type="bar",
        weekday=evening_peak(80),
        weekend=evening_peak(100),
        measured=measured,
        source=Source(label="BestTime", url="https://besttime.app") if measured else None,
    )


def test_identical_shapes_score_zero_error_whatever_the_scale() -> None:
    result = calibrate.shape_error(evening_peak(3.0), evening_peak(70.0))
    assert result == {"mae": 0.0, "r": 1.0}


def test_opposite_shapes_score_high_error() -> None:
    night = [1.0 if h < 6 else 0.0 for h in range(24)]
    day = [0.0 if h < 6 else 1.0 for h in range(24)]
    assert calibrate.shape_error(night, day)["mae"] > 0.7


def test_venues_without_a_matching_store_are_skipped() -> None:
    rows = calibrate.evaluate_venues(
        [venue("s9", True), venue(None, True)], {"s1": stats(evening_peak(2), evening_peak(3))}
    )
    assert rows == []


def test_placeholder_targets_never_feed_the_error() -> None:
    sim = {"s1": stats(evening_peak(2), evening_peak(3))}
    rows = calibrate.evaluate_venues([venue("s1", False)], sim)
    summary = calibrate.summarise(rows)
    assert summary["measuredCount"] == 0
    assert summary["meanError"] is None
    assert "placeholders" in summary["note"]


def test_measured_targets_set_the_mean_error() -> None:
    sim = {"s1": stats(evening_peak(2), evening_peak(3))}
    summary = calibrate.summarise(calibrate.evaluate_venues([venue("s1", True)], sim))
    assert summary["measuredCount"] == 1
    assert summary["meanError"] == 0.0


def test_pipeline_report_flags_a_fallback_map_by_its_source_label() -> None:
    class FakeMap:
        sources = [Source(label="Hand-written fallback layout (not OpenStreetMap)", url="x")]

    assert run_all._describe("map", "map.json", FakeMap())["fallback"] is True
