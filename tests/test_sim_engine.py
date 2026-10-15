"""Behaviour of the 14-day simulation on the hand-written fixture world (tests/fixtures/)."""

from __future__ import annotations

import json
from collections import defaultdict
from functools import cache
from pathlib import Path

import numpy as np
import pytest

from backend.contract import DAYS, MINUTES_PER_DAY, DayData, LightingLevel, MapData
from backend.schemas import DemandFile, EnergyFile, EntryDemand, PersonasFile, StoreConfig
from backend.sim import citizens, engine, kpis, runner

FIXTURES = Path(__file__).parent / "fixtures"
SEED = 42


@cache
def world() -> engine.World:
    def load(name, model):
        return model.model_validate(json.loads((FIXTURES / name).read_text()))

    return engine.World.build(
        load("map.json", MapData),
        load("personas.json", PersonasFile),
        load("demand.json", DemandFile),
        load("energy.json", EnergyFile),
    )


def baseline() -> dict[str, StoreConfig]:
    return runner.baseline_from(world().map, world().demand.clubNights)


@cache
def baseline_run(seed: int = SEED) -> engine.SimOutput:
    return engine.simulate(world(), baseline(), seed)


def index(store_id: str) -> int:
    return [s.id for s in world().stores].index(store_id)


def visits(out: engine.SimOutput, store_id: str, hours: set[int] | None = None) -> int:
    i = index(store_id)
    return sum(
        1
        for trip in out.trips
        for s, t_in, _ in trip.visits
        if s == i and (hours is None or (t_in // 60) % 24 in hours)
    )


def with_changes(**changes: dict) -> dict[str, StoreConfig]:
    configs = baseline()
    for store_id, update in changes.items():
        configs[store_id] = configs[store_id].model_copy(update=update)
    return configs


def relit(store_id: str, hours: range | list[int], level: LightingLevel) -> list[LightingLevel]:
    lighting = list(baseline()[store_id].lighting)
    for h in hours:
        lighting[h] = level
    return lighting


def test_fixture_files_validate_against_schemas() -> None:
    w = world()
    assert len(w.stores) == 8 and len(w.entries) == 6
    assert w.demand.clubNights[0].clubId == "c1"


def test_simulation_is_deterministic() -> None:
    a = engine.simulate(world(), baseline(), SEED)
    b = baseline_run()
    days_a = [d.model_dump_json() for d in engine.day_files(a.trips, world().stores)]
    days_b = [d.model_dump_json() for d in engine.day_files(b.trips, world().stores)]
    assert days_a == days_b
    assert np.array_equal(a.found_closed, b.found_closed)
    assert np.array_equal(a.footfall_near, b.footfall_near)


def test_other_seed_gives_other_run() -> None:
    a, b = baseline_run(), baseline_run(7)
    assert [t.path for t in a.trips[:50]] != [t.path for t in b.trips[:50]]


def test_changing_one_store_does_not_reshuffle_arrivals() -> None:
    changed = engine.simulate(
        world(), with_changes(s1={"close": "04:00"}, s4={"open": "06:00"}), SEED
    )

    def arrivals(out: engine.SimOutput) -> list[tuple]:
        return sorted((t.agent_id, t.persona, t.returning, tuple(t.path[0])) for t in out.trips)

    assert arrivals(changed) == arrivals(baseline_run())


def test_targets_agents_visits_concurrency_and_file_size() -> None:
    out = baseline_run()
    per_day = np.bincount([t.day for t in out.trips], minlength=DAYS + 1)[1:]
    assert 600 <= per_day.mean() <= 1200
    store_visits = sum(1 for t in out.trips for s, _, _ in t.visits if not world().is_club[s])
    assert store_visits / DAYS >= 800
    assert out.peak_present <= 400
    sizes = [len(d.model_dump_json()) for d in engine.day_files(out.trips, world().stores)]
    assert max(sizes) < 2.5e6


def test_keyframes_follow_the_contract() -> None:
    out = baseline_run()
    entries = {(e.x, e.z) for e in world().entries}
    for day in engine.day_files(out.trips, world().stores):
        DayData.model_validate(day.model_dump())
        for agent in day.agents:
            times = [t for t, _, _ in agent.path]
            assert times[0] % citizens.TICK == 0, "spawn on the tick grid"
            assert all(b > a for a, b in zip(times, times[1:], strict=False))
            for (t0, x0, z0), (t1, x1, z1) in zip(agent.path, agent.path[1:], strict=False):
                assert np.hypot(x1 - x0, z1 - z0) / ((t1 - t0) * 60) <= 2.5, "walking, not running"
            assert (agent.path[0][1], agent.path[0][2]) in entries
            assert (agent.path[-1][1], agent.path[-1][2]) in entries
            for visit in agent.visits:
                assert visit.tIn % citizens.TICK == 0 and visit.tOut % citizens.TICK == 0
                assert times[0] < visit.tIn < visit.tOut < times[-1]
                assert visit.tOut in times, "agent reappears at the door at tOut"


def test_one_offs_never_reappear_and_regulars_do() -> None:
    out = baseline_run()
    trips_per_id = defaultdict(list)
    for trip in out.trips:
        trips_per_id[trip.agent_id].append(trip)
    one_offs = [ts for ts in trips_per_id.values() if not ts[0].returning]
    assert one_offs and all(len(ts) == 1 for ts in one_offs)
    regular_days = [len({t.day for t in ts}) for ts in trips_per_id.values() if ts[0].returning]
    assert max(regular_days) >= 7
    # In the day files a one-off shows up once, or in two consecutive days with the same path
    # when its single trip runs past midnight.
    seen = defaultdict(list)
    for day in engine.day_files(out.trips, world().stores):
        for agent in day.agents:
            if not agent.returning:
                seen[agent.id].append((day.day, agent.path))
    for occurrences in seen.values():
        assert len(occurrences) <= 2
        if len(occurrences) == 2:
            (d1, p1), (d2, p2) = occurrences
            assert d2 == d1 + 1 and p1 == p2
            assert p1[0][0] < d1 * MINUTES_PER_DAY <= p1[-1][0]


def test_midnight_trips_are_in_both_day_files() -> None:
    out = baseline_run()
    days = engine.day_files(out.trips, world().stores)
    crossing = [t for t in out.trips if t.path[0][0] // MINUTES_PER_DAY < t.path[-1][0] // 1440]
    crossing = [t for t in crossing if t.path[-1][0] < DAYS * MINUTES_PER_DAY]
    assert crossing
    trip = crossing[0]
    start_day = trip.path[0][0] // MINUTES_PER_DAY + 1
    for d in (start_day, start_day + 1):
        assert any(a.id == trip.agent_id and a.path == trip.path for a in days[d - 1].agents)
    # A regular can then appear twice in one day file (last night's trip, today's trip), but
    # never at the same time, so "agents active at t" never shows one id twice.
    for day in days:
        spans: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for agent in day.agents:
            spans[agent.id].append((agent.path[0][0], agent.path[-1][0]))
        for ranges in spans.values():
            ranges.sort()
            assert all(b[0] > a[1] for a, b in zip(ranges, ranges[1:], strict=False))


def test_closing_a_store_all_day_means_no_visits_and_less_energy() -> None:
    configs = baseline()
    del configs["s6"]  # the engine treats a store without a config as shut all day
    closed = engine.simulate(world(), configs, SEED)
    assert visits(baseline_run(), "s6") > 0
    assert visits(closed, "s6") == 0
    kwh_base = kpis.store_kwh(world(), baseline_run())
    kwh_closed = kpis.store_kwh(world(), closed)
    assert kwh_closed[index("s6")].sum() < kwh_base[index("s6")].sum()
    assert kwh_closed.sum() < kwh_base.sum()


def test_club_spill_out_finds_the_takeaway_next_door_shut() -> None:
    out = baseline_run()
    assert visits(out, "s1", {3}) == 0
    after_club = [
        e
        for e in out.closed_events
        if e.store == index("s1")
        and (e.minute // 60) % 24 == 3
        and (e.minute // MINUTES_PER_DAY) % 7 in (4, 5, 6)  # Fri/Sat/Sun mornings
    ]
    assert len(after_club) > 50
    seen_shut = sum(not e.walked for e in after_club)
    assert seen_shut >= 0.9 * len(after_club), "35 m from the club door it is visibly shut"


def test_takeaway_open_past_club_close_gains_visits() -> None:
    extended = engine.simulate(
        world(),
        with_changes(s1={"close": "04:00", "lighting": relit("s1", [23, 0, 1, 2, 3], "high")}),
        SEED,
    )
    assert visits(extended, "s1", {3}) > 100
    assert visits(extended, "s1") > visits(baseline_run(), "s1")
    weekdays = [(t // MINUTES_PER_DAY) % 7 for t in _visit_times(extended, "s1", {3})]
    after_club = sum(d in (4, 5, 6) for d in weekdays)  # Fri/Sat/Sun mornings
    assert after_club >= 0.8 * len(weekdays), "the 03:00 trade comes from club spill-out"


def _visit_times(out: engine.SimOutput, store_id: str, hours: set[int]) -> list[int]:
    i = index(store_id)
    return [
        t_in
        for trip in out.trips
        for s, t_in, _ in trip.visits
        if s == i and (t_in // 60) % 24 in hours
    ]


def test_night_lighting_raises_visits_of_an_open_store() -> None:
    night = range(17, 24)
    bright = engine.simulate(world(), with_changes(s3={"lighting": relit("s3", night, "high")}), 1)
    dark = engine.simulate(world(), with_changes(s3={"lighting": relit("s3", night, "off")}), 1)
    assert visits(bright, "s3", set(night)) > 1.2 * visits(dark, "s3", set(night))


def test_regulars_who_found_a_store_shut_choose_it_less_later() -> None:
    """Off-licence shut from 17:00: locals who found it shut in the evening want it far less on
    later evening trips than regulars who never had that experience."""
    out = engine.simulate(world(), with_changes(s7={"close": "17:00"}), SEED)
    s7 = index("s7")
    shut_at: dict[str, list[int]] = defaultdict(list)
    for e in out.closed_events:
        if e.returning and e.store == s7 and 18 <= (e.minute // 60) % 24 < 21:
            shut_at[e.agent_id].append(e.minute)
    counts = {True: [0, 0], False: [0, 0]}  # remembers? -> [trips, trips that wanted s7]
    for trip in out.trips:
        if not trip.returning or not 18 * 60 <= trip.path[0][0] % MINUTES_PER_DAY < 21 * 60:
            continue
        start, end = trip.path[0][0], trip.path[-1][0]
        remembers = any(m < start for m in shut_at[trip.agent_id])
        counts[remembers][0] += 1
        counts[remembers][1] += any(start <= m <= end for m in shut_at[trip.agent_id])
    with_memory = counts[True][1] / counts[True][0]
    without = counts[False][1] / counts[False][0]
    assert counts[True][0] > 100
    assert with_memory < 0.5 * without


def test_memory_factor_penalises_found_closed_and_rewards_satisfaction() -> None:
    memory = citizens.Memory.empty(3)
    evening = 19 * 60
    memory.found_closed(0, evening)
    memory.visited(1, evening)
    factor = memory.factor(evening)
    assert factor[0] == pytest.approx(citizens.CLOSED_PENALTY)
    assert factor[1] > 1.0 and factor[2] == pytest.approx(1.0)
    assert memory.factor(9 * 60)[0] == pytest.approx(1.0), "memory is per hour band"


def test_race_skips_visibly_shut_winner_and_reports_it() -> None:
    draws = np.array([0.1, 0.5, 2.0, 5.0])  # three stores + outside option
    weights = np.ones(3)
    visible_closed = np.array([True, False, False])
    choice = citizens.race(draws, weights, visible_closed, outside=1.0)
    assert choice == citizens.Choice(store=1, wanted_shut=0)
    assert citizens.race(draws, np.zeros(3), visible_closed, 1.0).store is None


def test_arrival_scale_keeps_demand_inside_the_band() -> None:
    entries = world().entries

    def demand(per_hour: float) -> DemandFile:
        hourly = EntryDemand(weekday=[per_hour] * 24, weekend=[per_hour] * 24)
        return DemandFile(
            entryPoints={"st1": hourly}, returningPoolSize=0, returningShare=0, clubNights=[]
        )

    low, high = citizens.GENERAL_ARRIVALS_PER_DAY
    assert citizens.arrival_scale(demand(30.0), entries) == pytest.approx(1.0)  # 720 a day
    assert citizens.arrival_scale(demand(1000.0), entries) == pytest.approx(high / 24000)
    assert citizens.arrival_scale(demand(10.0), entries) == pytest.approx(low / 240)
    assert citizens.arrival_scale(demand(0.0), entries) == 0.0


def test_kpis_recompute_from_per_store_results() -> None:
    results = kpis.build_results(world(), baseline(), baseline_run())
    shops = [sid for sid in results.stores if sid != "c1"]
    visits_total = sum(results.stores[sid].kpis.visits for sid in shops)
    kwh_total = sum(results.stores[sid].kpis.kwh for sid in shops)
    unique = sum(results.stats[sid].uniqueVisitors for sid in shops)
    repeat = sum(results.stats[sid].repeatVisitors for sid in shops)
    assert results.kpis.visits == visits_total
    assert results.kpis.kwh == pytest.approx(kwh_total, abs=0.01)
    assert results.kpis.visitsPerKwh == pytest.approx(visits_total / kwh_total, abs=1e-4)
    assert results.kpis.returnRate == pytest.approx(repeat / unique, abs=1e-4)
    curve = [sum(results.stats[sid].kwhByHour[h] for sid in shops) for h in range(24)]
    assert results.city.peak_kw == pytest.approx(max(curve), abs=1e-3)
    assert results.city.peak_hour == int(np.argmax(curve))
    assert 0 < results.kpis.returnRate < 1
