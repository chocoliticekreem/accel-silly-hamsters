"""The training loop: store agents propose, the analyst chooses, the sim runs, repeat until done.

One training session is a baseline run plus experiment runs, all on the same seed:

  baseline   execute_run(baseline_configs(), seed)
  each iteration, one checkpointed step at a time (AnalystState.step):
    proposed   store agents propose on the current best run (runs/{best}/suggestions.json)
    chosen     the analyst picks changes and states a hypothesis; the hard rules re-check them
               (runs/analyst_pending.json holds the choice until it is scored)
    ran        execute_run(best configs + changes, seed, parent_run=best, applied_changes=...)
    scored     objective vs the best run -> gain, notebook line, best run, low-gain streak
  stop       gain < THRESHOLD for PATIENCE runs in a row, or the analyst finds nothing left to
             try ("threshold"); max_runs runs in the session, baseline included ("max_runs");
             the spend cap, llm.check_budget ("budget"); an exception ("error", re-raised)

runs/analyst_state.json is written after every step. train() without fresh resumes from it and
never redoes a completed step; a run that finished just before a crash comes back from the run
cache instead of being simulated again. Hand-offs (analyst -> store agents -> analyst) and every
hypothesis are written to the runs' llm_log.jsonl.

After stopping: reports for the best run, then the session's LLM cost into every session run's
summary.json and costPerStoreWeekGbp into runs/index.json.

Cost per store-week = the session's LLM cost (GBP) / (advised stores x weeks of advice). A
session produces one weekly report per non-club store, so weeks = 1: the figure is what one
store's weekly advice cost to produce.

One-shop sessions (train(scope_store=...), POST /api/stores/{id}/optimize) run the same steps
with AnalystState.scopeStore set: only that store's agent proposes, the choice ranks its
proposals by expected GBP/week, the objective is its profit change per week vs the baseline
(gain = change / the shop's weekly margin), and reports are written for that store only.
"""

from __future__ import annotations

import traceback
import uuid
from itertools import combinations
from typing import Literal

from backend import cache, economics, llm, settings, store
from backend.agents import analyst, report, rundata, store_owner
from backend.agents.analyst import AnalystBackend
from backend.agents.experiment import AnalystContext, IterationOutcome
from backend.agents.objective import city_value, gain
from backend.agents.rules import check_changes, log_rejections
from backend.agents.wording import change_label
from backend.contract import MapData, StoreType, Suggestion, dump
from backend.schemas import AnalystState, NotebookEntry, RunSummary
from backend.sim import runner

AGENT = "training"
ADVICE_WEEKS_PER_SESSION = 1

StopReason = Literal["threshold", "max_runs", "budget", "error"]


def pending_path():
    return settings.RUNS_DIR / "analyst_pending.json"


def train(
    max_runs: int = settings.MAX_RUNS,
    fresh: bool = False,
    seed: int = settings.DEFAULT_SEED,
    scope_store: str | None = None,
) -> AnalystState:
    """Run (or resume) a training session and return its final checkpoint.

    fresh=True starts a new session that reads neither the LLM response cache nor runs from
    earlier sessions; otherwise the last checkpoint is resumed (same seed) and caches are reused.

    scope_store runs a one-shop session (POST /api/stores/{id}/optimize): the same loop,
    checkpoints and budgets, but only that store's agent proposes, only its settings change
    (every other store stays at the baseline), and the objective is its profit change per week
    vs the baseline (economics.profit_vs). The choice is a deterministic ranking by expected
    GBP/week (the area analyst's prompts and tools are area-wide), so no analyst LLM is called.
    Only a running session with the same scope is resumed.
    """
    cache.set_policy(fresh=fresh)
    backend = analyst.select_backend("heuristic" if scope_store else None)
    state = _start_or_resume(fresh, seed, backend.name, scope_store)
    reason: StopReason
    try:
        reason = _loop(state, backend, max_runs)
    except llm.BudgetExceeded as e:
        llm.log_event(state.bestRun, {"agent": AGENT, "type": "budget_stop", "error": str(e)})
        reason = "budget"
    except Exception as e:
        state.state = "stopped"
        state.stoppedReason = "error"
        state.error = f"{type(e).__name__}: {e}"
        _checkpoint(state)
        llm.log_event(
            state.bestRun,
            {"agent": AGENT, "type": "error", "step": state.step, "trace": traceback.format_exc()},
        )
        backend.close("error")
        raise
    _finish(state, backend, reason)
    return state


