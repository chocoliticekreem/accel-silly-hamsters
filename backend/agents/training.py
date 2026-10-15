"""The training loop: store agents propose, the analyst chooses, the sim runs, repeat until done.

A TrainingConfig (backend/schemas.py: runs/training_config.json, or what the CLI/API passes) sets
the objective, the stop rule (threshold, patience, maxRuns), what may change (levers, storeIds,
maxStoresPerIteration, maxChangesPerStore), the seed, the session's spend cap and the backends.

One training session is a baseline run plus experiment runs, all on the same seed:

  baseline   execute_run(baseline_configs(), seed)
  each iteration, one checkpointed step at a time (AnalystState.step):
    proposed   store agents propose on the current best run (runs/{best}/suggestions.json)
    chosen     the analyst picks changes and states a hypothesis; the hard rules re-check them
               (runs/analyst_pending.json holds the choice until it is scored)
    ran        execute_run(best configs + changes, seed, parent_run=best, applied_changes=...)
    scored     objective vs the best run -> gain, notebook line, best run, low-gain streak
  stop       gain < threshold for patience runs in a row, or the analyst finds nothing left to
             try ("threshold"); maxRuns runs in the session, baseline included ("max_runs");
             the spend cap, llm.check_budget ("budget"); a stop request ("stopped"); an
             exception ("error", re-raised)

A stop request (request_stop, e.g. POST /api/training/stop; or runs/training_stop.flag written by
any process) is honoured at the next step boundary: the step in progress finishes first.

runs/analyst_state.json is written after every step. train() without fresh resumes from it when
the seed and objective match (otherwise a new session starts) and never redoes a completed step;
a run that finished just before a crash comes back from the run cache instead of being simulated
again. A resume under another scope (levers, stores, limits) mid-iteration redoes the iteration.
While a session runs, its process holds runs/training.lock: no other process can take it over.
Hand-offs (analyst -> store agents -> analyst) and every hypothesis are written to the runs'
llm_log.jsonl.

After stopping, the wrap-up: the store agents propose on the best run, so runs/{best}/
suggestions.json holds next week's proposals (after an error too, best effort; the session then
resumes later), reports for the best run, then the session's LLM cost into every session run's
summary.json and costPerStoreWeekGbp into runs/index.json.

Cost per store-week = the session's LLM cost (GBP) / (advised stores x weeks of advice). A
session produces one weekly report per non-club store, so weeks = 1: the figure is what one
store's weekly advice cost to produce.
"""

from __future__ import annotations

import fcntl
import os
import socket
import threading
import traceback
import uuid
from dataclasses import dataclass
from typing import IO

from backend import cache, llm, settings, store
from backend.agents import analyst, report, rundata, store_owner
from backend.agents.analyst import AnalystBackend
from backend.agents.experiment import AnalystContext, IterationOutcome
from backend.agents.objective import gain
from backend.agents.rules import check_changes, log_rejections
from backend.contract import MapData, Suggestion, dump
from backend.schemas import AnalystState, NotebookEntry, StopReason, TrainingConfig
from backend.sim import runner

AGENT = "training"
ADVICE_WEEKS_PER_SESSION = 1
# TrainingConfig fields the store agents' proposals depend on, those the analyst's choice also
# depends on, and those the wrap-up's proposals depend on (an objective change starts a new
# session, so it is in none of them).
PROPOSAL_FIELDS = {"levers", "storeIds", "maxChangesPerStore"}
CHOICE_FIELDS = PROPOSAL_FIELDS | {"maxStoresPerIteration"}
WRAP_UP_FIELDS = PROPOSAL_FIELDS | {"storeAgents"}

_stop = threading.Event()


class SessionBusy(RuntimeError):
    """Another process (CLI or API) is running a training session on the same runs/."""


def pending_path():
    return settings.RUNS_DIR / "analyst_pending.json"


# --- stop requests --------------------------------------------------------------------------


def request_stop() -> None:
    """Ask the running session to stop at its next step boundary: in this process (event) and in
    any other process training on the same runs/ (flag file)."""
    _stop.set()
    store.set_training_stop()


