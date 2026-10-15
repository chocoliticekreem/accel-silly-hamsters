"""Internal shapes: processed pipeline data (data/processed/*.json) and run files.

These are the seams between pipeline -> sim -> agents -> api. The frontend contract lives in
backend/contract.py; map.json is contract.MapData (served as-is by GET /api/map).
Every processed file carries `sources` (citations) and `fallback` (True when hand-written
defaults were used because a source was unreachable or needed a key we don't have).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend import settings
from backend.contract import Kpis, LightingLevel, MapData, Source, StoreType

Hourly = list[float]  # always 24 values, index = clock hour


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProcessedFile(Model):
    sources: list[Source] = Field(default_factory=list)
    fallback: bool = False
    notes: list[str] = Field(default_factory=list)


# --- personas.json --------------------------------------------------------------------------


class Persona(Model):
    id: str  # kebab-case, e.g. "night-owl"; appears as DayAgent.persona
    label: str
    share: float  # share of all arrivals, sums to 1 across personas
    returningProb: float  # probability that an agent of this persona is a regular (returning)
    activeHours: Hourly = Field(min_length=24, max_length=24)  # relative arrival weight by hour
    weekendMultiplier: float = 1.0  # arrival weight multiplier on Sat/Sun
    storePrefs: dict[StoreType, float]  # preference weight per store type, 0..1
    lightingSensitivity: float  # 0..1, how much a lit facade at night attracts them
    stopsPerTrip: tuple[float, float]  # min/max store visits per trip
    dwellMinutes: dict[StoreType, tuple[int, int]]  # min/max dwell per store type
    entryKinds: dict[Literal["street", "station"], float]  # where they arrive from
    evidence: list[Source] = Field(default_factory=list)  # anonymous citations only


class PersonasFile(ProcessedFile):
    personas: list[Persona]


# --- demand.json ----------------------------------------------------------------------------


class EntryDemand(Model):
    weekday: Hourly = Field(min_length=24, max_length=24)  # arrivals per hour
    weekend: Hourly = Field(min_length=24, max_length=24)


class ClubNight(Model):
    clubId: str  # a MapStore.id with type "club"
    days: list[str]  # weekday names from timeutil.WEEKDAYS, e.g. ["thu", "fri", "sat"]
    open: str
    close: str
    capacity: int  # people inside at peak; drives spill-out at close


class DemandFile(ProcessedFile):
    entryPoints: dict[str, EntryDemand]  # keyed by contract.EntryPoint.id
    returningPoolSize: int  # size of the fixed pool of regulars across all 14 days
    returningShare: float  # share of daily arrivals that come from the returning pool
    clubNights: list[ClubNight]


# --- energy.json ----------------------------------------------------------------------------


class EnergyFile(ProcessedFile):
    kwhPerM2PerOpenHour: dict[StoreType, float]  # baseline while open
    standbyKwhPerM2PerHour: dict[StoreType, float]  # fridges, alarms, etc. while closed
    lightingKw: dict[LightingLevel, float]  # facade + window lighting load by level
    carbonGPerKwh: Hourly = Field(min_length=24, max_length=24)  # typical London profile
    priceGbpPerKwh: Hourly = Field(min_length=24, max_length=24)


# --- calibration.json -----------------------------------------------------------------------


class CalibrationVenue(Model):
    name: str
    storeId: str | None  # matching MapStore.id, if the venue is in the map
    type: StoreType
    weekday: Hourly = Field(min_length=24, max_length=24)  # busyness 0..100 by hour
    weekend: Hourly = Field(min_length=24, max_length=24)
    measured: bool  # False when the shape is a labelled placeholder, not real Popular Times
    source: Source | None = None


class CalibrationFile(ProcessedFile):
    venues: list[CalibrationVenue]


# --- run files (runs/{run}/...) -------------------------------------------------------------


class StoreConfig(Model):
    open: str
    close: str
    lighting: list[LightingLevel] = Field(min_length=24, max_length=24)


class RunConfig(Model):
    """runs/{run}/config.json: everything needed to reproduce a run."""

    run: int
    seed: int
    simVersion: str
    stores: dict[str, StoreConfig]  # every MapStore.id, clubs included (clubs never change)
    parentRun: int | None = None
    appliedChanges: list[dict] = Field(default_factory=list)  # contract.Suggestion dicts
    configHash: str


class CostSummary(Model):
    calls: int = 0
    inputTokens: int = 0
    outputTokens: int = 0
    cacheReadTokens: int = 0
    cacheWriteTokens: int = 0
    costGbp: float = 0.0
    savedByCachingGbp: float = 0.0
    costPerStoreWeekGbp: float = 0.0
    byAgent: dict[str, float] = Field(default_factory=dict)  # GBP per agent name


class CacheStats(Model):
    hits: dict[str, int] = Field(default_factory=dict)  # per cache layer
    misses: dict[str, int] = Field(default_factory=dict)


class DailyKpis(Model):
    """One sim day of a run, area totals over non-club stores (the in-run learning curve)."""

    day: int  # 1..14
    visits: int  # visits starting that day (a trip past midnight of day 14 counts on day 14)
    kwh: float
    visitsPerKwh: float
    profitGbp: float  # margin on the visits minus that day's energy bill (backend/economics.py)
    ownerActions: int  # owner events dated that day


class RunSummary(Model):
    """runs/{run}/summary.json."""

    run: int
    seed: int
    kpis: Kpis
    objective: str
    objectiveValue: float
    peakKw: float
    peakHour: int
    co2Kg: float
    energyCostGbp: float
    demandByHourKw: Hourly = Field(min_length=24, max_length=24)  # city curve, avg over 14 days
    footfallByHour: Hourly = Field(min_length=24, max_length=24)  # people in the area
    agents: dict[str, int]  # {"returning": n, "oneOff": n, "total": n}
    durationSec: float
    cost: CostSummary = Field(default_factory=CostSummary)
    cache: CacheStats = Field(default_factory=CacheStats)
    # Per sim day, 14 entries; every new run has it, runs from before it was added do not.
    daily: list[DailyKpis] | None = Field(default=None, exclude_if=lambda v: v is None)


class NotebookEntry(Model):
    run: int
    line: str  # <= 12 words
    objectiveValue: float | None = None
    at: str
    objective: str | None = None  # what objectiveValue measures; None in entries from before


# --- runs/training_config.json --------------------------------------------------------------

TrainingObjective = Literal["visitsPerKwh", "netValueGbp", "visits", "storeProfitGbp"]
AnalystBackendName = Literal["auto", "heuristic", "messages", "managed"]
StoreAgentsMode = Literal["auto", "heuristic", "batch"]
StopReason = Literal["threshold", "max_runs", "budget", "error", "stopped"]

# Bounds of TrainingConfig's numeric fields as (min, max), both inclusive, None = unbounded.
# GET /api/training serves this table as `options`, so the UI offers what validation accepts.
TRAINING_RANGES: dict[str, tuple[float, float | None]] = {
    "threshold": (0.0, 1.0),
    "patience": (1, None),
    "maxRuns": (2, 50),  # the baseline counts as a run
    "maxStoresPerIteration": (1, 24),
    "maxChangesPerStore": (1, 2),  # the hard rule caps a store at 2 changes a week
    "seed": (0, None),
    "sessionBudgetUsd": (0.01, None),  # the max is settings.SPEND_CAP_USD, checked below
}


def _ranged(name: str, default: Callable[[], float]) -> Any:
    low, high = TRAINING_RANGES[name]
    return Field(default_factory=default, ge=low, le=high)


class Levers(Model):
    """The owner's two levers. A training session only ever changes the enabled ones."""

    hours: bool = True
    lighting: bool = True

    @model_validator(mode="after")
    def _at_least_one(self) -> Levers:
        if not (self.hours or self.lighting):
            raise ValueError("enable at least one lever: hours or lighting")
        return self

    def allows(self, field: str) -> bool:
        """True when a change to `field` ("open", "close" or "lighting") uses an enabled lever."""
        return self.lighting if field == "lighting" else self.hours


