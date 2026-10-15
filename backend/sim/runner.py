"""Run orchestration: simulate 14 days for a set of store configs and persist the run files.

This is the seam the agents, the CLI and the API call. Interface owned by the sim module.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.contract import Kpis, StoreRunResult
from backend.schemas import RunSummary, StoreConfig, StoreStats


@dataclass
class EvalResult:
    kpis: Kpis
    stores: dict[str, StoreRunResult]
    stats: dict[str, StoreStats]
    summary: RunSummary


def baseline_configs() -> dict[str, StoreConfig]:
    """Starting configs for every MapStore (clubs included) from map.json defaultHours."""
    raise NotImplementedError


def evaluate(stores: dict[str, StoreConfig], seed: int) -> EvalResult:
    """Simulate 14 days in memory, without writing any files (multi-seed confidence checks)."""
    raise NotImplementedError


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
    suggestions.json ([] until store agents fill it), days/1..14.json, summary.json; upsert
    runs/index.json and record the run in runs/cache.json.

    Returns the run id. On a run-cache hit (same configs + seed + SIM_VERSION, honouring the
    cache policy) returns the cached run id without simulating. `run_id` lets the API reserve
    an id first (POST /api/apply answers with it before the run finishes).
    """
    raise NotImplementedError
