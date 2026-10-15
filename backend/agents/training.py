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
the seed, objective and shop match (otherwise a new session starts) and never redoes a completed
step; a run that finished just before a crash comes back from the run cache instead of being
simulated again. A resume under another scope (levers, stores, limits) mid-iteration redoes the
iteration. While a session runs, its process holds runs/training.lock: no other process can take
it over. Hand-offs (analyst -> store agents -> analyst) and every hypothesis are written to the
runs' llm_log.jsonl.

After stopping, the wrap-up: the store agents propose on the best run, so runs/{best}/
suggestions.json holds next week's proposals (after an error too, best effort; the session then
resumes later), reports for the best run, then the session's LLM cost into every session run's
summary.json and costPerStoreWeekGbp into runs/index.json.

Cost per store-week = the session's LLM cost (GBP) / (advised stores x weeks of advice). A
session produces one weekly report per non-club store, so weeks = 1: the figure is what one
store's weekly advice cost to produce.

One-shop sessions (train(scope_store=...), POST /api/stores/{id}/optimize) are a TrainingConfig
with storeIds=[that store] and objective storeProfitGbp (effective_config), run by the same loop:
only that store's agent proposes and only its settings change, the objective is its profit change
per week vs the baseline (gain = change / the shop's weekly margin), the choice ranks its
proposals by expected GBP/week (_choose_for_store: the area analyst's prompts and tools are
area-wide, so no analyst LLM is called), the notebook stays area-level, reports are written for
that store only, and the shared baseline run keeps its area session's cost. A finished one-shop
session is never resumed: "optimise again" starts a new one.
"""

from __future__ import annotations

import fcntl
import math
import os
import socket
import threading
import traceback
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import combinations
from typing import IO, Any

from backend import cache, chaos, economics, llm, settings, store
from backend.agents import analyst, report, rundata, store_owner
from backend.agents.analyst import AnalystBackend
from backend.agents.experiment import AnalystContext, IterationOutcome
from backend.agents.objective import STORE_PROFIT, gain
from backend.agents.rules import check_changes, log_rejections
from backend.agents.wording import change_label, clamp_words
from backend.contract import MapData, RunListItem, StoreType, Suggestion, dump
from backend.schemas import AnalystState, NotebookEntry, StopReason, StoreConfig, TrainingConfig
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


def intent_path():
    """runs/training_intent.json: the run id reserved for the simulation in progress, written
    before it starts, so a kill mid-run resumes into the same id (no duplicate runs)."""
    return settings.RUNS_DIR / "training_intent.json"


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


def lock_held() -> bool:
    """True while some live process (this one included) holds runs/training.lock."""
    handle = _try_lock()
    if handle is None:
        return True
    handle.close()
    return False


def _try_lock() -> IO[str] | None:
    path = store.training_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def heartbeat_path():
    """runs/training_heartbeat.json: who holds the session and when it last checkpointed. The
    flock is the authority on liveness (the kernel drops it with the process); the heartbeat
    names the holder for takeover events and the API."""
    return settings.RUNS_DIR / "training_heartbeat.json"


def _heartbeat(state: AnalystState) -> None:
    store.write_json(
        heartbeat_path(),
        {
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "sessionId": state.sessionId,
            "step": state.step,
            "at": store.now_iso(),
        },
    )


# A checkpoint stamped this far in the future came from a clock that runs fast (or was skewed):
# its age says nothing about liveness.
CLOCK_SKEW_SECONDS = 300


def checkpoint_age_seconds(state: AnalystState) -> float | None:
    try:
        updated = datetime.strptime(state.updatedAt, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None
    return (datetime.now(UTC) - updated).total_seconds()


def reconcile_stale(grace_seconds: float = 60.0) -> AnalystState | None:
    """A checkpoint reads "running" but no live process holds the lock (the trainer crashed or
    was killed, or the API restarted under it): mark it stopped with stoppedReason "error" so the
    UI stops showing a ghost session; the next start resumes it. A checkpoint younger than
    grace_seconds is left alone (a session between its first checkpoint and taking the lock),
    unless its timestamp is in the future beyond CLOCK_SKEW_SECONDS. Holds the lock while it
    writes, so it can never overwrite a trainer. Returns the reconciled state, or None."""
    if settings.READ_ONLY:  # the hosted demo replays files it must not rewrite
        return None
    state = store.load_analyst_state()
    if state is None or state.state != "running":
        return None
    age = checkpoint_age_seconds(state)
    if age is not None and -CLOCK_SKEW_SECONDS <= age < grace_seconds:
        return None
    handle = _try_lock()
    if handle is None:
        return None  # its trainer is alive
    try:
        state = store.load_analyst_state()  # re-read under the lock
        if state is None or state.state != "running":
            return None
        state.state, state.stoppedReason = "stopped", "error"
        state.error = (
            f"the process running this session ({state.owner}) ended without stopping (crash, "
            f"kill or restart); start training to resume after step {state.step}"
        )
        llm.load_recoveries(state.sessionId, state.recoveries)
        llm.record_recovery(
            "reconcile",
            agent=AGENT,
            session=state.sessionId,
            kind="stale_running",
            owner=state.owner,
            lastCheckpoint=state.updatedAt,
            outcome="marked stopped; resumable",
        )
        state.recoveries = llm.recovery_counts(state.sessionId)
        store.save_analyst_state(state)
        return state
    finally:
        handle.close()


def _note_takeover(previous: AnalystState | None, beat: dict, state: AnalystState) -> None:
    """This process took the lock over a checkpoint another process left "running": that
    process is dead (the kernel released its lock). Logged with what its heartbeat said."""
    if previous is None or previous.state != "running" or beat.get("pid") in (None, os.getpid()):
        return
    llm.record_recovery(
        "lock_takeover",
        agent=AGENT,
        session=state.sessionId,
        kind="dead_holder",
        previousPid=beat.get("pid"),
        previousHost=beat.get("host"),
        lastHeartbeat=beat.get("at"),
        outcome="taken over",
    )


# --- config ---------------------------------------------------------------------------------


def effective_config(
    config: TrainingConfig | None = None,
    *,
    max_runs: int | None = None,
    seed: int | None = None,
    scope_store: str | None = None,
) -> TrainingConfig:
    """`config` (default: the saved runs/training_config.json) with max_runs/seed applied. With
    scope_store: the one-shop session for that store (only it takes part, objective
    storeProfitGbp, the deterministic choice); levers, limits, stop rule and budget stay."""
    base = config or store.load_training_config()
    overrides: dict[str, Any] = {
        k: v for k, v in (("maxRuns", max_runs), ("seed", seed)) if v is not None
    }
    if scope_store is not None:
        overrides.update(storeIds=[scope_store], objective=STORE_PROFIT, analystBackend="heuristic")
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
    scope_store: str | None = None,
) -> Session:
    """Start or resume a session and checkpoint it as running. Quick: nothing is simulated yet.

    fresh=True starts a new session that reads neither the LLM response cache nor runs from
    earlier sessions; otherwise the last checkpoint is resumed (see the module docstring) and
    caches are reused. A stop requested before this call is discarded. Raises SessionBusy while
    another process runs a session on the same runs/ (its stop request is left alone): two
    writers would corrupt the checkpoint.
    """
    config = effective_config(config, max_runs=max_runs, seed=seed, scope_store=scope_store)
    config.check_store_ids(store.load_map())
    lock = _lock_runs_dir()
    try:
        _clear_stop()
        cache.set_policy(fresh=fresh)
        backend = analyst.select_backend(
            "heuristic" if config.scope_store else config.analystBackend
        )
        previous, beat = store.load_analyst_state(), store.read_json(heartbeat_path()) or {}
        state = _start_or_resume(fresh, config, backend.name)
        _note_takeover(previous, beat, state)
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
    scope_store: str | None = None,
) -> AnalystState:
    """Run (or resume) a training session and return its final checkpoint.

    `config` defaults to the saved runs/training_config.json (settings when none was saved);
    max_runs and seed, when given, override it. scope_store runs a one-shop session for that
    store (effective_config; POST /api/stores/{id}/optimize).
    """
    session = begin(config, fresh=fresh, max_runs=max_runs, seed=seed, scope_store=scope_store)
    return run(session)


def start_store_session(store_id: str) -> AnalystState:
    """Checkpoint a new one-shop session for `store_id` as running (step "start") without running
    it, so the API can answer with its status at once; train(scope_store=store_id) then resumes
    it."""
    return _new_session(effective_config(scope_store=store_id), False, "heuristic")


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
    """Why the last session cannot continue under `config` (a different seed, objective or shop
    would compare runs that are not comparable; a one-shop session that finished is done), or
    None when it can."""
    objective = previous.config.objective if previous.config else settings.OBJECTIVE
    if previous.seed != config.seed:
        return f"seed {previous.seed} -> {config.seed}"
    if objective != config.objective:
        return f"objective {objective} -> {config.objective}"
    if previous.scopeStore != config.scope_store:
        return f"store {previous.scopeStore} -> {config.scope_store}"
    if config.scope_store is not None and previous.state != "running":
        return "a finished one-shop session is not resumed"
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
        llm.load_recoveries(previous.sessionId, previous.recoveries)
        llm.record_recovery(
            "resume",
            agent=AGENT,
            session=previous.sessionId,
            step=previous.step,
            runs=previous.runsThisSession,
            kind="restart",
            outcome=f"continuing after step {previous.step}",
        )
        _checkpoint(previous)
        return previous
    return _new_session(config, fresh, backend_name, replaces=previous, reason=blocker)


def _new_session(
    config: TrainingConfig,
    fresh: bool,
    backend_name: str,
    *,
    replaces: AnalystState | None = None,
    reason: str | None = None,
) -> AnalystState:
    now = store.now_iso()
    state = AnalystState(
        sessionId=uuid.uuid4().hex[:12],
        state="running",
        startedAt=now,
        updatedAt=now,
        backend=backend_name,
        fresh=fresh,
        seed=config.seed,
        scopeStore=config.scope_store,
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
    if config.scope_store is not None:
        event["scope"] = "store"
    if replaces is not None:
        event.update(replaces=replaces.sessionId, reason=reason)
    llm.log_event(None, event)
    return state


def _checkpoint(state: AnalystState) -> None:
    state.spentGbp = round(llm.ledger_total_gbp(session=state.sessionId), 4)
    state.recoveries = llm.recovery_counts(state.sessionId)
    store.save_analyst_state(state)
    _heartbeat(state)
    chaos.after_checkpoint()  # CHAOS kill_after_step:N


# --- objective ------------------------------------------------------------------------------


def _shop_type(store_id: str) -> StoreType:
    return rundata.store_types(store.load_map())[store_id]


def _objective_value(state: AnalystState, config: TrainingConfig, run: int) -> float:
    """The session objective for `run`: rundata.objective_value, or (one-shop session) the shop's
    profit change per week vs the session baseline."""
    sid, base = config.scope_store, state.baselineRun
    if sid is None:
        return rundata.objective_value(run, config.objective)
    if base is None or run == base:
        return 0.0
    before, after = rundata.load_stores(base)[sid].kpis, rundata.load_stores(run)[sid].kpis
    return economics.profit_vs(_shop_type(sid), before, after, economics.area_price_gbp_per_kwh())


def _shop_scale(state: AnalystState, config: TrainingConfig) -> float:
    """GBP that count as a 100% gain in a one-shop session: the shop's weekly margin at the
    baseline (at least GBP 1), so the threshold reads as a share of what the shop keeps."""
    sid, base = config.scope_store, state.baselineRun
    assert sid is not None and base is not None
    kpis = rundata.load_stores(base)[sid].kpis
    return max(economics.weekly_margin_gbp(_shop_type(sid), kpis), 1.0)


def _gain(state: AnalystState, config: TrainingConfig, new: float, reference: float) -> float:
    if config.scope_store is None:
        return gain(new, reference, config.objective)
    return (new - reference) / _shop_scale(state, config)


def _notebook_entry(config: TrainingConfig, run: int, line: str, value: float) -> NotebookEntry:
    """The notebook is area-level in every session: a one-shop session notes the run's area
    value on settings.OBJECTIVE, not the shop's profit."""
    objective: str = config.objective
    if config.scope_store is not None:
        objective = settings.OBJECTIVE
        value = rundata.objective_value(run, objective)
    return NotebookEntry(
        run=run, line=line, objectiveValue=value, at=store.now_iso(), objective=objective
    )


# --- the loop -------------------------------------------------------------------------------


def _add_run(state: AnalystState, run: int) -> None:
    if run not in state.runsThisSession:
        state.runsThisSession.append(run)
    state.iterations = len(state.runsThisSession)
    cache.policy.session_runs.add(run)


def _stop_reason(state: AnalystState, config: TrainingConfig) -> StopReason | None:
    if state.lowGainStreak >= config.patience:
        return "threshold"
    if len(state.runsThisSession) + len(state.quarantinedRuns) >= config.maxRuns:
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
        llm.reset_breaker()  # a breaker opened in one step degrades that step only
        llm.set_step(step)
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
    configs = runner.baseline_configs()
    run = _simulate(state, configs)
    if run is None:
        raise RuntimeError("the baseline run crashed on every attempt (quarantined)")
    reason = _sanity(state, config, run, reference=None)
    if reason is not None:
        raise RuntimeError(f"baseline run {run} is not usable: {reason}")
    summary = rundata.load_summary(run)
    state.baselineRun = state.currentRun = state.bestRun = run
    state.bestObjective = _objective_value(state, config, run)
    _add_run(state, run)
    line = analyst.baseline_notebook_line(summary)
    store.append_notebook(_notebook_entry(config, run, line, state.bestObjective))
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
    value = _objective_value(state, config, run)
    parent_value = _objective_value(state, config, run_config.parentRun)
    pending = store.read_json(pending_path(), {}) or {}
    return IterationOutcome(
        run=run,
        parent_run=run_config.parentRun,
        applied=[Suggestion.model_validate(c) for c in run_config.appliedChanges],
        objective_value=value,
        gain=_gain(state, config, value, parent_value),
        is_best=state.bestRun == run,
        hypothesis=pending.get("hypothesis", "") if pending.get("run") == run else "",
    )


def _choose(
    state: AnalystState, backend: AnalystBackend, map_data: MapData, config: TrainingConfig
) -> bool:
    best = state.bestRun
    assert best is not None and state.bestObjective is not None
    # The participating stores' proposals, made under this scope (see the rewind); a frozen
    # store's suggestions on the run stay in the file for its store card.
    proposals = [p for p in rundata.load_suggestions(best) if config.takes_part(p.storeId)]
    if config.scope_store is not None:
        return _choose_for_store(state, config, map_data, proposals)
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
        proposals=proposals,
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


# One-shop sessions test ideas down to this estimated loss; the patience rule ends the exploring.
EXPLORE_GBP_PER_WEEK = 200.0


def _choose_for_store(
    state: AnalystState, config: TrainingConfig, map_data: MapData, proposals: list[Suggestion]
) -> bool:
    """One-shop session: the untried set of up to maxChangesPerStore of the shop's proposals
    with the highest expected profit per week (expectedDelta on the best run's numbers,
    economics.gbp_per_week) that passes the rules. Only this shop's config changes; every other
    store keeps the best run's (= the baseline's) settings."""
    sid, best = config.scope_store, state.bestRun
    assert sid is not None and best is not None
    files = rundata.RunFiles.load(best)
    kind, price = _shop_type(sid), economics.area_price_gbp_per_kwh()
    shop = files.stores[sid]
    kpis = shop.kpis

    def expected_gbp(option: tuple[Suggestion, ...]) -> float:
        d_visits = sum(c.expectedDelta.visits for c in option) * kpis.visits
        d_kwh = sum(c.expectedDelta.kwh for c in option) * kpis.kwh
        d_hours = sum(economics.suggestion_open_hours_delta(shop, c) for c in option)
        return economics.gbp_per_week(kind, d_visits, d_kwh, d_hours, price)

    options = [
        option
        for size in range(1, config.maxChangesPerStore + 1)
        for option in combinations(proposals, size)
    ]
    ranked = sorted(
        (o for o in options if expected_gbp(o) > -EXPLORE_GBP_PER_WEEK),
        key=lambda o: -expected_gbp(o),
    )
    for option in ranked:
        result = check_changes(files.config.stores, list(option), map_data, training=config)
        if result.rejections:
            continue
        if cache.run_lookup(cache.run_key(result.configs, state.seed)) is not None:
            continue
        gbp = expected_gbp(option)
        labels = ", ".join(change_label(c) for c in result.accepted)
        hypothesis = (
            f"{labels} should add about £{gbp:.0f} a week for this shop"
            if gbp > 0
            else f"{labels} is worth testing: the estimate is £{gbp:.0f} a week, the 14 days decide"
        )
        scale = _shop_scale(state, config)
        _commit_choice(state, result.accepted, hypothesis, gbp / scale, "heuristic")
        return True
    llm.log_event(
        best,
        {
            "agent": "analyst",
            "type": "no_experiment",
            "reason": "Nothing untried is worth testing for this shop: no change should be made",
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
    run = _simulate(state, result.configs, parent_run=parent, applied_changes=pending["changes"])
    if run is None:  # crashed on every attempt: quarantined, and the iteration counts as no gain
        state.lowGainStreak += 1
        state.step = "scored"
        _checkpoint(state)
        return
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
    reason = _sanity(state, config, run, reference=state.bestObjective)
    if reason is not None:
        state.runsThisSession.remove(run)
        state.iterations = len(state.runsThisSession)
        state.currentRun = pending["bestRun"]
        _quarantine(state, config, run, reason, rundata.load_config(run).stores, attempts=1)
        state.lowGainStreak += 1
        state.step = "scored"
        _checkpoint(state)
        return
    value = _objective_value(state, config, run)
    run_gain = _gain(state, config, value, state.bestObjective)
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
    store.append_notebook(_notebook_entry(config, run, line, value))
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


# --- simulation: intent, retries, sanity guards, quarantine ----------------------------------


def _execute(configs: dict[str, StoreConfig], seed: int, **kwargs: Any) -> int:
    """runner.execute_run behind the chaos seam (CHAOS sim_crash / sim_nan / sim_zero)."""
    if chaos.fires("sim_crash"):
        raise RuntimeError("chaos: simulated sim crash")
    run = runner.execute_run(configs, seed, **kwargs)
    if kwargs.get("parent_run") is None:
        return run  # a corrupt baseline stops the session by design (tested on its own)
    nan, zero = chaos.fires("sim_nan"), chaos.fires("sim_zero")
    if nan or zero:
        path = store.run_dir(run) / "summary.json"
        summary = store.read_json(path)
        if nan:
            summary["objectiveValue"] = math.nan
            summary["kpis"]["visitsPerKwh"] = math.nan
        else:
            summary["kpis"]["visits"] = 0
        store.write_json(path, summary)
    return run


def _simulate(state: AnalystState, configs: dict[str, StoreConfig], **kwargs: Any) -> int | None:
    """Simulate with intent and retries. The run id is reserved and recorded (training_intent
    .json) before the sim starts, so a kill mid-run resumes into the same id and a run that
    finished before the kill comes back from the run cache. A crash is retried (SIM_ATTEMPTS);
    a run that crashes on every attempt is quarantined and None returned."""
    key = cache.run_key(configs, state.seed)
    intent = store.read_json(intent_path()) or {}
    if intent.get("sessionId") == state.sessionId and intent.get("key") == key:
        reserved = int(intent["reservedRun"])
        store.run_dir(reserved).mkdir(parents=True, exist_ok=True)
    else:
        reserved = store.reserve_run_id()
        store.write_json(
            intent_path(), {"sessionId": state.sessionId, "key": key, "reservedRun": reserved}
        )
    error: Exception | None = None
    for attempt in range(1, settings.SIM_ATTEMPTS + 1):
        try:
            run = _execute(configs, state.seed, run_id=reserved, **kwargs)
        except Exception as e:
            error = e
            if attempt < settings.SIM_ATTEMPTS:
                llm.record_recovery(
                    "retry",
                    agent=AGENT,
                    run=reserved,
                    session=state.sessionId,
                    kind="sim_crash",
                    attempt=attempt,
                    wait=0.0,
                    outcome="simulating again",
                    error=f"{type(e).__name__}: {str(e)[:200]}",
                )
            continue
        if run != reserved:  # a run-cache hit: the reserved id was never used
            _release(reserved)
        return run
    assert error is not None
    reason = f"crashed {settings.SIM_ATTEMPTS} times: {type(error).__name__}: {error}"
    _quarantine(state, state.config, reserved, reason, configs, attempts=settings.SIM_ATTEMPTS)
    return None


def _release(run: int) -> None:
    directory = store.run_dir(run)
    try:
        directory.rmdir()  # only when empty: never touch a run with files
    except OSError:
        pass


def _sanity(
    state: AnalystState, config: TrainingConfig, run: int, *, reference: float | None
) -> str | None:
    """Why `run` must not be trusted (None when it can): unreadable files, zero visits, a NaN or
    infinite objective, or an implausible jump vs the best run (MAX_PLAUSIBLE_GAIN)."""
    try:
        summary = rundata.load_summary(run)
        value = _objective_value(state, config, run)
    except (OSError, ValueError) as e:
        return f"unreadable run files: {type(e).__name__}"
    if summary.kpis.visits <= 0:
        return "zero visits"
    if not math.isfinite(value):
        return "objective is not a finite number"
    if reference is not None:
        run_gain = _gain(state, config, value, reference)
        if not math.isfinite(run_gain) or abs(run_gain) > settings.MAX_PLAUSIBLE_GAIN:
            return f"outlier: {run_gain:+.0%} vs the best run"
    return None


def _quarantine(
    state: AnalystState,
    config: TrainingConfig | None,
    run: int,
    reason: str,
    configs: dict[str, StoreConfig],
    *,
    attempts: int,
) -> None:
    """Mark `run` failed and keep its files: index status "failed" with the reason, error.json,
    a notebook line, out of the run cache (its configs count as tried), a recovery event."""
    try:
        key = rundata.load_config(run).configHash or cache.run_key(configs, state.seed)
    except (OSError, ValueError):
        key = cache.run_key(configs, state.seed)
    cache.run_quarantine(key, run, configs)
    store.write_json(
        store.run_dir(run) / "error.json",
        {
            "run": run,
            "session": state.sessionId,
            "error": reason,
            "attempts": attempts,
            "at": store.now_iso(),
        },
    )
    objective = config.objective if config is not None else settings.OBJECTIVE
    line = clamp_words(f"Run {run} quarantined: {reason}", analyst.NOTEBOOK_WORDS)
    store.append_notebook(
        NotebookEntry(
            run=run, line=line, objectiveValue=None, at=store.now_iso(), objective=objective
        )
    )
    note = f"Quarantined: {reason}"[:240]
    if any(item.run == run for item in store.load_index()):
        store.update_index(run, status="failed", notebook=note)
    else:
        store.upsert_index(
            RunListItem(
                run=run,
                seed=state.seed,
                status="failed",
                kpis=None,
                notebook=note,
                createdAt=store.now_iso(),
            )
        )
    if run not in state.quarantinedRuns:
        state.quarantinedRuns.append(run)
    llm.record_recovery(
        "quarantine",
        agent=AGENT,
        run=run,
        session=state.sessionId,
        kind="sim_crash" if attempts > 1 else "sanity_guard",
        attempt=attempts,
        outcome="run failed, files kept, session continues",
        error=reason[:240],
    )


# --- stop and wrap-up -----------------------------------------------------------------------


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
            write_session_costs(state, config)
        finally:
            _checkpoint(state)


def _wrap_up(state: AnalystState, config: TrainingConfig, reason: StopReason) -> None:
    """Next week's proposals and the owner reports for the best run (a one-shop session: its
    store's only). Each runs even when the other fails; a failure of the proposals is logged and
    raised after the reports."""
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
        report.write_reports(
            best,
            baseline,
            session=state.sessionId,
            store_ids=None if config.scope_store is None else {config.scope_store},
            objective=config.objective,
        )
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


def write_session_costs(state: AnalystState, config: TrainingConfig) -> float:
    """Write the session's cost into each session run's summary.json and the run index.

    Returns costPerStoreWeekGbp (see the module docstring for the definition).
    """
    map_data = store.load_map()
    advised = 1 if config.scope_store else len(rundata.advised_stores(map_data))
    store_weeks = advised * ADVICE_WEEKS_PER_SESSION
    summary_cost = llm.cost_summary(session=state.sessionId, store_weeks=store_weeks)
    runs = state.runsThisSession
    if config.scope_store:  # the shared baseline run keeps its area session's cost
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
