"""One trainer at a time: the session lock with its heartbeat, safe takeover from a dead holder,
and reconciling a "running" checkpoint that no live process owns (crash, kill, clock skew)."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from test_agents_fakesim import setup_world  # pytest puts tests/ on sys.path
from test_agents_training import lock_held_elsewhere

from backend import llm, settings, store
from backend.agents import training
from backend.api.routers import stores as stores_router
from backend.schemas import AnalystState


@pytest.fixture
def sim(tmp_path, monkeypatch):
    return setup_world(tmp_path, monkeypatch)


def iso(delta_seconds: float) -> str:
    return (datetime.now(UTC) + timedelta(seconds=delta_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def running_state(updated: str, step: str = "proposed") -> AnalystState:
    return AnalystState(
        sessionId="dead",
        state="running",
        startedAt=updated,
        updatedAt=updated,
        backend="heuristic",
        fresh=False,
        seed=42,
        step=step,
        owner="otherhost:999",
    )


def save_raw(state: AnalystState) -> None:
    """Write the checkpoint as a dead process left it (save_analyst_state stamps updatedAt)."""
    store.write_json(store.analyst_state_path(), state, backup=True)


def events() -> list[dict]:
    path = settings.RUNS_DIR / "llm_log.jsonl"
    return [json.loads(line) for line in path.open()] if path.exists() else []


def test_the_heartbeat_names_the_holder_and_moves_with_every_checkpoint(sim):
    beats = []
    real = training._heartbeat

    def spy(state):
        real(state)
        beats.append(store.read_json(training.heartbeat_path()))

    training._heartbeat = spy
    try:
        training.train(max_runs=2)
    finally:
        training._heartbeat = real
    assert len(beats) >= 4
    assert {b["pid"] for b in beats} == {training.os.getpid()}
    assert [b["step"] for b in beats][:2] == ["start", "baseline"]


def test_a_lock_left_by_a_killed_trainer_is_taken_over_and_logged(sim):
    save_raw(running_state(iso(-5), step="start"))
    store.write_json(training.heartbeat_path(), {"pid": 999, "host": "otherhost", "at": iso(-5)})
    with lock_held_elsewhere(store.training_lock_path()):
        with pytest.raises(training.SessionBusy):
            training.train(max_runs=2)
    # the holder was SIGKILLed: the kernel dropped its lock, so the next trainer takes over
    state = training.train(max_runs=2)
    assert state.stoppedReason == "max_runs"
    [takeover] = [e for e in events() if e["type"] == "lock_takeover"]
    assert takeover["previousPid"] == 999 and takeover["outcome"] == "taken over"


def test_reconcile_marks_a_dead_running_session_stopped(sim):
    save_raw(running_state(iso(-600)))
    state = training.reconcile_stale()
    assert state is not None and state.state == "stopped" and state.stoppedReason == "error"
    assert "ended without stopping" in (state.error or "")
    assert store.load_analyst_state().state == "stopped"
    [event] = [e for e in events() if e["type"] == "reconcile"]
    assert event["outcome"] == "marked stopped; resumable"


def test_reconcile_leaves_a_session_whose_trainer_is_alive(sim):
    save_raw(running_state(iso(-600)))
    with lock_held_elsewhere(store.training_lock_path()):
        assert training.reconcile_stale() is None
        assert store.load_analyst_state().state == "running"


def test_reconcile_waits_out_a_session_that_is_just_starting(sim):
    save_raw(running_state(iso(-2)))  # checkpointed, its trainer not yet holding the lock
    assert training.reconcile_stale(grace_seconds=60) is None
    assert training.reconcile_stale(grace_seconds=0) is not None


def test_a_checkpoint_from_a_clock_far_ahead_is_still_reconciled(sim):
    save_raw(running_state(iso(+3 * 3600)))  # written by a machine whose clock runs fast
    assert training.reconcile_stale(grace_seconds=60) is not None


def test_a_resumed_session_after_reconcile_continues_where_it_was(sim):
    first = training.train(max_runs=2)
    stale = first.model_copy(update={"state": "running", "stoppedReason": None})
    save_raw(stale.model_copy(update={"updatedAt": iso(-600)}))
    training.reconcile_stale()
    resumed = training.train(max_runs=3)
    assert resumed.sessionId == first.sessionId and resumed.runsThisSession == [1, 2, 3]


def test_the_api_reconciles_on_startup_and_serves_recovery_counts(sim):
    from backend.api.main import app

    state = running_state(iso(-600)).model_copy(update={"recoveries": {"retries": 3}})
    save_raw(state)
    with TestClient(app) as client:  # runs the startup hook
        body = client.get("/api/agents/session").json()
    assert body["state"] == "stopped" and body["stoppedReason"] == "error"
    assert body["recoveries"]["retries"] == 3 and body["recoveries"]["reconciled"] == 1
    assert set(body["recoveries"]) >= {"retries", "fallbacks", "repairs", "resumed", "quarantined"}


def test_recovery_events_reach_the_agent_log_without_shop_ids(sim):
    from backend.api.main import app

    llm.record_recovery(
        "retry", agent="store_owner", run=None, kind="http_429", attempt=1, wait=1.5,
        outcome="retrying", storeId="s2",
    )  # fmt: skip
    llm.record_recovery(
        "fallback", agent="analyst", run=None, kind="circuit_open", to="heuristic",
        outcome="heuristic chose this iteration",
    )  # fmt: skip
    llm.record_recovery("quarantine", agent="training", run=None, kind="sanity_guard")
    with TestClient(app) as client:
        body = client.get("/api/agents/log").json()
    kinds = {e["type"]: e["data"] for e in body}
    assert {"retry", "fallback", "quarantine"} <= set(kinds)
    assert kinds["retry"]["attempt"] == 1 and kinds["retry"]["wait"] == 1.5
    assert kinds["retry"]["kind"] == "http_429" and kinds["retry"]["outcome"] == "retrying"
    assert '"s2"' not in json.dumps(body)  # area view: no shop ids


def test_a_read_only_deployment_never_rewrites_the_checkpoint(sim, monkeypatch):
    save_raw(running_state(iso(-600)))
    monkeypatch.setattr(settings, "READ_ONLY", True)
    assert training.reconcile_stale() is None
    assert store.load_analyst_state().state == "running"


def test_store_optimize_trusts_the_lock_over_timestamps(sim):
    future = running_state(iso(+3 * 3600))
    assert not stores_router._is_running(future)  # skewed clock, nobody holds the lock
    old = running_state(iso(-10 * 3600))
    with lock_held_elsewhere(store.training_lock_path()):
        assert stores_router._is_running(old)  # a live trainer, however old its checkpoint


def test_two_trainers_started_together_never_both_run(sim, tmp_path):
    """Two real processes race for the same runs/: exactly one trains, the other is refused."""
    script = (
        "import sys; sys.path[:0] = ['.', 'tests'];"
        "import pytest; from test_agents_fakesim import setup_world;"
        "from pathlib import Path; from backend.agents import training;"
        "mp = pytest.MonkeyPatch(); setup_world(Path(sys.argv[1]), mp);"
        "\ntry:\n    training.train(max_runs=3); print('trained')"
        "\nexcept training.SessionBusy:\n    print('busy')"
    )
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", script, str(tmp_path)],
            stdout=subprocess.PIPE,
            text=True,
            cwd=str(settings.ROOT),
        )
        for _ in range(2)
    ]
    outputs = sorted(p.communicate(timeout=300)[0].strip().splitlines()[-1] for p in procs)
    assert outputs in (["busy", "trained"], ["trained", "trained"])
    final = store.load_analyst_state()
    assert final is not None and final.state == "stopped"
    index = [r.run for r in store.load_index()]
    assert index == sorted(set(index))  # never two writers: no duplicated or interleaved runs
    assert llm.load_ledger() == []  # offline: nothing spent
