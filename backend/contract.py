"""The data contract shared with the frontend (docs/FRONTEND_PROMPT.md, "Data contract").

Every JSON shape the API serves is defined here and nowhere else. Change a shape only
together with the contract doc, and list the change at the top of backend/CONTRACT_CHANGES.md.

Coordinates: metres, origin at Shoreditch High St station, x = east, z = north.
Time: t = sim minutes since Day 1 00:00. 14 days = 20160.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LightingLevel = Literal["off", "low", "high"]
BuildingKind = Literal["store", "club", "office", "residential", "station"]
StoreType = Literal["cafe", "restaurant", "takeaway", "bar", "shop", "offlicence", "club"]
EntryKind = Literal["street", "station"]
LandmarkKind = Literal["venue", "hotel", "station", "market", "landmark"]
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


class Landmark(Model):
    """A named real place the frontend labels or renders specially (additive)."""

    id: str
    name: str
    kind: LandmarkKind
    buildingId: str | None = None  # the map building that is this place; null = no building
    x: float
    z: float
    h: float  # height in metres to hang a label at (the building's height; 0 = street level)
    note: str | None = Optional()


class MapData(Model):
    bounds: Bounds
    streets: list[Street]
    buildings: list[Building]
    stores: list[MapStore]
    entryPoints: list[EntryPoint]
    # Additive: citations for where the map came from.
    sources: list[Source] = Field(default_factory=list)
    # Additive: named real places (venue, hotel, stations, market); omitted when unset.
    landmarks: list[Landmark] | None = Optional()


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
    # Additive: hours open over the 14 days; staff are paid for these (backend/economics.py).
    openHours: float = 0.0


class ScheduleEntry(Model):
    fromDay: int = Field(ge=1)
    week: list[HoursWindow | None] = Field(min_length=7, max_length=7)  # Mon..Sun, null = closed


class StoreRunResult(Model):
    open: str
    close: str
    lighting: list[LightingLevel] = Field(min_length=24, max_length=24)
    kpis: StoreKpis
    visitsByHour: list[float] = Field(min_length=24, max_length=24)
    # Additive (docs/OWNER_ACTIONS.md): the weekly hours as the owner changed them during the
    # run, oldest first (absent = open/close every day), and the day it closed for good.
    schedule: list[ScheduleEntry] | None = Optional()
    closedFromDay: int | None = Optional()

    @model_validator(mode="after")
    def _fill_open_hours(self) -> StoreRunResult:
        """Runs saved before openHours existed: rebuild it from the hours and schedule."""
        if "openHours" not in self.kpis.model_fields_set:
            self.kpis.openHours = _scheduled_open_hours(self)
        return self


def _window_hours(window: HoursWindow | None) -> float:
    if window is None:
        return 0.0
    o, c = (int(t[:2]) * 60 + int(t[3:]) for t in (window.open, window.close))
    return ((c - o) % MINUTES_PER_DAY or MINUTES_PER_DAY) / 60


def _scheduled_open_hours(result: StoreRunResult) -> float:
    last_day = (result.closedFromDay or DAYS + 1) - 1
    entries = sorted(result.schedule or [], key=lambda e: e.fromDay)
    daily = HoursWindow(open=result.open, close=result.close)
    total = 0.0
    for day in range(1, min(last_day, DAYS) + 1):
        week = [e.week for e in entries if e.fromDay <= day]
        total += _window_hours(week[-1][(day - 1) % 7] if week else daily)
    return round(total, 2)


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


# --- GET /api/runs/{run}/footfall -----------------------------------------------------------
# Additive: the street crowd behind the frontend's background walkers (backend/api/footfall.py).
# Area totals only: no store or agent ids.

HourValues = Annotated[list[float], Field(min_length=24, max_length=24)]


class RunFootfall(Model):
    run: int
    # [day - 1][hour]: mean sim agents on the street (between their first and last keyframe, not
    # inside a store) over that clock hour of that day. x peoplePerAgent (GET /api/health) = people.
    onStreetByDayHour: list[HourValues] = Field(min_length=DAYS, max_length=DAYS)


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


# --- GET /api/stores/{storeId}/insights?run={run} -------------------------------------------
# Additive: the per-store insights panel, built by backend/insights.py. Store-scoped: the
# store's own run data plus anonymous peer aggregates over >= 3 stores, never another store's
# id, name or per-store numbers. kpis, funnel and energy are 14-day totals like StoreKpis;
# hourly and weekdayVsWeekend are averages per day by clock hour; insight metrics and
# impact.gbpPerWeek are per week.

InsightKind = Literal[
    "missed_demand", "wasted_energy", "dead_hours", "lighting_opportunity", "benchmark"
]
Severity = Literal["high", "medium", "low"]


class InsightKpis(Model):
    visits: int
    kwh: float
    visitsPerKwh: float
    returnRate: float
    energyCostGbp: float
    co2Kg: float


class InsightFunnel(Model):
    passersBy: int  # sum(footfallNearbyByHour) x days
    visits: int
    uniqueVisitors: int
    returningVisitors: int  # visited on 2+ different days
    captureRate: float  # visits / passersBy, 0 when nobody passed
    returnRate: float


class InsightHourly(Model):
    visits: list[float] = Field(min_length=24, max_length=24)
    footfall: list[float] = Field(min_length=24, max_length=24)
    missedDemand: list[float] = Field(min_length=24, max_length=24)  # found the store shut
    kwh: list[float] = Field(min_length=24, max_length=24)
    lighting: list[LightingLevel] = Field(min_length=24, max_length=24)
    openFraction: list[float] = Field(min_length=24, max_length=24)  # 0..1 of the hour open


class WeekdayVsWeekend(Model):
    weekday: list[float] = Field(min_length=24, max_length=24)
    weekend: list[float] = Field(min_length=24, max_length=24)


class PersonaVisits(Model):
    persona: str  # anonymous archetype id, e.g. "night-owl"
    visits: int
    share: float


class InsightEnergy(Model):
    kwh: float
    kwhWhileClosed: float
    kwhLightingWhileClosed: float
    kwhLowTrafficOpen: float  # open hours quieter than insights.DEAD_VISITS_PER_OPEN_HOUR
    costGbp: float
    co2Kg: float
    visitsPerKwh: float


class InsightBenchmarks(Model):
    peers: int  # anonymous stores in the comparison group, never fewer than 3
    peerType: StoreType | Literal["all"]  # "all" when fewer than 3 same-type peers exist
    areaMedianVisitsPerKwh: float
    visitsPerKwhPercentile: float  # 0..1: share of peers below this store, ties count half
    areaMedianCaptureRate: float
    captureRatePercentile: float


class InsightMetric(Model):
    label: str
    value: float
    unit: str


class Insight(Model):
    id: str  # stable per store and kind, e.g. "missed-demand-close"
    kind: InsightKind
    severity: Severity
    title: str = Field(max_length=60)
    detail: str = Field(max_length=140)
    metric: InsightMetric
    # Same shape as the report's impact: visits/kwh are fractions of the store's current 14-day
    # values; gbpPerWeek = economics.gbp_per_week (margin minus energy and wages, + = better off).
    impact: Impact
    confidence: Confidence
    suggestion: Suggestion | None
    evidence: list[Source]


class StoreInsights(Model):
    storeId: str
    run: int
    name: str
    type: StoreType
    days: int
    kpis: InsightKpis
    funnel: InsightFunnel
    hourly: InsightHourly
    weekdayVsWeekend: WeekdayVsWeekend
    personas: list[PersonaVisits]
    energy: InsightEnergy
    benchmarks: InsightBenchmarks | None  # null when fewer than 3 anonymous peers exist at all
    insights: list[Insight]  # ranked by impact.gbpPerWeek, then severity; at most 5
    note: str = "Simulated, not guaranteed."


# --- GET /api/agents/session, GET /api/agents/log -------------------------------------------
# Additive: the frontend's Agents view (backend/api/routers/agents.py). Area-level, read-only.


class AgentSession(Model):
    """The analyst checkpoint (runs/analyst_state.json) as served to the Agents view."""

    sessionId: str
    state: Literal["running", "stopped"]
    startedAt: str
    updatedAt: str
    backend: str  # heuristic | messages | managed
    fresh: bool
    seed: int
    baselineRun: int | None = None
    currentRun: int | None = None
    bestRun: int | None = None
    bestObjective: float | None = None
    iterations: int = 0
    runsThisSession: list[int] = Field(default_factory=list)
    lowGainStreak: int = 0
    step: str = "start"
    stoppedReason: Literal["threshold", "max_runs", "budget", "error", "stopped"] | None = None
    spentGbp: float = 0.0
    error: str | None = None


class AgentEvent(Model):
    """One step of the agents' story: hand-off, proposals, hypothesis, experiment or result."""

    at: str
    agent: str  # analyst | store_owner | store_agents | training | ...
    type: str
    run: int | None = None
    # scalar fields only (no prompts, responses or store id lists); lists become <name>Count
    data: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