def stop_requested() -> bool:
    return _stop.is_set() or store.training_stop_path().exists()


def _clear_stop() -> None:
    _stop.clear()
    store.clear_training_stop()


# --- the process running a session -----------------------------------------------------------


def _this_process() -> str:
    """The checkpoint's `owner`: names the process in SessionBusy messages."""
    return f"{socket.gethostname()}:{os.getpid()}"


def _lock_runs_dir() -> IO[str]:
    """Lock runs/training.lock for as long as this session runs. The kernel drops the lock when
    the process ends, however it ends (crash, kill -9), so only a live session blocks: one
    writer per checkpoint, whichever process (CLI or API) holds it."""
    path = store.training_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a")  # stays open, and locked, until run() closes it
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        last = store.load_analyst_state()
        who = f"session {last.sessionId} ({last.owner})" if last else "a training session"
        raise SessionBusy(
            f"{who} is still running in another process: stop it first "
            "(POST /api/training/stop, or Ctrl-C in its terminal)"
        ) from None
    return handle


# --- config ---------------------------------------------------------------------------------


def effective_config(
    config: TrainingConfig | None = None,
    *,
    max_runs: int | None = None,
    seed: int | None = None,
) -> TrainingConfig:
    """`config` (default: the saved runs/training_config.json) with max_runs/seed applied."""
    base = config or store.load_training_config()
    overrides = {k: v for k, v in (("maxRuns", max_runs), ("seed", seed)) if v is not None}
    return TrainingConfig.model_validate({**base.model_dump(), **overrides})


# --- session --------------------------------------------------------------------------------


@dataclass
class Session:
    """A started (or resumed) session, checkpointed as running and ready for run()."""

    state: AnalystState
    backend: AnalystBackend
    config: TrainingConfig
    lock: IO[str]  # runs/training.lock, held until run() ends


def begin(
    config: TrainingConfig | None = None,
    *,
    fresh: bool = False,
    max_runs: int | None = None,
    seed: int | None = None,
) -> Session:
    """Start or resume a session and checkpoint it as running. Quick: nothing is simulated yet.

    fresh=True starts a new session that reads neither the LLM response cache nor runs from
    earlier sessions; otherwise the last checkpoint is resumed (see the module docstring) and
    caches are reused. A stop requested before this call is discarded. Raises SessionBusy while
    another process runs a session on the same runs/ (its stop request is left alone): two
    writers would corrupt the checkpoint.
    """
    config = effective_config(config, max_runs=max_runs, seed=seed)
    config.check_store_ids(store.load_map())
    lock = _lock_runs_dir()
    try:
        _clear_stop()
        cache.set_policy(fresh=fresh)
        backend = analyst.select_backend(config.analystBackend)
        state = _start_or_resume(fresh, config, backend.name)
        llm.set_session_budget(state.sessionId, config.sessionBudgetUsd)
    except BaseException:
        lock.close()
        raise
    return Session(state=state, backend=backend, config=config, lock=lock)


def run(session: Session) -> AnalystState:
    """Run a begun session until it stops and return its final checkpoint."""
    try:
        return _run_session(session)
    finally:
        _clear_stop()
        # The cache policy is process-wide: in the API process a fresh session must not leave
        # POST /api/apply ignoring earlier runs after it ends.
        cache.set_policy(fresh=False)
        session.lock.close()  # releases runs/training.lock


def train(
    config: TrainingConfig | None = None,
    *,
    fresh: bool = False,
    max_runs: int | None = None,
    seed: int | None = None,
) -> AnalystState:
    """Run (or resume) a training session and return its final checkpoint.

    `config` defaults to the saved runs/training_config.json (settings when none was saved);
    max_runs and seed, when given, override it.
    """
    return run(begin(config, fresh=fresh, max_runs=max_runs, seed=seed))


