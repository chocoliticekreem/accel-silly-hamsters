"""The owner's store page (docs/STORE_PAGE.md): GET /api/stores/{storeId}/overview and
POST /api/stores/{storeId}/optimize (a training session scoped to one shop).

Store-scoped (data firewall): the overview carries only this shop's numbers (backend/overview.py).
"""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from backend import cache, contract, overview, settings, store
from backend.agents import rules, training
from backend.api import common
from backend.api.routers.training import RuleChecked, _queue_run
from backend.contract import (
    AnalystStatus,
    ApplyResponse,
    ExperimentRequest,
    OptimizeRequest,
    StoreOverview,
    Suggestion,
)
from backend.schemas import AnalystState, RunConfig, StoreConfig

logger = logging.getLogger(__name__)
router = APIRouter(tags=["stores"])

# A "running" checkpoint not updated for this long is a session that died with the server.
STALE_SESSION_SECONDS = 30 * 60
_start_lock = threading.Lock()


@router.get("/api/stores/{store_id}/overview", response_model=StoreOverview)
def get_store_overview(store_id: str, run: int | None = None) -> JSONResponse:
    """The store page for `run` (default: this shop's most profitable run vs its baseline, else
    the latest finished run). 404 for clubs, unknown stores, unknown or unfinished runs, and
    before any run has finished."""
    try:
        return common.contract_json(overview.store_overview(common.load_map(), store_id, run))
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'\"")) from e
    except overview.NoRuns as e:
        raise HTTPException(404, f"{e}: run the sim or POST /api/stores/{store_id}/optimize") from e


def _is_running(state: AnalystState | None) -> bool:
    if state is None or state.state != "running":
        return False
    try:
        updated = datetime.strptime(state.updatedAt, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return True
    return (datetime.now(UTC) - updated).total_seconds() < STALE_SESSION_SECONDS


def _status(state: AnalystState) -> AnalystStatus:
    return AnalystStatus(
        state=state.state,
        startedAt=state.startedAt,
        iterations=state.iterations,
        bestRun=state.bestRun,
        stoppedReason=state.stoppedReason,
    )


def run_store_session(store_id: str, max_runs: int) -> None:
    """Background task: the one-shop session. train() checkpoints an error itself; log it here
    so a failed session never takes the server down."""
    try:
        training.train(max_runs=max_runs, scope_store=store_id)
    except Exception:
        logger.exception("store session for %s failed", store_id)


@router.post("/api/stores/{store_id}/optimize", response_model=AnalystStatus, status_code=202)
def post_store_optimize(
    store_id: str, background: BackgroundTasks, request: OptimizeRequest | None = None
) -> JSONResponse:
    """Start a training session scoped to this shop: only its settings change and the objective
    is its profit change per week. Answers 202 with the new session's analyst status; poll
    GET /api/analyst or the overview. 403 on the read-only demo, 404 for clubs and unknown
    stores, 409 while any session runs, 503 without processed data."""
    if settings.READ_ONLY:
        raise HTTPException(403, "read-only demo: optimising is switched off")
    try:
        map_data = store.load_map()
    except FileNotFoundError as e:
        raise HTTPException(503, "data/processed/map.json is missing; run the pipeline") from e
    try:
        overview.find_store(map_data, store_id)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'\"")) from e
    max_runs = (request or OptimizeRequest()).maxRuns
    with _start_lock:
        if _is_running(store.load_analyst_state()):
            raise HTTPException(409, "a training session is already running")
        state = training.start_store_session(store_id)
    background.add_task(run_store_session, store_id, max_runs)
    return JSONResponse(contract.dump(_status(state)), status_code=202)


OWNER_EXPERIMENT = "The owner's own experiment"


def _experiment_changes(
    store_id: str, current: StoreConfig, req: ExperimentRequest
) -> list[Suggestion]:
    zero = {"visits": 0, "kwh": 0}
    out: list[Suggestion] = []

    def change(field: str, frm: str, to: str, hours: list[int] | None = None) -> Suggestion:
        raw: dict[str, object] = {"storeId": store_id, "field": field, "from": frm, "to": to}
        raw |= {"expectedDelta": zero, "reason": OWNER_EXPERIMENT}
        if hours is not None:
            raw["hours"] = hours
        return Suggestion.model_validate(raw)

    for field, to in (("open", req.open), ("close", req.close)):
        frm = getattr(current, field)
        if to is not None and to != frm:
            out.append(change(field, frm, to))
    if req.lighting is not None:
        groups: dict[tuple[str, str], list[int]] = {}
        for hour, (old, new) in enumerate(
            zip(list[str](current.lighting), list[str](req.lighting), strict=True)
        ):
            if old != new:
                groups.setdefault((old, new), []).append(hour)
        for (old, new), hours in groups.items():
            out.append(change("lighting", old, new, hours))
    return out


def _latest_run() -> int:
    done = [r.run for r in store.load_index() if r.status == "done" and r.run != common.SAMPLE_RUN]
    if not done:
        raise HTTPException(409, "no finished run yet: start the agents first")
    return max(done)


@router.post("/api/stores/{store_id}/experiment", response_model=ApplyResponse, status_code=202)
def post_store_experiment(
    store_id: str, request: ExperimentRequest, background: BackgroundTasks
) -> JSONResponse:
    """The owner's own experiment: this shop's hours and lighting set by hand, simulated as one run
    on top of a base run. Every change passes the same safety rules as the agents' (licensed hours,
    day length, 30-minute steps) but not their two-changes-a-week cap: the owner decides. 403 on
    the read-only demo, 404 for clubs and unknown shops, 409 when a session is running, nothing
    changes, or the rules reject a change."""
    if settings.READ_ONLY:
        raise HTTPException(403, "read-only demo: experiments are switched off")
    try:
        map_data = store.load_map()
    except FileNotFoundError as e:
        raise HTTPException(503, "data/processed/map.json is missing; run the pipeline") from e
    try:
        overview.find_store(map_data, store_id)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'\"")) from e
    if _is_running(store.load_analyst_state()):
        raise HTTPException(409, "the agents are running: stop them first")
    base_run = request.baseRun if request.baseRun is not None else _latest_run()
    base = common.read_run_file(base_run, "config.json", RunConfig)
    changes = _experiment_changes(store_id, base.stores[store_id], request)
    if not changes:
        raise HTTPException(409, f"these are already the settings in run {base_run}")
    # one change at a time, so the owner is held to the safety rules but not the agents' cap
    configs = base.stores
    accepted: list[Suggestion] = []
    for change in changes:
        result = rules.check_changes(configs, [change], map_data, check_tried=False)
        if result.rejections:
            raise HTTPException(
                409,
                {
                    "message": "a change breaks the shop's rules",
                    "rejections": jsonable_encoder(result.rejections),
                },
            )
        configs, accepted = result.configs, [*accepted, *result.accepted]
    cached = cache.run_lookup(cache.run_key(configs, base.seed))
    if cached is not None:
        return JSONResponse(contract.dump(ApplyResponse(queuedRun=cached)), status_code=202)
    queued = _queue_run(base, RuleChecked(configs, accepted, []), background)
    return JSONResponse(contract.dump(ApplyResponse(queuedRun=queued)), status_code=202)
