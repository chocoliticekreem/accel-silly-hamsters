"""A small deterministic stand-in for backend.sim.runner, shared by the agents tests.

It honours the runner's contract (run files, run index, run cache, EvalResult) with a simple
demand model that gives the agents real effects to find:
  s1 Dawn Cafe    shut from 18:00 while its window lights still burn
  s2 Kebab Co     next to Club One: big spill-out demand after its 23:00 close, dark after midnight
  s3 Night Bar    open till 01:00, quiet after midnight
  s4 Corner Shop  open till 22:00 with almost nobody after 20:00
Visits = demand x open share x night lighting factor x small seeded noise; found-closed =
demand while shut; kWh follows docs/BUILD_NOTES.md.
"""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np

from backend import cache, settings, store
from backend.contract import (
    Kpis,
    LightingLevel,
    MapData,
    RunListItem,
    StoreKpis,
    StoreRunResult,
    StoreType,
)
from backend.schemas import EnergyFile, RunConfig, RunSummary, StoreConfig, StoreStats
from backend.sim.runner import EvalResult
from backend.timeutil import open_hours_fraction

NIGHT = set(range(17, 24)) | set(range(0, 7))
STORES: dict[str, tuple[str, StoreType, float, tuple[str, str]]] = {
    "s1": ("Dawn Cafe", "cafe", 80.0, ("07:00", "18:00")),
    "s2": ("Kebab Co", "takeaway", 60.0, ("11:00", "23:00")),
    "s3": ("Night Bar", "bar", 120.0, ("16:00", "01:00")),
    "s4": ("Corner Shop", "shop", 50.0, ("07:00", "22:00")),
    "c1": ("Club One", "club", 400.0, ("22:00", "03:00")),
}


def _hours(values: Mapping[int, float]) -> list[float]:
    return [float(values.get(h, 0.0)) for h in range(24)]


DEMAND = {
    "s1": _hours(
        {6: 2, 7: 8, 8: 10, 9: 8, 10: 6, 11: 6, 12: 8, 13: 7, 14: 5, 15: 4, 16: 3, 17: 2, 18: 1}
        | {19: 0.5}
    ),
    "s2": _hours(
        {0: 8, 1: 9, 2: 8, 3: 10, 4: 2, 11: 2, 12: 6, 13: 6, 14: 3, 15: 2, 16: 3, 17: 4}
        | {18: 6, 19: 7, 20: 6, 21: 5, 22: 4, 23: 5}
    ),
    "s3": _hours({0: 3, 1: 1, 16: 2, 17: 4, 18: 6, 19: 8, 20: 9, 21: 8, 22: 6, 23: 4}),
    "s4": _hours(
        {7: 3, 8: 4, 9: 4, 10: 4, 11: 5, 12: 6, 13: 5, 14: 4, 15: 4, 16: 5, 17: 6, 18: 5}
        | {19: 3, 20: 0.3, 21: 0.2}
    ),
    "c1": _hours({}),
}
AREA_FOOTFALL = _hours(
    {h: 150.0 for h in range(8, 20)}
    | {20: 110, 21: 100, 22: 90, 23: 80, 0: 70, 1: 60, 2: 60}
    | {3: 90, 4: 40, 5: 10, 6: 20, 7: 80}
)
FOOTFALL_SHARE = {"s1": 0.3, "s2": 0.4, "s3": 0.3, "s4": 0.25, "c1": 0.5}
QUIET_BAR_HOURS = {0: 0.05}  # the bar's street empties after midnight
LIGHT_FACTOR: dict[str, float] = {"off": 0.8, "low": 1.0, "high": 1.15}

ENERGY = {
    "sources": [{"label": "CIBSE TM46 energy benchmarks", "url": "https://example.org/tm46"}],
    "fallback": True,
    "kwhPerM2PerOpenHour": {
        "cafe": 0.045,
        "restaurant": 0.04,
        "takeaway": 0.06,
        "bar": 0.035,
        "shop": 0.035,
        "offlicence": 0.05,
        "club": 0.06,
    },
    "standbyKwhPerM2PerHour": {
        "cafe": 0.008,
        "restaurant": 0.007,
        "takeaway": 0.012,
        "bar": 0.008,
        "shop": 0.004,
        "offlicence": 0.018,
        "club": 0.006,
    },
    "lightingKw": {"off": 0.0, "low": 0.3, "high": 1.0},
    "carbonGPerKwh": [150.0] * 24,
    "priceGbpPerKwh": [0.27] * 24,
}