# --- GET /api/runs/{run}/owner-events, GET /api/runs/{run}/street-events ---------------------
# Additive (docs/OWNER_ACTIONS.md): the self-learning city. Owners adapt day by day inside a run
# (backend/sim/owners.py); street events are what they react to (backend/sim/street.py).

OwnerAction = Literal[
    "hours_changed",
    "day_closed",
    "day_reopened",
    "shut_early",
    "open_late",
    "temporary_closure",
    "lighting_changed",
    "closed_permanently",
]
TriggerKind = Literal[
    "missed_demand",
    "empty_hours",
    "dead_day",
    "roadworks",
    "heavy_traffic",
    "club_night",
    "event",
    "weather",
    "losses",
    "lights_waste",
]
StreetEventKind = Literal["roadworks", "heavy_traffic", "club_night", "event", "weather"]


class OwnerTrigger(Model):
    kind: TriggerKind
    value: float
    label: str


class OwnerEvent(Model):
    day: int  # the day the action applies (today-only actions: that day)
    t: int  # sim minute it happens: decision time today, else 00:00 of `day`
    storeId: str
    action: OwnerAction
    # "HH:MM" for hours, a weekday ("mon") for days, a LightingLevel for lighting.
    from_: str | None = Field(default=None, alias="from", exclude_if=lambda v: v is None)
    to: str | None = Optional()
    reason: str = Field(max_length=100)  # one plain sentence in the owner's voice
    trigger: OwnerTrigger

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class StreetEvent(Model):
    day: int
    fromT: int
    toT: int
    kind: StreetEventKind
    streetId: str  # a Street.id from the map
    label: str
    severity: float = Field(ge=0, le=1)


