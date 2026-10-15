"""GET /api/map: the city the frontend renders. GET /api/calibration: the credibility chart data."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from backend import settings, store
from backend.api import common
from backend.contract import MapData
from backend.schemas import CalibrationFile

router = APIRouter(tags=["city"])


@router.get("/api/map", response_model=MapData)
def get_map() -> JSONResponse:
    """data/processed/map.json; the run-0 sample map while the pipeline has not built one."""
    return common.contract_json(common.load_map())


@router.get("/api/calibration", response_model=CalibrationFile)
def get_calibration() -> JSONResponse:
    """data/processed/calibration.json as built: anchor venues with Popular Times busyness.

    Venues with measured=false are placeholder shapes; they are served with that flag so the
    chart can label them and never present them as proof. 404 until the pipeline has built the
    file (the frontend then hides its calibration tab).
    """
    if not (settings.PROCESSED_DIR / "calibration.json").exists():
        raise HTTPException(404, "data/processed/calibration.json missing: run the pipeline")
    return common.contract_json(store.load_calibration())
