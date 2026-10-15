"""Read and write the run files the agents work from (runs/{run}/...).

The sim runner writes config.json, stores.json, store_stats.json and summary.json; the agents read
them here and write suggestions.json, the cost block of summary.json and reports. Writes go through
backend.store so they stay atomic while the API serves the same files.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend import economics, store
from backend.agents.objective import NET_VALUE, city_value, net_value_gbp
from backend.contract import MapData, MapStore, StoreRunResult, StoreType, Suggestion, dump
from backend.schemas import RunConfig, RunSummary, StoreStats


def _path(run: int, name: str) -> Path:
    return store.run_dir(run) / name


def _read_dict(path: Path) -> dict:
    data = store.read_json(path)
    if data is None:
        raise FileNotFoundError(path)
    return data


def load_config(run: int) -> RunConfig:
    return store.read_model(_path(run, "config.json"), RunConfig)


def load_stores(run: int) -> dict[str, StoreRunResult]:
    data = _read_dict(_path(run, "stores.json"))
    return {sid: StoreRunResult.model_validate(value) for sid, value in data.items()}


def load_stats(run: int) -> dict[str, StoreStats]:
    data = _read_dict(_path(run, "store_stats.json"))
    return {sid: StoreStats.model_validate(value) for sid, value in data.items()}


def load_summary(run: int) -> RunSummary:
    return store.read_model(_path(run, "summary.json"), RunSummary)


def save_summary(run: int, summary: RunSummary) -> None:
    store.write_json(_path(run, "summary.json"), summary)


def load_suggestions(run: int) -> list[Suggestion]:
    return [
        Suggestion.model_validate(s) for s in store.read_json(_path(run, "suggestions.json"), [])
    ]


def save_suggestions(run: int, suggestions: list[Suggestion]) -> None:
    store.write_json(_path(run, "suggestions.json"), [dump(s) for s in suggestions])


@dataclass
class RunFiles:
    """Everything the agents read about one finished run."""

    run: int
    config: RunConfig
    stores: dict[str, StoreRunResult]
    stats: dict[str, StoreStats]
    summary: RunSummary

    @classmethod
    def load(cls, run: int) -> RunFiles:
        return cls(
            run=run,
            config=load_config(run),
            stores=load_stores(run),
            stats=load_stats(run),
            summary=load_summary(run),
        )


def advised_stores(map_data: MapData) -> list[MapStore]:
    """Stores that get advice: every map store except clubs (fixed anchors)."""
    return [s for s in map_data.stores if s.type != "club"]


def store_names(map_data: MapData) -> dict[str, str]:
    return {s.id: s.name for s in map_data.stores}


def store_types(map_data: MapData) -> dict[str, StoreType]:
    return {s.id: s.type for s in map_data.stores}


def objective_value(run: int, objective: str) -> float:
    """A finished run's value on `objective`: netValueGbp from its stores, a Kpis field from
    its summary (the sim's own objectiveValue when it scored the same objective)."""
    summary = load_summary(run)
    if objective == NET_VALUE:
        stores = {sid: result.kpis for sid, result in load_stores(run).items()}
        types = store_types(store.load_map())
        return net_value_gbp(stores, types, economics.area_price_gbp_per_kwh())
    if summary.objective == objective:
        return summary.objectiveValue
    return city_value(summary.kpis, objective)
