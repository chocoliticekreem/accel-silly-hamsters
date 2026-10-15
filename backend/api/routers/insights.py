"""GET /api/stores/{storeId}/insights: one shop's analytics and ranked, actionable insights.

Store-scoped (data firewall): the payload carries only this store's numbers plus anonymised area
benchmarks, never another shop's id, name or figures (backend/insights.py enforces it).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from backend import insights
from backend.api import common
from backend.api.routers.reports import report_run
from backend.contract import StoreInsights

router = APIRouter(tags=["insights"])


@router.get("/api/stores/{store_id}/insights", response_model=StoreInsights)
def get_store_insights(store_id: str, run: int | None = None) -> JSONResponse:
    """Insights for `run` (default: the analyst's best run, else the latest finished run).

    404 for an unknown store or run, a club (fixed anchor, no insights) or a run without store
    stats (the hand-made sample run); 503 when the processed map or energy data is missing.
    """
    try:
        return common.contract_json(insights.store_insights(report_run(run), store_id))
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'\"")) from e
    except FileNotFoundError as e:
        raise HTTPException(503, f"processed data missing ({e}): run the pipeline") from e
