"""Per-store insights: "PostHog for stores, but for energy".

Served as GET /api/stores/{storeId}/insights?run={run} (contract.StoreInsights). The owner opens
their store and sees its own funnel (passers-by -> visits -> returning), hourly shape, energy
breakdown, an anonymous benchmark and up to MAX_INSIGHTS ranked insights. Each insight carries an
impact estimate, honest confidence, replay evidence and at most one contract Suggestion.

Data firewall (docs/BUILD_NOTES.md misuse cases: a shop spying on a competitor, competitors
coordinating hours). build_store_insights sees one store's own run data plus Peers, which carry a
store type and run numbers but no id and no name. Peer numbers leave only as a median and a
percentile over at least K_ANONYMITY stores: same-type peers when there are enough, else every
other non-club store (peerType "all"), else no benchmark at all. Every suggestion names this
store only and is derived from its own data.

Generators run in this order so their suggestions never contradict each other:
  1. lighting_opportunity  open night hours with passers-by but lights off/low -> high
  2. missed_demand         extend close, then open, in 30-min steps over closed time where people
                           found the store shut: the best-paying extension inside the licence
  3. dead_hours            trim quiet edge hours; never an edge that step 2 extends, never
                           through an hour that step 1 lights up (light it first, judge it after)
  4. wasted_energy         lights on in fully closed hours -> off, except hours step 2 would open
  5. benchmark             visits per kWh and capture rate percentiles vs anonymous peers
Every hours suggestion passes the hard rules alone and together with the store's other hours
suggestion: 30-min grid, inside licensedHours (default caps by type), open >= 60 min and closed
>= 30 min. Energy deltas use the sim's model (docs/BUILD_NOTES.md "Energy and KPIs"): an hours
change turns standby into open load at floorArea x (open - standby) kWh per hour; lighting kWh is
charged whether open or closed, so an hours change leaves it as it is.

Severity: the headline effect as a share of the store's own 14-day totals (visits for missed
demand and lighting, kWh for dead hours and wasted energy): high >= SEVERITY_HIGH, medium >=
SEVERITY_MEDIUM, else low. A benchmark is medium in the bottom BENCHMARK_MEDIUM_BELOW, else low.

Confidence: how many simulated people an estimate rests on, per week. Found-shut people for
missed demand, passers-by in the hours concerned for dead hours and lighting: high >=
CONFIDENCE_HIGH_PEOPLE_PER_WEEK, medium >= CONFIDENCE_MEDIUM_PEOPLE_PER_WEEK, else low. Lighting
is capped at medium because its uplift is an assumption: no simulated person was seen reacting.
Wasted energy is high: energy-model arithmetic with no visitor estimate. Benchmarks: by peer
count (BENCHMARK_HIGH_PEERS, BENCHMARK_MEDIUM_PEERS).
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import median
from typing import Any, Literal, NamedTuple

from backend import economics, timeutil
from backend.agents import rules
from backend.contract import (
    DAYS,
    MINUTES_PER_DAY,
    Confidence,
    Impact,
    Insight,
    InsightBenchmarks,
    InsightEnergy,
    InsightFunnel,
    InsightHourly,
    InsightKpis,
    InsightMetric,
    LightingLevel,
    MapStore,
    PersonaVisits,
    Severity,
    Source,
    StoreInsights,
    StoreKpis,
    StoreRunResult,
    StoreType,
    Suggestion,
    WeekdayVsWeekend,
)
from backend.schemas import EnergyFile, RunConfig, StoreConfig, StoreStats
from backend.store import load_energy, load_map, read_json, run_dir
from backend.timeutil import to_hhmm

MAX_INSIGHTS = 5

# Never publish an aggregate over fewer stores: the median of one or two stores is their number.
K_ANONYMITY = 3

# The hard rules for the hours lever (same values as backend/agents/rules.py).
STEP_MINUTES = 30
MIN_OPEN_MINUTES = 60
MIN_CLOSED_MINUTES = 30
# Licence caps when map.json has no licensedHours (same table as backend/agents/rules.py).
DEFAULT_LICENSED_HOURS: dict[StoreType, tuple[str, str]] = {
    "cafe": ("06:00", "23:00"),
    "restaurant": ("07:00", "00:30"),
    "takeaway": ("06:00", "04:00"),
    "bar": ("10:00", "02:00"),
    "shop": ("06:00", "23:00"),
    "offlicence": ("06:00", "23:00"),
}

# Lighting attracts only while open at night (docs/BUILD_NOTES.md "Time, hours, lighting").
NIGHT_HOURS = frozenset([*range(17, 24), *range(0, 7)])
# Day 5 of the run is a Friday, a club night, so late demand is visible in the replay.
REPLAY_DAY = 5

# Two people a day (28 over the run) who wanted in is the smallest pattern worth changing hours
# for; a smaller count is mostly sampling noise (about +-19% at 28 events).
MISSED_MIN_PER_DAY = 2.0
# Share of found-shut people who become visits once the store is open. The sim records an agent's
# top choice that was visibly shut; some were only passing or would pick the next store anyway.
MISSED_CAPTURE = 0.6
# Change the day by a service, not a shift: at most 5 hours a side per week (a lunch service, or
# past the 03:00 club close for a late takeaway). Citizens walk up to any shop they want unless
# they see it shut, so all-day "found shut" counts would otherwise send an evening takeaway to
# open at 06:00. The next run measures again.
MISSED_MAX_EXTENSION_MINUTES = 300

# Fewer than one visit every two hours on an average day: the hour is open mostly for its energy
# bill. MIN_GBP_PER_WEEK still decides whether trimming it pays.
DEAD_VISITS_PER_OPEN_HOUR = 0.5
# Trim the edges, not the business: at most 2 hours a side per week, so a quiet store is told to
# shorten its day, not to shut. The next run measures again.
DEAD_MAX_TRIM_MINUTES = 120

# A lit facade pays only where people walk past; under 5 passers-by an hour nobody sees it.
LIGHTING_MIN_FOOTFALL_PER_HOUR = 5.0
# Visit uplift in an open night hour when the lights go to high. The sim scales a store's pull at
# night by 1 + 0.6 x lightingSensitivity for high, 1 for low and 1 - 0.6 x s for off; night
# personas average s ~0.5, so high pulls ~1.3x low and ~1.85x off. Competition and the "move on"
# option absorb part of any extra pull, so we assume half of it becomes visits.
LIGHTING_UPLIFT_TO_HIGH: dict[LightingLevel, float] = {"off": 0.4, "low": 0.15}

# Below GBP 1 a week an owner changes nothing, and the item would crowd out the ones that matter.
MIN_GBP_PER_WEEK = 1.0

# A 10% move in the store's own visits or kWh shows on the till or the bill; under 3% it is hard
# to see week to week.
SEVERITY_HIGH = 0.10
SEVERITY_MEDIUM = 0.03
# The bottom quarter of comparable stores is worth a look even without a concrete change.
BENCHMARK_MEDIUM_BELOW = 0.25

# People per week behind an estimate: 100 a week is 200 over the run (Poisson error ~7%), 25 a
# week is 50 (~14%); below that the error passes 15%.
CONFIDENCE_HIGH_PEOPLE_PER_WEEK = 100.0
CONFIDENCE_MEDIUM_PEOPLE_PER_WEEK = 25.0
# A percentile over n stores moves 1/n when one store changes: 10 peers = 10 points, 5 = 20.
BENCHMARK_HIGH_PEERS = 10
BENCHMARK_MEDIUM_PEERS = 5

TITLE_MAX = 60
DETAIL_MAX = 140
MAX_REASON_WORDS = 15

LEVELS: tuple[LightingLevel, ...] = ("off", "low", "high")
SEVERITY_RANK: dict[str, int] = {"high": 0, "medium": 1, "low": 2}
FULL_HOUR = [60] * 24
PLURAL: dict[str, str] = {
    "cafe": "cafes",
    "restaurant": "restaurants",
    "takeaway": "takeaways",
    "bar": "bars",
    "shop": "shops",
    "offlicence": "off-licences",
    "all": "stores",
}


class Peer(NamedTuple):
    """Another non-club store in the same run, anonymous by construction: no id and no name."""

    type: StoreType
    result: StoreRunResult
    stats: StoreStats


@dataclass(frozen=True)
class _Store:
    """The store's own run data, derived once for the generators."""

    id: str
    type: StoreType
    run: int
    lighting: list[LightingLevel]
    open_m: int  # minute of the day
    close_u: int  # close, unwrapped so that open_m < close_u <= open_m + 1440
    licence: tuple[str, str]
    visits: int  # 14-day total
    kwh: float  # 14-day total
    by_hour: list[float]  # visits per clock hour, average day
    footfall: list[float]
    missed: list[float]
    open_min: list[int]  # open minutes in each clock hour
    closed_min: list[int]
    area: float
    open_rate: float  # kWh per m2 per open hour
    standby_rate: float  # kWh per m2 per closed hour
    light_kw: dict[LightingLevel, float]
    price: float
    visits_per_kwh: float
    capture_rate: float

    @property
    def open_hour_kwh(self) -> float:
        """Extra kWh for one more open hour: standby load becomes open load."""
        return self.area * (self.open_rate - self.standby_rate)