def map_data() -> MapData:
    buildings = []
    stores = []
    for index, (sid, (name, kind, area, hours)) in enumerate(STORES.items()):
        buildings.append(
            {
                "id": f"b{index}",
                "kind": "club" if kind == "club" else "store",
                "storeId": sid,
                "x": 20.0 * index,
                "z": 10.0,
                "w": 10.0,
                "d": 8.0,
                "h": 9.0,
            }
        )
        stores.append(
            {
                "id": sid,
                "name": name,
                "type": kind,
                "buildingId": f"b{index}",
                "defaultHours": {"open": hours[0], "close": hours[1]},
                "floorArea": area,
            }
        )
    return MapData.model_validate(
        {
            "bounds": {"minX": -250, "maxX": 250, "minZ": -250, "maxZ": 250},
            "streets": [],
            "buildings": buildings,
            "stores": stores,
            "entryPoints": [{"id": "st1", "kind": "station", "name": "Station", "x": 0, "z": 0}],
            "sources": [
                {"label": "OpenStreetMap contributors", "url": "https://www.openstreetmap.org"}
            ],
        }
    )


def baseline_lighting(open_hhmm: str, close_hhmm: str) -> list[LightingLevel]:
    fracs = open_hours_fraction(open_hhmm, close_hhmm)
    lighting: list[LightingLevel] = []
    for hour, share in enumerate(fracs):
        if share > 0:
            lighting.append("low" if 7 <= hour < 17 else "high")
        else:
            lighting.append("low" if hour >= 18 else "off")
    return lighting


class FakeSim:
    """Replaces runner.baseline_configs / execute_run / evaluate (see install())."""

    def __init__(self) -> None:
        self.simulations = 0
        self.crash_at: int | None = None  # raise on this simulation number (1-based)
        self.crash_after_write = False  # raise after the run's files and cache entry exist
        self.energy = EnergyFile.model_validate(ENERGY)

    def install(self, monkeypatch) -> None:
        from backend.sim import runner

        monkeypatch.setattr(runner, "baseline_configs", self.baseline_configs)
        monkeypatch.setattr(runner, "execute_run", self.execute_run)
        monkeypatch.setattr(runner, "evaluate", self.evaluate)

    def baseline_configs(self) -> dict[str, StoreConfig]:
        configs = {}
        for sid, (_, kind, _, (open_hhmm, close_hhmm)) in STORES.items():
            if kind == "club":
                fracs = open_hours_fraction(open_hhmm, close_hhmm)
                lighting: list[LightingLevel] = ["high" if f > 0 else "off" for f in fracs]
            else:
                lighting = baseline_lighting(open_hhmm, close_hhmm)
            configs[sid] = StoreConfig(open=open_hhmm, close=close_hhmm, lighting=lighting)
        return configs

    def _store(self, sid: str, index: int, config: StoreConfig, seed: int):
        name, kind, area, _ = STORES[sid]
        rng = np.random.default_rng([seed, index])
        noise = 1.0 + rng.normal(0.0, 0.03, 24)
        fracs = open_hours_fraction(config.open, config.close)
        demand = DEMAND[sid]
        visits, found, kwh, footfall = [], [], [], []
        for h in range(24):
            light = LIGHT_FACTOR[config.lighting[h]] if h in NIGHT else 1.0
            visits.append(demand[h] * fracs[h] * light * noise[h])
            found.append(demand[h] * (1 - fracs[h]) * 0.9 * noise[h])
            open_kwh = fracs[h] * area * self.energy.kwhPerM2PerOpenHour[kind]
            standby = (1 - fracs[h]) * area * self.energy.standbyKwhPerM2PerHour[kind]
            kwh.append(open_kwh + standby + self.energy.lightingKw[config.lighting[h]])
            share = FOOTFALL_SHARE[sid] * (QUIET_BAR_HOURS.get(h, 1.0) if sid == "s3" else 1.0)
            footfall.append(AREA_FOOTFALL[h] * share)
        total_visits = round(sum(visits) * 14)
        total_kwh = sum(kwh) * 14
        unique = max(1, int(total_visits * 0.6))
        result = StoreRunResult(
            open=config.open,
            close=config.close,
            lighting=list(config.lighting),
            kpis=StoreKpis(visits=total_visits, kwh=round(total_kwh, 3), returnRate=0.3),
            visitsByHour=[round(v, 4) for v in visits],
        )
        stats = StoreStats(
            visitsByHourWeekday=[round(v * 0.95, 4) for v in visits],
            visitsByHourWeekend=[round(v * 1.1, 4) for v in visits],
            footfallNearbyByHour=[round(f, 3) for f in footfall],
            foundClosedByHour=[round(f, 4) for f in found],
            kwhByHour=[round(k, 4) for k in kwh],
            uniqueVisitors=unique,
            repeatVisitors=int(unique * 0.3),
            visitsByPersona={"regular": total_visits},
            energyCostGbp=round(
                sum(k * p for k, p in zip(kwh, self.energy.priceGbpPerKwh, strict=True)) * 14, 3
            ),
            co2Kg=round(sum(kwh) * 14 * 0.15, 3),
        )
        return kind, result, stats, kwh

    def evaluate(self, stores: dict[str, StoreConfig], seed: int) -> EvalResult:
        self.simulations += 1
        if self.crash_at == self.simulations and not self.crash_after_write:
            raise RuntimeError("simulated crash before the run was written")
        results, stats, demand = {}, {}, [0.0] * 24
        visits = 0
        kwh = 0.0
        for index, sid in enumerate(STORES):
            kind, result, stat, kwh_by_hour = self._store(sid, index, stores[sid], seed)
            results[sid], stats[sid] = result, stat
            if kind != "club":
                visits += result.kpis.visits
                kwh += result.kpis.kwh
                demand = [d + k for d, k in zip(demand, kwh_by_hour, strict=True)]
        kpis = Kpis(
            visits=visits, kwh=round(kwh, 3), visitsPerKwh=round(visits / kwh, 6), returnRate=0.3
        )
        summary = RunSummary(
            run=0,
            seed=seed,
            kpis=kpis,
            objective=settings.OBJECTIVE,
            objectiveValue=float(getattr(kpis, settings.OBJECTIVE)),
            peakKw=round(max(demand), 3),
            peakHour=int(np.argmax(demand)),
            co2Kg=round(kwh * 0.15, 3),
            energyCostGbp=round(kwh * 0.27, 3),
            demandByHourKw=[round(d, 3) for d in demand],
            footfallByHour=AREA_FOOTFALL,
            agents={"returning": 300, "oneOff": 500, "total": 800},
            durationSec=0.01,
        )
        return EvalResult(kpis=kpis, stores=results, stats=stats, summary=summary)

    def execute_run(
        self,
        stores: dict[str, StoreConfig],
        seed: int,
        *,
        parent_run: int | None = None,
        applied_changes: list[dict] | None = None,
        run_id: int | None = None,
        use_cache: bool = True,
    ) -> int:
        key = cache.run_key(stores, seed)
        if use_cache:
            cached = cache.run_lookup(key)
            if cached is not None:
                return cached
        result = self.evaluate(stores, seed)
        run = run_id if run_id is not None else store.reserve_run_id()
        folder = store.run_dir(run)
        config = RunConfig(
            run=run,
            seed=seed,
            simVersion=settings.SIM_VERSION,
            stores=stores,
            parentRun=parent_run,
            appliedChanges=applied_changes or [],
            configHash=key,
        )
        store.write_json(folder / "config.json", config)
        store.write_json(
            folder / "stores.json", {k: v.model_dump() for k, v in result.stores.items()}
        )
        store.write_json(
            folder / "store_stats.json", {k: v.model_dump() for k, v in result.stats.items()}
        )
        store.write_json(folder / "suggestions.json", [])
        store.write_json(folder / "summary.json", result.summary.model_copy(update={"run": run}))
        cache.run_record(key, run, stores)
        store.upsert_index(
            RunListItem(
                run=run,
                seed=seed,
                status="done",
                kpis=result.kpis,
                notebook="",
                createdAt=store.now_iso(),
            )
        )
        if self.crash_at == self.simulations and self.crash_after_write:
            raise RuntimeError("simulated crash after the run was written")
        return run


