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
"""

from __future__ import annotations

import traceback
import uuid
from typing import Literal

from backend import cache, llm, settings, store
from backend.agents import analyst, report, rundata, store_owner
from backend.agents.analyst import AnalystBackend
from backend.agents.experiment import AnalystContext, IterationOutcome
from backend.agents.objective import city_value, gain
from backend.agents.rules import check_changes, log_rejections
from backend.contract import MapData, Suggestion, dump
from backend.schemas import AnalystState, NotebookEntry, RunSummary
from backend.sim import runner

AGENT = "training"
ADVICE_WEEKS_PER_SESSION = 1

StopReason = Literal["threshold", "max_runs", "budget", "error"]


def pending_path():
    return settings.RUNS_DIR / "analyst_pending.json"


def train(
    max_runs: int = settings.MAX_RUNS, fresh: bool = False, seed: int = settings.DEFAULT_SEED
) -> AnalystState:
    """Run (or resume) a training session and return its final checkpoint.

    fresh=True starts a new session that reads neither the LLM response cache nor runs from
    earlier sessions; otherwise the last checkpoint is resumed (same seed) and caches are reused.
    """
    cache.set_policy(fresh=fresh)
    backend = analyst.select_backend()
    state = _start_or_resume(fresh, seed, backend.name)
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


def _start_or_resume(fresh: bool, seed: int, backend_name: str) -> AnalystState:
    previous = None if fresh else store.load_analyst_state()
    if previous is not None and previous.seed == seed:
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
    state.bestObjective = _score_of(summary)
    _add_run(state, run)
    store.append_notebook(
        NotebookEntry(
            run=run,
            line=analyst.baseline_notebook_line(summary),
            objectiveValue=state.bestObjective,
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
    proposals = store_owner.propose_all(best, session=state.sessionId)
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
    value = _score_of(rundata.load_summary(run))
    parent_value = _score_of(rundata.load_summary(config.parentRun))
    pending = store.read_json(pending_path(), {}) or {}
    return IterationOutcome(
        run=run,
        parent_run=config.parentRun,
        applied=[Suggestion.model_validate(c) for c in config.appliedChanges],
        objective_value=value,
        gain=gain(value, parent_value, settings.OBJECTIVE),
        is_best=state.bestRun == run,
        hypothesis=pending.get("hypothesis", "") if pending.get("run") == run else "",
    )


def _choose(state: AnalystState, backend: AnalystBackend, map_data: MapData, max_runs: int) -> bool:
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
    changes = [dump(s) for s in result.accepted]
    store.write_json(
        pending_path(),
        {
            "sessionId": state.sessionId,
            "bestRun": best,
            "hypothesis": choice.hypothesis,
            "expectedGain": choice.expected_gain,
            "changes": changes,
        },
    )
    llm.log_event(
        best,
        {
            "agent": "analyst",
            "type": "hypothesis",
            "backend": backend.name,
            "text": choice.hypothesis,
            "expectedGain": choice.expected_gain,
            "changes": changes,
        },
    )
    state.step = "chosen"
    _checkpoint(state)
    return True


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
    value = _score_of(rundata.load_summary(run))
    run_gain = gain(value, state.bestObjective, settings.OBJECTIVE)
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
        NotebookEntry(run=run, line=line, objectiveValue=value, at=store.now_iso())
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
            report.write_reports(state.bestRun, state.baselineRun, session=state.sessionId)
    finally:
        write_session_costs(state)
        _checkpoint(state)


def write_session_costs(state: AnalystState) -> float:
    """Write the session's cost into each session run's summary.json and the run index.

    Returns costPerStoreWeekGbp (see the module docstring for the definition).
    """
    map_data = store.load_map()
    store_weeks = len(rundata.advised_stores(map_data)) * ADVICE_WEEKS_PER_SESSION
    summary_cost = llm.cost_summary(session=state.sessionId, store_weeks=store_weeks)
    for run in state.runsThisSession:
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