@dataclass(frozen=True)
class _HoursPlan:
    """A move of one edge of the opening window, with its estimated effect."""

    field: Literal["open", "close"]
    new_m: int  # the new open or close, minute of the day
    start: int  # the minutes added (extension) or removed (trim): [start, end), unwrapped
    end: int
    people: float  # per day: found-shut people covered, or passers-by in the trimmed time
    visits_14d: float
    kwh_14d: float
    gbp: float


# --- entry points ---------------------------------------------------------------------------


def store_insights(run: int, store_id: str) -> StoreInsights:
    """Insights for one store in a finished run, from runs/{run}/ and data/processed/.

    Raises KeyError for a missing run file or an unknown store; clubs are fixed anchors and get
    no insights, so they raise KeyError too. FileNotFoundError when map.json or energy.json is
    missing from data/processed/.
    """
    results = {
        sid: StoreRunResult.model_validate(v) for sid, v in _run_file(run, "stores.json").items()
    }
    stats = {
        sid: StoreStats.model_validate(v) for sid, v in _run_file(run, "store_stats.json").items()
    }
    config = RunConfig.model_validate(_run_file(run, "config.json"))
    map_stores = load_map().stores
    own = next((s for s in map_stores if s.id == store_id), None)
    if own is None or not (store_id in results and store_id in stats and store_id in config.stores):
        raise KeyError(f"store {store_id!r} is not in run {run}")
    if own.type == "club":
        raise KeyError(f"store {store_id!r} is a club: clubs are fixed anchors, no insights")
    peers = [
        Peer(s.type, results[s.id], stats[s.id])
        for s in map_stores
        if s.id != store_id and s.type != "club" and s.id in results and s.id in stats
    ]
    return build_store_insights(
        own,
        results[store_id],
        stats[store_id],
        config.stores[store_id],
        peers=peers,
        energy=load_energy(),
        run=run,
    )


