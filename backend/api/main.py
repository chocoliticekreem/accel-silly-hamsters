"""FastAPI app serving the data contract (docs/FRONTEND_PROMPT.md) from the JSON files on disk.

    uvicorn backend.api.main:app --reload

Shapes come from backend/contract.py; additive differences are listed in
backend/CONTRACT_CHANGES.md. Until the pipeline and the sim have run, the API serves the
hand-made sample run in runs/0 (and its map), so the frontend can switch off mock data early.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from backend import settings, store
from backend.api import common, footfall
from backend.api.routers import agents, city, insights, reports, runs, stores, training
from backend.contract import Model, Optional

# Any localhost port: Vite moves to the next free port when 5173 is taken.
LOCAL_ORIGIN_REGEX = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"

app = FastAPI(
    title="Smart City Sim API",
    version=settings.SIM_VERSION,
    summary="Shoreditch sim runs, store-owner reports and the analyst, as JSON.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_origin_regex=LOCAL_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)
for module in (city, runs, training, reports, insights, stores, agents):
    app.include_router(module.router)


@app.exception_handler(ValidationError)
async def data_file_invalid(request: Request, exc: ValidationError) -> JSONResponse:
    """A file another module wrote (index, analyst state, notebook) no longer matches its schema:
    name the schema instead of answering a bare 500."""
    detail = f"{exc.title} data does not match its schema: {common.validation_summary(exc)}"
    return JSONResponse(status_code=500, content={"detail": detail})


class HealthStatus(Model):
    ok: bool = True
    simVersion: str
    mapSource: common.MapSource  # "sample" until data/processed/map.json exists
    realRuns: int  # runs in runs/index.json other than the sample run
    # Real people one sim agent stands for (footfall.people_per_agent); omitted until the
    # pipeline has built demand.json and the map.
    peoplePerAgent: float | None = Optional()


@app.get("/api/health", response_model=HealthStatus, tags=["meta"])
def get_health() -> JSONResponse:
    """Liveness plus which map is served, how many real runs exist and the sim's people scale."""
    real_runs = sum(1 for r in store.load_index() if r.run != common.SAMPLE_RUN)
    return common.contract_json(
        HealthStatus(
            simVersion=settings.SIM_VERSION,
            mapSource=common.map_source(),
            realRuns=real_runs,
            peoplePerAgent=footfall.people_per_agent(),
        )
    )
