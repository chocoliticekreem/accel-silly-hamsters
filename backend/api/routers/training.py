"""POST /api/apply (manual apply from the UI), GET /api/analyst and GET /api/notebook."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from backend import cache, contract, store
from backend.api import apply, common
from backend.contract import (
    AnalystStatus,
    ApplyRequest,
    ApplyResponse,
    MapData,
    RunListItem,
    Suggestion,
)
from backend.schemas import NotebookEntry, RunConfig

logger = logging.getLogger(__name__)
router = APIRouter(tags=["training"])

ExecuteRun = Callable[..., int]
MANUAL_APPLY_AGENT = "manual_apply"  # the `agent` on rule rejections logged by POST /api/apply


def _load_execute_run() -> ExecuteRun:
    """backend.sim.runner.execute_run, imported per request so the API boots while the sim is
    being rebuilt and tests can monkeypatch it."""
    try:
        from backend.sim import runner
    except ImportError as e:
        raise HTTPException(503, f"simulation unavailable: {e}") from e
    return runner.execute_run


def _processed_map() -> MapData:
    try:
        return store.load_map()
    except FileNotFoundError as e:
        raise HTTPException(503, "data/processed/map.json is missing; run the pipeline") from e


@dataclass
class RuleChecked:
    """The outcome of the hard rules for one apply."""

    configs: apply.Configs  # every store of the base run, accepted changes applied
    accepted: list[Suggestion]
    rejections: list[Any]


def _rule_checked(base: RunConfig, selected: list[Suggestion]) -> RuleChecked:
    """Apply the selected suggestions through backend.agents.rules.check_changes and log the
    rejections to the base run's audit log. Without a rules module: apply all, with a warning."""
    try:
        rules = apply.load_rules()
    except ImportError as e:
        raise HTTPException(503, f"hard rules unavailable, nothing applied: {e}") from e
    if rules is None:
        logger.warning("%s not found: applying without the hard rules", apply.RULES_MODULE)
        try:
            return RuleChecked(apply.apply_suggestions(base.stores, selected), selected, [])
        except ValueError as e:
            raise HTTPException(409, f"run {base.run} has an invalid suggestion: {e}") from e
    try:
        check_changes, log_rejections = rules.check_changes, rules.log_rejections
    except AttributeError as e:
        raise HTTPException(503, f"hard rules unavailable, nothing applied: {e}") from e
    # check_tried=False: the owner re-applying a suggestion the analyst already simulated is
    # not agent flip-flopping, and an exact repeat of a whole run comes back from the run cache.
    result = check_changes(base.stores, selected, _processed_map(), check_tried=False)
    log_rejections(base.run, result.rejections, agent=MANUAL_APPLY_AGENT)
    return RuleChecked(result.configs, list(result.accepted), list(result.rejections))


def run_queued(
    execute_run: ExecuteRun,
    configs: apply.Configs,
    seed: int,
    *,
    parent_run: int,
    applied_changes: list[dict],
    run_id: int,
) -> None:
    """Background task for a queued run: mark it running, simulate, and mark it failed when the
    runner raises or hands back another run (the runner itself records a finished run as done)."""
    store.update_index(run_id, status="running")
    try:
        result = execute_run(
            configs,
            seed,
            parent_run=parent_run,
            applied_changes=applied_changes,
            run_id=run_id,
        )
    except Exception as e:
        logger.exception("queued run %d failed", run_id)
        store.update_index(run_id, status="failed", notebook=f"Run failed: {type(e).__name__}")
        return
    if result != run_id:
        store.update_index(
            run_id, status="failed", notebook=f"Same config as run {result}; not re-run"
        )


def _queued_note(run: int, applied: list[Suggestion]) -> str:
    stores = sorted({s.storeId for s in applied})
    target = ", ".join(stores) if len(stores) <= 3 else f"{len(stores)} stores"
    return f"Applied {len(applied)} change(s) from run {run}: {target}"


def _selection(request: ApplyRequest) -> tuple[RunConfig, list[Suggestion]]:
    """The base run's config and the suggestions the request selects; 404/409 when unusable."""
    common.run_path(request.run)
    if request.run == common.SAMPLE_RUN:
        raise HTTPException(409, "sample run cannot be applied; run the sim first")
    base = common.read_run_file(request.run, "config.json", RunConfig)
    store_ids = request.storeIds if request.scope == "store" else None
    unknown = sorted(set(store_ids or []) - base.stores.keys())
    if unknown:
        raise HTTPException(404, f"run {request.run} has no store {', '.join(unknown)}")
    suggestions = common.read_run_file(request.run, "suggestions.json", list[Suggestion])
    selected = apply.select_suggestions(suggestions, store_ids)
    if not selected:
        scope = ", ".join(store_ids or ["any store"])
        raise HTTPException(409, f"run {request.run} has no suggestions for {scope}")
    return base, selected


def _queue_run(base: RunConfig, checked: RuleChecked, background: BackgroundTasks) -> int:
    """Reserve a run id, list it as queued and simulate it after the response is sent."""
    execute_run = _load_execute_run()
    run_id = store.reserve_run_id()
    store.upsert_index(
        RunListItem(
            run=run_id,
            seed=base.seed,
            status="queued",
            kpis=None,
            notebook=_queued_note(base.run, checked.accepted),
            createdAt=store.now_iso(),
        )
    )
    background.add_task(
        run_queued,
        execute_run,
        checked.configs,
        base.seed,
        parent_run=base.run,
        applied_changes=[contract.dump(s) for s in checked.accepted],
        run_id=run_id,
    )
    return run_id


@router.post("/api/apply", response_model=ApplyResponse)
def post_apply(request: ApplyRequest, background: BackgroundTasks) -> JSONResponse:
    """Queue one run with the selected suggestions applied, same seed and cache rules as the
    analyst. A run-cache hit answers with the cached run instead of simulating again."""
    if request.scope == "store" and not request.storeIds:
        raise HTTPException(422, "scope 'store' needs a non-empty storeIds list")
    base, selected = _selection(request)
    checked = _rule_checked(base, selected)
    if not checked.accepted:
        raise HTTPException(
            409,
            {
                "message": "every selected suggestion was rejected by the hard rules",
                "rejections": jsonable_encoder(checked.rejections),
            },
        )
    cached = cache.run_lookup(cache.run_key(checked.configs, base.seed))
    if cached is not None:
        return common.contract_json(ApplyResponse(queuedRun=cached))
    return common.contract_json(ApplyResponse(queuedRun=_queue_run(base, checked, background)))


@router.get("/api/analyst", response_model=AnalystStatus)
def get_analyst() -> JSONResponse:
    """The analyst checkpoint (runs/analyst_state.json); "stopped" before it has ever run."""
    state = store.load_analyst_state()
    if state is None:
        status = AnalystStatus(
            state="stopped", startedAt=None, iterations=0, bestRun=None, stoppedReason=None
        )
    else:
        status = AnalystStatus(
            state=state.state,
            startedAt=state.startedAt,
            iterations=state.iterations,
            bestRun=state.bestRun,
            stoppedReason=state.stoppedReason,
        )
    return common.contract_json(status)


@router.get("/api/notebook", response_model=list[NotebookEntry])
def get_notebook() -> JSONResponse:
    """The analyst's lab notebook, one line per run."""
    return common.contract_json(store.load_notebook())
