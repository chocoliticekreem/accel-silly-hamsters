"""The self-learning city: street events and owners adapting day by day (docs/OWNER_ACTIONS.md),
on the hand-written fixture world (tests/fixtures/)."""

from __future__ import annotations

import json
import shutil
from functools import cache
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from backend import cache as run_cache
from backend import economics, settings, store, timeutil
from backend.agents import rules
from backend.api.main import app
from backend.contract import (
    DAYS,
    MINUTES_PER_DAY,
    OwnerEvent,
    StoreRunResult,
    StreetEvent,
    dump,
)
from backend.schemas import RunConfig, RunSummary
from backend.sim import citizens, engine, kpis, owners, runner, street
from tests.test_sim_engine import baseline, index, with_changes, world

FIXTURES = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).resolve().parent.parent
SEED = 42
SEEDS = (42, 1, 7)


@cache
def adapted(seed: int = SEED) -> engine.SimOutput:
    return engine.simulate(world(), baseline(), seed, adapt=True)


@cache
def late_offlicence() -> engine.SimOutput:
    """Off-licence s7 shut from 17:00: plenty of people find it shut every evening."""
    return engine.simulate(world(), with_changes(s7={"close": "17:00"}), SEED, adapt=True)


def store_ids() -> list[str]:
    return [s.id for s in world().stores]


def day_files_json(out: engine.SimOutput) -> list[str]:
    return [d.model_dump_json() for d in engine.day_files(out.trips, world().stores)]


# --- switch and determinism -------------------------------------------------------------------


def test_adaptation_is_deterministic() -> None:
    a, b = adapted(), engine.simulate(world(), baseline(), SEED, adapt=True)
    assert [dump(e) for e in a.owner_events] == [dump(e) for e in b.owner_events]
    assert a.street_events == b.street_events
    assert a.schedules == b.schedules and a.closed_from == b.closed_from
    assert day_files_json(a) == day_files_json(b)
    assert np.array_equal(a.schedule.open_ticks, b.schedule.open_ticks)
    assert np.array_equal(a.schedule.lit, b.schedule.lit)
    assert np.array_equal(a.footfall_near, b.footfall_near)
    assert a.owner_events, "owners act in a normal fortnight"


def test_switch_off_is_the_old_sim() -> None:
    """adapt=False (and the default with OWNER_ADAPTATION off) is the pre-adaptation sim."""
    assert settings.OWNER_ADAPTATION is False  # tests/conftest.py
    off = engine.simulate(world(), baseline(), SEED, adapt=False)
    default = engine.simulate(world(), baseline(), SEED)
    assert day_files_json(off) == day_files_json(default)
    assert np.array_equal(off.found_closed, default.found_closed)
    assert off.owner_events == [] and off.street_events == [] and off.schedules == {}
    assert np.array_equal(
        off.schedule.open_ticks, engine.build_schedule(world(), baseline()).open_ticks
    )


def test_switch_on_reads_the_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "OWNER_ADAPTATION", True)
    out = engine.simulate(world(), baseline(), SEED)
    assert [dump(e) for e in out.owner_events] == [dump(e) for e in adapted().owner_events]


def test_arrivals_are_the_same_with_and_without_owners() -> None:
    """Fixed seed: the same people come; only decisions differ."""

    def arrivals(out: engine.SimOutput) -> list[tuple]:
        return sorted((t.agent_id, t.persona, t.returning, tuple(t.path[0])) for t in out.trips)

    off = engine.simulate(world(), baseline(), SEED, adapt=False)
    assert arrivals(off) == arrivals(adapted())


# --- street events ----------------------------------------------------------------------------