def _run_session(session: Session) -> AnalystState:
    state, backend, config = session.state, session.backend, session.config
    reason: StopReason
    try:
        reason = _loop(state, backend, config)
    except llm.BudgetExceeded as e:
        llm.log_event(state.bestRun, {"agent": AGENT, "type": "budget_stop", "error": str(e)})
        reason = "budget"
    except Exception as e:
        state.state = "stopped"
        state.stoppedReason = "error"
        state.error = f"{type(e).__name__}: {e}"
        llm.log_event(
            state.bestRun,
            {"agent": AGENT, "type": "error", "step": state.step, "trace": traceback.format_exc()},
        )
        try:
            backend.close("error")
            _next_week_after_error(state, config)
        finally:
            _checkpoint(state)  # last, as in _finish: "stopped" means its files are written
        raise
    _finish(state, backend, reason, config)
    return state


def _next_week_after_error(state: AnalystState, config: TrainingConfig) -> None:
    """An error stop gets next week's proposals too (the session itself resumes later). Best
    effort and offline: the store agents may be what failed, and an error must not wait on or
    pay for a batch. A failure here is logged; the original error is the one raised."""
    if state.bestRun is None:
        return
    offline = config.model_copy(update={"storeAgents": "heuristic"})
    try:
        _propose_next_week(state, offline, "error")
    except Exception as e:
        llm.log_event(
            state.bestRun,
            {"agent": AGENT, "type": "wrap_up_error", "part": "next_week", "error": repr(e)},
        )


def _resume_blocker(previous: AnalystState, config: TrainingConfig) -> str | None:
    """Why the last session cannot continue under `config` (a different seed or objective would
    compare runs that are not comparable), or None when it can."""
    objective = previous.config.objective if previous.config else settings.OBJECTIVE
    if previous.seed != config.seed:
        return f"seed {previous.seed} -> {config.seed}"
    if objective != config.objective:
        return f"objective {objective} -> {config.objective}"
    return None


def _changed(before: TrainingConfig, after: TrainingConfig, fields: set[str]) -> bool:
    return before.model_dump(include=fields) != after.model_dump(include=fields)


def _rewind_for_a_new_scope(previous: AnalystState, config: TrainingConfig) -> None:
    """Proposals or a pending choice made under other levers, stores or limits must not run.
    Proposals made under another scope are redone (back to the propose step); a choice made
    under other per-experiment limits only is redone from the same proposals."""
    before = previous.config or TrainingConfig()
    if previous.step in ("proposed", "chosen") and _changed(before, config, PROPOSAL_FIELDS):
        rewound = "baseline" if previous.currentRun == previous.baselineRun else "scored"
    elif previous.step == "chosen" and _changed(before, config, CHOICE_FIELDS):
        rewound = "proposed"
    else:
        return
    llm.log_event(
        None,
        {
            "agent": AGENT,
            "type": "rescope",
            "session": previous.sessionId,
            "from": previous.step,
            "to": rewound,
        },
    )
    previous.step = rewound


def _start_or_resume(fresh: bool, config: TrainingConfig, backend_name: str) -> AnalystState:
    previous = None if fresh else store.load_analyst_state()
    blocker = _resume_blocker(previous, config) if previous is not None else None
    if previous is not None and blocker is None:
        _rewind_for_a_new_scope(previous, config)
        if _changed(previous.config or TrainingConfig(), config, WRAP_UP_FIELDS):
            previous.wrappedUp = False  # next week's proposals would differ: redo them at the stop
        previous.state = "running"
        previous.stoppedReason = None
        previous.error = None
        previous.backend = backend_name
        previous.config = config
        previous.owner = _this_process()
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
        seed=config.seed,
        config=config,
        owner=_this_process(),
    )
    _checkpoint(state)
    event = {
        "agent": AGENT,
        "type": "start",
        "session": state.sessionId,
        "fresh": fresh,
        "seed": config.seed,
        "config": config.model_dump(mode="json"),
    }
    if previous is not None:
        event.update(replaces=previous.sessionId, reason=blocker)
    llm.log_event(None, event)
    return state


def _checkpoint(state: AnalystState) -> None:
    state.spentGbp = round(llm.ledger_total_gbp(session=state.sessionId), 4)
    store.save_analyst_state(state)