def start_store_session(store_id: str, seed: int = settings.DEFAULT_SEED) -> AnalystState:
    """Checkpoint a new one-shop session as running (step "start") without running it, so the
    API can answer with its status at once; train(scope_store=store_id) then resumes it."""
    now = store.now_iso()
    state = AnalystState(
        sessionId=uuid.uuid4().hex[:12],
        state="running",
        startedAt=now,
        updatedAt=now,
        backend="heuristic",
        fresh=False,
        seed=seed,
        scopeStore=store_id,
    )
    _checkpoint(state)
    llm.log_event(
        None,
        {"agent": AGENT, "type": "start", "session": state.sessionId, "scope": "store"},
    )
    return state


def _resumable(previous: AnalystState | None, seed: int, scope_store: str | None) -> bool:
    if previous is None or previous.seed != seed or previous.scopeStore != scope_store:
        return False
    # A finished one-shop session is never resumed: "optimise again" starts a new one.
    return scope_store is None or previous.state == "running"


def _start_or_resume(
    fresh: bool, seed: int, backend_name: str, scope_store: str | None = None
) -> AnalystState:
    previous = None if fresh else store.load_analyst_state()
    if previous is not None and _resumable(previous, seed, scope_store):
        previous.state = "running"
        previous.stoppedReason = None
        previous.error = None
        previous.backend = backend_name
        cache.policy.session_runs.update(previous.runsThisSession)
        _checkpoint(previous)
        llm.log_event(
            None,
            {
                "agent": AGENT,
                "type": "resume",
                "session": previous.sessionId,
                "step": previous.step,
                "runs": previous.runsThisSession,
            },
        )
        return previous
    now = store.now_iso()
    state = AnalystState(
        sessionId=uuid.uuid4().hex[:12],
        state="running",
        startedAt=now,
        updatedAt=now,
        backend=backend_name,
        fresh=fresh,
        seed=seed,
        scopeStore=scope_store,
    )
    _checkpoint(state)
    llm.log_event(
        None,
        {"agent": AGENT, "type": "start", "session": state.sessionId, "fresh": fresh, "seed": seed},
    )
    return state


def _checkpoint(state: AnalystState) -> None:
    state.spentGbp = round(llm.ledger_total_gbp(session=state.sessionId), 4)
    store.save_analyst_state(state)


def _score_of(summary: RunSummary) -> float:
    if summary.objective == settings.OBJECTIVE:
        return summary.objectiveValue
    return city_value(summary.kpis, settings.OBJECTIVE)


def _store_type(store_id: str) -> StoreType:
    for ms in store.load_map().stores:
        if ms.id == store_id:
            return ms.type
    raise KeyError(f"unknown store {store_id}")


def _objective_value(state: AnalystState, run: int) -> float:
    """The session objective for `run`: the area KPI, or (one-shop session) the shop's profit
    change per week vs the session baseline."""
    if state.scopeStore is None:
        return _score_of(rundata.load_summary(run))
    sid, base = state.scopeStore, state.baselineRun
    if base is None or run == base:
        return 0.0
    before, after = rundata.load_stores(base)[sid].kpis, rundata.load_stores(run)[sid].kpis
    return economics.profit_vs(_store_type(sid), before, after, economics.area_price_gbp_per_kwh())


def _shop_scale(state: AnalystState) -> float:
    """GBP that count as a 100% gain in a one-shop session: the shop's weekly margin at the
    baseline (at least GBP 1), so THRESHOLD reads as a share of what the shop keeps."""
    sid, base = state.scopeStore, state.baselineRun
    assert sid is not None and base is not None
    kpis = rundata.load_stores(base)[sid].kpis
    return max(economics.weekly_margin_gbp(_store_type(sid), kpis), 1.0)