def test_street_events_are_deterministic_and_valid() -> None:
    streets = {s.id for s in world().map.streets}
    for seed in SEEDS:
        events = street.generate(world(), seed)
        assert events == street.generate(world(), seed)
        items = TypeAdapter(list[StreetEvent]).validate_python([e.to_json() for e in events])
        assert [e.fromT for e in items] == sorted(e.fromT for e in items)
        kinds = {e.kind for e in items}
        assert {"roadworks", "heavy_traffic", "club_night", "event"} <= kinds
        for e in items:
            assert e.streetId in streets
            assert 1 <= e.day <= DAYS and e.fromT < e.toT
            assert timeutil.day_of(e.fromT) == e.day
        works = [e for e in items if e.kind == "roadworks"]
        assert 1 <= len({e.label for e in works}) <= 2
        assert all(e.label.startswith(("Roadworks", "Street closed")) for e in works)
        traffic = [e for e in items if e.kind == "heavy_traffic"]
        assert all(not timeutil.is_weekend_day(e.day) for e in traffic)
    assert street.generate(world(), 1) != street.generate(world(), 7)


def test_roadworks_cut_visits_on_their_street() -> None:
    events = street.generate(world(), SEED)
    factor = street.store_factors(world(), events, engine.SIM_TICKS)
    on_street = street.store_streets(world())
    works = next(e for e in events if e.kind == "roadworks")
    tick = (works.from_t + 60) // citizens.TICK
    for i, key in enumerate(on_street):
        if world().is_club[i]:
            assert factor[i].min() == 1.0 or key != works.street
        elif key == works.street:
            assert factor[i, tick] <= 1.0 - works.severity + 1e-9
    assert factor.min() >= 0.0


# --- owner decisions --------------------------------------------------------------------------


def test_roadworks_make_an_affected_shop_shut_early() -> None:
    out = adapted()
    on_street = street.store_streets(world())
    works = {(e["day"], e["streetId"]) for e in out.street_events if e["kind"] == "roadworks"}
    street_of = {s.id: s.name for s in world().map.streets}
    shut = [
        e for e in out.owner_events if e.action == "shut_early" and e.trigger.kind == "roadworks"
    ]
    assert shut, "a roadworks day makes at least one shop on that street shut early"
    for e in shut:
        i = index(e.storeId)
        assert any(day == e.day and street_of[sid] == on_street[i] for day, sid in works)
        assert e.trigger.value >= owners.SHUT_EARLY_DROP and "vs usual" in e.trigger.label
        assert timeutil.day_of(e.t) == e.day
        # Shut from `to` that day: nobody is inside after it.
        shut_at = (e.day - 1) * MINUTES_PER_DAY + timeutil.to_minutes(e.to)
        assert not out.schedule.is_open(i, shut_at)
        assert not out.schedule.is_open(i, shut_at + 60)
        for trip in out.trips:
            for s, t_in, t_out in trip.visits:
                if s == i and timeutil.day_of(t_in) == e.day:
                    assert t_out <= shut_at


def test_missed_demand_after_close_makes_the_owner_stay_open_later() -> None:
    out = late_offlicence()
    changes = [e for e in out.owner_events if e.storeId == "s7" and e.action == "hours_changed"]
    assert changes
    first = changes[0]
    assert (first.from_, first.to) == ("17:00", "18:00")
    assert first.trigger.kind == "missed_demand" and first.trigger.value >= owners.EXTEND_MIN_MISSED
    assert "17:00" in first.reason and len(first.reason) <= 100
    schedule = out.schedules["s7"]
    assert schedule[0]["fromDay"] == 1 and schedule[0]["week"][0]["close"] == "17:00"
    later = next(entry for entry in schedule if entry["fromDay"] == first.day)
    assert all(day == {"open": "08:00", "close": "18:00"} for day in later["week"])
    s7 = index("s7")
    evening = (first.day - 1) * MINUTES_PER_DAY + 17 * 60 + 30
    assert out.schedule.is_open(s7, evening)
    assert not out.schedule.is_open(s7, evening - MINUTES_PER_DAY * (first.day - 1))  # day 1


