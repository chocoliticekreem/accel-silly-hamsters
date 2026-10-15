"""The owner's store page in one call (docs/STORE_PAGE.md): GET /api/stores/{storeId}/overview.

Built from the run files on disk (config.json, stores.json, suggestions.json, owner_events.json,
runs/index.json, runs/analyst_state.json). Mirrors apps/web/src/sim/overview.ts (the frontend's
fallback), with two deliberate differences: history follows each run's parentRun (not "the run
before it"), and advice status reads the runs' recorded appliedChanges as well as config diffs.

Honesty: "best" is THIS shop's most profitable run against its own baseline, not the area-wide
best run. A run that costs the shop money says so in the headline ("going back is better").

Data firewall: only this shop's numbers; a suggestion reason that names another shop is dropped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from backend import economics, store
from backend.agents.changes import config_diff
from backend.agents.wording import hours_range
from backend.contract import (
    AdviceStatus,
    Certainty,
    MapData,
    MapStore,
    OverviewAdvice,
    OverviewHistoryItem,
    OverviewNumber,
    OverviewNumbers,
    OverviewStatus,
    StoreKpis,
    StoreOverview,
    StoreRunResult,
    Suggestion,
)
from backend.schemas import AnalystState, RunConfig, StoreConfig

SAMPLE_RUN = 0
MAX_ADVICE = 3
NOTE = "Simulated, not guaranteed."
CERTAINTY: dict[str, Certainty] = {"high": "likely", "medium": "worth testing", "low": "uncertain"}
BASELINE_LABEL = "Your current settings"
LEVEL_RANK = {"off": 0, "low": 1, "high": 2}
DAY_STARTS_MINUTE = 5 * 60  # "later" in the owner's day: 03:00 is later than 23:00

ChangeKey = tuple[str, tuple[int, ...], str, str]  # field, hours, from, to


class NoRuns(LookupError):
    """No finished run to build the page from (the API answers 404)."""


@dataclass
class ShopRun:
    run: int
    config: RunConfig
    result: StoreRunResult

    @property
    def kpis(self) -> StoreKpis:
        return self.result.kpis


@dataclass
class _HistoryRow:
    shop: ShopRun
    profit: float
    changes: list[dict] = field(default_factory=list)


# --- wording ----------------------------------------------------------------------------------


def change_label(change: dict) -> str:
    """'Close 22:30 → 03:30', 'Lights 18–00 low → off'."""
    if change["field"] == "lighting":
        return f"Lights {hours_range(change['hours'] or [])} {change['from']} → {change['to']}"
    name = "Open" if change["field"] == "open" else "Close"
    return f"{name} {change['from']} → {change['to']}"


def run_label(changes: list[dict]) -> str:
    """The first change in words ('Open till 03:30', 'Lights 18–00 off'), or the baseline's."""
    if not changes:
        return BASELINE_LABEL
    first = changes[0]
    if first["field"] == "close":
        return f"Open till {first['to']}"
    if first["field"] == "open":
        return f"Open from {first['to']}"
    return f"Lights {hours_range(first['hours'] or [])} {first['to']}"


def _day_minutes(hhmm: str) -> int:
    minutes = int(hhmm[:2]) * 60 + int(hhmm[3:5])
    return (minutes - DAY_STARTS_MINUTE) % 1440


def _later(a: str, b: str) -> bool:
    return _day_minutes(a) > _day_minutes(b)


def advice_text(s: Suggestion, customers_per_week: float, gbp_per_week: float) -> str:
    """One plain sentence per suggestion, with the number an owner cares about."""
    more = round(customers_per_week)
    save = abs(round(gbp_per_week))
    net = f", £{save} a week after staff and power" if gbp_per_week >= 0.5 else ""
    if s.field == "close":
        if _later(s.to, s.from_):
            return f"Stay open until {s.to}: about {more} more customers a week{net}."
        return (
            f"Close at {s.to} instead of {s.from_}: the last hours are nearly empty, "
            f"saving about £{save} a week in staff and power."
        )
    if s.field == "open":
        if _later(s.from_, s.to):
            return f"Open at {s.to}: catch about {more} more customers a week{net}."
        return f"Open at {s.to} instead of {s.from_}: the first hours are nearly empty."
    hours = hours_range(s.hours or [])
    if LEVEL_RANK.get(s.to, 0) > LEVEL_RANK.get(s.from_, 0):
        return f"Light the window {hours}: about {more} more customers a week."
    return f"Turn the window lights {s.to} {hours}: saves about £{save} a week."


def _headline(
    status: OverviewStatus,
    advice: list[OverviewAdvice],
    profit_now: float,
    best: _HistoryRow | None,
    baseline_run: int,
    customers: float,
) -> str:
    if profit_now < 0:
        # Honesty: the run on screen costs this shop money; point back to its own best.
        gap = round((best.profit if best else 0.0) - profit_now)
        if best is None or best.shop.run == baseline_run:
            return (
                f"Your original settings did better: going back is about £{gap} a week "
                "better for you."
            )
        return (
            "Your settings from an earlier test did better: going back to them is about "
            f"£{gap} a week better for you."
        )
    if advice:
        return advice[0].text
    if status == "not_started":
        return "No changes tested for your shop yet: run the agents to get this week's advice."
    if profit_now > 0:
        return (
            f"Keep these settings: about {round(customers)} customers a week, "
            f"£{round(profit_now)} a week better off."
        )
    return (
        f"No change has beaten your original settings yet: about {round(customers)} "
        "customers a week."
    )