def _gain(state: AnalystState, new: float, reference: float) -> float:
    if state.scopeStore is None:
        return gain(new, reference, settings.OBJECTIVE)
    return (new - reference) / _shop_scale(state)


def _add_run(state: AnalystState, run: int) -> None:
    if run not in state.runsThisSession:
        state.runsThisSession.append(run)
    state.iterations = len(state.runsThisSession)
    cache.policy.session_runs.add(run)


def _stop_reason(state: AnalystState, max_runs: int) -> StopReason | None:
    if state.lowGainStreak >= settings.PATIENCE:
        return "threshold"
    if len(state.runsThisSession) >= max_runs:
        return "max_runs"
    return None


def _loop(state: AnalystState, backend: AnalystBackend, max_runs: int) -> StopReason:
    map_data = store.load_map()
    while True:
        step = state.step
        if step == "start":
            _baseline(state)
        elif step in ("baseline", "scored"):
            reason = _stop_reason(state, max_runs)
            if reason:
                return reason
            llm.check_budget(state.sessionId)
            _propose(state)
        elif step == "proposed":
            if not _choose(state, backend, map_data, max_runs):
                return "threshold"
        elif step == "chosen":
            _run(state, map_data)
        elif step == "ran":
            _score(state, backend)
        else:
            raise RuntimeError(f"unknown checkpoint step {step!r}")


def _baseline(state: AnalystState) -> None:
    run = runner.execute_run(runner.baseline_configs(), state.seed)
    summary = rundata.load_summary(run)
    state.baselineRun = state.currentRun = state.bestRun = run
    state.bestObjective = _objective_value(state, run)
    _add_run(state, run)
    store.append_notebook(
        NotebookEntry(
            run=run,
            line=analyst.baseline_notebook_line(summary),
            objectiveValue=_score_of(summary),  # the notebook is area-level in every session
            at=store.now_iso(),
        )
    )
    state.step = "baseline"
    _checkpoint(state)


def _propose(state: AnalystState) -> None:
    best = state.bestRun
    assert best is not None
    llm.log_event(
        best,
        {"agent": "analyst", "type": "handoff", "to": "store_agents", "run": best},
    )
    if state.scopeStore is None:
        proposals = store_owner.propose_all(best, session=state.sessionId)
    else:
        proposals = store_owner.propose_all(
            best, session=state.sessionId, store_ids={state.scopeStore}
        )
    llm.log_event(
        best,
        {
            "agent": "store_agents",
            "type": "handoff",
            "to": "analyst",
            "proposals": len(proposals),
            "stores": len({p.storeId for p in proposals}),
        },
    )
    state.step = "proposed"
    _checkpoint(state)


def _last_outcome(state: AnalystState) -> IterationOutcome | None:
    """The measured result of the latest experiment, rebuilt from run files (survives restarts)."""
    run = state.currentRun
    if run is None or run == state.baselineRun:
        return None
    config = rundata.load_config(run)
    if config.parentRun is None:
        return None
    value = _objective_value(state, run)
    parent_value = _objective_value(state, config.parentRun)
    pending = store.read_json(pending_path(), {}) or {}
    return IterationOutcome(
        run=run,
        parent_run=config.parentRun,
        applied=[Suggestion.model_validate(c) for c in config.appliedChanges],
        objective_value=value,
        gain=_gain(state, value, parent_value),
        is_best=state.bestRun == run,
        hypothesis=pending.get("hypothesis", "") if pending.get("run") == run else "",
    )


