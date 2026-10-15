"""The training loop under failure: sim crashes (retried, then quarantined), sanity guards on
every run (NaN/inf objective, zero visits, outliers), kills mid-step that resume without
duplicate runs, a budget hit mid-step, and recovery counts carried in the checkpoint."""

from __future__ import annotations

import json
import math

import pytest
from test_agents_fakesim import setup_world  # pytest puts tests/ on sys.path

from backend import cache, llm, settings, store
from backend.agents import rundata, store_owner, training


class Killed(BaseException):
    """Stands in for SIGKILL: no `except Exception` sees it, nothing is checkpointed after it."""


@pytest.fixture
def sim(tmp_path, monkeypatch):
    return setup_world(tmp_path, monkeypatch)


def log_events(run: int | None) -> list[dict]:
    folder = settings.RUNS_DIR / str(run) if run is not None else settings.RUNS_DIR
    path = folder / "llm_log.jsonl"
    return [json.loads(line) for line in path.open()] if path.exists() else []


def all_events() -> list[dict]:
    out = log_events(None)
    for d in settings.RUNS_DIR.iterdir():
        if d.is_dir() and d.name.isdigit():
            out += log_events(int(d.name))
    return out


def break_simulation(sim, numbers: set[int], how) -> None:
    """Make the fake sim's Nth simulations go wrong: raise, or rewrite the result with `how`."""
    real = sim.evaluate
    count = {"n": 0}

    def evaluate(stores, seed):
        count["n"] += 1
        result = real(stores, seed)
        if count["n"] in numbers:
            if isinstance(how, type) and issubclass(how, BaseException):
                raise how(f"sim exploded on simulation {count['n']}")
            return how(result)
        return result

    sim.evaluate = evaluate


def run_dirs() -> list[int]:
    return sorted(int(p.name) for p in settings.RUNS_DIR.iterdir() if p.name.isdigit())


# --- sim crashes -----------------------------------------------------------------------------


def test_a_transient_sim_crash_is_retried_and_the_session_is_unchanged(sim):
    break_simulation(sim, {2}, RuntimeError)
    state = training.train(max_runs=10)
    assert state.stoppedReason == "threshold" and state.runsThisSession == [1, 2, 3]
    assert run_dirs() == [1, 2, 3]  # the retry reused the reserved run id
    [retry] = [e for e in all_events() if e["type"] == "retry" and e["agent"] == "training"]
    assert retry["kind"] == "sim_crash" and retry["attempt"] == 1


def test_a_run_that_keeps_crashing_is_quarantined_and_the_session_moves_on(sim):
    break_simulation(sim, {2, 3}, RuntimeError)
    state = training.train(max_runs=10)
    assert state.state == "stopped" and state.error is None
    assert state.quarantinedRuns == [2] and 2 not in state.runsThisSession
    failed = next(r for r in store.load_index() if r.run == 2)
    assert failed.status == "failed" and "sim exploded" in failed.notebook
    error = store.read_json(store.run_dir(2) / "error.json")
    assert error["attempts"] == 2 and "sim exploded" in error["error"]
    notebook = {e.run: e for e in store.load_notebook()}
    assert notebook[2].line.startswith("Run 2 quarantined") and notebook[2].objectiveValue is None
    assert state.recoveries["quarantined"] == 1
    # the crashed config is never simulated again; the session found other experiments
    assert state.bestRun is not None and state.bestRun != 2
    assert len(state.runsThisSession) >= 2


@pytest.mark.parametrize(
    ("damage", "reason"),
    [
        (lambda r: _with_objective(r, math.nan), "objective is not a finite number"),
        (lambda r: _with_objective(r, math.inf), "objective is not a finite number"),
        (lambda r: _with_visits(r, 0), "zero visits"),
        (lambda r: _with_objective(r, r.summary.objectiveValue * 50), "outlier"),
    ],
)
def test_runs_that_fail_a_sanity_guard_are_quarantined_with_the_reason(sim, damage, reason):
    break_simulation(sim, {2}, damage)
    state = training.train(max_runs=10)
    assert state.quarantinedRuns == [2] and state.bestRun != 2
    note = {e.run: e.line for e in store.load_notebook()}[2]
    assert reason in note
    assert next(r for r in store.load_index() if r.run == 2).status == "failed"
    assert cache.run_lookup(rundata.load_config(2).configHash) is None  # never reused
    assert state.stoppedReason in ("threshold", "max_runs")


