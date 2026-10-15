"""The data contract shared with the frontend (docs/FRONTEND_PROMPT.md, "Data contract").

Every JSON shape the API serves is defined here and nowhere else. Change a shape only
together with the contract doc, and list the change at the top of backend/CONTRACT_CHANGES.md.

Coordinates: metres, origin at Shoreditch High St station, x = east, z = north.
Time: t = sim minutes since Day 1 00:00. 14 days = 20160.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

LightingLevel = Literal["off", "low", "high"]
BuildingKind = Literal["store", "club", "office", "residential", "station"]
StoreType = Literal["cafe", "restaurant", "takeaway", "bar", "shop", "offlicence", "club"]
EntryKind = Literal["street", "station"]
Confidence = Literal["low", "medium", "high"]

DAYS = 14
MINUTES_PER_DAY = 1440
SIM_MINUTES = DAYS * MINUTES_PER_DAY


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


def Optional(default=None):  # noqa: N802 - reads like a type marker at the call site
    """An optional field that is omitted from the JSON when unset, instead of sent as null."""
    return Field(default=default, exclude_if=lambda v: v is None)


# --- GET /api/map ---------------------------------------------------------------------------


class Bounds(Model):
    minX: float
    maxX: float
    minZ: float
    maxZ: float


class Street(Model):
    id: str
    name: str
    points: list[tuple[float, float]]
    width: float


class Building(Model):
    id: str
    kind: BuildingKind
    storeId: str | None = Optional()
    x: float
    z: float
    w: float
    d: float
    h: float


class HoursWindow(Model):
    open: str
    close: str


class MapStore(Model):
    id: str
    name: str
    type: StoreType
    buildingId: str
    # Additive fields (see CONTRACT_CHANGES.md); the frontend may ignore them.
    licensedHours: HoursWindow | None = Optional()
    defaultHours: HoursWindow | None = Optional()
    floorArea: float | None = Optional()
    osmId: str | None = Optional()


class EntryPoint(Model):
    id: str
    kind: EntryKind
    name: str | None = Optional()
    x: float
    z: float


class MapData(Model):
    bounds: Bounds
    streets: list[Street]
    buildings: list[Building]
    stores: list[MapStore]
    entryPoints: list[EntryPoint]
    # Additive: citations for where the map came from.
    sources: list[Source] = Field(default_factory=list)


# --- GET /api/runs --------------------------------------------------------------------------


class Kpis(Model):
    visits: int
    kwh: float
    visitsPerKwh: float
    returnRate: float


class RunListItem(Model):
    run: int
    seed: int
    status: Literal["queued", "running", "done", "failed"]
    kpis: Kpis | None
    notebook: str
    createdAt: str
    costPerStoreWeekGbp: float = 0.0


# --- GET /api/runs/{run}/stores -------------------------------------------------------------


class StoreKpis(Model):
    visits: int
    kwh: float
    returnRate: float


class StoreRunResult(Model):
    open: str
    close: str
    lighting: list[LightingLevel] = Field(min_length=24, max_length=24)
    kpis: StoreKpis
    visitsByHour: list[float] = Field(min_length=24, max_length=24)


# --- GET /api/runs/{run}/days/{day} ---------------------------------------------------------


class Visit(Model):
    storeId: str
    tIn: int
    tOut: int


class DayAgent(Model):
    id: str
    persona: str
    returning: bool
    path: list[tuple[int, float, float]]
    visits: list[Visit]


class DayData(Model):
    day: int
    agents: list[DayAgent]


# --- GET /api/runs/{run}/suggestions --------------------------------------------------------


class ExpectedDelta(Model):
    visits: float
    kwh: float


class Suggestion(Model):
    storeId: str
    field: Literal["open", "close", "lighting"]
    hours: list[int] | None = Optional()
    # "HH:MM" for open/close, a LightingLevel for lighting.
    from_: str = Field(alias="from")
    to: str
    expectedDelta: ExpectedDelta
    # Additive: honest confidence and a one-line reason (see CONTRACT_CHANGES.md).
    confidence: Confidence | None = Optional()
    reason: str | None = Optional()

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# --- POST /api/apply ------------------------------------------------------------------------


class ApplyRequest(Model):
    run: int
    scope: Literal["store", "all"]
    storeIds: list[str] | None = Optional()


class ApplyResponse(Model):
    queuedRun: int


# --- GET /api/analyst -----------------------------------------------------------------------


class AnalystStatus(Model):
    state: Literal["running", "stopped"]
    startedAt: str | None
    iterations: int
    bestRun: int | None
    stoppedReason: Literal["threshold", "max_runs", "budget", "error", "stopped"] | None
    # Additive: the session's baseline run, compare mode's left side (see CONTRACT_CHANGES.md).
    baselineRun: int | None = Optional()


# --- GET /api/stores/{storeId}/report?run={run} ---------------------------------------------


class Impact(Model):
    visits: float
    kwh: float
    gbpPerWeek: float


class Source(Model):
    label: str
    url: str
    fetchedAt: str | None = Optional()


class StoreReport(Model):
    storeId: str
    changes: list[Suggestion]
    impact: Impact
    confidence: Confidence
    evidence: list[Source]
    pdfUrl: str | None
    # Additive: the honesty note shown with every report.
    note: str = "Simulated, not guaranteed."


# --- POST /api/decision ---------------------------------------------------------------------


class DecisionRequest(Model):
    storeId: str
    suggestionIndex: int
    decision: Literal["approve", "reject"]
    reason: str | None = Optional()


class OkResponse(Model):
    ok: bool = True


MapData.model_rebuild()


def dump(model: BaseModel) -> dict:
    """Serialize with contract field names (e.g. Suggestion.from_ -> "from").

    Required-but-nullable fields (AnalystStatus.stoppedReason, RunListItem.kpis) stay as null,
    as in the contract samples; optional extras declared with Optional() are omitted when unset.
    """
    return model.model_dump(mode="json", by_alias=True)
