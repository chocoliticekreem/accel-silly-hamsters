"""The training loop end-to-end offline on the fake sim: stop rules, checkpoint/resume, costs."""

from __future__ import annotations

import json

import pytest
from test_agents_fakesim import setup_world  # pytest puts tests/ on sys.path

from backend import llm, settings, store
from backend.agents import analyst, rundata, store_owner, training
from backend.contract import StoreReport


@pytest.fixture
def sim(tmp_path, monkeypatch):
    return setup_world(tmp_path, monkeypatch)


def log_events(run: int | None) -> list[dict]:
    folder = settings.RUNS_DIR / str(run) if run is not None else settings.RUNS_DIR
    path = folder / "llm_log.jsonl"
    return [json.loads(line) for line in path.open()] if path.exists() else []


def test_offline_training_improves_and_stops_when_nothing_is_left(sim):
    state = training.train(max_runs=10)

    assert state.state == "stopped" and state.stoppedReason == "threshold"
    assert state.backend == "heuristic" and state.error is None
    assert state.runsThisSession == [1, 2, 3] and state.iterations == 3
    baseline = rundata.load_summary(state.baselineRun).objectiveValue
    assert state.bestRun == 3 and state.bestObjective > baseline * 1.1
    assert store.load_analyst_state() == state

    notebook = {e.run: e.line for e in store.load_notebook()}
    assert notebook[1].startswith("Baseline:")
    assert notebook[2].startswith("Opened Kebab Co till 03:00") and len(notebook[2].split()) <= 12
    assert [r.notebook for r in store.load_index()] == [notebook[1], notebook[2], notebook[3]]

    second = rundata.load_config(2)
    assert second.parentRun == 1 and second.appliedChanges
    assert rundata.load_config(3).parentRun == 2
    assert rundata.load_suggestions(1) and rundata.load_suggestions(2)

    events = [e["type"] for e in log_events(1)]
    assert events.index("handoff") < events.index("proposals") < events.index("hypothesis")
    assert [e["to"] for e in log_events(1) if e["type"] == "handoff"] == ["store_agents", "analyst"]
    assert any(e["type"] == "experiment" for e in log_events(2))

    reports = settings.RUNS_DIR / "3" / "reports"
    for sid in ("s1", "s2", "s3", "s4"):
        report = StoreReport.model_validate(store.read_json(reports / f"{sid}.json"))
        assert report.pdfUrl == f"/files/reports/3/{sid}.pdf"
        assert (reports / f"{sid}.pdf").read_bytes().startswith(b"%PDF")
    assert not (reports / "c1.json").exists()

    for run in state.runsThisSession:
        assert rundata.load_summary(run).cost.costPerStoreWeekGbp == 0.0
    assert all(r.costPerStoreWeekGbp == 0.0 for r in store.load_index())


def test_threshold_stop_after_patience_low_gain_runs(sim, monkeypatch):
    monkeypatch.setattr(settings, "THRESHOLD", 0.5)  # every experiment gains less than 50%
    state = training.train(max_runs=10)
    assert state.stoppedReason == "threshold"
    assert state.runsThisSession == [1, 2, 3] and state.lowGainStreak == settings.PATIENCE
    assert state.step == "scored"


def test_max_runs_stop_counts_the_baseline(sim):
    state = training.train(max_runs=2)
    assert state.stoppedReason == "max_runs" and state.runsThisSession == [1, 2]
    assert (settings.RUNS_DIR / "2" / "reports" / "s2.pdf").exists()


