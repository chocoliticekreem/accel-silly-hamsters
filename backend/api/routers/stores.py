"""The owner's store page (docs/STORE_PAGE.md): GET /api/stores/{storeId}/overview and
POST /api/stores/{storeId}/optimize (a training session scoped to one shop).

Store-scoped (data firewall): the overview carries only this shop's numbers (backend/overview.py).
"""

from __future__ import annotations

import logging
import threading

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse

from backend import contract, overview, settings, store
from backend.agents import training
from backend.api import common
from backend.contract import AnalystStatus, OptimizeRequest, StoreOverview
from backend.schemas import AnalystState

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
    """A live trainer holds the lock: running, however old its checkpoint. Without one, a
    "running" checkpoint counts only while young (a session about to take the lock); one from a
    clock running fast (timestamp in the future) is a ghost."""
    if state is None or state.state != "running":
        return False
    if training.lock_held():
        return True
    age = training.checkpoint_age_seconds(state)
    if age is None:
        return True
    return -training.CLOCK_SKEW_SECONDS <= age < STALE_SESSION_SECONDS


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