# --- run files --------------------------------------------------------------------------------


class _Runs:
    """Lazy reads of the run files one overview needs, each file at most once."""

    def __init__(self, store_id: str) -> None:
        self.store_id = store_id
        self._configs: dict[int, RunConfig | None] = {}
        self._results: dict[int, StoreRunResult | None] = {}

    def config(self, run: int) -> RunConfig | None:
        if run not in self._configs:
            data = store.read_json(store.run_dir(run) / "config.json")
            self._configs[run] = RunConfig.model_validate(data) if data else None
        return self._configs[run]

    def result(self, run: int) -> StoreRunResult | None:
        if run not in self._results:
            data = store.read_json(store.run_dir(run) / "stores.json") or {}
            raw = data.get(self.store_id)
            self._results[run] = StoreRunResult.model_validate(raw) if raw else None
        return self._results[run]

    def shop(self, run: int) -> ShopRun | None:
        config, result = self.config(run), self.result(run)
        if config is None or result is None or self.store_id not in config.stores:
            return None
        return ShopRun(run, config, result)

    def shop_config(self, run: int) -> StoreConfig | None:
        config = self.config(run)
        return config.stores.get(self.store_id) if config else None


def _done_runs() -> list[int]:
    return sorted(r.run for r in store.load_index() if r.run != SAMPLE_RUN and r.status == "done")


def _baseline_run(done: list[int], runs: _Runs, state: AnalystState | None) -> int:
    """The analyst's baseline, else the first finished run without a parent, else the first."""
    if state is not None and state.baselineRun in done and runs.shop(state.baselineRun):
        return state.baselineRun
    for run in done:
        config = runs.config(run)
        if config is not None and config.parentRun is None and runs.shop(run):
            return run
    for run in done:
        if runs.shop(run):
            return run
    raise NoRuns("no finished run yet")


def _key(change: dict) -> ChangeKey:
    return (change["field"], tuple(sorted(change.get("hours") or [])), change["from"], change["to"])


def _suggestion_key(s: Suggestion) -> ChangeKey:
    return (s.field, tuple(sorted(s.hours or [])), s.from_, s.to)


def _run_change_keys(row: _HistoryRow, store_id: str) -> set[ChangeKey]:
    """What a history run changed for this shop: its config diff plus its recorded changes."""
    keys = {_key(c) for c in row.changes}
    for applied in row.shop.config.appliedChanges:
        if applied.get("storeId") == store_id:
            keys.add(_key({**applied, "hours": applied.get("hours")}))
    return keys


def _ancestors(run: int, runs: _Runs) -> set[int]:
    chain: set[int] = set()
    current: int | None = run
    while current is not None and current not in chain:
        chain.add(current)
        config = runs.config(current)
        current = config.parentRun if config else None
    return chain


def _scrub(s: Suggestion, others: list[MapStore]) -> Suggestion:
    """Drop a reason that names another shop (data firewall); keep the change itself."""
    if not s.reason:
        return s
    for other in others:
        if other.name in s.reason or re.search(rf"\b{re.escape(other.id)}\b", s.reason):
            return s.model_copy(update={"reason": None})
    return s


def _fraction(before: float, after: float) -> float:
    return round((after - before) / before, 3) if before > 0 else 0.0


# --- the overview -----------------------------------------------------------------------------


def find_store(map_data: MapData, store_id: str) -> MapStore:
    """The map store, or KeyError for unknown stores and clubs (fixed anchors, no advice)."""
    ms = next((s for s in map_data.stores if s.id == store_id), None)
    if ms is None:
        raise KeyError(f"unknown store {store_id}")
    if ms.type == "club":
        raise KeyError(f"{store_id} is a club: fixed anchor, no store page")
    return ms