class TrainingConfig(Model):
    """How a training session runs: runs/training_config.json, or what a CLI/API caller passes.

    Every default comes from settings, so a missing file (or field) means "as in settings".
    storeIds None = every non-club store takes part; the others stay frozen at their config.
    objective storeProfitGbp makes it a one-shop session (training.py): exactly one store takes
    part and its proposals are ranked by expected GBP a week, never by an LLM analyst.
    """

    model_config = ConfigDict(extra="forbid", validate_default=True)

    # cast: validate_default checks the settings value against the Literal.
    objective: TrainingObjective = Field(
        default_factory=lambda: cast(TrainingObjective, settings.OBJECTIVE)
    )
    threshold: float = _ranged("threshold", lambda: settings.THRESHOLD)
    patience: int = _ranged("patience", lambda: settings.PATIENCE)
    maxRuns: int = _ranged("maxRuns", lambda: settings.MAX_RUNS)
    maxStoresPerIteration: int = _ranged(
        "maxStoresPerIteration", lambda: settings.MAX_STORES_PER_ITERATION
    )
    maxChangesPerStore: int = _ranged(
        "maxChangesPerStore", lambda: settings.MAX_CHANGES_PER_STORE_PER_WEEK
    )
    seed: int = _ranged("seed", lambda: settings.DEFAULT_SEED)
    levers: Levers = Field(default_factory=Levers)
    storeIds: list[str] | None = Field(default=None, min_length=1)
    sessionBudgetUsd: float = _ranged("sessionBudgetUsd", lambda: settings.SESSION_BUDGET_USD)
    analystBackend: AnalystBackendName = Field(
        default_factory=lambda: cast(AnalystBackendName, settings.ANALYST_BACKEND)
    )
    storeAgents: StoreAgentsMode = "auto"

    @field_validator("storeIds")
    @classmethod
    def _unique_store_ids(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("store ids must be unique")
        return value

    @field_validator("sessionBudgetUsd")
    @classmethod
    def _within_spend_cap(cls, value: float) -> float:
        if value > settings.SPEND_CAP_USD:
            raise ValueError(f"must not exceed the global spend cap of ${settings.SPEND_CAP_USD:g}")
        return value

    @model_validator(mode="after")
    def _one_shop_objective(self) -> TrainingConfig:
        if self.objective != "storeProfitGbp":
            return self
        if self.storeIds is None or len(self.storeIds) != 1:
            raise ValueError("objective storeProfitGbp needs exactly one store in storeIds")
        if self.analystBackend not in ("auto", "heuristic"):
            raise ValueError(
                "objective storeProfitGbp is chosen without an LLM analyst: "
                "analystBackend must be auto or heuristic"
            )
        return self

    @property
    def scope_store(self) -> str | None:
        """The store of a one-shop session (objective storeProfitGbp), else None."""
        return self.storeIds[0] if self.objective == "storeProfitGbp" and self.storeIds else None

    def takes_part(self, store_id: str) -> bool:
        """True when `store_id` may change in this session (it is not frozen)."""
        return self.storeIds is None or store_id in self.storeIds

    def check_store_ids(self, map_data: MapData) -> None:
        """Raise ValueError when storeIds names a store that is not on the map, or a club."""
        if self.storeIds is None:
            return
        types = {s.id: s.type for s in map_data.stores}
        problems = []
        unknown = [sid for sid in self.storeIds if sid not in types]
        if unknown:
            problems.append(f"unknown store ids: {', '.join(unknown)}")
        clubs = [sid for sid in self.storeIds if types.get(sid) == "club"]
        if clubs:
            problems.append(f"clubs never change: {', '.join(clubs)}")
        if problems:
            raise ValueError("storeIds: " + "; ".join(problems))


class AnalystState(Model):
    """runs/analyst_state.json: checkpoint written after every step; resume reads it."""

    sessionId: str
    state: Literal["running", "stopped"]
    startedAt: str
    updatedAt: str
    backend: str
    fresh: bool
    seed: int
    baselineRun: int | None = None
    currentRun: int | None = None
    bestRun: int | None = None
    bestObjective: float | None = None
    iterations: int = 0
    runsThisSession: list[int] = Field(default_factory=list)
    lowGainStreak: int = 0
    step: str = "start"  # last completed step, for resume
    stoppedReason: StopReason | None = None
    spentGbp: float = 0.0
    error: str | None = None
    # A one-shop session (POST /api/stores/{id}/optimize; TrainingConfig.scope_store): only this
    # store's settings change and the objective is its profit change per week vs the baseline.
    # None = the area session.
    scopeStore: str | None = None
    config: TrainingConfig | None = None  # the config the session ran with (None before configs)
    owner: str | None = None  # "host:pid" of the process that started or resumed it last
    wrappedUp: bool = False  # the last stop's proposals and reports are written; nothing ran since


class Decision(Model):
    """runs/decisions.json entries: the owner's approve/reject, read by store agents next week."""

    storeId: str
    run: int | None
    suggestionIndex: int
    suggestion: dict | None
    decision: Literal["approve", "reject"]
    reason: str | None = None
    at: str


class StoreStats(Model):
    """runs/{run}/store_stats.json[storeId]: per-store detail the agents read (not served raw).

    All hourly arrays are averages per day over the 14 days, index = clock hour.
    """

    visitsByHourWeekday: Hourly = Field(min_length=24, max_length=24)
    visitsByHourWeekend: Hourly = Field(min_length=24, max_length=24)
    footfallNearbyByHour: Hourly = Field(min_length=24, max_length=24)  # passers-by within ~60 m
    foundClosedByHour: Hourly = Field(min_length=24, max_length=24)  # would have entered, was shut
    kwhByHour: Hourly = Field(min_length=24, max_length=24)
    uniqueVisitors: int
    repeatVisitors: int  # visited on 2+ different days
    visitsByPersona: dict[str, int]
    energyCostGbp: float
    co2Kg: float