def _with_objective(result, value):
    kpis = result.kpis.model_copy(update={"visitsPerKwh": value})
    return result.__class__(
        kpis=kpis,
        stores=result.stores,
        stats=result.stats,
        summary=result.summary.model_copy(update={"kpis": kpis, "objectiveValue": value}),
    )


def _with_visits(result, visits):
    kpis = result.kpis.model_copy(update={"visits": visits, "visitsPerKwh": 0.0})
    return result.__class__(
        kpis=kpis,
        stores=result.stores,
        stats=result.stats,
        summary=result.summary.model_copy(update={"kpis": kpis, "objectiveValue": 0.0}),
    )


def test_an_unusable_baseline_stops_the_session_with_a_clear_error(sim):
    break_simulation(sim, {1}, lambda r: _with_visits(r, 0))
    with pytest.raises(RuntimeError, match="baseline run 1 is not usable: zero visits"):
        training.train(max_runs=10)
    assert store.load_analyst_state().stoppedReason == "error"


# --- kills mid-step: intent before acting, completion after -------------------------------------


def test_a_kill_mid_simulation_resumes_into_the_same_run_id(sim):
    break_simulation(sim, {2}, Killed)
    with pytest.raises(Killed):
        training.train(max_runs=10)
    killed = store.load_analyst_state()
    assert killed.state == "running" and killed.step == "chosen"  # as a SIGKILL leaves it
    intent = store.read_json(training.intent_path())
    assert intent["reservedRun"] == 2  # the intent was recorded before simulating

    state = training.train(max_runs=10)
    assert state.sessionId == killed.sessionId and state.runsThisSession == [1, 2, 3]
    assert run_dirs() == [1, 2, 3] and [r.run for r in store.load_index()] == [1, 2, 3]
    assert state.recoveries["resumed"] == 1


def test_a_kill_after_the_run_finished_reuses_it_without_simulating_again(sim, monkeypatch):
    real_execute = sim.execute_run
    calls = {"n": 0}

    def execute_then_die(*args, **kwargs):
        run = real_execute(*args, **kwargs)
        calls["n"] += 1
        if calls["n"] == 2:
            raise Killed  # the run's files are complete; its completion was never checkpointed
        return run

    monkeypatch.setattr(training.runner, "execute_run", execute_then_die)
    with pytest.raises(Killed):
        training.train(max_runs=10)
    simulations = sim.simulations
    monkeypatch.setattr(training.runner, "execute_run", real_execute)
    state = training.train(max_runs=10)
    assert state.runsThisSession == [1, 2, 3] and run_dirs() == [1, 2, 3]
    assert sim.simulations == simulations + 1 + 2 * len(training.report.EXTRA_SEED_OFFSETS)


def test_a_budget_hit_mid_step_stops_cleanly_and_resumes_at_that_step(sim, monkeypatch):
    real = store_owner.propose_all
    calls = {"n": 0}

    def propose(run, *, session=None, config=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise llm.BudgetExceeded("session budget: the next call would cross it")
        return real(run, session=session, config=config)

    monkeypatch.setattr(store_owner, "propose_all", propose)
    state = training.train(max_runs=10)
    assert state.stoppedReason == "budget" and state.step == "baseline"
    assert state.runsThisSession == [1]
    resumed = training.train(max_runs=10)
    assert resumed.sessionId == state.sessionId and resumed.runsThisSession == [1, 2, 3]


# --- recovery counts ----------------------------------------------------------------------------


def test_recovery_counts_are_checkpointed_and_continue_after_a_resume(sim):
    break_simulation(sim, {2}, RuntimeError)
    first = training.train(max_runs=2)
    assert first.recoveries["retries"] == 1
    llm.reset_recoveries()  # a new process
    second = training.train(max_runs=3)
    assert second.recoveries["retries"] == 1 and second.recoveries["resumed"] == 1
