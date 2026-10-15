"""The data that flows through one training iteration, shared by the analyst backends and the loop.

training.py builds an AnalystContext (best run, store proposals, notebook), the analyst backend
answers with a Choice (changes + a one-line hypothesis), the loop runs it and records an
IterationOutcome (measured result) that the next iteration's context carries.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from functools import lru_cache

from backend import economics
from backend.agents.changes import affected_hours
from backend.agents.objective import NET_VALUE, expected_gain, net_value_gbp
from backend.agents.rundata import RunFiles, advised_stores, store_names, store_types
from backend.agents.wording import change_label
from backend.contract import MapData, Suggestion, dump
from backend.schemas import NotebookEntry, StoreConfig, TrainingConfig
from backend.timeutil import open_hours_fraction

# A store's extra (or lost) visits partly come from (or go to) other stores that are open at the
# same hours, while its extra energy is all new to the area. Net share of a change's visits =
# 1 - SUBSTITUTION x (share of the other stores open in the hours it touches). Two measured real
# runs gave SUBSTITUTION 0.62 and 0.75 (net shares 0.58 and 0.37); at 3am with nothing else
# open, almost every extra visit is new. debt: one constant for every store type. ceiling: two
# calibration points. upgrade: when the analyst ranks badly, fit it per session from measured
# runs (area visit delta / changed stores' visit delta).
SUBSTITUTION = 0.7


@dataclass
class IterationOutcome:
    """The measured result of one experiment run."""

    run: int
    parent_run: int
    applied: list[Suggestion]
    objective_value: float
    gain: float  # vs the best run before this one, positive = better
    is_best: bool
    hypothesis: str = ""

    def to_brief(self) -> dict:
        return {
            "run": self.run,
            "parentRun": self.parent_run,
            "changes": [{"storeId": s.storeId, "change": change_label(s)} for s in self.applied],
            "objectiveValue": round(self.objective_value, 5),
            "gainVsBest": round(self.gain, 5),
            "newBest": self.is_best,
            "hypothesis": self.hypothesis,
        }


@dataclass
class AnalystContext:
    """Everything an analyst backend needs to choose the next experiment."""

    session: str
    seed: int
    objective: str
    run_number: int  # the experiment will be run N of this session (the baseline is run 1)
    max_runs: int
    best_run: int
    best_objective: float
    base_configs: dict[str, StoreConfig]  # the best run's configs; changes apply on top
    proposals: list[Suggestion]  # store agents' rule-checked proposals on the best run
    map_data: MapData
    notebook: list[NotebookEntry] = field(default_factory=list)
    last_outcome: IterationOutcome | None = None
    # The session's limits (stores per experiment, levers, stores, threshold); training sets
    # objective and max_runs from it too.
    config: TrainingConfig = field(default_factory=TrainingConfig)


@dataclass
class Choice:
    """The analyst's decision for one iteration."""

    changes: list[Suggestion]
    hypothesis: str
    expected_gain: float | None = None
    stop: bool = False  # the analyst judged that no experiment is worth running


def net_visit_share(change: Suggestion, files: RunFiles, advised: list[str]) -> float:
    """Share of a change's visit delta that is new to the area (see SUBSTITUTION)."""
    config = files.config.stores.get(change.storeId)
    others = [sid for sid in advised if sid != change.storeId and sid in files.config.stores]
    if config is None or not others:
        return 1.0
    hours = affected_hours(change, config)
    if not hours:
        return 1.0
    open_share = statistics.fmean(
        sum(_open_fraction(files.config.stores[sid], hour) for sid in others) / len(others)
        for hour in hours
    )
    return 1.0 - SUBSTITUTION * open_share


def _open_fraction(config: StoreConfig, hour: int) -> float:
    return _window_fractions(config.open, config.close)[hour]


@lru_cache(maxsize=4096)
def _window_fractions(open_hhmm: str, close_hhmm: str) -> tuple[float, ...]:
    return tuple(open_hours_fraction(open_hhmm, close_hhmm))


def expected_city_gain(
    changes: list[Suggestion], files: RunFiles, objective: str, map_data: MapData
) -> float:
    """Estimated area objective gain if `changes` were applied to the run in `files`.

    Each change's expectedDelta (fractions of its store's totals) becomes absolute visits/kWh on
    that store. Energy adds to the area in full; visits only by net_visit_share, because part of
    a store's gain is another store's loss when the others are open too. netValueGbp values each
    visit at its store type's margin and each kWh at the mean tariff.
    """
    advised = [s.id for s in advised_stores(map_data)]
    deltas: list[tuple[str, float, float, float]] = []  # (store, visits, kWh, open h), 14 days
    for change in changes:
        result = files.stores.get(change.storeId)
        if result is None:
            continue
        share = net_visit_share(change, files, advised)
        deltas.append(
            (
                change.storeId,
                change.expectedDelta.visits * result.kpis.visits * share,
                change.expectedDelta.kwh * result.kpis.kwh,
                economics.suggestion_open_hours_delta(result, change),
            )
        )
    if objective == NET_VALUE:
        return _expected_net_value_gain(deltas, files, map_data)
    kpis = files.summary.kpis
    d_visits = sum(d[1] for d in deltas)
    d_kwh = sum(d[2] for d in deltas)
    return expected_gain(kpis.visits, kpis.kwh, d_visits, d_kwh, objective)


def _expected_net_value_gain(
    deltas: list[tuple[str, float, float, float]], files: RunFiles, map_data: MapData
) -> float:
    types, price = store_types(map_data), economics.area_price_gbp_per_kwh()
    value = net_value_gbp({sid: r.kpis for sid, r in files.stores.items()}, types, price)
    delta = sum(economics.gbp_per_week(types[sid], dv, dk, dh, price) for sid, dv, dk, dh in deltas)
    return delta / abs(value) if value else 0.0


def iteration_brief(ctx: AnalystContext, files: RunFiles) -> dict:
    """What an LLM analyst sees at the start of an iteration: the best run's numbers, the
    notebook, the last measured result and each store agent's proposals with their area gain."""
    names = store_names(ctx.map_data)
    by_store: dict[str, list[Suggestion]] = {}
    for proposal in ctx.proposals:
        by_store.setdefault(proposal.storeId, []).append(proposal)
    return {
        "session": ctx.session,
        "objective": ctx.objective,
        "threshold": ctx.config.threshold,
        "runNumber": ctx.run_number,
        "maxRuns": ctx.max_runs,
        "bestRun": ctx.best_run,
        "bestObjective": round(ctx.best_objective, 5),
        "bestKpis": files.summary.kpis.model_dump(mode="json"),
        "notebook": [f"Run {e.run}: {e.line}" for e in ctx.notebook[-12:]],
        "lastResult": ctx.last_outcome.to_brief() if ctx.last_outcome else None,
        "proposals": [
            {
                "storeId": sid,
                "store": names.get(sid, sid),
                "expectedAreaGain": round(
                    expected_city_gain(changes, files, ctx.objective, ctx.map_data), 5
                ),
                "changes": [dump(s) for s in changes],
            }
            for sid, changes in by_store.items()
        ],
    }