def build_store_insights(
    store: MapStore,
    result: StoreRunResult,
    stats: StoreStats,
    config: StoreConfig,
    *,
    peers: list[Peer],
    energy: EnergyFile,
    run: int,
) -> StoreInsights:
    """The insights payload for one non-club store. Pure and deterministic.

    `config` is the store's config in this run; `peers` are the other non-club stores of the
    same run, anonymous (any club among them is ignored).
    """
    if store.type == "club":
        raise ValueError(f"{store.id} is a club: clubs are fixed anchors and get no insights")
    s = _store(store, result, stats, config, energy, run)
    benchmarks = _benchmarks(s, peers)
    return StoreInsights(
        storeId=store.id,
        run=run,
        name=store.name,
        type=store.type,
        days=DAYS,
        kpis=InsightKpis(
            visits=result.kpis.visits,
            kwh=result.kpis.kwh,
            visitsPerKwh=round(s.visits_per_kwh, 4),
            returnRate=result.kpis.returnRate,
            energyCostGbp=stats.energyCostGbp,
            co2Kg=stats.co2Kg,
        ),
        funnel=InsightFunnel(
            passersBy=_passers_by(stats),
            visits=result.kpis.visits,
            uniqueVisitors=stats.uniqueVisitors,
            returningVisitors=stats.repeatVisitors,
            captureRate=round(s.capture_rate, 4),
            returnRate=result.kpis.returnRate,
        ),
        hourly=InsightHourly(
            visits=result.visitsByHour,
            footfall=stats.footfallNearbyByHour,
            missedDemand=stats.foundClosedByHour,
            kwh=stats.kwhByHour,
            lighting=config.lighting,
            openFraction=[round(m / 60, 4) for m in s.open_min],
        ),
        weekdayVsWeekend=WeekdayVsWeekend(
            weekday=stats.visitsByHourWeekday, weekend=stats.visitsByHourWeekend
        ),
        personas=_personas(stats),
        energy=_energy(s, result, stats),
        benchmarks=benchmarks,
        insights=_insights(s, benchmarks),
    )


def rank_insights(insights: list[Insight]) -> list[Insight]:
    """Highest GBP per week first, then severity, then id; at most MAX_INSIGHTS."""
    ranked = sorted(insights, key=lambda i: (-i.impact.gbpPerWeek, SEVERITY_RANK[i.severity], i.id))
    return ranked[:MAX_INSIGHTS]


# --- derived data ---------------------------------------------------------------------------


def _run_file(run: int, name: str) -> Any:
    data = read_json(run_dir(run) / name)
    if data is None:
        raise KeyError(f"run {run}: {name} not found")
    return data