def _choose(state: AnalystState, backend: AnalystBackend, map_data: MapData, max_runs: int) -> bool:
    if state.scopeStore is not None:
        return _choose_for_store(state, map_data)
    best = state.bestRun
    assert best is not None and state.bestObjective is not None
    base = rundata.load_config(best).stores
    ctx = AnalystContext(
        session=state.sessionId,
        seed=state.seed,
        objective=settings.OBJECTIVE,
        run_number=len(state.runsThisSession) + 1,
        max_runs=max_runs,
        best_run=best,
        best_objective=state.bestObjective,
        base_configs=base,
        proposals=rundata.load_suggestions(best),
        map_data=map_data,
        notebook=store.load_notebook(),
        last_outcome=_last_outcome(state),
    )
    choice = backend.choose(ctx)
    result = check_changes(base, choice.changes, map_data)
    log_rejections(best, result.rejections, agent="analyst")
    if choice.stop or not result.accepted:
        llm.log_event(
            best,
            {"agent": "analyst", "type": "no_experiment", "reason": choice.hypothesis},
        )
        return False
    _commit_choice(state, result.accepted, choice.hypothesis, choice.expected_gain, backend.name)
    return True


def _commit_choice(
    state: AnalystState,
    accepted: list[Suggestion],
    hypothesis: str,
    expected_gain: float | None,
    backend_name: str,
) -> None:
    best = state.bestRun
    changes = [dump(s) for s in accepted]
    store.write_json(
        pending_path(),
        {
            "sessionId": state.sessionId,
            "bestRun": best,
            "hypothesis": hypothesis,
            "expectedGain": expected_gain,
            "changes": changes,
        },
    )
    llm.log_event(
        best,
        {
            "agent": "analyst",
            "type": "hypothesis",
            "backend": backend_name,
            "text": hypothesis,
            "expectedGain": expected_gain,
            "changes": changes,
        },
    )
    state.step = "chosen"
    _checkpoint(state)


def _choose_for_store(state: AnalystState, map_data: MapData) -> bool:
    """One-shop session: the untried set of 1-2 of the shop's proposals with the highest
    expected profit per week (expectedDelta on the best run's numbers, economics.gbp_per_week)
    that passes the hard rules. Only this shop's config changes; every other store keeps the
    best run's (= the baseline's) settings."""
    sid, best = state.scopeStore, state.bestRun
    assert sid is not None and best is not None
    files = rundata.RunFiles.load(best)
    kind, price = _store_type(sid), economics.area_price_gbp_per_kwh()
    kpis = files.stores[sid].kpis
    proposals = [p for p in rundata.load_suggestions(best) if p.storeId == sid]

    def expected_gbp(option: tuple[Suggestion, ...]) -> float:
        d_visits = sum(c.expectedDelta.visits for c in option) * kpis.visits
        d_kwh = sum(c.expectedDelta.kwh for c in option) * kpis.kwh
        return economics.gbp_per_week(kind, d_visits, d_kwh, price)

    options = [(p,) for p in proposals] + list(
        combinations(proposals, settings.MAX_CHANGES_PER_STORE_PER_WEEK)
    )
    ranked = sorted((o for o in options if expected_gbp(o) > 0), key=lambda o: -expected_gbp(o))
    for option in ranked:
        result = check_changes(files.config.stores, list(option), map_data)
        if result.rejections:
            continue
        if cache.run_lookup(cache.run_key(result.configs, state.seed)) is not None:
            continue
        gbp = expected_gbp(option)
        labels = ", ".join(change_label(c) for c in result.accepted)
        hypothesis = f"{labels} should add about £{gbp:.0f} a week for this shop"
        _commit_choice(state, result.accepted, hypothesis, gbp / _shop_scale(state), "heuristic")
        return True
    llm.log_event(
        best,
        {
            "agent": "analyst",
            "type": "no_experiment",
            "reason": "No untried change for this shop with a positive expected profit",
        },
    )
    return False


def _load_pending(state: AnalystState) -> dict:
    pending = store.read_json(pending_path())
    if not pending or pending.get("sessionId") != state.sessionId:
        raise RuntimeError(
            f"checkpoint step {state.step!r} needs {pending_path()} from session {state.sessionId}"
        )
    return pending


