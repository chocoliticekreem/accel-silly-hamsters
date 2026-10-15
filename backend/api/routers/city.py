"""GET /api/map: the city the frontend renders."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend.api import common
from backend.contract import MapData

router = APIRouter(tags=["city"])


@router.get("/api/map", response_model=MapData)
def get_map() -> JSONResponse:
    """data/processed/map.json; the run-0 sample map while the pipeline has not built one."""
    return common.contract_json(common.load_map())