def test_budget_stop_checkpoints_and_reports_cost_per_store_week(sim, monkeypatch):
    real_propose = store_owner.propose_all

    def costly_propose(run, *, session=None):
        # $1.00 per round of store agents: 500k Sonnet input tokens at $2/MTok
        usage = llm.Usage(input_tokens=500_000)
        llm.record_usage("store_owner", settings.STORE_AGENT_MODEL, usage, run=run, session=session)
        return real_propose(run, session=session)

    monkeypatch.setattr(store_owner, "propose_all", costly_propose)
    monkeypatch.setattr(settings, "SESSION_BUDGET_USD", 1.5)
    state = training.train(max_runs=10)

    assert state.stoppedReason == "budget" and state.state == "stopped"
    assert state.runsThisSession == [1, 2, 3]
    assert state.spentGbp == pytest.approx(2.0 * settings.GBP_PER_USD)
    saved = store.load_analyst_state()
    assert saved is not None and saved.stoppedReason == "budget"
    assert any(e["type"] == "budget_stop" for e in log_events(state.bestRun))

    # cost per store-week = session LLM cost / (4 advised stores x 1 week of advice)
    expected = round(2.0 * settings.GBP_PER_USD / 4, 4)
    for run in state.runsThisSession:
        cost = rundata.load_summary(run).cost
        assert cost.costGbp == pytest.approx(1.5) and cost.costPerStoreWeekGbp == expected
        assert cost.byAgent == {"store_owner": pytest.approx(1.5)}
    assert {r.costPerStoreWeekGbp for r in store.load_index()} == {expected}


def test_restart_after_a_crash_resumes_without_redoing_the_finished_run(sim):
    sim.crash_at, sim.crash_after_write = 2, True
    with pytest.raises(RuntimeError, match="after the run was written"):
        training.train(max_runs=10)
    crashed = store.load_analyst_state()
    assert crashed is not None
    assert crashed.stoppedReason == "error" and crashed.step == "chosen"
    assert crashed.runsThisSession == [1] and "simulated crash" in (crashed.error or "")
    assert sim.simulations == 2

    sim.crash_at = None
    state = training.train(max_runs=10)
    assert state.sessionId == crashed.sessionId and state.stoppedReason == "threshold"
    assert state.runsThisSession == [1, 2, 3]
    runs = [r.run for r in store.load_index()]
    assert runs == [1, 2, 3]  # run 2 came back from the run cache, not a second simulation
    assert sim.simulations == 3 + 2 * len(training.report.EXTRA_SEED_OFFSETS)
    assert any(e["type"] == "resume" for e in log_events(None))


def test_restart_after_a_crash_before_the_run_was_written(sim):
    sim.crash_at, sim.crash_after_write = 2, False
    with pytest.raises(RuntimeError, match="before the run was written"):
        training.train(max_runs=10)
    assert [r.run for r in store.load_index()] == [1]
    sim.crash_at = None
    state = training.train(max_runs=10)
    assert state.runsThisSession == [1, 2, 3] and [r.run for r in store.load_index()] == [1, 2, 3]


def test_restart_during_the_analyst_step_keeps_completed_runs(sim, monkeypatch):
    real_choose = analyst.HeuristicAnalyst.choose
    calls = {"n": 0}

    def flaky_choose(self, ctx):
        calls["n"] += 1
        if calls["n"] == 2:
            raise ConnectionError("analyst went away")
        return real_choose(self, ctx)

    monkeypatch.setattr(analyst.HeuristicAnalyst, "choose", flaky_choose)
    with pytest.raises(ConnectionError):
        training.train(max_runs=10)
    crashed = store.load_analyst_state()
    assert crashed is not None and crashed.step == "proposed" and crashed.runsThisSession == [1, 2]
    state = training.train(max_runs=10)
    assert state.runsThisSession == [1, 2, 3] and state.sessionId == crashed.sessionId


def test_resume_continues_a_stopped_session_and_fresh_starts_a_new_one(sim):
    first = training.train(max_runs=2)
    assert first.runsThisSession == [1, 2]
    resumed = training.train(max_runs=3)
    assert resumed.sessionId == first.sessionId and resumed.runsThisSession == [1, 2, 3]

    simulations = sim.simulations
    fresh = training.train(max_runs=2, fresh=True)
    assert fresh.sessionId != first.sessionId and fresh.fresh
    assert fresh.runsThisSession == [4, 5]  # nothing reused from the earlier session
    assert sim.simulations > simulations
