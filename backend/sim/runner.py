"""Run orchestration: simulate 14 days for a set of store configs and persist the run files.

This is the seam the agents, the CLI and the API call. Interface owned by the sim module.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import dataclass

from backend import cache, settings, store, timeutil
from backend.contract import (
    Kpis,
    LightingLevel,
    MapData,
    MapStore,
    RunListItem,
    StoreRunResult,
    StoreType,
    dump,
)
from backend.schemas import ClubNight, RunConfig, RunSummary, StoreConfig, StoreStats
from backend.sim import engine
from backend.sim import kpis as kpi_model

# Trading window by type when map.json has no defaultHours (same table as the map pipeline).
TYPE_DEFAULT_HOURS: dict[StoreType, tuple[str, str]] = {
    "cafe": ("07:00", "18:00"),
    "restaurant": ("12:00", "23:00"),
    "takeaway": ("11:00", "23:00"),
    "bar": ("16:00", "00:00"),
    "shop": ("10:00", "19:00"),
    "offlicence": ("08:00", "23:00"),
    "club": ("22:00", "03:00"),
}


@dataclass
class EvalResult:
    kpis: Kpis
    stores: dict[str, StoreRunResult]
    stats: dict[str, StoreStats]
    summary: RunSummary


def baseline_configs() -> dict[str, StoreConfig]:
    """Starting configs for every MapStore (clubs included) from map.json defaultHours."""
    try:
        club_nights = store.load_demand().clubNights
    except FileNotFoundError:
        club_nights = []
    return baseline_from(store.load_map(), club_nights)


def baseline_from(map_data: MapData, club_nights: list[ClubNight]) -> dict[str, StoreConfig]:
    """docs/BUILD_NOTES.md baseline: hours from defaultHours; lighting low while open 07-17,
    high while open 17-07, low while closed 18-24 (window display), off while closed otherwise.
    Clubs take their first ClubNight's hours, lighting high while open, else off."""
    nights: dict[str, ClubNight] = {}
    for night in club_nights:
        nights.setdefault(night.clubId, night)
    configs = {}
    for s in map_data.stores:
        open_, close = _baseline_hours(s, nights.get(s.id))
        is_open = [f > 0 for f in timeutil.open_hours_fraction(open_, close)]
        lighting = [_baseline_level(s.type, h, is_open[h]) for h in range(24)]
        configs[s.id] = StoreConfig(open=open_, close=close, lighting=lighting)
    return configs


def _baseline_hours(s: MapStore, night: ClubNight | None) -> tuple[str, str]:
    if s.type == "club" and night is not None:
        return night.open, night.close
    if s.defaultHours is not None:
        return s.defaultHours.open, s.defaultHours.close
    return TYPE_DEFAULT_HOURS[s.type]


def _baseline_level(store_type: StoreType, hour: int, is_open: bool) -> LightingLevel:
    if store_type == "club":
        return "high" if is_open else "off"
    if is_open:
        return "low" if 7 <= hour < 17 else "high"
    return "low" if hour >= 18 else "off"


def evaluate(stores: dict[str, StoreConfig], seed: int) -> EvalResult:
    """Simulate 14 days in memory, without writing any files (multi-seed confidence checks).

    The summary's `run` is -1: nothing was persisted.
    """
    started = time.perf_counter()
    world = engine.load_world()
    _check_configs(world, stores)
    results = kpi_model.build_results(world, stores, engine.simulate(world, stores, seed))
    summary = _summary(-1, seed, results, time.perf_counter() - started)
    return EvalResult(
        kpis=results.kpis, stores=results.stores, stats=results.stats, summary=summary
    )