def _store(
    store: MapStore,
    result: StoreRunResult,
    stats: StoreStats,
    config: StoreConfig,
    energy: EnergyFile,
    run: int,
) -> _Store:
    open_fraction = timeutil.open_hours_fraction(config.open, config.close)
    open_min = [round(f * 60) for f in open_fraction]
    open_m = timeutil.to_minutes(config.open)
    close_m = timeutil.to_minutes(config.close)
    licence = (
        (store.licensedHours.open, store.licensedHours.close)
        if store.licensedHours is not None
        else DEFAULT_LICENSED_HOURS[store.type]
    )
    area = (
        store.floorArea
        if store.floorArea is not None
        else _area_from_kwh(stats, config, energy, store.type, open_fraction)
    )
    return _Store(
        id=store.id,
        type=store.type,
        run=run,
        lighting=config.lighting,
        open_m=open_m,
        close_u=close_m if close_m > open_m else close_m + MINUTES_PER_DAY,
        licence=licence,
        visits=result.kpis.visits,
        kwh=result.kpis.kwh,
        by_hour=result.visitsByHour,
        footfall=stats.footfallNearbyByHour,
        missed=stats.foundClosedByHour,
        open_min=open_min,
        closed_min=[60 - m for m in open_min],
        area=area,
        open_rate=energy.kwhPerM2PerOpenHour.get(store.type, 0.0),
        standby_rate=energy.standbyKwhPerM2PerHour.get(store.type, 0.0),
        light_kw={level: energy.lightingKw.get(level, 0.0) for level in LEVELS},
        price=economics.price_gbp_per_kwh(energy),
        visits_per_kwh=_visits_per_kwh(result.kpis),
        capture_rate=_capture_rate(result.kpis.visits, stats),
    )


def _area_from_kwh(
    stats: StoreStats,
    config: StoreConfig,
    energy: EnergyFile,
    store_type: StoreType,
    open_fraction: list[float],
) -> float:
    """Floor area backed out of the store's own kWh with the sim's energy model. Only used when
    map.json has no floorArea: the sim then used the building footprint, which is not passed in."""
    open_rate = energy.kwhPerM2PerOpenHour.get(store_type, 0.0)
    standby_rate = energy.standbyKwhPerM2PerHour.get(store_type, 0.0)
    per_m2 = sum(f * open_rate + (1 - f) * standby_rate for f in open_fraction)
    lighting = sum(energy.lightingKw.get(level, 0.0) for level in config.lighting)
    return max(sum(stats.kwhByHour) - lighting, 0.0) / per_m2 if per_m2 > 0 else 0.0


def _passers_by(stats: StoreStats) -> int:
    return round(sum(stats.footfallNearbyByHour) * DAYS)


def _capture_rate(visits: int, stats: StoreStats) -> float:
    passers = _passers_by(stats)
    return visits / passers if passers else 0.0


def _visits_per_kwh(kpis: StoreKpis) -> float:
    return kpis.visits / kpis.kwh if kpis.kwh > 0 else 0.0


def _fraction(delta: float, base: float) -> float:
    """delta as a fraction of base, 0 when base is 0 (same rule as the agents' objective)."""
    return delta / base if base > 0 else 0.0


def _per_open_hour(s: _Store, hour: int) -> float:
    """Visits in a clock hour scaled to a fully open hour."""
    return s.by_hour[hour] * 60 / s.open_min[hour]


def _personas(stats: StoreStats) -> list[PersonaVisits]:
    total = sum(stats.visitsByPersona.values())
    ordered = sorted(stats.visitsByPersona.items(), key=lambda kv: (-kv[1], kv[0]))
    return [
        PersonaVisits(persona=p, visits=v, share=round(v / total, 4) if total else 0.0)
        for p, v in ordered
    ]


def _energy(s: _Store, result: StoreRunResult, stats: StoreStats) -> InsightEnergy:
    closed_light = closed = quiet_open = 0.0
    for h in range(24):
        light = s.light_kw[s.lighting[h]]
        closed_light += s.closed_min[h] / 60 * light
        closed += s.closed_min[h] / 60 * (s.area * s.standby_rate + light)
        if s.open_min[h] and _per_open_hour(s, h) < DEAD_VISITS_PER_OPEN_HOUR:
            quiet_open += s.open_min[h] / 60 * (s.area * s.open_rate + light)
    return InsightEnergy(
        kwh=result.kpis.kwh,
        kwhWhileClosed=round(closed * DAYS, 2),
        kwhLightingWhileClosed=round(closed_light * DAYS, 2),
        kwhLowTrafficOpen=round(quiet_open * DAYS, 2),
        costGbp=stats.energyCostGbp,
        co2Kg=stats.co2Kg,
        visitsPerKwh=round(s.visits_per_kwh, 4),
    )


