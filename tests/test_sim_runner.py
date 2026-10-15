"""runner: run files, index, run cache, evaluate, baseline configs (tests/fixtures/ world)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from backend import cache, settings, store
from backend.contract import DAYS, DayData, RunListItem, StoreRunResult
from backend.schemas import RunConfig, RunSummary, StoreConfig, StoreStats
from backend.sim import engine, kpis, runner

FIXTURES = Path(__file__).parent / "fixtures"
SEED = 42


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Fixture data as data/processed and an empty runs/ dir, both under tmp_path."""
    processed = tmp_path / "processed"
    shutil.copytree(FIXTURES, processed)
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed)
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(cache.policy, "fresh", False)
    monkeypatch.setattr(cache.policy, "disabled", False)
    return tmp_path / "runs"


def read(path: Path):
    return json.loads(path.read_text())


def test_execute_run_writes_every_run_file(dirs: Path) -> None:
    configs = runner.baseline_configs()
    run = runner.execute_run(configs, SEED, parent_run=None, applied_changes=[])
    d = store.run_dir(run)
    config = RunConfig.model_validate(read(d / "config.json"))
    assert config.configHash == cache.run_key(configs, SEED)
    assert config.stores == configs and config.simVersion == settings.SIM_VERSION
    stores = {sid: StoreRunResult.model_validate(v) for sid, v in read(d / "stores.json").items()}
    stats = {sid: StoreStats.model_validate(v) for sid, v in read(d / "store_stats.json").items()}
    assert set(stores) == set(stats) == set(configs)  # clubs included
    assert read(d / "suggestions.json") == []
    for day in range(1, DAYS + 1):
        data = DayData.model_validate(read(d / "days" / f"{day}.json"))
        assert data.day == day and data.agents
    summary = RunSummary.model_validate(read(d / "summary.json"))
    assert summary.run == run and summary.seed == SEED
    assert summary.objective == settings.OBJECTIVE
    assert summary.objectiveValue == getattr(summary.kpis, settings.OBJECTIVE)
    assert summary.agents["total"] == summary.agents["returning"] + summary.agents["oneOff"]
    [item] = store.load_index()
    assert item.run == run and item.status == "done" and item.kpis == summary.kpis
    assert cache.run_lookup(config.configHash) == run


def test_summary_recomputes_from_store_files(dirs: Path) -> None:
    run = runner.execute_run(runner.baseline_configs(), SEED)
    d = store.run_dir(run)
    stores = {sid: StoreRunResult.model_validate(v) for sid, v in read(d / "stores.json").items()}
    stats = {sid: StoreStats.model_validate(v) for sid, v in read(d / "store_stats.json").items()}
    summary = RunSummary.model_validate(read(d / "summary.json"))
    clubs = {"c1"}
    assert kpis.run_kpis(stores, stats, clubs) == summary.kpis
    city = kpis.city_metrics(stats, clubs)
    assert city.demand_by_hour_kw == summary.demandByHourKw
    assert (city.peak_kw, city.peak_hour) == (summary.peakKw, summary.peakHour)
    assert summary.peakKw == max(summary.demandByHourKw)
    assert (city.co2_kg, city.energy_cost_gbp) == (summary.co2Kg, summary.energyCostGbp)


def test_same_seed_and_configs_give_identical_files(dirs: Path) -> None:
    configs = runner.baseline_configs()
    a = runner.execute_run(configs, SEED, use_cache=False)
    b = runner.execute_run(configs, SEED, use_cache=False)
    assert a != b
    da, db = store.run_dir(a), store.run_dir(b)
    names = ["stores.json", "store_stats.json", "suggestions.json"]
    names += [f"days/{day}.json" for day in range(1, DAYS + 1)]
    for name in names:
        assert (da / name).read_bytes() == (db / name).read_bytes(), name
    volatile = {"run", "durationSec", "cache"}  # run id, wall time, in-process cache counters
    sa, sb = read(da / "summary.json"), read(db / "summary.json")
    assert {k: v for k, v in sa.items() if k not in volatile} == {
        k: v for k, v in sb.items() if k not in volatile
    }
    ca, cb = read(da / "config.json"), read(db / "config.json")
    assert {k: v for k, v in ca.items() if k != "run"} == {
        k: v for k, v in cb.items() if k != "run"
    }


