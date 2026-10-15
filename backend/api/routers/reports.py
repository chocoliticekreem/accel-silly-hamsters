"""The owner's product screen: weekly report, approve/reject decisions, report PDFs."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from backend import contract, store
from backend.api import common
from backend.contract import DecisionRequest, OkResponse, StoreReport, Suggestion
from backend.schemas import Decision

router = APIRouter(tags=["reports"])


def report_run(run: int | None) -> int:
    """The run a report or decision refers to: `run` when given, else the analyst's best run,
    else the latest finished real run, else the sample run while no real runs exist."""
    if run is not None:
        return run
    state = store.load_analyst_state()
    if state is not None and state.bestRun is not None:
        return state.bestRun
    items = store.load_index()
    done = [r.run for r in items if r.run != common.SAMPLE_RUN and r.status == "done"]
    if done:
        return max(done)
    if all(r.run == common.SAMPLE_RUN for r in items):
        return common.SAMPLE_RUN
    raise HTTPException(404, "no finished run yet; pass ?run=")


def store_changes(run: int, store_id: str) -> list[Suggestion]:
    """What a decision's suggestionIndex points into: the store's report changes for that run,
    or that run's suggestions for the store when no report was written."""
    directory = common.run_path(run)
    report = directory / "reports" / f"{store_id}.json"
    if report.is_file():
        return common.read_file(report, StoreReport).changes
    suggestions = directory / "suggestions.json"
    if not suggestions.is_file():
        return []
    return [s for s in common.read_file(suggestions, list[Suggestion]) if s.storeId == store_id]


@router.get("/api/stores/{store_id}/report", response_model=StoreReport)
def get_store_report(store_id: str, run: int | None = None) -> JSONResponse:
    """runs/{run}/reports/{storeId}.json, written by the report agent."""
    return common.contract_json(
        common.read_run_file(report_run(run), f"reports/{store_id}.json", StoreReport)
    )


@router.post("/api/decision", response_model=OkResponse)
def post_decision(request: DecisionRequest, run: int | None = None) -> JSONResponse:
    """Record the owner's approve/reject; store agents read decisions.json next week.

    Optional ?run= pins the report the owner saw (default: same run as GET .../report).
    """
    if request.storeId not in {s.id for s in common.load_map().stores}:
        raise HTTPException(404, f"unknown store {request.storeId}")
    run_id = report_run(run)
    changes = store_changes(run_id, request.storeId)
    if not changes:
        raise HTTPException(
            404, f"run {run_id} has no report or suggestions for store {request.storeId}"
        )
    if not 0 <= request.suggestionIndex < len(changes):
        raise HTTPException(
            422,
            f"suggestionIndex {request.suggestionIndex} out of range: run {run_id} has "
            f"{len(changes)} change(s) for store {request.storeId}",
        )
    store.append_decision(
        Decision(
            storeId=request.storeId,
            run=run_id,
            suggestionIndex=request.suggestionIndex,
            suggestion=contract.dump(changes[request.suggestionIndex]),
            decision=request.decision,
            reason=request.reason,
            at=store.now_iso(),
        )
    )
    return common.contract_json(OkResponse())


@router.get("/files/reports/{run}/{store_id}.pdf", response_class=FileResponse)
def get_report_pdf(run: int, store_id: str) -> FileResponse:
    """The report PDF that StoreReport.pdfUrl points at."""
    return FileResponse(
        common.run_file(run, f"reports/{store_id}.pdf"), media_type="application/pdf"
    )
