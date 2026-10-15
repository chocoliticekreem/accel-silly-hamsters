"""POST /api/apply (manual apply from the UI), GET /api/analyst, GET /api/notebook and the
training controls: GET /api/training, PUT /api/training/config, POST /api/training/start|stop.

POST /api/training/start runs the session in a background thread of this API process, one at a
time; POST /api/training/stop asks it to stop at its next step boundary. With settings.READ_ONLY
(the hosted demo replays pre-computed runs) the training writes answer 403.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from types import ModuleType
from typing import Any, get_args

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from backend import cache, contract, settings, store
from backend.agents import rundata
from backend.agents.objective import city_value, direction
from backend.api import apply, common
from backend.contract import (
    AnalystStatus,
    ApplyRequest,
    ApplyResponse,
    Kpis,
    MapData,
    Model,
    RunListItem,
    Suggestion,
)
from backend.schemas import (
    TRAINING_RANGES,
    AnalystBackendName,
    NotebookEntry,
    RunConfig,
    StoreAgentsMode,
    TrainingConfig,
    TrainingObjective,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["training"])

ExecuteRun = Callable[..., int]
MANUAL_APPLY_AGENT = "manual_apply"  # the `agent` on rule rejections logged by POST /api/apply

READ_ONLY_DETAIL = (
    "read-only deployment: this hosted demo replays pre-computed runs, so training cannot be "
    "started, stopped or reconfigured here; run the API locally to train"
)
_lock = threading.Lock()  # one start or config write at a time
_thread: threading.Thread | None = None  # the session started by POST /api/training/start


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


def _run_value(item: RunListItem, objective: str) -> float:
    if objective in Kpis.model_fields:
        assert item.kpis is not None
        return city_value(item.kpis, objective)
    return rundata.objective_value(item.run, objective)


def _best_real_run(real: list[RunListItem]) -> int | None:
    """The finished real run with the best settings.OBJECTIVE (earliest on a tie)."""
    objective = settings.OBJECTIVE
    scored: list[tuple[float, int]] = []
    for item in real:
        if item.status != "done" or item.kpis is None:
            continue
        try:
            scored.append((direction(objective) * _run_value(item, objective), -item.run))
        except FileNotFoundError:
            continue
    return -max(scored)[1] if scored else None


def analyst_status() -> AnalystStatus:
    """The analyst checkpoint (runs/analyst_state.json).

    Without a checkpoint, the real runs on disk stand in: startedAt = the first real run's
    createdAt, bestRun = the best real run by settings.OBJECTIVE, baselineRun = the first real
    run. baselineRun is never missing while real runs exist; "stopped" with nulls before any.
    """
    state = store.load_analyst_state()
    real = sorted(
        (r for r in store.load_index() if r.run != common.SAMPLE_RUN), key=lambda r: r.run
    )
    first = real[0] if real else None
    first_run = first.run if first else None
    if state is None:
        return AnalystStatus(
            state="stopped",
            startedAt=first.createdAt if first else None,
            iterations=0,
            bestRun=_best_real_run(real),
            stoppedReason=None,
            baselineRun=first_run,
        )
    baseline = state.baselineRun if state.baselineRun is not None else first_run
    return AnalystStatus(
        state=state.state,
        startedAt=state.startedAt,
        iterations=state.iterations,
        bestRun=state.bestRun,
        stoppedReason=state.stoppedReason,
        baselineRun=baseline,
    )


@router.get("/api/analyst", response_model=AnalystStatus)
def get_analyst() -> JSONResponse:
    """The analyst status: the checkpoint, or the real runs while no session exists."""
    return common.contract_json(analyst_status())


@router.get("/api/notebook", response_model=list[NotebookEntry])
def get_notebook() -> JSONResponse:
    """The analyst's lab notebook, one line per run."""
    return common.contract_json(store.load_notebook())


# --- training controls ----------------------------------------------------------------------


class TrainingOverview(Model):
    config: TrainingConfig  # the saved config: what the next session runs with
    options: dict[str, Any]  # allowed values / ranges per config field
    status: AnalystStatus
    running: bool  # a session started by this API process is running now


class StartRequest(Model):
    config: TrainingConfig | None = None  # saved as the current config before the session starts
    fresh: bool = False  # new session: no cached LLM responses or runs from earlier sessions