def test_club_night_spill_out_makes_the_takeaway_next_door_open_late() -> None:
    out = adapted()
    late = [e for e in out.owner_events if e.action == "open_late"]
    assert late and all(e.storeId == "s1" and e.trigger.kind == "club_night" for e in late)
    s1 = index("s1")
    for e in late:
        assert timeutil.weekday_of_day(e.day) in ("thu", "fri", "sat")
        at_three = e.day * MINUTES_PER_DAY + 3 * 60  # 03:00 the next morning
        assert out.schedule.is_open(s1, at_three)


def test_no_decision_breaks_the_licence_or_the_minimum_hours() -> None:
    for seed in SEEDS:
        out = adapted(seed)
        events = out.owner_events
        assert [e.t for e in events] == sorted(e.t for e in events)
        for e in events:
            assert len(e.reason) <= 100 and e.reason.endswith(".")
            assert 1 <= e.day <= DAYS
        for i, s in enumerate(world().stores):
            if s.type == "club":
                continue
            licence = rules.licensed_window(s)
            allowed = np.array(
                [timeutil.is_open(*licence, k * citizens.TICK) for k in range(engine.TICKS_PER_DAY)]
            )
            ticks = out.schedule.open_ticks[i].reshape(-1, engine.TICKS_PER_DAY)
            assert not (ticks & ~allowed).any(), f"{s.id} open outside its licence {licence}"
        for sid, entries in out.schedules.items():
            licence = rules.licensed_window(world().stores[index(sid)])
            for entry in entries:
                for day in entry["week"]:
                    if day is not None:
                        assert rules.hours_violation(day["open"], day["close"], licence) is None


def test_visits_only_happen_while_the_shop_is_open() -> None:
    out = adapted()
    for trip in out.trips:
        for s, t_in, t_out in trip.visits:
            if world().is_club[s]:
                continue  # club-goers queue and leave on the club's own clock
            assert out.schedule.is_open(s, t_in)
            assert t_out <= out.schedule.open_until(s, t_in)


def test_energy_follows_the_adapted_schedule() -> None:
    out = adapted()
    n = world().n_stores
    fraction = out.schedule.open_ticks[:, : DAYS * engine.TICKS_PER_DAY]
    expected = fraction.reshape(n, DAYS, 24, -1).mean(-1)
    assert np.array_equal(out.schedule.open_fraction, expected)
    off = engine.simulate(world(), baseline(), SEED, adapt=False)
    changed = index(next(iter(out.schedules)))
    kwh_on = kpis_kwh(out)[changed].sum()
    kwh_off = kpis_kwh(off)[changed].sum()
    assert kwh_on != pytest.approx(kwh_off)


def kpis_kwh(out: engine.SimOutput) -> np.ndarray:
    from backend.sim import kpis

    return kpis.store_kwh(world(), out)


def test_lights_off_while_shut_saves_energy() -> None:
    out = adapted(1)
    events = [e for e in out.owner_events if e.action == "lighting_changed"]
    for e in events:
        assert (e.from_, e.to) in {("low", "off"), ("high", "off")}
        i = index(e.storeId)
        shut = out.schedule.open_fraction[i, e.day - 1 :] == 0
        mask = owners_mask(out, e.storeId)
        assert (out.schedule.lit[i, e.day - 1 :][shut & mask] == 0).all()


def owners_mask(out: engine.SimOutput, store_id: str) -> np.ndarray:
    lighting = baseline()[store_id].lighting
    return np.array([level != "off" for level in lighting])[None, :]