def _add_run(state: AnalystState, run: int) -> None:
    if run not in state.runsThisSession:
        state.runsThisSession.append(run)
    state.iterations = len(state.runsThisSession)
    cache.policy.session_runs.add(run)


def _stop_reason(state: AnalystState, config: TrainingConfig) -> StopReason | None:
    if state.lowGainStreak >= config.patience:
        return "threshold"
    if len(state.runsThisSession) >= config.maxRuns:
        return "max_runs"
    return None


def _loop(state: AnalystState, backend: AnalystBackend, config: TrainingConfig) -> StopReason:
    map_data = store.load_map()
    while True:
        step = state.step
        # A stop that is due wins over a stop request. At proposed/chosen it catches a resume
        # with a lower maxRuns or patience; at "ran" the run exists, so it is scored first.
        if step in ("baseline", "scored", "proposed", "chosen"):
            reason = _stop_reason(state, config)
            if reason:
                return reason
        if step in ("baseline", "scored"):
            llm.check_budget(state.sessionId)
        if stop_requested():
            llm.log_event(state.bestRun, {"agent": AGENT, "type": "stop_requested", "step": step})
            return "stopped"
        state.wrappedUp = False  # this step changes what the wrap-up would write
        if step == "start":
            _baseline(state, config)
        elif step in ("baseline", "scored"):
            _propose(state, config)
        elif step == "proposed":
            if not _choose(state, backend, map_data, config):
                return "threshold"
        elif step == "chosen":
            _run(state, map_data, config)
        elif step == "ran":
            _score(state, backend, config)
        else:
            raise RuntimeError(f"unknown checkpoint step {step!r}")


def _baseline(state: AnalystState, config: TrainingConfig) -> None:
    run = runner.execute_run(runner.baseline_configs(), state.seed)
    summary = rundata.load_summary(run)
    state.baselineRun = state.currentRun = state.bestRun = run
    state.bestObjective = rundata.objective_value(run, config.objective)
    _add_run(state, run)
    store.append_notebook(
        NotebookEntry(
            run=run,
            line=analyst.baseline_notebook_line(summary),
            objectiveValue=state.bestObjective,
            at=store.now_iso(),
            objective=config.objective,
        )
    )
    state.step = "baseline"
    _checkpoint(state)


def _propose(state: AnalystState, config: TrainingConfig) -> None:
    best = state.bestRun
    assert best is not None
    llm.log_event(
        best,
        {"agent": "analyst", "type": "handoff", "to": "store_agents", "run": best},
    )
    proposals = store_owner.propose_all(best, session=state.sessionId, config=config)
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


def _last_outcome(state: AnalystState, config: TrainingConfig) -> IterationOutcome | None:
    """The measured result of the latest experiment, rebuilt from run files (survives restarts)."""
    run = state.currentRun
    if run is None or run == state.baselineRun:
        return None
    run_config = rundata.load_config(run)
    if run_config.parentRun is None:
        return None
    value = rundata.objective_value(run, config.objective)
    parent_value = rundata.objective_value(run_config.parentRun, config.objective)
    pending = store.read_json(pending_path(), {}) or {}
    return IterationOutcome(
        run=run,
        parent_run=run_config.parentRun,
        applied=[Suggestion.model_validate(c) for c in run_config.appliedChanges],
        objective_value=value,
        gain=gain(value, parent_value, config.objective),
        is_best=state.bestRun == run,
        hypothesis=pending.get("hypothesis", "") if pending.get("run") == run else "",
    )


def _choose(
    state: AnalystState, backend: AnalystBackend, map_data: MapData, config: TrainingConfig
) -> bool:
    best = state.bestRun
    assert best is not None and state.bestObjective is not None
    base = rundata.load_config(best).stores
    ctx = AnalystContext(
        session=state.sessionId,
        seed=state.seed,
        objective=config.objective,
        run_number=len(state.runsThisSession) + 1,
        max_runs=config.maxRuns,
        best_run=best,
        best_objective=state.bestObjective,
        base_configs=base,
        proposals=rundata.load_suggestions(best),  # made under this scope (see the rewind)
        map_data=map_data,
        notebook=store.load_notebook(),
        last_outcome=_last_outcome(state, config),
        config=config,
    )
    choice = backend.choose(ctx)
    result = check_changes(base, choice.changes, map_data, training=config)
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