def test_cache_hit_returns_the_run_without_simulating(
    dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configs = runner.baseline_configs()
    first = runner.execute_run(configs, SEED)

    def boom(*args, **kwargs):
        raise AssertionError("simulated despite a cache hit")

    monkeypatch.setattr(engine, "simulate", boom)
    assert runner.execute_run(configs, SEED) == first
    assert sorted(p.name for p in dirs.iterdir() if p.name.isdigit()) == [str(first)]


def test_rebuilt_processed_data_never_reuses_a_run(dirs: Path) -> None:
    configs = runner.baseline_configs()
    first = runner.execute_run(configs, SEED)
    sid, config = next(iter(configs.items()))
    assert cache.store_config_tried(sid, config)

    demand = settings.PROCESSED_DIR / "demand.json"
    rebuilt = read(demand)
    rebuilt["notes"] = [*rebuilt.get("notes", []), "rebuilt"]
    demand.write_text(json.dumps(rebuilt))

    assert cache.run_lookup(cache.run_key(configs, SEED)) is None
    assert not cache.store_config_tried(sid, config)
    second = runner.execute_run(configs, SEED)
    assert second != first
    assert cache.run_lookup(cache.run_key(configs, SEED)) == second


def test_reserved_run_id_and_index_status(dirs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run = store.reserve_run_id()
    store.upsert_index(
        RunListItem(run=run, seed=SEED, status="queued", kpis=None, notebook="", createdAt="x")
    )
    seen: list[str] = []
    real_simulate = engine.simulate

    def spy(world, configs, seed):
        seen.append(next(i.status for i in store.load_index() if i.run == run))
        return real_simulate(world, configs, seed)

    monkeypatch.setattr(engine, "simulate", spy)
    assert runner.execute_run(runner.baseline_configs(), SEED, run_id=run) == run
    assert seen == ["running"]
    [item] = store.load_index()
    assert item.status == "done" and item.createdAt == "x" and item.kpis is not None


def test_failed_simulation_marks_the_run_failed(
    dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*args, **kwargs):
        raise RuntimeError("sim crashed")

    monkeypatch.setattr(engine, "simulate", broken)
    with pytest.raises(RuntimeError):
        runner.execute_run(runner.baseline_configs(), SEED)
    [item] = store.load_index()
    assert item.status == "failed"
    assert not (store.run_dir(item.run) / "summary.json").exists()


def test_configs_must_cover_every_store(dirs: Path) -> None:
    configs = runner.baseline_configs()
    del configs["s3"]
    with pytest.raises(ValueError, match="s3"):
        runner.execute_run(configs, SEED)
    with pytest.raises(ValueError, match="s3"):
        runner.evaluate(configs, SEED)
    assert not dirs.exists() or not any(p.name.isdigit() for p in dirs.iterdir())


def test_evaluate_matches_the_run_and_writes_nothing(dirs: Path) -> None:
    configs = runner.baseline_configs()
    result = runner.evaluate(configs, SEED)
    assert not dirs.exists()
    assert result.summary.run == -1
    run = runner.execute_run(configs, SEED)
    summary = RunSummary.model_validate(read(store.run_dir(run) / "summary.json"))
    assert result.kpis == summary.kpis
    assert result.stores == {
        sid: StoreRunResult.model_validate(v)
        for sid, v in read(store.run_dir(run) / "stores.json").items()
    }


def test_baseline_lighting_follows_build_notes(dirs: Path) -> None:
    configs = runner.baseline_configs()
    cafe = configs["s4"]  # 07:00-18:00
    assert (cafe.open, cafe.close) == ("07:00", "18:00")
    assert cafe.lighting[:7] == ["off"] * 7  # closed 00-07
    assert cafe.lighting[7:17] == ["low"] * 10  # open 07-17
    assert cafe.lighting[17] == "high"  # open 17-18
    assert cafe.lighting[18:] == ["low"] * 6  # closed 18-24: window display
    bar = configs["s3"]  # 16:00-00:00
    assert bar.lighting[16] == "low" and bar.lighting[17:] == ["high"] * 7
    club = configs["c1"]  # its ClubNight: 22:00-03:00
    assert (club.open, club.close) == ("22:00", "03:00")
    assert club.lighting == ["high"] * 3 + ["off"] * 19 + ["high"] * 2


def test_baseline_without_demand_falls_back_to_default_hours(dirs: Path) -> None:
    (settings.PROCESSED_DIR / "demand.json").unlink()
    configs = runner.baseline_configs()
    assert (configs["c1"].open, configs["c1"].close) == ("22:00", "03:00")
    assert all(isinstance(c, StoreConfig) for c in configs.values())


def test_energy_follows_the_build_notes_formula(dirs: Path) -> None:
    configs = runner.baseline_configs()
    configs["s4"] = configs["s4"].model_copy(update={"open": "07:30"})
    result = runner.evaluate(configs, SEED)
    energy = store.load_energy()
    area = 120.0
    open_rate = energy.kwhPerM2PerOpenHour["cafe"] * area
    standby = energy.standbyKwhPerM2PerHour["cafe"] * area
    kwh = result.stats["s4"].kwhByHour
    lit = energy.lightingKw
    assert kwh[3] == pytest.approx(standby + lit["off"], abs=1e-3)
    assert kwh[7] == pytest.approx(0.5 * open_rate + 0.5 * standby + lit["low"], abs=1e-3)
    assert kwh[12] == pytest.approx(open_rate + lit["low"], abs=1e-3)
    assert kwh[20] == pytest.approx(standby + lit["low"], abs=1e-3)
    assert result.stores["s4"].kpis.kwh == pytest.approx(sum(kwh) * DAYS, abs=0.2)