# --- GET /api/stores/{storeId}/overview, POST /api/stores/{storeId}/optimize -----------------
# Additive (docs/STORE_PAGE.md): the owner's store page in one call, built by backend/overview.py.
# Store-scoped like insights: this shop's numbers only, never another shop's id, name or figures.

OverviewStatus = Literal["not_started", "improving", "best_found"]
Certainty = Literal["likely", "worth testing", "uncertain"]
AdviceStatus = Literal["new", "applied", "tested_better", "tested_worse"]


class OverviewNumber(Model):
    value: float
    change: float  # fraction vs the baseline run (0.33 = +33%)


class OverviewNumbers(Model):
    customersPerWeek: OverviewNumber
    energyCostPerWeekGbp: OverviewNumber
    kwhPerWeek: OverviewNumber
    # Margin on extra customers minus extra energy and wages vs the baseline (economics.py).
    profitChangePerWeekGbp: float


class OverviewAdvice(Model):
    text: str  # one plain sentence with the number an owner cares about
    gbpPerWeek: float
    certainty: Certainty  # high -> likely, medium -> worth testing, low -> uncertain
    status: AdviceStatus
    suggestion: Suggestion | None


class OverviewHistoryItem(Model):
    run: int
    label: str  # "Your current settings", "Open till 03:30", "Lights 18–00 off"
    customersPerWeek: int
    kwhPerWeek: float
    profitChangePerWeekGbp: float
    changes: list[str]  # "Close 22:30 → 03:30", "Lights 18–00 low → off"
    best: bool  # this shop's most profitable run vs its baseline (not the area's best run)


class StoreOverview(Model):
    storeId: str
    name: str
    type: StoreType
    run: int
    baselineRun: int
    bestRun: int | None  # this shop's best run; null while only the baseline exists
    status: OverviewStatus
    headline: str
    numbers: OverviewNumbers
    advice: list[OverviewAdvice] = Field(max_length=3)
    history: list[OverviewHistoryItem]
    note: str = "Simulated, not guaranteed."
    # Additive: how many times this shop's owner adapted during `run` (owner_events.json).
    ownerChanges: int | None = Optional()


class OptimizeRequest(Model):
    # Runs in the session, the baseline included (it usually comes back from the run cache).
    maxRuns: int = Field(default=6, ge=2, le=40)