def execute_run(
    stores: dict[str, StoreConfig],
    seed: int,
    *,
    parent_run: int | None = None,
    applied_changes: list[dict] | None = None,
    run_id: int | None = None,
    use_cache: bool = True,
) -> int:
    """Simulate 14 days and persist runs/{run}/: config.json, stores.json, store_stats.json,
    suggestions.json ([] until store agents fill it), owner_events.json, street_events.json
    (both [] with settings.OWNER_ADAPTATION off), days/1..14.json, summary.json; upsert
    runs/index.json and record the run in runs/cache.json.

    With owner adaptation on, an owner may close for good only in a run whose parent is not the
    baseline (docs/OWNER_ACTIONS.md: never in run 1 of a session).

    Returns the run id. On a run-cache hit (same configs + seed + SIM_VERSION, honouring the
    cache policy) returns the cached run id without simulating. `run_id` lets the API reserve
    an id first (POST /api/apply answers with it before the run finishes).

    The index item reads "running" while the run simulates, then "done" with its KPIs (or
    "failed" if the simulation raised). summary.json is written last: its presence marks the run
    complete for the run cache.
    """
    allow_closure = _closures_allowed(parent_run)
    key = cache.run_key(stores, seed, allow_closure=allow_closure)
    if use_cache:
        hit = cache.run_lookup(key)
        if hit is not None:
            return hit
    started = time.perf_counter()
    world = engine.load_world()
    _check_configs(world, stores)
    run = run_id if run_id is not None else store.reserve_run_id()
    directory = store.run_dir(run)
    config = RunConfig(
        run=run,
        seed=seed,
        simVersion=settings.SIM_VERSION,
        stores=stores,
        parentRun=parent_run,
        appliedChanges=applied_changes or [],
        configHash=key,
    )
    store.write_json(directory / "config.json", config)
    _mark_running(run, seed)
    try:
        if allow_closure:
            out = engine.simulate(world, stores, seed, allow_closure=True)
        else:
            out = engine.simulate(world, stores, seed)
        results = kpi_model.build_results(world, stores, out)
        for day in engine.day_files(out.trips, world.stores):
            store.write_json(directory / "days" / f"{day.day}.json", dump(day))
        store.write_json(
            directory / "stores.json", {sid: dump(r) for sid, r in results.stores.items()}
        )
        store.write_json(
            directory / "store_stats.json", {sid: dump(s) for sid, s in results.stats.items()}
        )
        store.write_json(directory / "suggestions.json", [])
        store.write_json(directory / "owner_events.json", [dump(e) for e in out.owner_events])
        store.write_json(directory / "street_events.json", out.street_events)
        summary = _summary(run, seed, results, time.perf_counter() - started)
        store.write_json(directory / "summary.json", summary)
        store.update_index(run, status="done", kpis=results.kpis)
        cache.run_record(key, run, stores)
    except Exception:
        store.update_index(run, status="failed")
        raise
    return run


def _closures_allowed(parent_run: int | None) -> bool:
    """Permanent closures need adaptation on and a parent that is not the baseline (a run with
    no parent of its own)."""
    if not settings.OWNER_ADAPTATION or parent_run is None:
        return False
    try:
        parent = store.read_model(store.run_dir(parent_run) / "config.json", RunConfig)
    except FileNotFoundError:
        return False
    return parent.parentRun is not None


def _check_configs(world: engine.World, stores: Mapping[str, StoreConfig]) -> None:
    ids = {s.id for s in world.stores}
    missing, unknown = sorted(ids - set(stores)), sorted(set(stores) - ids)
    if missing or unknown:
        raise ValueError(
            f"configs must cover every map store: missing {missing}, unknown {unknown}"
        )


def _mark_running(run: int, seed: int) -> None:
    if any(item.run == run for item in store.load_index()):
        store.update_index(run, status="running", seed=seed)
        return
    store.upsert_index(
        RunListItem(
            run=run, seed=seed, status="running", kpis=None, notebook="", createdAt=store.now_iso()
        )
    )


def _summary(run: int, seed: int, results: kpi_model.RunResults, duration: float) -> RunSummary:
    city = results.city
    return RunSummary(
        run=run,
        seed=seed,
        kpis=results.kpis,
        objective=settings.OBJECTIVE,
        objectiveValue=float(getattr(results.kpis, settings.OBJECTIVE)),
        peakKw=city.peak_kw,
        peakHour=city.peak_hour,
        co2Kg=city.co2_kg,
        energyCostGbp=city.energy_cost_gbp,
        demandByHourKw=city.demand_by_hour_kw,
        footfallByHour=results.footfall_by_hour,
        agents=results.agents,
        durationSec=round(duration, 2),
        cache=cache.stats(),
    )