def test_closing_for_good_needs_permission_and_a_losing_streak(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spend = dict(economics.SPEND_GBP_PER_VISIT, shop=0)  # the shop never covers its energy
    monkeypatch.setattr(economics, "SPEND_GBP_PER_VISIT", spend)
    never = engine.simulate(world(), baseline(), SEED, adapt=True)
    assert not never.closed_from
    assert all(e.action != "closed_permanently" for e in never.owner_events)
    out = engine.simulate(world(), baseline(), SEED, adapt=True, allow_closure=True)
    assert out.closed_from == {"s6": owners.LOSS_DAYS + 1}
    [event] = [e for e in out.owner_events if e.action == "closed_permanently"]
    assert event.storeId == "s6" and event.trigger.kind == "losses"
    s6 = index("s6")
    start = owners.LOSS_DAYS * engine.TICKS_PER_DAY
    assert not out.schedule.open_ticks[s6, start:].any()
    assert (out.schedule.lit[s6, owners.LOSS_DAYS :] == 0).all()
    assert all(
        t_in < owners.LOSS_DAYS * MINUTES_PER_DAY
        for trip in out.trips
        for s, t_in, _ in trip.visits
        if s == s6
    )


# --- runner, files and API --------------------------------------------------------------------


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    processed = tmp_path / "processed"
    shutil.copytree(FIXTURES, processed)
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed)
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(run_cache.policy, "fresh", False)
    monkeypatch.setattr(run_cache.policy, "disabled", False)
    return tmp_path / "runs"


def read(path: Path):
    return json.loads(path.read_text())