def store_overview(map_data: MapData, store_id: str, run: int | None = None) -> StoreOverview:
    """The store page for `run` (default: this shop's best run, else the latest finished run).

    KeyError: unknown or club store, or a run that is not finished or has no data for the shop.
    NoRuns: no finished run yet.
    """
    ms = find_store(map_data, store_id)
    others = [s for s in map_data.stores if s.id != store_id]
    runs = _Runs(store_id)
    done = _done_runs()
    state = store.load_analyst_state()
    baseline_run = _baseline_run(done, runs, state)
    baseline = runs.shop(baseline_run)
    assert baseline is not None
    price = economics.area_price_gbp_per_kwh()

    def profit(shop: ShopRun) -> float:
        return economics.profit_vs(ms.type, baseline.kpis, shop.kpis, price)

    # History: the baseline plus every later run (same seed) that changed this shop's settings
    # against its parent run, oldest first.
    history: list[_HistoryRow] = [_HistoryRow(baseline, 0.0)]
    for r in done:
        if r <= baseline_run:
            continue
        shop = runs.shop(r)
        if shop is None or shop.config.seed != baseline.config.seed:
            continue
        parent = shop.config.parentRun
        before = runs.shop_config(parent) if parent is not None else None
        before = before or baseline.config.stores[store_id]
        changes = config_diff(before, shop.config.stores[store_id])
        if changes:
            history.append(_HistoryRow(shop, profit(shop), changes))
    # A run where the shop closed for good is never the pick: its "profit" is the wages it saved.
    candidates = [h for h in history if h.shop.result.closedFromDay is None]
    best = max(candidates, key=lambda h: h.profit) if len(history) > 1 and candidates else None
    best_run = best.shop.run if best else None

    if run is None:
        latest = next((r for r in reversed(done) if runs.shop(r)), baseline_run)
        run = best_run if best_run is not None else latest
    elif run not in done or runs.shop(run) is None:
        raise KeyError(f"run {run} is not a finished run with data for {store_id}")
    current = runs.shop(run)
    assert current is not None
    profit_now = profit(current)

    # Advice: this shop's suggestions on the run, best GBP first, with what earlier runs showed.
    tried: dict[ChangeKey, float] = {}
    rows_by_run = {h.shop.run: h for h in history}
    for row in history[1:]:
        parent = row.shop.config.parentRun
        parent_shop = runs.shop(parent) if parent is not None else None
        effect = row.profit - (profit(parent_shop) if parent_shop else 0.0)
        for key in _run_change_keys(row, store_id):
            tried[key] = effect
    applied: set[ChangeKey] = set()
    for r in _ancestors(run, runs):
        if r in rows_by_run and r != baseline_run:
            applied |= _run_change_keys(rows_by_run[r], store_id)
    suggestions = store.read_json(store.run_dir(run) / "suggestions.json", []) or []
    advice: list[OverviewAdvice] = []
    for raw in suggestions:
        s = Suggestion.model_validate(raw)
        if s.storeId != store_id:
            continue
        d_visits = current.kpis.visits * s.expectedDelta.visits
        d_kwh = current.kpis.kwh * s.expectedDelta.kwh
        d_hours = economics.suggestion_open_hours_delta(current.result, s)
        gbp = round(economics.gbp_per_week(ms.type, d_visits, d_kwh, d_hours, price))
        key = _suggestion_key(s)
        status: AdviceStatus = "new"
        if key in applied:
            status = "applied"
        elif key in tried:
            status = "tested_better" if tried[key] >= 0 else "tested_worse"
        advice.append(
            OverviewAdvice(
                text=advice_text(
                    s, d_visits * economics.people_per_agent() / economics.WEEKS_PER_RUN, gbp
                ),
                gbpPerWeek=float(gbp),
                certainty=CERTAINTY[s.confidence or "medium"],
                status=status,
                suggestion=_scrub(s, others),
            )
        )
    advice.sort(key=lambda a: -a.gbpPerWeek)
    advice = advice[:MAX_ADVICE]

    overview_status: OverviewStatus
    if len(history) <= 1:
        overview_status = "not_started"
    elif state is not None and state.state == "running":
        overview_status = "improving"
    else:
        overview_status = "best_found"

    weeks = economics.WEEKS_PER_RUN
    per_week = economics.people_per_agent() / weeks  # sim visits in a run -> real customers a week
    customers = current.kpis.visits * per_week
    kwh = current.kpis.kwh / weeks
    base_customers = baseline.kpis.visits * per_week
    base_kwh = baseline.kpis.kwh / weeks
    owner_events = store.read_json(store.run_dir(run) / "owner_events.json")
    return StoreOverview(
        storeId=store_id,
        name=ms.name,
        type=ms.type,
        run=run,
        baselineRun=baseline_run,
        bestRun=best_run,
        status=overview_status,
        headline=_headline(overview_status, advice, profit_now, best, baseline_run, customers),
        numbers=OverviewNumbers(
            customersPerWeek=OverviewNumber(
                value=round(customers), change=_fraction(base_customers, customers)
            ),
            energyCostPerWeekGbp=OverviewNumber(
                value=round(kwh * price, 2), change=_fraction(base_kwh, kwh)
            ),
            kwhPerWeek=OverviewNumber(value=round(kwh, 1), change=_fraction(base_kwh, kwh)),
            profitChangePerWeekGbp=float(round(profit_now)),
        ),
        advice=advice,
        history=[
            OverviewHistoryItem(
                run=h.shop.run,
                label=run_label(h.changes),
                customersPerWeek=round(h.shop.kpis.visits * per_week),
                kwhPerWeek=round(h.shop.kpis.kwh / weeks, 1),
                profitChangePerWeekGbp=float(round(h.profit)),
                changes=[change_label(c) for c in h.changes],
                best=best is not None and h is best,
            )
            for h in history
        ],
        note=NOTE,
        ownerChanges=None
        if owner_events is None
        else sum(1 for e in owner_events if e.get("storeId") == store_id),
    )
