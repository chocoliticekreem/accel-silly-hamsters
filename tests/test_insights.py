"""Per-store insights engine and the economics helpers, on synthetic stores built in code.

The synthetic energy model is round on purpose: open 0.05 and standby 0.01 kWh/m2/h on 50 m2, so
one more open hour costs exactly 2.0 kWh, and a flat 0.30 GBP/kWh. The clean store is a takeaway
open 11:00-23:00 with 5 visits an hour, lights low by day and high at night, dark while closed:
840 visits and 575.4 kWh over the run, and no insight fires on it.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from typing import Any, get_args

import pytest

from backend import economics, settings
from backend.contract import (
    DAYS,
    Bounds,
    HoursWindow,
    Impact,
    Insight,
    InsightMetric,
    LightingLevel,
    MapData,
    MapStore,
    StoreInsights,
    StoreKpis,
    StoreRunResult,
    StoreType,
    dump,
)
from backend.insights import Peer, build_store_insights, rank_insights, store_insights
from backend.schemas import EnergyFile, RunConfig, StoreConfig, StoreStats
from backend.store import write_json
from backend.timeutil import open_hours_fraction, to_minutes, window_within

STORE_TYPES: tuple[StoreType, ...] = get_args(StoreType)
LIGHT_KW: dict[LightingLevel, float] = {"off": 0.0, "low": 0.25, "high": 0.6}
ENERGY = EnergyFile(
    kwhPerM2PerOpenHour={t: 0.05 for t in STORE_TYPES},
    standbyKwhPerM2PerHour={t: 0.01 for t in STORE_TYPES},
    lightingKw=LIGHT_KW,
    carbonGPerKwh=[150.0] * 24,
    priceGbpPerKwh=[0.3] * 24,
)
AREA = 50.0
NIGHT = {*range(17, 24), *range(0, 7)}
RUN = 9


@dataclass
class Case:
    store: MapStore
    result: StoreRunResult
    stats: StoreStats
    config: StoreConfig

    def peer(self) -> Peer:
        return Peer(self.store.type, self.result, self.stats)


def make_case(
    *,
    store_id: str = "me",
    name: str = "Test Takeaway",
    store_type: StoreType = "takeaway",
    hours: tuple[str, str] = ("11:00", "23:00"),
    licence: tuple[str, str] | None = ("06:00", "04:00"),
    floor_area: float | None = AREA,
    energy_area: float | None = None,
    visit_rate: float = 5.0,
    visits: dict[int, float] | None = None,
    footfall: dict[int, float] | None = None,
    missed: dict[int, float] | None = None,
    lighting: dict[int, LightingLevel] | None = None,
) -> Case:
    """A store and its run files, consistent with the BUILD_NOTES energy model.

    Defaults: visit_rate visits per open hour, 50 passers-by an hour while open and 2 while
    closed, nobody found it shut, lights low by day and high at night while open, off while
    closed. `energy_area` is the area the energy was simulated with (defaults to floor_area).
    """
    fraction = open_hours_fraction(*hours)
    by_hour = [round(visit_rate * f, 3) for f in fraction]
    by_hour = _override(by_hour, visits)
    passing = _override([50.0 if f > 0 else 2.0 for f in fraction], footfall)
    shut = _override([0.0] * 24, missed)
    levels: list[LightingLevel] = [
        ("high" if h in NIGHT else "low") if f > 0 else "off" for h, f in enumerate(fraction)
    ]
    for hour, level in (lighting or {}).items():
        levels[hour] = level
    area = energy_area or floor_area or AREA
    kwh = [
        f * area * 0.05 + (1 - f) * area * 0.01 + LIGHT_KW[levels[h]]
        for h, f in enumerate(fraction)
    ]
    total_visits = round(sum(by_hour) * DAYS)
    total_kwh = round(sum(kwh) * DAYS, 2)
    unique = total_visits // 2
    repeat = unique // 4
    store = MapStore(
        id=store_id,
        name=name,
        type=store_type,
        buildingId=f"b-{store_id}",
        licensedHours=HoursWindow(open=licence[0], close=licence[1]) if licence else None,
        defaultHours=HoursWindow(open=hours[0], close=hours[1]),
        floorArea=floor_area,
    )
    result = StoreRunResult(
        open=hours[0],
        close=hours[1],
        lighting=levels,
        kpis=StoreKpis(
            visits=total_visits,
            kwh=total_kwh,
            returnRate=round(repeat / unique, 4) if unique else 0.0,
        ),
        visitsByHour=by_hour,
    )
    stats = StoreStats(
        visitsByHourWeekday=by_hour,
        visitsByHourWeekend=[round(v * 1.5, 3) for v in by_hour],
        footfallNearbyByHour=passing,
        foundClosedByHour=shut,
        kwhByHour=[round(k, 3) for k in kwh],
        uniqueVisitors=unique,
        repeatVisitors=repeat,
        visitsByPersona={
            "office-worker": total_visits - total_visits // 4,
            "night-owl": total_visits // 4,
        },
        energyCostGbp=round(total_kwh * 0.3, 2),
        co2Kg=round(total_kwh * 0.15, 2),
    )
    return Case(store, result, stats, StoreConfig(open=hours[0], close=hours[1], lighting=levels))


def _override(values: list[float], changes: dict[int, float] | None) -> list[float]:
    out = list(values)
    for hour, value in (changes or {}).items():
        out[hour] = value
    return out


def build(case: Case, peers: list[Peer] | None = None) -> StoreInsights:
    return build_store_insights(
        case.store, case.result, case.stats, case.config, peers=peers or [], energy=ENERGY, run=RUN
    )


def insight_map(payload: StoreInsights) -> dict[str, Insight]:
    return {i.id: i for i in payload.insights}


def window_ok(open_hhmm: str, close_hhmm: str, licence: tuple[str, str]) -> bool:
    """The hard rules, written out independently of the engine."""
    length = (to_minutes(close_hhmm) - to_minutes(open_hhmm)) % 1440 or 1440
    on_grid = to_minutes(open_hhmm) % 30 == 0 and to_minutes(close_hhmm) % 30 == 0
    return (
        on_grid
        and length >= 60
        and 1440 - length >= 30
        and window_within((open_hhmm, close_hhmm), licence)
    )


def numbers(value: Any) -> list[float]:
    """Every number anywhere in a JSON value."""
    if isinstance(value, bool):
        return []
    if isinstance(value, int | float):
        return [float(value)]
    if isinstance(value, dict):
        return [n for v in value.values() for n in numbers(v)]
    if isinstance(value, list):
        return [n for v in value for n in numbers(v)]
    return []


# --- economics -------------------------------------------------------------------------------


def test_gbp_per_week_is_margin_on_visits_minus_energy_over_two_weeks() -> None:
    # takeaway: +20 visits and +10 kWh over 14 days -> 10 visits x 9 x 0.3 - 5 kWh x 0.3
    assert economics.gbp_per_week("takeaway", 20, 10, 0.3) == pytest.approx(25.5)
    # cafe: -10 visits and -40 kWh -> -5 x 6 x 0.3 + 20 x 0.25
    assert economics.gbp_per_week("cafe", -10, -40, 0.25) == pytest.approx(-4.0)
    # clubs earn nothing per visit: only the energy line remains
    assert economics.gbp_per_week("club", 100, 4, 0.5) == pytest.approx(-1.0)


def test_price_is_the_mean_of_the_hourly_tariff() -> None:
    energy = ENERGY.model_copy(update={"priceGbpPerKwh": [0.2] * 12 + [0.4] * 12})
    assert economics.price_gbp_per_kwh(energy) == pytest.approx(0.3)


def test_spend_constants_match_the_frontend_mock() -> None:
    assert economics.SPEND_GBP_PER_VISIT == {
        "cafe": 6,
        "restaurant": 22,
        "takeaway": 9,
        "bar": 14,
        "shop": 15,
        "offlicence": 8,
        "club": 0,
    }
    assert economics.GROSS_MARGIN == 0.3


# --- payload shape ---------------------------------------------------------------------------


def test_payload_has_the_contract_keys_and_definitions() -> None:
    case = make_case()
    data = dump(build(case))
    assert list(data) == [
        "storeId",
        "run",
        "name",
        "type",
        "days",
        "kpis",
        "funnel",
        "hourly",
        "weekdayVsWeekend",
        "personas",
        "energy",
        "benchmarks",
        "insights",
        "note",
    ]
    assert (data["storeId"], data["run"], data["name"], data["type"], data["days"]) == (
        "me",
        RUN,
        "Test Takeaway",
        "takeaway",
        14,
    )
    assert data["kpis"] == {
        "visits": 840,
        "kwh": 575.4,
        "visitsPerKwh": round(840 / 575.4, 4),
        "returnRate": case.result.kpis.returnRate,
        "energyCostGbp": case.stats.energyCostGbp,
        "co2Kg": case.stats.co2Kg,
    }
    passers = round(sum(case.stats.footfallNearbyByHour) * DAYS)
    assert data["funnel"] == {
        "passersBy": passers,
        "visits": 840,
        "uniqueVisitors": 420,
        "returningVisitors": 105,
        "captureRate": round(840 / passers, 4),
        "returnRate": case.result.kpis.returnRate,
    }
    assert set(data["hourly"]) == {
        "visits",
        "footfall",
        "missedDemand",
        "kwh",
        "lighting",
        "openFraction",
    }
    assert all(len(v) == 24 for v in data["hourly"].values())
    assert data["hourly"]["openFraction"][10:12] == [0.0, 1.0]
    assert data["hourly"]["missedDemand"] == case.stats.foundClosedByHour
    assert data["weekdayVsWeekend"]["weekend"] == case.stats.visitsByHourWeekend
    assert data["personas"] == [
        {"persona": "office-worker", "visits": 630, "share": 0.75},
        {"persona": "night-owl", "visits": 210, "share": 0.25},
    ]
    # closed 12 h x 50 m2 x 0.01 standby, lights off while closed; nothing quiet while open
    assert data["energy"] == {
        "kwh": 575.4,
        "kwhWhileClosed": 84.0,
        "kwhLightingWhileClosed": 0.0,
        "kwhLowTrafficOpen": 0.0,
        "costGbp": case.stats.energyCostGbp,
        "co2Kg": case.stats.co2Kg,
        "visitsPerKwh": round(840 / 575.4, 4),
    }
    assert data["benchmarks"] is None
    assert data["note"] == "Simulated, not guaranteed."


def test_capture_rate_is_zero_without_passers_by() -> None:
    case = make_case(footfall={h: 0.0 for h in range(24)})
    funnel = build(case).funnel
    assert (funnel.passersBy, funnel.captureRate) == (0, 0.0)


def test_clean_store_gets_no_insights() -> None:
    assert build(make_case()).insights == []


def test_clubs_get_no_insights() -> None:
    case = make_case(store_type="club")
    with pytest.raises(ValueError, match="club"):
        build(case)


# --- missed demand ---------------------------------------------------------------------------


def test_missed_demand_extends_the_close_over_late_demand() -> None:
    case = make_case(missed={23: 3.0, 0: 3.0, 1: 3.0})
    insights = build(case).insights
    assert [i.id for i in insights] == ["missed-demand-close"]
    insight = insights[0]
    # 9 found shut a day -> 63 a week; x 14 days x 0.6 capture = 75.6 visits for 3 h x 2.0 kWh
    # x 14 = 84 kWh: 37.8 x 9 x 0.3 - 42 x 0.3 = GBP 89.46 a week, the best of every 30-min step
    assert insight.kind == "missed_demand"
    assert insight.metric == InsightMetric(label="Missed visits / week", value=63, unit="people")
    assert insight.impact == Impact(visits=0.09, kwh=round(84 / 575.4, 4), gbpPerWeek=89.46)
    assert (insight.confidence, insight.severity) == ("medium", "medium")
    assert insight.title == "63 people a week find you shut after 23:00"
    suggestion = insight.suggestion
    assert suggestion is not None
    assert (suggestion.storeId, suggestion.field, suggestion.from_, suggestion.to) == (
        "me",
        "close",
        "23:00",
        "02:00",
    )
    assert suggestion.hours is None
    assert (suggestion.expectedDelta.visits, suggestion.expectedDelta.kwh) == (
        insight.impact.visits,
        insight.impact.kwh,
    )
    assert suggestion.confidence == "medium"
    assert [(e.label, e.url) for e in insight.evidence] == [
        ("Sim run 9, Fri 23:00-02:00", "/api/runs/9/days/5")
    ]


def test_missed_demand_extends_the_open_over_early_demand() -> None:
    case = make_case(missed={9: 3.0, 10: 3.0})
    insight = insight_map(build(case))["missed-demand-open"]
    assert insight.suggestion is not None
    assert (insight.suggestion.field, insight.suggestion.from_, insight.suggestion.to) == (
        "open",
        "11:00",
        "09:00",
    )
    # 6 a day x 14 x 0.6 = 50.4 visits for 2 h x 2.0 x 14 = 56 kWh
    assert insight.impact.gbpPerWeek == pytest.approx(25.2 * 9 * 0.3 - 28 * 0.3)
    assert insight.title == "42 people a week find you shut before 11:00"


def test_missed_demand_extends_at_most_five_hours_a_side() -> None:
    # Demand all day long (citizens walk up unless they see the shop shut) must not send an
    # evening shop to open at dawn: the opening move stops 5 h before the current open.
    case = make_case(missed={h: 3.0 for h in range(0, 11)})
    insight = insight_map(build(case))["missed-demand-open"]
    assert insight.suggestion is not None
    assert (insight.suggestion.from_, insight.suggestion.to) == ("11:00", "06:00")


def test_missed_demand_stays_silent_below_two_people_a_day() -> None:
    case = make_case(missed={23: 0.9, 0: 0.9})
    assert build(case).insights == []


def test_missed_demand_stays_inside_the_licence() -> None:
    # A cafe with no licensedHours in map.json gets the default cafe cap, 06:00-23:00.
    case = make_case(
        store_type="cafe",
        hours=("08:00", "18:00"),
        licence=None,
        missed={h: 3.0 for h in [*range(18, 24), 0, 1, 2]},
    )
    suggestion = insight_map(build(case))["missed-demand-close"].suggestion
    assert suggestion is not None
    assert suggestion.to == "23:00"
    assert window_ok("08:00", suggestion.to, ("06:00", "23:00"))


def test_missed_demand_stops_on_the_grid_before_an_off_grid_licence_end() -> None:
    case = make_case(
        store_type="cafe",
        hours=("08:00", "20:00"),
        licence=("06:00", "23:45"),
        missed={h: 3.0 for h in range(20, 24)},
    )
    suggestion = insight_map(build(case))["missed-demand-close"].suggestion
    assert suggestion is not None
    assert suggestion.to == "23:30"


def test_missed_demand_is_silent_when_the_licence_has_no_room() -> None:
    case = make_case(licence=("11:00", "23:00"), missed={23: 3.0, 0: 3.0, 1: 3.0})
    assert build(case).insights == []


def test_missed_demand_lands_on_the_30_minute_grid_from_an_off_grid_close() -> None:
    # 1 found shut a day in 22:45-23:00 and 3 in 23:00-24:00: the best step is 00:00.
    case = make_case(hours=("11:00", "22:45"), missed={22: 1.0, 23: 3.0})
    suggestion = insight_map(build(case))["missed-demand-close"].suggestion
    assert suggestion is not None
    assert (suggestion.from_, suggestion.to) == ("22:45", "00:00")
    assert to_minutes(suggestion.to) % 30 == 0


def test_both_extensions_together_keep_the_rules() -> None:
    case = make_case(licence=("00:00", "00:00"), missed={23: 3.0, 10: 3.0})
    found = insight_map(build(case))
    close = found["missed-demand-close"].suggestion
    open_ = found["missed-demand-open"].suggestion
    assert close is not None and open_ is not None
    assert (close.to, open_.to) == ("00:00", "10:00")
    licence = ("00:00", "00:00")
    assert window_ok(open_.to, close.to, licence)
    assert window_ok("11:00", close.to, licence) and window_ok(open_.to, "23:00", licence)


def test_extensions_never_close_the_last_30_minutes() -> None:
    # Demand all night under a 24 h licence: both edges move their full 5 hours and the day they
    # leave still keeps at least 30 minutes closed between the new close and the new open.
    closed_hours = [*range(23, 24), *range(0, 11)]
    case = make_case(licence=("00:00", "00:00"), missed={h: 3.0 for h in closed_hours})
    found = insight_map(build(case))
    close = found["missed-demand-close"].suggestion
    open_ = found["missed-demand-open"].suggestion
    assert close is not None and open_ is not None
    assert (close.to, open_.to) == ("04:00", "06:00")
    assert window_ok(open_.to, close.to, ("00:00", "00:00"))


# --- wasted energy ---------------------------------------------------------------------------


def test_wasted_energy_turns_off_lights_in_closed_hours() -> None:
    case = make_case(lighting={0: "low", 1: "low", 2: "low", 23: "low", 5: "high"})
    payload = build(case)
    assert [i.id for i in payload.insights] == ["wasted-energy-low", "wasted-energy-high"]
    low, high = payload.insights
    # low: 4 h x 0.25 kW x 14 = 14 kWh -> 7 kWh a week x 0.3 = GBP 2.10; high: 0.6 x 14 x 0.15
    assert low.impact == Impact(
        visits=0.0, kwh=round(-14 / case.result.kpis.kwh, 4), gbpPerWeek=2.1
    )
    assert high.impact.gbpPerWeek == 1.26
    assert low.metric == InsightMetric(label="Lit while closed / week", value=7.0, unit="kWh")
    assert (low.confidence, low.severity) == ("high", "low")
    assert low.suggestion is not None and high.suggestion is not None
    assert (low.suggestion.field, low.suggestion.hours) == ("lighting", [0, 1, 2, 23])
    assert (low.suggestion.from_, low.suggestion.to) == ("low", "off")
    assert (high.suggestion.hours, high.suggestion.from_, high.suggestion.to) == (
        [5],
        "high",
        "off",
    )
    assert low.evidence[0].label == "Sim run 9, Fri 23:00-03:00"
    assert payload.energy.kwhLightingWhileClosed == pytest.approx((1.0 + 0.6) * DAYS)


def test_wasted_energy_skips_hours_an_extension_would_open() -> None:
    dark: dict[int, LightingLevel] = {h: "low" for h in [23, *range(0, 7)]}
    case = make_case(lighting=dark, missed={23: 3.0, 0: 3.0, 1: 3.0})
    found = insight_map(build(case))
    extension = found["missed-demand-close"].suggestion
    waste = found["wasted-energy-low"].suggestion
    assert extension is not None and waste is not None
    assert extension.to == "02:00"
    assert waste.hours == [2, 3, 4, 5, 6]


def test_wasted_energy_ignores_a_single_dim_hour_worth_under_a_pound() -> None:
    # 1 h x 0.25 kW x 7 days x GBP 0.30 = GBP 0.53 a week, under MIN_GBP_PER_WEEK
    assert build(make_case(lighting={3: "low"})).insights == []


# --- dead hours ------------------------------------------------------------------------------


def test_dead_hours_trims_a_quiet_close() -> None:
    case = make_case(visits={21: 0.1, 22: 0.1})
    payload = build(case)
    assert [i.id for i in payload.insights] == ["dead-hours-close"]
    insight = payload.insights[0]
    # 2 h saved: 2 x 2.0 x 14 = 56 kWh; lost 0.2 a day x 14 = 2.8 visits -> GBP 8.40 - 3.78
    assert insight.impact.gbpPerWeek == pytest.approx(4.62)
    assert insight.impact.visits == round(-2.8 / case.result.kpis.visits, 4)
    assert insight.impact.kwh == round(-56 / case.result.kpis.kwh, 4)
    assert insight.severity == "medium"
    assert insight.confidence == "high"  # 50 passers-by an hour x 2 h x 7 days = 700 a week
    assert insight.title == "Quiet 21:00-23:00: 0.1 visits an hour"
    assert insight.suggestion is not None
    assert (insight.suggestion.field, insight.suggestion.from_, insight.suggestion.to) == (
        "close",
        "23:00",
        "21:00",
    )
    assert insight.suggestion.expectedDelta.visits < 0 and insight.suggestion.expectedDelta.kwh < 0
    # the quiet hours are also what kwhLowTrafficOpen counts: (2.5 kWh + 0.6 high lights) x 2 h
    assert payload.energy.kwhLowTrafficOpen == pytest.approx(3.1 * 2 * DAYS)


def test_dead_hours_stays_silent_when_trimming_loses_money() -> None:
    # 0.45 visits an hour is quiet, but its margin beats the 2 kWh the hour costs
    case = make_case(visits={22: 0.45})
    assert build(case).insights == []
    assert build(case).energy.kwhLowTrafficOpen > 0


def test_dead_hours_trims_at_most_two_hours_a_side() -> None:
    case = make_case(hours=("08:00", "23:00"), visit_rate=0.1)
    found = insight_map(build(case))
    close, open_ = found["dead-hours-close"].suggestion, found["dead-hours-open"].suggestion
    assert close is not None and open_ is not None
    assert (close.to, open_.to) == ("21:00", "10:00")


def test_dead_hours_keep_the_window_at_least_an_hour() -> None:
    case = make_case(hours=("11:00", "12:30"), floor_area=200.0, visit_rate=0.1)
    found = insight_map(build(case))
    assert "dead-hours-open" not in found
    close = found["dead-hours-close"].suggestion
    assert close is not None
    assert close.to == "12:00"
    assert window_ok("11:00", close.to, ("06:00", "04:00"))


def test_dead_hours_never_trims_through_an_hour_worth_lighting() -> None:
    # 21-22 are open, dark and quiet with people passing: lighting them up pays, so they are
    # lit, not cut. With the lights already high the same hours are trimmed.
    quiet = {21: 0.3, 22: 0.3}
    dark = make_case(floor_area=100.0, visits=quiet, lighting={21: "off", 22: "off"})
    found = insight_map(build(dark))
    assert "dead-hours-close" not in found
    lighting = found["lighting-opportunity-off"].suggestion
    assert lighting is not None
    assert lighting.hours == [21, 22]
    lit = make_case(floor_area=100.0, visits=quiet)
    assert "dead-hours-close" in insight_map(build(lit))


# --- lighting opportunity --------------------------------------------------------------------


def test_lighting_opportunity_raises_dim_busy_night_hours() -> None:
    case = make_case(lighting={h: "low" for h in range(17, 23)})
    insights = build(case).insights
    assert [i.id for i in insights] == ["lighting-opportunity-low"]
    insight = insights[0]
    # 6 h x 5 visits x 0.15 uplift x 14 = 63 visits; 6 h x 0.35 kW x 14 = 29.4 kWh
    assert insight.impact.gbpPerWeek == pytest.approx(31.5 * 9 * 0.3 - 14.7 * 0.3)
    assert insight.impact.visits == round(63 / 840, 4)
    assert insight.severity == "medium"
    # 2100 passers-by a week would be high, but the uplift is an assumption: capped at medium
    assert insight.confidence == "medium"
    assert insight.suggestion is not None
    assert insight.suggestion.hours == list(range(17, 23))
    assert (insight.suggestion.from_, insight.suggestion.to) == ("low", "high")


def test_lighting_opportunity_stays_silent_on_a_quiet_street() -> None:
    case = make_case(
        lighting={h: "low" for h in range(17, 23)}, footfall={h: 3.0 for h in range(17, 23)}
    )
    assert build(case).insights == []


def test_lighting_opportunity_ignores_daytime_hours() -> None:
    case = make_case(lighting={h: "off" for h in range(11, 17)})
    assert build(case).insights == []


# --- benchmark and k-anonymity ---------------------------------------------------------------


def peer_cases(store_type: StoreType, rates: list[float]) -> list[Case]:
    return [
        make_case(store_id=f"p-{store_type}-{i}", store_type=store_type, visit_rate=rate)
        for i, rate in enumerate(rates)
    ]


def test_benchmark_against_same_type_peers() -> None:
    peers = [c.peer() for c in peer_cases("takeaway", [2.0, 4.0, 8.0])]
    payload = build(make_case(), peers)
    benchmarks = payload.benchmarks
    assert benchmarks is not None
    assert (benchmarks.peers, benchmarks.peerType) == (3, "takeaway")
    own = 840 / 575.4
    peer_values = [p.result.kpis.visits / p.result.kpis.kwh for p in peers]
    assert benchmarks.areaMedianVisitsPerKwh == round(sorted(peer_values)[1], 4)
    assert benchmarks.visitsPerKwhPercentile == round(sum(v < own for v in peer_values) / 3, 4)
    insight = insight_map(payload)["benchmark-visits-per-kwh"]
    assert insight.kind == "benchmark"
    assert insight.suggestion is None
    assert insight.impact == Impact(visits=0.0, kwh=0.0, gbpPerWeek=0.0)
    assert insight.confidence == "low"  # 3 peers
    assert insight.title == "More visits per kWh than 67% of similar stores"


def test_benchmark_ties_count_half() -> None:
    peers = [c.peer() for c in peer_cases("takeaway", [5.0, 5.0, 5.0])]
    benchmarks = build(make_case(), peers).benchmarks
    assert benchmarks is not None
    assert (benchmarks.visitsPerKwhPercentile, benchmarks.captureRatePercentile) == (0.5, 0.5)


def test_benchmark_falls_back_to_all_stores_under_three_same_type_peers() -> None:
    cases = peer_cases("takeaway", [2.0, 4.0]) + peer_cases("cafe", [3.0, 6.0])
    payload = build(make_case(), [c.peer() for c in cases])
    assert payload.benchmarks is not None
    assert (payload.benchmarks.peers, payload.benchmarks.peerType) == (4, "all")
    assert "nearby stores" in insight_map(payload)["benchmark-visits-per-kwh"].title


def test_no_benchmark_under_three_peers_in_total() -> None:
    cases = peer_cases("takeaway", [2.0]) + peer_cases("cafe", [3.0])
    club = make_case(store_id="club-a", store_type="club").peer()  # ignored if passed by mistake
    payload = build(make_case(), [c.peer() for c in cases] + [club])
    assert payload.benchmarks is None
    assert payload.insights == []


# --- ranking ---------------------------------------------------------------------------------


def fake_insight(id_: str, gbp: float, severity: str) -> Insight:
    return Insight.model_validate(
        {
            "id": id_,
            "kind": "benchmark",
            "severity": severity,
            "title": id_,
            "detail": id_,
            "metric": {"label": "x", "value": 0, "unit": "x"},
            "impact": {"visits": 0, "kwh": 0, "gbpPerWeek": gbp},
            "confidence": "low",
            "suggestion": None,
            "evidence": [],
        }
    )


def test_rank_by_gbp_then_severity_and_keep_five() -> None:
    insights = [
        fake_insight("a", 5, "low"),
        fake_insight("b", 10, "medium"),
        fake_insight("c", 10, "high"),
        fake_insight("d", 0, "high"),
        fake_insight("e", 3, "medium"),
        fake_insight("f", 7, "low"),
        fake_insight("g", 10, "high"),
    ]
    assert [i.id for i in rank_insights(insights)] == ["c", "g", "b", "f", "a"]


def test_ranked_payload_mixes_kinds_in_gbp_order() -> None:
    case = make_case(
        missed={23: 3.0, 0: 3.0, 1: 3.0},
        lighting={**{h: "low" for h in range(17, 23)}, 4: "low", 5: "low", 6: "low", 3: "low"},
        visits={11: 0.05},
    )
    payload = build(case, [c.peer() for c in peer_cases("takeaway", [2.0, 4.0, 8.0])])
    ids = [i.id for i in payload.insights]
    # GBP 89.46, 80.64, 3.26 (trim 11:00 -> 12:00), 2.10 (03:00-07:00 lit low), 0
    assert ids == [
        "missed-demand-close",
        "lighting-opportunity-low",
        "dead-hours-open",
        "wasted-energy-low",
        "benchmark-visits-per-kwh",
    ]
    gbp = [i.impact.gbpPerWeek for i in payload.insights]
    assert gbp == sorted(gbp, reverse=True)
    for insight in payload.insights:
        assert len(insight.title) <= 60 and len(insight.detail) <= 140
        if insight.suggestion is not None:
            assert len((insight.suggestion.reason or "").split()) <= 15


def test_every_hours_suggestion_respects_the_rules() -> None:
    cases = [
        make_case(missed={23: 3.0, 0: 3.0, 1: 3.0, 2: 3.0, 3: 6.0, 4: 6.0}),
        make_case(hours=("17:00", "22:30"), missed={22: 1.0, 23: 2.0, 3: 8.0}),
        make_case(
            store_type="bar", hours=("16:00", "00:00"), licence=None, missed={0: 3, 1: 3, 2: 9}
        ),
        make_case(hours=("06:30", "23:00"), missed={h: 4.0 for h in range(0, 7)}),
        make_case(hours=("07:00", "23:00"), visit_rate=0.05),
    ]
    for case in cases:
        licence = (
            (case.store.licensedHours.open, case.store.licensedHours.close)
            if case.store.licensedHours
            else {"bar": ("10:00", "02:00")}[case.store.type]
        )
        moves = {
            i.suggestion.field: i.suggestion.to
            for i in build(case).insights
            if i.suggestion is not None and i.suggestion.field != "lighting"
        }
        assert moves, case.store
        open_, close = moves.get("open", case.config.open), moves.get("close", case.config.close)
        assert window_ok(open_, close, licence), (open_, close, licence)
        for field, to in moves.items():
            alone = (to, case.config.close) if field == "open" else (case.config.open, to)
            assert window_ok(*alone, licence), (alone, licence)


# --- data firewall and loading ---------------------------------------------------------------


RIVALS = [
    ("rival-kebab-house", "Rival Kebab House", 7.3, 61.7),
    ("rival-noodle-bar", "Rival Noodle Bar", 3.7, 83.9),
    ("rival-pizza-slice", "Rival Pizza Slice", 9.1, 37.3),
    ("rival-chippy", "Rival Chippy", 4.9, 129.1),
]


@pytest.fixture
def run_files(tmp_path, monkeypatch: pytest.MonkeyPatch) -> list[Case]:
    """runs/7 and data/processed for one takeaway ("me"), four rival takeaways and a club."""
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    cases = [make_case(missed={23: 3.0, 0: 3.0, 1: 3.0})]
    cases += [
        make_case(store_id=sid, name=name, visit_rate=rate, floor_area=area)
        for sid, name, rate, area in RIVALS
    ]
    club = make_case(
        store_id="club-x",
        name="Club X",
        store_type="club",
        hours=("22:00", "03:00"),
        visit_rate=6.7,
        floor_area=412.3,
    )
    cases.append(club)
    map_data = MapData(
        bounds=Bounds(minX=-250, maxX=250, minZ=-250, maxZ=250),
        streets=[],
        buildings=[],
        stores=[c.store for c in cases],
        entryPoints=[],
    )
    write_json(settings.PROCESSED_DIR / "map.json", map_data)
    write_json(settings.PROCESSED_DIR / "energy.json", ENERGY)
    run = settings.RUNS_DIR / "7"
    write_json(run / "stores.json", {c.store.id: dump(c.result) for c in cases})
    write_json(run / "store_stats.json", {c.store.id: dump(c.stats) for c in cases})
    config = RunConfig(
        run=7,
        seed=42,
        simVersion="test",
        stores={c.store.id: c.config for c in cases},
        configHash="test",
    )
    write_json(run / "config.json", config)
    return cases


def test_firewall_payload_carries_no_other_store_id_name_or_numbers(run_files: list[Case]) -> None:
    payload = store_insights(7, "me")
    assert payload.benchmarks is not None
    assert (payload.benchmarks.peers, payload.benchmarks.peerType) == (4, "takeaway")
    data = dump(payload)
    text = json.dumps(data, ensure_ascii=False)
    for case in run_files[1:]:
        assert case.store.id not in text
        assert case.store.name not in text
    own = run_files[0]
    rival_numbers = {
        float(n)
        for case in run_files[1:]
        for n in (
            case.result.kpis.visits,
            case.result.kpis.kwh,
            case.stats.energyCostGbp,
            case.stats.co2Kg,
            case.stats.uniqueVisitors,
            case.stats.repeatVisitors,
            round(case.result.kpis.visits / case.result.kpis.kwh, 4),
        )
    }
    alone = build_store_insights(
        own.store, own.result, own.stats, own.config, peers=[], energy=ENERGY, run=7
    )
    # No rival number appears in the store's own data, so any match below can only be a leak.
    assert not rival_numbers & set(numbers(dump(alone)))
    assert not rival_numbers & set(numbers(data))
    assert data["storeId"] == "me"
    assert all(s["storeId"] == "me" for i in data["insights"] if (s := i["suggestion"]))


def test_store_insights_matches_the_pure_builder(run_files: list[Case]) -> None:
    own, rivals = run_files[0], run_files[1:-1]
    expected = build_store_insights(
        own.store,
        own.result,
        own.stats,
        own.config,
        peers=[c.peer() for c in rivals],
        energy=ENERGY,
        run=7,
    )
    assert dump(store_insights(7, "me")) == dump(expected)


def test_store_insights_raises_keyerror_for_unknown_store_run_or_club(
    run_files: list[Case],
) -> None:
    with pytest.raises(KeyError, match="nope"):
        store_insights(7, "nope")
    with pytest.raises(KeyError, match="stores.json"):
        store_insights(8, "me")
    with pytest.raises(KeyError, match="club"):
        store_insights(7, "club-x")
    (settings.RUNS_DIR / "7" / "store_stats.json").unlink()
    with pytest.raises(KeyError, match="store_stats.json"):
        store_insights(7, "me")


# --- determinism and fallbacks ---------------------------------------------------------------


def test_build_is_deterministic_and_ignores_peer_order() -> None:
    case = make_case(
        missed={23: 3.0, 0: 3.0, 1: 3.0}, lighting={3: "low", 4: "low", 5: "low", 6: "low"}
    )
    peers = [c.peer() for c in peer_cases("takeaway", [2.0, 4.0, 8.0, 3.0, 6.0])]
    first = json.dumps(dump(build(case, peers)))
    shuffled = list(peers)
    random.Random(1).shuffle(shuffled)
    assert json.dumps(dump(build(case, peers))) == first
    assert json.dumps(dump(build(case, shuffled))) == first


def test_floor_area_is_backed_out_of_kwh_when_the_map_has_none() -> None:
    kwargs: dict[str, Any] = {"missed": {23: 3.0, 0: 3.0, 1: 3.0}, "visits": {11: 0.05}}
    known = build(make_case(**kwargs))
    unknown = build(make_case(floor_area=None, energy_area=AREA, **kwargs))
    assert unknown.energy.kwhWhileClosed == pytest.approx(known.energy.kwhWhileClosed, abs=0.05)
    assert [i.id for i in unknown.insights] == [i.id for i in known.insights]
    for a, b in zip(unknown.insights, known.insights, strict=True):
        assert a.impact.gbpPerWeek == pytest.approx(b.impact.gbpPerWeek, abs=0.05)