def _benchmarks(s: _Store, peers: list[Peer]) -> InsightBenchmarks | None:
    """Percentiles against anonymous peers, k-anonymous: same type when at least K_ANONYMITY
    such peers exist, else all non-club peers, else None."""
    others = [p for p in peers if p.type != "club"]
    group = [p for p in others if p.type == s.type]
    peer_type: StoreType | Literal["all"] = s.type
    if len(group) < K_ANONYMITY:
        group, peer_type = others, "all"
    if len(group) < K_ANONYMITY:
        return None
    per_kwh = [_visits_per_kwh(p.result.kpis) for p in group]
    capture = [_capture_rate(p.result.kpis.visits, p.stats) for p in group]
    return InsightBenchmarks(
        peers=len(group),
        peerType=peer_type,
        areaMedianVisitsPerKwh=round(median(per_kwh), 4),
        visitsPerKwhPercentile=round(_percentile(s.visits_per_kwh, per_kwh), 4),
        areaMedianCaptureRate=round(median(capture), 4),
        captureRatePercentile=round(_percentile(s.capture_rate, capture), 4),
    )


def _percentile(value: float, values: list[float]) -> float:
    """Share of `values` below `value`, ties counting half."""
    below = sum(v < value for v in values)
    ties = sum(v == value for v in values)
    return (below + 0.5 * ties) / len(values)


# --- generators -----------------------------------------------------------------------------