def _run(state: AnalystState, map_data: MapData, config: TrainingConfig) -> None:
    pending = _load_pending(state)
    parent = pending["bestRun"]
    changes = [Suggestion.model_validate(c) for c in pending["changes"]]
    # Checked when chosen, under this scope (a resume under another one rewinds first); a crash
    # after the run finished leaves its config already "tried".
    result = check_changes(
        rundata.load_config(parent).stores, changes, map_data, check_tried=False, training=config
    )
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


def _score(state: AnalystState, backend: AnalystBackend, config: TrainingConfig) -> None:
    pending = _load_pending(state)
    run = state.currentRun
    assert run is not None and state.bestObjective is not None
    value = rundata.objective_value(run, config.objective)
    run_gain = gain(value, state.bestObjective, config.objective)
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
            run=run, line=line, objectiveValue=value, at=store.now_iso(), objective=config.objective
        )
    )
    if outcome.is_best:
        state.bestRun, state.bestObjective = run, value
    state.lowGainStreak = state.lowGainStreak + 1 if run_gain < config.threshold else 0
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


def _finish(
    state: AnalystState, backend: AnalystBackend, reason: StopReason, config: TrainingConfig
) -> None:
    """The wrap-up (next week's proposals, reports), costs, then the "stopped" checkpoint. It
    comes last (in `finally`, so it is written even when a report fails), so "stopped" means
    every file of the session is written and a new session cannot start over the wrap-up. A
    session resumed only to stop again (nothing ran, same config) skips the wrap-up it already
    has, so a repeated start costs no new store-agent batch."""
    state.state = "stopped"
    state.stoppedReason = reason
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
        if not state.wrappedUp:
            _wrap_up(state, config, reason)
            state.wrappedUp = True
    finally:
        try:
            write_session_costs(state)
        finally:
            _checkpoint(state)


def _wrap_up(state: AnalystState, config: TrainingConfig, reason: StopReason) -> None:
    """Next week's proposals and the owner reports for the best run. Each runs even when the
    other fails; a failure of the proposals is logged and raised after the reports."""
    best, baseline = state.bestRun, state.baselineRun
    if best is None:
        return
    failure: Exception | None = None
    try:
        _propose_next_week(state, config, reason)
    except Exception as e:
        failure = e
        llm.log_event(
            best, {"agent": AGENT, "type": "wrap_up_error", "part": "next_week", "error": repr(e)}
        )
    if baseline is not None:
        report.write_reports(best, baseline, session=state.sessionId, objective=config.objective)
    if failure is not None:
        raise failure


def _propose_next_week(state: AnalystState, config: TrainingConfig, reason: StopReason) -> None:
    """Store agents on the best run, so runs/{best}/suggestions.json (shown on the store card)
    holds next week's proposals instead of nothing (a best run found by the last experiment was
    never proposed on). Skipped when the session stopped right after proposing on the best run.
    Never spends past the cap: after a budget stop, or if the cap is reached here, the offline
    heuristic proposes."""
    best = state.bestRun
    assert best is not None
    if state.step == "proposed":
        return
    offline = config.model_copy(update={"storeAgents": "heuristic"})
    try:
        proposals = store_owner.propose_all(
            best, session=state.sessionId, config=offline if reason == "budget" else config
        )
    except llm.BudgetExceeded as e:
        llm.log_event(best, {"agent": AGENT, "type": "budget_fallback", "error": str(e)})
        proposals = store_owner.propose_all(best, session=state.sessionId, config=offline)
    llm.log_event(
        best,
        {
            "agent": AGENT,
            "type": "next_week_proposals",
            "run": best,
            "proposals": len(proposals),
            "stores": len({p.storeId for p in proposals}),
        },
    )


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