def test_run_files_with_adaptation(dirs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configs = runner.baseline_configs()
    off_key = run_cache.run_key(configs, SEED)
    off = runner.execute_run(configs, SEED)
    assert read(store.run_dir(off) / "owner_events.json") == []
    assert read(store.run_dir(off) / "street_events.json") == []
    assert all("schedule" not in r for r in read(store.run_dir(off) / "stores.json").values())

    monkeypatch.setattr(settings, "OWNER_ADAPTATION", True)
    assert run_cache.run_key(configs, SEED) != off_key  # never served from an off run's cache
    a = runner.execute_run(configs, SEED, use_cache=False)
    b = runner.execute_run(configs, SEED, use_cache=False)
    da, db = store.run_dir(a), store.run_dir(b)
    for name in ["stores.json", "store_stats.json", "owner_events.json", "street_events.json"]:
        assert (da / name).read_bytes() == (db / name).read_bytes(), name
    events = TypeAdapter(list[OwnerEvent]).validate_python(read(da / "owner_events.json"))
    TypeAdapter(list[StreetEvent]).validate_python(read(da / "street_events.json"))
    assert events and all("from_" not in e for e in read(da / "owner_events.json"))
    stores = TypeAdapter(dict[str, StoreRunResult]).validate_python(read(da / "stores.json"))
    changed = {e.storeId for e in events if e.action in ("hours_changed", "day_closed")}
    assert changed and {sid for sid, r in stores.items() if r.schedule} == changed
    for sid in changed:
        assert (stores[sid].open, stores[sid].close) == (configs[sid].open, configs[sid].close)
        assert stores[sid].schedule[0].fromDay == 1
    assert runner.execute_run(configs, SEED) in (a, b)  # cached under the adaptation key
    for run in (off, a):
        summary = read(store.run_dir(run) / "summary.json")
        assert [d["day"] for d in summary["daily"]] == list(range(1, DAYS + 1))
        assert set(summary["daily"][0]) == {
            "day", "visits", "kwh", "visitsPerKwh", "profitGbp", "ownerActions",
        }  # fmt: skip
        assert sum(d["visits"] for d in summary["daily"]) == summary["kpis"]["visits"]
    assert read(da / "summary.json")["daily"] == read(db / "summary.json")["daily"]
    assert sum(d["ownerActions"] for d in read(da / "summary.json")["daily"]) == len(events)


def test_closures_only_below_a_non_baseline_parent(
    dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "OWNER_ADAPTATION", True)
    configs = runner.baseline_configs()
    base = runner.execute_run(configs, SEED)
    child_configs = with_changes(s6={"close": "20:00"})
    child = runner.execute_run(child_configs, SEED, parent_run=base)
    assert runner._closures_allowed(None) is False
    assert runner._closures_allowed(base) is False  # parent is the baseline
    assert runner._closures_allowed(child) is True
    config = RunConfig.model_validate(read(store.run_dir(child) / "config.json"))
    assert config.configHash == run_cache.run_key(child_configs, SEED)
    monkeypatch.setattr(settings, "OWNER_ADAPTATION", False)
    assert runner._closures_allowed(child) is False


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    runs = tmp_path / "runs"
    shutil.copytree(ROOT / "runs" / "0", runs / "0")
    monkeypatch.setattr(settings, "RUNS_DIR", runs)
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    return TestClient(app)


def test_owner_and_street_events_endpoints(client: TestClient) -> None:
    body = client.get("/api/runs/0/owner-events").json()
    events = TypeAdapter(list[OwnerEvent]).validate_python(body)
    assert events and [e.t for e in events] == sorted(e.t for e in events)
    assert set(body[0]) == {"day", "t", "storeId", "action", "from", "to", "reason", "trigger"}
    assert set(body[0]["trigger"]) == {"kind", "value", "label"}
    body = client.get("/api/runs/0/street-events").json()
    TypeAdapter(list[StreetEvent]).validate_python(body)
    assert set(body[0]) == {"day", "fromT", "toT", "kind", "streetId", "label", "severity"}


@pytest.mark.parametrize("name", ["owner-events", "street-events"])
def test_owner_and_street_events_404(client: TestClient, name: str) -> None:
    assert client.get(f"/api/runs/99/{name}").status_code == 404
    (settings.RUNS_DIR / "0" / f"{name.replace('-', '_')}.json").unlink()
    response = client.get(f"/api/runs/0/{name}")
    assert response.status_code == 404
    assert f"{name.replace('-', '_')}.json" in response.json()["detail"]


def test_sample_events_fit_the_sample_map() -> None:
    sample = ROOT / "runs" / "0"
    map_data = read(sample / "map.json")
    store_ids_ = {s["id"] for s in map_data["stores"]}
    street_ids = {s["id"] for s in map_data["streets"]}
    for e in TypeAdapter(list[OwnerEvent]).validate_python(read(sample / "owner_events.json")):
        assert e.storeId in store_ids_ and timeutil.day_of(e.t) == e.day
    for e in TypeAdapter(list[StreetEvent]).validate_python(read(sample / "street_events.json")):
        assert e.streetId in street_ids and timeutil.day_of(e.fromT) == e.day


def test_contract_changes_document_the_additions() -> None:
    changes = (ROOT / "backend" / "CONTRACT_CHANGES.md").read_text()
    for key in (
        "`schedule`",
        "`closedFromDay`",
        "owner-events",
        "street-events",
        "OWNER_ADAPTATION",
        "`daily`",
        "profitGbp",
        "ownerActions",
    ):
        assert key in changes, key


# --- weekday closures from one dead week (driven tallies) ---------------------------------------


def fresh_team() -> owners.Owners:
    """Owners on the fixture world with no street events; tests feed the day tallies."""
    schedule = engine.build_schedule(world(), baseline())
    return owners.Owners(world(), schedule, baseline(), [], allow_closure=False)


def window_hours(store_id: str) -> np.ndarray:
    config = baseline()[store_id]
    return np.asarray(timeutil.open_hours_fraction(config.open, config.close)) > 0


def live_days(
    team: owners.Owners, store_id: str, *, dead_day: int, last_day: int, passing: float
) -> None:
    """Days 1..last_day for one shop: 3 visits and 20 passers-by an open hour, except dead_day
    (no visits) and, while a weekday is closed, `passing` passers-by an hour at the shut door."""
    i, hours = index(store_id), window_hours(store_id)
    for day in range(1, last_day + 1):
        footfall = np.zeros((world().n_stores, 24))
        if team.owners[i].window(day) is None:
            footfall[i, hours] = passing
        else:
            footfall[i, hours] = 20.0
            if day != dead_day:
                team.visits[i, day, hours] = 3.0
        team.end_day(day, footfall)


def test_a_clearly_dead_weekday_in_week_one_closes_from_week_two() -> None:
    team = fresh_team()
    live_days(team, "s5", dead_day=3, last_day=owners.REVIEW_DAY, passing=0.0)
    s5 = index("s5")
    [closed] = [e for e in team.events() if e.action == "day_closed"]
    assert (closed.storeId, closed.day, closed.to) == ("s5", owners.REVIEW_DAY + 1, "wed")
    assert closed.t == owners.REVIEW_DAY * MINUTES_PER_DAY and closed.trigger.kind == "dead_day"
    assert closed.reason == "Wednesdays are dead, closing Wednesdays."
    assert team.schedules()["s5"][-1] == {
        "fromDay": owners.REVIEW_DAY + 1,
        "week": [None if k == 2 else {"open": "12:00", "close": "23:00"} for k in range(7)],
    }
    ticks = team.schedule.open_ticks[s5].reshape(-1, engine.TICKS_PER_DAY)
    assert ticks[2].any() and not ticks[9].any()  # open Wednesday day 3, shut Wednesday day 10
    assert ticks[7].any() and ticks[10].any()
    assert not any(e.storeId == "c1" for e in team.events())  # clubs are never touched


def test_a_quiet_weekday_that_still_pays_stays_open() -> None:
    team = fresh_team()
    s5, hours = index("s5"), window_hours("s5")
    for day in range(1, owners.REVIEW_DAY + 1):
        team.visits[s5, day, hours] = 0.25 if day == 3 else 3.0
        team.end_day(day, np.zeros((world().n_stores, 24)))
    quiet, usual = 0.25 * hours.sum(), 3.0 * hours.sum()
    assert quiet < owners.DEAD_DAY_SHARE * usual  # dead by visits ...
    margin = economics.SPEND_GBP_PER_VISIT["restaurant"] * economics.GROSS_MARGIN
    assert quiet * margin > team._open_cost(team.owners[s5], 12 * 60, 11 * 60)  # ... but it pays
    assert not [e for e in team.events() if e.action == "day_closed"]


@pytest.mark.parametrize(("passing", "reopens"), [(20.0, True), (17.0, True), (5.0, False)])
def test_a_closed_weekday_people_walk_past_reopens(passing: float, reopens: bool) -> None:
    team = fresh_team()
    live_days(team, "s5", dead_day=3, last_day=10, passing=passing)
    events = [e for e in team.events() if e.action == "day_reopened"]
    if not reopens:
        assert not events
        assert team.schedules()["s5"][-1]["week"][2] is None
        return
    [event] = events
    assert (event.storeId, event.day, event.to) == ("s5", 11, "wed")
    assert event.trigger.value >= owners.REOPEN_FOOTFALL_SHARE
    assert "walking past" in event.reason
    assert team.schedules()["s5"][-1]["fromDay"] == 11
    assert team.schedules()["s5"][-1]["week"][2] == {"open": "12:00", "close": "23:00"}


# --- profit-aware decisions -------------------------------------------------------------------


def test_open_cost_counts_the_open_load_and_the_lights() -> None:
    team = fresh_team()
    s7 = index("s7")
    o = team.owners[s7]
    e = world().energy
    rate = world().floor_area[s7] * (
        e.kwhPerM2PerOpenHour["offlicence"] - e.standbyKwhPerM2PerHour["offlicence"]
    )
    lighting = baseline()["s7"].lighting
    assert lighting[23] == "low"  # shut at 23:00 with the window lit low, and low when open
    expected = rate * e.priceGbpPerKwh[23]
    assert team._open_cost(o, 23 * 60, 60) == pytest.approx(expected)
    assert team._open_cost(o, 23 * 60, 30) == pytest.approx(expected / 2)
    assert lighting[3] == "off"  # 03:00 shut and dark: opening it lights the window high
    expected = (rate + e.lightingKw["high"]) * e.priceGbpPerKwh[3]
    assert team._open_cost(o, 3 * 60, 60) == pytest.approx(expected)


def test_an_extension_whose_power_costs_more_than_its_margin_is_not_taken(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    taken = [e for e in late_offlicence().owner_events if e.storeId == "s7"]
    assert any(e.trigger.kind == "missed_demand" for e in taken)
    spend = dict(economics.SPEND_GBP_PER_VISIT, offlicence=0.05)  # a sale barely buys a light
    monkeypatch.setattr(economics, "SPEND_GBP_PER_VISIT", spend)
    out = engine.simulate(world(), with_changes(s7={"close": "17:00"}), SEED, adapt=True)
    assert not [
        e for e in out.owner_events if e.storeId == "s7" and e.trigger.kind == "missed_demand"
    ]


def run_money(out: engine.SimOutput) -> tuple[float, float]:
    results = kpis.build_results(world(), baseline(), out)
    return sum(d.profitGbp for d in results.daily), results.kpis.visitsPerKwh


@pytest.mark.parametrize("seed", SEEDS)
def test_adapting_owners_make_more_profit_and_visits_per_kwh(seed: int) -> None:
    profit_off, per_kwh_off = run_money(engine.simulate(world(), baseline(), seed, adapt=False))
    profit_on, per_kwh_on = run_money(adapted(seed))
    assert profit_on >= profit_off
    assert per_kwh_on >= per_kwh_off


def test_lights_that_bring_nobody_in_go_off() -> None:
    out = adapted()
    events = [e for e in out.owner_events if e.action == "lighting_changed"]
    assert events and all(e.trigger.kind == "lights_waste" for e in events)
    for e in events:
        i = index(e.storeId)
        later = out.schedule.lit[i, e.day - 1 :]
        assert (later[:, ~owners.NIGHT] == 0).all()  # no lights in daylight ...
        assert (later[out.schedule.open_fraction[i, e.day - 1 :] == 0] == 0).all()  # ... or shut


# --- the per-day learning curve ---------------------------------------------------------------


@pytest.mark.parametrize("adapt", [False, True])
def test_daily_kpis_add_up_to_the_run(adapt: bool) -> None:
    out = adapted() if adapt else engine.simulate(world(), baseline(), SEED, adapt=False)
    results = kpis.build_results(world(), baseline(), out)
    daily = results.daily
    assert [d.day for d in daily] == list(range(1, DAYS + 1))
    assert sum(d.visits for d in daily) == results.kpis.visits
    assert sum(d.kwh for d in daily) == pytest.approx(results.kpis.kwh, abs=0.1)
    assert sum(d.ownerActions for d in daily) == len(out.owner_events)
    price = np.asarray(world().energy.priceGbpPerKwh)
    shops = ~world().is_club
    margin = sum(
        results.stores[s.id].kpis.visits
        * economics.SPEND_GBP_PER_VISIT[s.type]
        * economics.GROSS_MARGIN
        for s in world().stores
    )
    bill = float((kpis.store_kwh(world(), out)[shops] * price).sum())
    assert sum(d.profitGbp for d in daily) == pytest.approx(margin - bill, abs=0.1)
    for d in daily:
        assert d.visitsPerKwh == round(d.visits / d.kwh, 4)
    assert kpis.build_results(world(), baseline(), out).daily == daily  # deterministic
    assert (sum(d.ownerActions for d in daily) > 0) == adapt


def test_sample_summary_daily_fits_its_totals() -> None:
    summary = RunSummary.model_validate(read(ROOT / "runs" / "0" / "summary.json"))
    assert summary.daily is not None and len(summary.daily) == DAYS
    assert sum(d.visits for d in summary.daily) == summary.kpis.visits
    assert sum(d.kwh for d in summary.daily) == pytest.approx(summary.kpis.kwh, abs=0.1)
    events = read(ROOT / "runs" / "0" / "owner_events.json")
    assert sum(d.ownerActions for d in summary.daily) == len(events)
    older = summary.model_copy(update={"daily": None})
    assert "daily" not in older.model_dump(mode="json")  # omitted when unset (older runs)