def training_options(map_data: MapData | None) -> dict[str, Any]:
    """What each TrainingConfig field accepts (schemas.TRAINING_RANGES, the Literal choices)."""
    ranges: dict[str, Any] = {
        name: {"min": low} | ({"max": high} if high is not None else {})
        for name, (low, high) in TRAINING_RANGES.items()
    }
    ranges["sessionBudgetUsd"]["max"] = settings.SPEND_CAP_USD
    stores = (
        [{"id": s.id, "name": s.name, "type": s.type} for s in rundata.advised_stores(map_data)]
        if map_data is not None
        else []
    )
    return {
        "objective": {"values": list(get_args(TrainingObjective))},
        **ranges,
        "levers": {"values": ["hours", "lighting"], "minEnabled": 1},
        "storeIds": {"stores": stores, "null": "every non-club store takes part"},
        "analystBackend": {"values": list(get_args(AnalystBackendName))},
        "storeAgents": {"values": list(get_args(StoreAgentsMode))},
    }


def _running() -> bool:
    return _thread is not None and _thread.is_alive()


def _check_writable() -> None:
    if settings.READ_ONLY:
        raise HTTPException(403, READ_ONLY_DETAIL)


def _check_store_ids(config: TrainingConfig, map_data: MapData) -> None:
    """422 when storeIds names an unknown store or a club."""
    try:
        config.check_store_ids(map_data)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


def _training_module() -> ModuleType:
    """backend.agents.training, imported per request like the sim (see _load_execute_run)."""
    try:
        from backend.agents import training
    except ImportError as e:
        raise HTTPException(503, f"training unavailable: {e}") from e
    return training


def _train_in_background(training: ModuleType, session: Any) -> None:
    try:
        training.run(session)
    except Exception:  # the session checkpointed itself as stopped/error; keep the API up
        logger.exception("training session %s failed", session.state.sessionId)


@router.get("/api/training", response_model=TrainingOverview)
def get_training() -> JSONResponse:
    """The saved training config, the options per field, the analyst status, and whether a
    session started by this API process is running."""
    map_data = common.load_map() if common.map_source() != "missing" else None
    overview = TrainingOverview(
        config=store.load_training_config(),
        options=training_options(map_data),
        status=analyst_status(),
        running=_running(),
    )
    return common.contract_json(overview)


@router.put(
    "/api/training/config",
    response_model=TrainingConfig,
    dependencies=[Depends(_check_writable)],  # before body validation: read-only is 403, not 422
)
def put_training_config(config: TrainingConfig) -> JSONResponse:
    """Save the config the next session runs with (runs/training_config.json). 409 while a
    session runs: it keeps the config it started with."""
    with _lock:
        if _running():
            raise HTTPException(409, "training is running; stop it first (POST /api/training/stop)")
        if config.storeIds is not None:
            _check_store_ids(config, _processed_map())
        store.save_training_config(config)
    return common.contract_json(config)


@router.post(
    "/api/training/start",
    response_model=AnalystStatus,
    dependencies=[Depends(_check_writable)],
)
def post_training_start(request: StartRequest | None = None) -> JSONResponse:
    """Start a session (or resume the last one: same seed and objective, not fresh) in the
    background. One at a time: 409 while one runs here or in another process (e.g. the CLI).
    Answers with the status, already "running"."""
    global _thread
    request = request or StartRequest()
    training = _training_module()
    with _lock:
        if _running():
            raise HTTPException(409, "training is already running")
        config = request.config or store.load_training_config()
        _check_store_ids(config, _processed_map())  # training needs the pipeline's map: 503
        try:
            session = training.begin(config, fresh=request.fresh)
        except training.SessionBusy as e:
            raise HTTPException(409, str(e)) from e
        if request.config is not None:
            store.save_training_config(request.config)
        _thread = threading.Thread(
            target=_train_in_background, args=(training, session), name="training", daemon=True
        )
        _thread.start()
    return common.contract_json(analyst_status())


@router.post(
    "/api/training/stop",
    response_model=AnalystStatus,
    dependencies=[Depends(_check_writable)],
)
def post_training_stop() -> JSONResponse:
    """Ask the running session to stop at its next step boundary; it then checkpoints with
    stoppedReason "stopped". Answers at once, while the step in progress finishes."""
    _training_module().request_stop()
    return common.contract_json(analyst_status())