def _run(state: AnalystState, map_data: MapData) -> None:
    pending = _load_pending(state)
    parent = pending["bestRun"]
    changes = [Suggestion.model_validate(c) for c in pending["changes"]]
    # Checked when chosen; a crash after the run finished leaves its config already "tried".
    result = check_changes(rundata.load_config(parent).stores, changes, map_data, check_tried=False)
    if result.rejections:
        raise RuntimeError(f"pending changes no longer pass the rules: {result.rejections}")
    run = runner.execute_run(
        result.configs, state.seed, parent_run=parent, applied_changes=pending["changes"]
    )
    state.currentRun = run
    _add_run(state, run)
    store.write_json(pending_path(), {**pending, "run": run})
    llm.log_event(
        run,
        {
            "agent": "analyst",
            "type": "experiment",
            "parentRun": parent,
            "hypothesis": pending["hypothesis"],
            "changes": pending["changes"],
        },
    )
    state.step = "ran"
    _checkpoint(state)


def _score(state: AnalystState, backend: AnalystBackend) -> None:
    pending = _load_pending(state)
    run = state.currentRun
    assert run is not None and state.bestObjective is not None
    value = _objective_value(state, run)
    run_gain = _gain(state, value, state.bestObjective)
    outcome = IterationOutcome(
        run=run,
        parent_run=pending["bestRun"],
        applied=[Suggestion.model_validate(c) for c in pending["changes"]],
        objective_value=value,
        gain=run_gain,
        is_best=run_gain > 0,
        hypothesis=pending["hypothesis"],
    )
    line = backend.notebook_line(outcome)
    store.append_notebook(
        NotebookEntry(
            run=run,
            line=line,
            objectiveValue=value
            if state.scopeStore is None
            else _score_of(rundata.load_summary(run)),
            at=store.now_iso(),
        )
    )
    if outcome.is_best:
        state.bestRun, state.bestObjective = run, value
    state.lowGainStreak = state.lowGainStreak + 1 if run_gain < settings.THRESHOLD else 0
    llm.log_event(
        run,
        {
            "agent": "analyst",
            "type": "result",
            "objectiveValue": value,
            "gain": run_gain,
            "newBest": outcome.is_best,
            "notebook": line,
            "hypothesis": pending["hypothesis"],
            "lowGainStreak": state.lowGainStreak,
        },
    )
    state.step = "scored"
    _checkpoint(state)


def _finish(state: AnalystState, backend: AnalystBackend, reason: StopReason) -> None:
    state.state = "stopped"
    state.stoppedReason = reason
    _checkpoint(state)
    llm.log_event(
        state.bestRun,
        {
            "agent": AGENT,
            "type": "stopped",
            "reason": reason,
            "bestRun": state.bestRun,
            "runs": state.runsThisSession,
        },
    )
    backend.close(reason)
    try:
        if state.bestRun is not None and state.baselineRun is not None:
            report.write_reports(
                state.bestRun,
                state.baselineRun,
                session=state.sessionId,
                store_ids=None if state.scopeStore is None else {state.scopeStore},
            )
    finally:
        write_session_costs(state)
        _checkpoint(state)


def write_session_costs(state: AnalystState) -> float:
    """Write the session's cost into each session run's summary.json and the run index.

    Returns costPerStoreWeekGbp (see the module docstring for the definition).
    """
    map_data = store.load_map()
    advised = 1 if state.scopeStore else len(rundata.advised_stores(map_data))
    store_weeks = advised * ADVICE_WEEKS_PER_SESSION
    summary_cost = llm.cost_summary(session=state.sessionId, store_weeks=store_weeks)
    runs = state.runsThisSession
    if state.scopeStore:  # the shared baseline run keeps its area session's cost
        runs = [r for r in runs if r != state.baselineRun]
    for run in runs:
        try:
            summary = rundata.load_summary(run)
        except FileNotFoundError:
            continue
        summary.cost = summary_cost
        rundata.save_summary(run, summary)
        try:
            store.update_index(run, costPerStoreWeekGbp=summary_cost.costPerStoreWeekGbp)
        except KeyError:
            llm.log_event(run, {"agent": AGENT, "type": "index_missing_run", "run": run})
    llm.log_event(
        state.bestRun,
        {
            "agent": AGENT,
            "type": "session_cost",
            "costGbp": summary_cost.costGbp,
            "storeWeeks": store_weeks,
            "costPerStoreWeekGbp": summary_cost.costPerStoreWeekGbp,
        },
    )
    return summary_cost.costPerStoreWeekGbp
