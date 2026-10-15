"""GET /api/runs and the per-run files: stores, days, suggestions, summary, footfall, owner and
street events."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from backend import store
from backend.api import common, footfall
from backend.contract import (
    DAYS,
    DayData,
    OwnerEvent,
    RunFootfall,
    RunListItem,
    StoreRunResult,
    StreetEvent,
    Suggestion,
)
from backend.schemas import RunSummary

router = APIRouter(tags=["runs"])


def list_runs() -> list[RunListItem]:
    """Real runs once any exist (store.real_runs), else the sample run from runs/0/run.json."""
    items = store.real_runs()
    if items:
        return items
    sample = store.run_dir(common.SAMPLE_RUN) / "run.json"
    return [common.read_file(sample, RunListItem)] if sample.is_file() else []


@router.get("/api/runs", response_model=list[RunListItem])
def get_runs() -> JSONResponse:
    """Every run in runs/index.json (queued and running ones included), oldest first."""
    return common.contract_json(list_runs())


@router.get("/api/runs/{run}/stores", response_model=dict[str, StoreRunResult])
def get_run_stores(run: int) -> JSONResponse:
    """Per store: its config in this run (open, close, lighting) and its results."""
    return common.contract_json(common.read_run_file(run, "stores.json", dict[str, StoreRunResult]))


@router.get("/api/runs/{run}/days/{day}", response_model=DayData)
def get_run_day(run: int, day: int) -> FileResponse:
    """The day file as written by the sim (already contract JSON), streamed without re-parsing:
    day files are the bulk of a run (up to ~2.5 MB each)."""
    common.run_path(run)
    if not 1 <= day <= DAYS:
        raise HTTPException(404, f"day {day} not found: days are 1-{DAYS}")
    return FileResponse(common.run_file(run, f"days/{day}.json"), media_type="application/json")


@router.get("/api/runs/{run}/suggestions", response_model=list[Suggestion])
def get_run_suggestions(run: int) -> JSONResponse:
    """The store agents' proposals after this run ([] until they have run)."""
    return common.contract_json(common.read_run_file(run, "suggestions.json", list[Suggestion]))


@router.get("/api/runs/{run}/summary", response_model=RunSummary)
def get_run_summary(run: int) -> JSONResponse:
    """City view for one run (area totals only: no store ids, see BUILD_NOTES misuse cases)."""
    return common.contract_json(common.read_run_file(run, "summary.json", RunSummary))


@router.get("/api/runs/{run}/footfall", response_model=RunFootfall)
def get_run_footfall(run: int) -> JSONResponse:
    """Sim agents on the street by day and clock hour, for the background crowd (area totals: no
    store or agent ids). Built from the day files on first request, then cached in the run."""
    return common.contract_json(footfall.run_footfall(run))


@router.get("/api/runs/{run}/owner-events", response_model=list[OwnerEvent])
def get_run_owner_events(run: int) -> JSONResponse:
    """What each shop's owner changed day by day inside this run, oldest first (area view)."""
    return common.contract_json(common.read_run_file(run, "owner_events.json", list[OwnerEvent]))


@router.get("/api/runs/{run}/street-events", response_model=list[StreetEvent])
def get_run_street_events(run: int) -> JSONResponse:
    """Roadworks, heavy traffic, club nights and events the owners reacted to, oldest first."""
    return common.contract_json(common.read_run_file(run, "street_events.json", list[StreetEvent]))