def setup_world(tmp_path, monkeypatch, *, energy: bool = True) -> FakeSim:
    """Point every data dir at tmp_path, write map/energy/demand files, install the fake sim."""
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "LLM_CACHE_DIR", tmp_path / "cache" / "llm")
    monkeypatch.setattr(settings, "OFFLINE", True)
    cache.set_policy(fresh=False, refresh=False)
    store.write_json(settings.PROCESSED_DIR / "map.json", map_data())
    if energy:
        store.write_json(settings.PROCESSED_DIR / "energy.json", ENERGY)
    store.write_json(
        settings.PROCESSED_DIR / "demand.json",
        {
            "sources": [{"label": "TfL station entries", "url": "https://tfl.gov.uk/open-data"}],
            "fallback": False,
            "entryPoints": {},
            "returningPoolSize": 300,
            "returningShare": 0.4,
            "clubNights": [
                {"clubId": "c1", "days": ["thu", "fri", "sat"], "open": "22:00", "close": "03:00"}
                | {"capacity": 600}
            ],
        },
    )
    sim = FakeSim()
    sim.install(monkeypatch)
    return sim


# --- sanity checks of the fake itself ---------------------------------------------------------


def test_fake_runs_are_deterministic_and_cached(tmp_path, monkeypatch):
    sim = setup_world(tmp_path, monkeypatch)
    configs = sim.baseline_configs()
    first = sim.execute_run(configs, 42)
    again = sim.execute_run(configs, 42)
    assert first == again
    assert sim.simulations == 1
    a, b = sim.evaluate(configs, 42), sim.evaluate(configs, 42)
    assert a.kpis == b.kpis
    assert sim.evaluate(configs, 43).kpis != a.kpis
    summary = store.read_model(store.run_dir(first) / "summary.json", RunSummary)
    assert summary.run == first
    assert [r.run for r in store.load_index()] == [first]


def test_fake_baseline_follows_the_lighting_rule():
    configs = FakeSim().baseline_configs()
    cafe = configs["s1"]
    assert cafe.lighting[8] == "low" and cafe.lighting[17] == "high"
    assert cafe.lighting[20] == "low" and cafe.lighting[3] == "off"