def _insights(s: _Store, benchmarks: InsightBenchmarks | None) -> list[Insight]:
    lighting = _lighting_opportunity(s)
    lit = {h for i in lighting if i.suggestion for h in i.suggestion.hours or []}
    close_ext = _extension(s, "close", None)
    open_ext = _extension(s, "open", close_ext.new_m if close_ext else None)
    close_trim = None if close_ext else _trim(s, "close", open_ext.new_m if open_ext else None, lit)
    close_move = close_ext or close_trim
    open_trim = (
        None if open_ext else _trim(s, "open", close_move.new_m if close_move else None, lit)
    )
    opening = {
        (m // 60) % 24
        for plan in (close_ext, open_ext)
        if plan
        for m in range(plan.start, plan.end)
    }
    insights = [
        *lighting,
        *(_missed_insight(s, p) for p in (close_ext, open_ext) if p),
        *(_dead_insight(s, p) for p in (close_trim, open_trim) if p),
        *_wasted_energy(s, opening),
    ]
    if benchmarks is not None:
        insights.append(_benchmark_insight(s, benchmarks))
    return rank_insights(insights)


def _lighting_opportunity(s: _Store) -> list[Insight]:
    insights = []
    for level in ("off", "low"):
        hours = [h for h in range(24) if _worth_lighting(s, h, level)]
        if not hours:
            continue
        visits = sum(s.by_hour[h] for h in hours) * LIGHTING_UPLIFT_TO_HIGH[level] * DAYS
        kwh = len(hours) * (s.light_kw["high"] - s.light_kw[level]) * DAYS
        impact = _impact(s, visits, kwh)
        if impact.gbpPerWeek < MIN_GBP_PER_WEEK:
            continue
        people = sum(s.footfall[h] * s.open_min[h] / 60 for h in hours) * 7
        volume = _people_confidence(people)
        confidence: Confidence = "medium" if volume == "high" else volume
        spans = _hour_spans(hours)
        insights.append(
            Insight(
                id=f"lighting-opportunity-{level}",
                kind="lighting_opportunity",
                severity=_severity(impact.visits),
                title=_clip(f"{people:.0f} people a week pass while your lights are {level}"),
                detail=_clip(
                    f"Raising lights to high {spans} could add ~{_count(_weekly(visits))} visits"
                    f" a week for {_weekly(kwh):.1f} kWh more: {_gbp(impact.gbpPerWeek)} a week"
                    " net.",
                    DETAIL_MAX,
                ),
                metric=InsightMetric(
                    label="Passers-by in dim hours / week", value=round(people), unit="people"
                ),
                impact=impact,
                confidence=confidence,
                suggestion=_suggestion(
                    s,
                    "lighting",
                    level,
                    "high",
                    impact=impact,
                    confidence=confidence,
                    reason=f"Busy street at night but lights {level}",
                    hours=hours,
                ),
                evidence=_evidence(s, spans),
            )
        )
    return insights


def _worth_lighting(s: _Store, hour: int, level: LightingLevel) -> bool:
    """An open night hour lit at `level`, with people passing, where high lighting pays."""
    if hour not in NIGHT_HOURS or not s.open_min[hour] or s.lighting[hour] != level:
        return False
    if s.footfall[hour] < LIGHTING_MIN_FOOTFALL_PER_HOUR:
        return False
    visits = s.by_hour[hour] * LIGHTING_UPLIFT_TO_HIGH[level] * DAYS
    kwh = (s.light_kw["high"] - s.light_kw[level]) * DAYS
    return economics.gbp_per_week(s.type, visits, kwh, s.price) > 0


def _extension(
    s: _Store, field: Literal["open", "close"], other_m: int | None
) -> _HoursPlan | None:
    """The best-paying move of `field` outward over closed time, in 30-min steps, covering at
    least MISSED_MIN_PER_DAY people who found the store shut. `other_m` is the other edge as
    another suggestion moves it; the window must pass the rules with and without that move."""
    if s.close_u - s.open_m >= MINUTES_PER_DAY:
        return None
    later = field == "close"
    edge = s.close_u if later else s.open_m
    best: _HoursPlan | None = None
    for target in _steps(edge, later):
        if abs(target - edge) > MISSED_MAX_EXTENSION_MINUTES:
            break
        if not _window_valid(s, field, target, other_m):
            break
        start, end = (edge, target) if later else (target, edge)
        people = _spread(s.missed, s.closed_min, start, end)
        visits = people * DAYS * MISSED_CAPTURE
        kwh = (end - start) / 60 * s.open_hour_kwh * DAYS
        gbp = economics.gbp_per_week(s.type, visits, kwh, s.price)
        if people >= MISSED_MIN_PER_DAY and gbp >= MIN_GBP_PER_WEEK:
            if best is None or gbp > best.gbp:
                best = _HoursPlan(
                    field, target % MINUTES_PER_DAY, start, end, people, visits, kwh, gbp
                )
    return best


def _trim(
    s: _Store, field: Literal["open", "close"], other_m: int | None, protected: set[int]
) -> _HoursPlan | None:
    """The best-paying move of `field` inward through quiet hours, in 30-min steps and at most
    DEAD_MAX_TRIM_MINUTES, stopping at the first busy hour or an hour in `protected`."""
    later = field == "open"
    edge = s.open_m if later else s.close_u
    best: _HoursPlan | None = None
    previous = edge
    for target in _steps(edge, later):
        if abs(target - edge) > DEAD_MAX_TRIM_MINUTES:
            break
        hour = (min(previous, target) // 60) % 24
        if hour in protected or not s.open_min[hour]:
            break
        if _per_open_hour(s, hour) >= DEAD_VISITS_PER_OPEN_HOUR:
            break
        if not _window_valid(s, field, target, other_m):
            break
        start, end = (edge, target) if later else (target, edge)
        visits = -_spread(s.by_hour, s.open_min, start, end) * DAYS
        kwh = -(end - start) / 60 * s.open_hour_kwh * DAYS
        gbp = economics.gbp_per_week(s.type, visits, kwh, s.price)
        if gbp >= MIN_GBP_PER_WEEK and (best is None or gbp > best.gbp):
            passers = _spread(s.footfall, FULL_HOUR, start, end)
            best = _HoursPlan(
                field, target % MINUTES_PER_DAY, start, end, passers, visits, kwh, gbp
            )
        previous = target
    return best


def _wasted_energy(s: _Store, opening: set[int]) -> list[Insight]:
    insights = []
    for level in ("high", "low"):
        hours = [
            h
            for h in range(24)
            if not s.open_min[h] and s.lighting[h] == level and h not in opening
        ]
        if not hours:
            continue
        kwh = -len(hours) * s.light_kw[level] * DAYS
        impact = _impact(s, 0.0, kwh)
        if impact.gbpPerWeek < MIN_GBP_PER_WEEK:
            continue
        spans = _hour_spans(hours)
        insights.append(
            Insight(
                id=f"wasted-energy-{level}",
                kind="wasted_energy",
                severity=_severity(impact.kwh),
                title=_clip(f"Lights {level} while closed: {_weekly(-kwh):.1f} kWh a week"),
                detail=_clip(
                    f"Lights stay {level} {spans} while you are shut. They only draw visits while"
                    f" open; off saves {_gbp(impact.gbpPerWeek)} a week.",
                    DETAIL_MAX,
                ),
                metric=InsightMetric(
                    label="Lit while closed / week", value=round(_weekly(-kwh), 1), unit="kWh"
                ),
                impact=impact,
                confidence="high",
                suggestion=_suggestion(
                    s,
                    "lighting",
                    level,
                    "off",
                    impact=impact,
                    confidence="high",
                    reason="Lights on while shut draw no visits",
                    hours=hours,
                ),
                evidence=_evidence(s, spans),
            )
        )
    return insights


def _missed_insight(s: _Store, plan: _HoursPlan) -> Insight:
    impact = _impact(s, plan.visits_14d, plan.kwh_14d)
    people = plan.people * 7
    current, new = _edge_hhmm(s, plan.field), to_hhmm(plan.new_m)
    side, verb = ("after", "Closing") if plan.field == "close" else ("before", "Opening")
    confidence = _people_confidence(people)
    return Insight(
        id=f"missed-demand-{plan.field}",
        kind="missed_demand",
        severity=_severity(impact.visits),
        title=_clip(f"{people:.0f} people a week find you shut {side} {current}"),
        detail=_clip(
            f"{verb} at {new} instead of {current} could add ~{_count(_weekly(plan.visits_14d))}"
            f" visits a week for {_weekly(plan.kwh_14d):.1f} kWh more:"
            f" {_gbp(impact.gbpPerWeek)} a week net, within your licence.",
            DETAIL_MAX,
        ),
        metric=InsightMetric(label="Missed visits / week", value=round(people), unit="people"),
        impact=impact,
        confidence=confidence,
        suggestion=_suggestion(
            s,
            plan.field,
            current,
            new,
            impact=impact,
            confidence=confidence,
            reason=f"{people:.0f} people a week found you shut {side} {current}",
        ),
        evidence=_evidence(s, f"{to_hhmm(plan.start)}-{to_hhmm(plan.end)}"),
    )


def _dead_insight(s: _Store, plan: _HoursPlan) -> Insight:
    impact = _impact(s, plan.visits_14d, plan.kwh_14d)
    current, new = _edge_hhmm(s, plan.field), to_hhmm(plan.new_m)
    verb = "Closing" if plan.field == "close" else "Opening"
    span = f"{to_hhmm(plan.start)}-{to_hhmm(plan.end)}"
    rate = -plan.visits_14d / DAYS / ((plan.end - plan.start) / 60)
    confidence = _people_confidence(plan.people * 7)
    return Insight(
        id=f"dead-hours-{plan.field}",
        kind="dead_hours",
        severity=_severity(impact.kwh),
        title=_clip(f"Quiet {span}: {rate:.1f} visits an hour"),
        detail=_clip(
            f"{verb} at {new} instead of {current} saves {_weekly(-plan.kwh_14d):.1f} kWh a week"
            f" for ~{_count(_weekly(-plan.visits_14d))} fewer visits:"
            f" {_gbp(impact.gbpPerWeek)} a week net.",
            DETAIL_MAX,
        ),
        metric=InsightMetric(label="Visits / hour when quiet", value=round(rate, 2), unit="visits"),
        impact=impact,
        confidence=confidence,
        suggestion=_suggestion(
            s,
            plan.field,
            current,
            new,
            impact=impact,
            confidence=confidence,
            reason=f"Quiet {span}: {rate:.1f} visits an hour at full energy cost",
        ),
        evidence=_evidence(s, span),
    )


def _benchmark_insight(s: _Store, b: InsightBenchmarks) -> Insight:
    p = b.visitsPerKwhPercentile
    group = "nearby stores" if b.peerType == "all" else "similar stores"
    if p >= 0.5:
        title = f"More visits per kWh than {p * 100:.0f}% of {group}"
    else:
        title = f"Fewer visits per kWh than {(1 - p) * 100:.0f}% of {group}"
    detail = (
        f"{s.visits_per_kwh:.2f} visits per kWh vs a median of {b.areaMedianVisitsPerKwh:.2f}"
        f" across {b.peers} anonymous {PLURAL[b.peerType]}; capture rate {s.capture_rate:.1%}"
        f" vs {b.areaMedianCaptureRate:.1%}."
    )
    return Insight(
        id="benchmark-visits-per-kwh",
        kind="benchmark",
        severity="medium" if p < BENCHMARK_MEDIUM_BELOW else "low",
        title=_clip(title),
        detail=_clip(detail, DETAIL_MAX),
        metric=InsightMetric(
            label="Visits per kWh percentile", value=round(p * 100), unit="percentile"
        ),
        impact=Impact(visits=0.0, kwh=0.0, gbpPerWeek=0.0),
        confidence=_peer_confidence(b.peers),
        suggestion=None,
        evidence=[Source(label=f"Sim run {s.run}, area summary", url=f"/api/runs/{s.run}/summary")],
    )


# --- window rules ---------------------------------------------------------------------------


def _steps(edge: int, later: bool) -> list[int]:
    """30-min grid points moving away from `edge` (unwrapped minutes), nearest first."""
    count = MINUTES_PER_DAY // STEP_MINUTES
    if later:
        first = (edge // STEP_MINUTES + 1) * STEP_MINUTES
        return [first + i * STEP_MINUTES for i in range(count)]
    first = ((edge - 1) // STEP_MINUTES) * STEP_MINUTES
    return [first - i * STEP_MINUTES for i in range(count)]


def _window_valid(
    s: _Store, field: Literal["open", "close"], target: int, other_m: int | None
) -> bool:
    """The hard rules for the window with `field` moved to `target`: on its own, and together
    with the other edge moved to `other_m` by the store's other hours suggestion."""
    others = [s.open_m if field == "close" else s.close_u]
    if other_m is not None:
        others.append(other_m)
    limit = rules.max_open_minutes(s.type, s.close_u - s.open_m)
    for other in others:
        open_m, close_m = (other, target) if field == "close" else (target, other)
        if not _window_ok(open_m, close_m, s.licence):
            return False
        if (close_m - open_m) % MINUTES_PER_DAY > limit:
            return False
    return True


def _window_ok(open_m: int, close_m: int, licence: tuple[str, str]) -> bool:
    """Open at least MIN_OPEN_MINUTES, closed at least MIN_CLOSED_MINUTES, inside the licence."""
    length = (close_m - open_m) % MINUTES_PER_DAY or MINUTES_PER_DAY
    if not MIN_OPEN_MINUTES <= length <= MINUTES_PER_DAY - MIN_CLOSED_MINUTES:
        return False
    return timeutil.window_within((to_hhmm(open_m), to_hhmm(close_m)), licence)


def _spread(values: list[float], minutes: list[int], start: int, end: int) -> float:
    """Sum over the minutes [start, end) of values[h] / minutes[h]: an hourly count spread evenly
    over the minutes it was counted in (closed minutes for found-shut, open minutes for visits)."""
    total = 0.0
    for m in range(start, end):
        hour = (m // 60) % 24
        if minutes[hour]:
            total += values[hour] / minutes[hour]
    return total


def _edge_hhmm(s: _Store, field: Literal["open", "close"]) -> str:
    return to_hhmm(s.open_m if field == "open" else s.close_u)


# --- shared pieces --------------------------------------------------------------------------


def _impact(s: _Store, visits_14d: float, kwh_14d: float) -> Impact:
    return Impact(
        visits=round(_fraction(visits_14d, s.visits), 4),
        kwh=round(_fraction(kwh_14d, s.kwh), 4),
        gbpPerWeek=round(economics.gbp_per_week(s.type, visits_14d, kwh_14d, s.price), 2),
    )


def _suggestion(
    s: _Store,
    field: Literal["open", "close", "lighting"],
    from_: str,
    to: str,
    *,
    impact: Impact,
    confidence: Confidence,
    reason: str,
    hours: list[int] | None = None,
) -> Suggestion:
    data: dict[str, Any] = {
        "storeId": s.id,
        "field": field,
        "from": from_,
        "to": to,
        "expectedDelta": {"visits": impact.visits, "kwh": impact.kwh},
        "confidence": confidence,
        "reason": " ".join(reason.split()[:MAX_REASON_WORDS]),
    }
    if hours is not None:
        data["hours"] = sorted(hours)
    return Suggestion.model_validate(data)


def _evidence(s: _Store, span: str) -> list[Source]:
    day = timeutil.weekday_of_day(REPLAY_DAY).capitalize()
    return [
        Source(label=f"Sim run {s.run}, {day} {span}", url=f"/api/runs/{s.run}/days/{REPLAY_DAY}")
    ]


def _severity(share: float) -> Severity:
    size = abs(share)
    if size >= SEVERITY_HIGH:
        return "high"
    if size >= SEVERITY_MEDIUM:
        return "medium"
    return "low"


def _people_confidence(people_per_week: float) -> Confidence:
    if people_per_week >= CONFIDENCE_HIGH_PEOPLE_PER_WEEK:
        return "high"
    if people_per_week >= CONFIDENCE_MEDIUM_PEOPLE_PER_WEEK:
        return "medium"
    return "low"


def _peer_confidence(peers: int) -> Confidence:
    if peers >= BENCHMARK_HIGH_PEERS:
        return "high"
    if peers >= BENCHMARK_MEDIUM_PEERS:
        return "medium"
    return "low"


def _hour_spans(hours: list[int]) -> str:
    """[0, 1, 5, 22, 23] -> "05:00-06:00, 22:00-02:00": runs of hours, joined across midnight."""
    groups: list[list[int]] = []
    for hour in sorted(set(hours)):
        if groups and hour == groups[-1][-1] + 1:
            groups[-1].append(hour)
        else:
            groups.append([hour])
    if len(groups) > 1 and groups[0][0] == 0 and groups[-1][-1] == 23:
        groups[0] = groups.pop() + groups[0]
    return ", ".join(f"{to_hhmm(g[0] * 60)}-{to_hhmm((g[-1] + 1) * 60)}" for g in groups)


def _weekly(value_14d: float) -> float:
    return value_14d / economics.WEEKS_PER_RUN


def _count(value: float) -> str:
    return f"{value:.0f}" if abs(value) >= 10 else f"{value:.1f}"


def _gbp(value: float) -> str:
    return f"£{value:,.0f}" if abs(value) >= 10 else f"£{value:.2f}"


def _clip(text: str, limit: int = TITLE_MAX) -> str:
    """Contract length caps (title 60, detail 140): a long value is cut, never a 500."""
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
