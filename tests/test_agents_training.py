"""The training loop end-to-end offline on the fake sim: stop rules, checkpoint/resume, costs."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from test_agents_fakesim import STORES, setup_world  # pytest puts tests/ on sys.path

from backend import cache, economics, llm, settings, store
from backend.agents import analyst, rundata, store_owner, training
from backend.agents.rules import check_changes
from backend.contract import StoreReport
from backend.schemas import Levers, TrainingConfig
from backend.sim import runner


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

    def costly_propose(run, *, session=None, config=None):
        # $1.00 per online round of store agents: 500k Sonnet input tokens at $2/MTok
        if config is None or config.storeAgents != "heuristic":
            usage = llm.Usage(input_tokens=500_000)
            llm.record_usage(
                "store_owner", settings.STORE_AGENT_MODEL, usage, run=run, session=session
            )
        return real_propose(run, session=session, config=config)

    monkeypatch.setattr(store_owner, "propose_all", costly_propose)
    monkeypatch.setattr(settings, "SESSION_BUDGET_USD", 1.5)
    state = training.train(max_runs=10)

    assert state.stoppedReason == "budget" and state.state == "stopped"
    assert state.runsThisSession == [1, 2, 3]
    assert state.spentGbp == pytest.approx(2.0 * settings.GBP_PER_USD)
    # next week's proposals on the best run still ran, offline: the spend above is unchanged
    best_log = log_events(state.bestRun)
    assert [e["mode"] for e in best_log if e["type"] == "proposals"][-1] == "heuristic"
    assert any(e["type"] == "next_week_proposals" for e in best_log)
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


# --- adjustable training (TrainingConfig) ----------------------------------------------------


def test_the_saved_config_runs_and_keyword_arguments_override_it(sim):
    store.save_training_config(TrainingConfig(maxRuns=3, threshold=0.01))
    state = training.train(max_runs=2)
    assert state.runsThisSession == [1, 2] and state.stoppedReason == "max_runs"
    assert state.config is not None
    assert (state.config.maxRuns, state.config.threshold) == (2, 0.01)
    assert store.load_training_config().maxRuns == 3  # an override is not saved
    assert store.load_analyst_state() == state


def test_levers_and_store_ids_scope_the_whole_session(sim):
    config = TrainingConfig(levers=Levers(hours=True, lighting=False), storeIds=["s2", "s4"])
    state = training.train(config)
    assert len(state.runsThisSession) > 1 and state.config == config
    baseline = rundata.load_config(state.baselineRun).stores
    for run in state.runsThisSession:
        for suggestion in rundata.load_suggestions(run):
            assert suggestion.field != "lighting" and suggestion.storeId in ("s2", "s4")
        stores = rundata.load_config(run).stores
        assert stores["s1"] == baseline["s1"] and stores["s3"] == baseline["s3"]  # frozen
        for change in rundata.load_config(run).appliedChanges:
            assert change["field"] != "lighting" and change["storeId"] in ("s2", "s4")
    best_s2 = rundata.load_config(state.bestRun).stores["s2"]
    assert best_s2.close != baseline["s2"].close  # the hours lever moved s2...
    assert best_s2.lighting == baseline["s2"].lighting  # ...and never its lighting


def test_per_experiment_limits_hold_in_every_run(sim):
    config = TrainingConfig(maxStoresPerIteration=1, maxChangesPerStore=1, maxRuns=4)
    state = training.train(config)
    assert state.runsThisSession == [1, 2, 3, 4]
    for run in state.runsThisSession[1:]:
        assert len(rundata.load_config(run).appliedChanges) == 1


@pytest.mark.parametrize("stop_at", ["proposed", "chosen"])
def test_a_resume_under_a_new_scope_redoes_the_iteration_inside_it(sim, monkeypatch, stop_at):
    real_propose, real_choose = store_owner.propose_all, analyst.HeuristicAnalyst.choose

    def propose_then_stop(run, *, session=None, config=None):
        proposals = real_propose(run, session=session, config=config)
        training.request_stop()
        return proposals

    def choose_then_stop(self, ctx):
        choice = real_choose(self, ctx)
        training.request_stop()
        return choice

    if stop_at == "proposed":
        monkeypatch.setattr(store_owner, "propose_all", propose_then_stop)
    else:
        monkeypatch.setattr(analyst.HeuristicAnalyst, "choose", choose_then_stop)
    stopped = training.train()
    assert stopped.stoppedReason == "stopped" and stopped.step == stop_at
    assert any(s.field == "lighting" for s in rundata.load_suggestions(1))
    if stop_at == "chosen":  # the pending experiment changes lighting on stores about to freeze
        pending = store.read_json(training.pending_path())["changes"]
        assert any(c["field"] == "lighting" and c["storeId"] != "s4" for c in pending)
    monkeypatch.setattr(store_owner, "propose_all", real_propose)
    monkeypatch.setattr(analyst.HeuristicAnalyst, "choose", real_choose)

    narrow = TrainingConfig(levers=Levers(hours=True, lighting=False), storeIds=["s4"], maxRuns=2)
    resumed = training.train(narrow)
    assert resumed.sessionId == stopped.sessionId and resumed.runsThisSession == [1, 2]
    applied = rundata.load_config(2).appliedChanges
    assert applied and all(c["field"] != "lighting" and c["storeId"] == "s4" for c in applied)
    baseline = rundata.load_config(1).stores
    assert all(rundata.load_config(2).stores[sid] == baseline[sid] for sid in ("s1", "s2", "s3"))
    [rescope] = [e for e in log_events(None) if e["type"] == "rescope"]
    assert (rescope["from"], rescope["to"]) == (stop_at, "baseline")


def test_net_value_objective_scores_runs_in_gbp_per_week(sim):
    types = {sid: kind for sid, (_, kind, _, _) in STORES.items()}
    price = 0.27  # the fake energy.json tariff, flat

    def by_hand(run: int) -> float:
        total = 0.0
        for sid, result in rundata.load_stores(run).items():
            if types[sid] != "club":
                spend = economics.SPEND_GBP_PER_VISIT[types[sid]] * economics.GROSS_MARGIN
                total += (result.kpis.visits * spend - result.kpis.kwh * price) / 2  # 14 days
        return total

    state = training.train(TrainingConfig(objective="netValueGbp"))
    notebook = {e.run: e for e in store.load_notebook()}
    for run in state.runsThisSession:
        assert notebook[run].objectiveValue == pytest.approx(by_hand(run))
        assert notebook[run].objective == "netValueGbp"  # the unit of objectiveValue
    assert state.bestObjective == pytest.approx(max(by_hand(r) for r in state.runsThisSession))
    assert state.bestObjective > by_hand(state.baselineRun)

    # the report's confidence is measured on net value too: its first seed delta is the s2 gain
    meta = store.read_json(settings.RUNS_DIR / str(state.bestRun) / "reports" / "s2.meta.json")
    before = rundata.load_stores(state.baselineRun)["s2"].kpis
    after = rundata.load_stores(state.bestRun)["s2"].kpis

    def s2_value(k) -> float:
        return (k.visits * 9 * 0.3 - k.kwh * price) / 2  # takeaway: £9 a visit, 30% margin

    expected = (s2_value(after) - s2_value(before)) / abs(s2_value(before))
    assert meta["seedDeltas"][0] == pytest.approx(expected)


@pytest.mark.parametrize("ask", ["event", "flag_file"])
def test_a_stop_request_stops_at_the_next_step_boundary_and_the_session_resumes(
    sim, monkeypatch, ask
):
    real_execute = runner.execute_run  # the fake sim

    def execute_then_stop(*args, **kwargs):
        run = real_execute(*args, **kwargs)
        if run == 2:  # another process writing the flag file stops this session too
            training.request_stop() if ask == "event" else store.set_training_stop()
        return run

    monkeypatch.setattr(runner, "execute_run", execute_then_stop)
    state = training.train()
    assert state.state == "stopped" and state.stoppedReason == "stopped"
    assert state.step == "ran" and state.runsThisSession == [1, 2]  # run 2 done, not scored
    assert store.load_analyst_state() == state
    assert not training.stop_requested() and not store.training_stop_path().exists()
    best_log = [e["type"] for e in log_events(state.bestRun)]
    assert "stop_requested" in best_log
    assert "next_week_proposals" in best_log  # a stopped session still proposes next week's

    resumed = training.train()
    assert resumed.sessionId == state.sessionId and resumed.stoppedReason == "threshold"
    assert resumed.runsThisSession == [1, 2, 3] and resumed.bestRun == 3


def test_the_session_reads_running_until_its_reports_are_written(sim, monkeypatch):
    seen: list[str] = []
    real_write = training.report.write_reports

    def spy(*args, **kwargs):
        saved = store.load_analyst_state()
        seen.append(saved.state if saved else "missing")
        return real_write(*args, **kwargs)

    monkeypatch.setattr(training.report, "write_reports", spy)
    training.train(max_runs=2)
    assert seen == ["running"]  # so a new start cannot overlap the reports (409 meanwhile)
    saved = store.load_analyst_state()
    assert saved is not None and (saved.state, saved.stoppedReason) == ("stopped", "max_runs")


def test_a_failing_report_still_checkpoints_the_stop(sim, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("pdf broke")

    monkeypatch.setattr(training.report, "write_reports", broken)
    with pytest.raises(RuntimeError, match="pdf broke"):
        training.train(max_runs=2)
    saved = store.load_analyst_state()
    assert saved is not None and (saved.state, saved.stoppedReason) == ("stopped", "max_runs")


@contextmanager
def lock_held_elsewhere(path: Path) -> Iterator[None]:
    """Another process holding runs/training.lock, as a running CLI or API session does."""
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import fcntl, sys, time; f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX);"
            " print('locked', flush=True); time.sleep(120)",
            str(path),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout is not None and holder.stdout.readline().strip() == "locked"
        yield
    finally:
        holder.kill()  # the kernel drops its lock, as for a crash or kill -9
        holder.wait()


def test_a_session_running_in_another_process_is_not_taken_over(sim):
    first = training.train(max_runs=2)
    store.set_training_stop()  # that process's pending stop request
    with lock_held_elsewhere(store.training_lock_path()):
        for fresh in (False, True):
            with pytest.raises(training.SessionBusy, match="still running in another process"):
                training.train(max_runs=3, fresh=fresh)
        assert store.training_stop_path().exists()  # left for its owner
        assert store.load_analyst_state() == first  # untouched
    # the holder is gone (killed: no clean exit), so its lock is gone and the session resumes
    resumed = training.train(max_runs=3)
    assert resumed.sessionId == first.sessionId and resumed.runsThisSession == [1, 2, 3]
    assert resumed.owner == f"{socket.gethostname()}:{os.getpid()}"


def test_restarting_a_finished_session_does_not_redo_its_wrap_up(sim):
    training.train(max_runs=2)
    rounds = [e["type"] for e in log_events(2)].count("proposals")
    reports = [e["type"] for e in log_events(2)].count("reports_written")
    again = training.train(max_runs=2)  # nothing left to do: stops at once, same config
    assert again.stoppedReason == "max_runs" and again.wrappedUp
    assert [e["type"] for e in log_events(2)].count("proposals") == rounds
    assert [e["type"] for e in log_events(2)].count("reports_written") == reports
    training.train(TrainingConfig(maxRuns=2, storeAgents="heuristic"))  # another config: redo
    assert [e["type"] for e in log_events(2)].count("proposals") == rounds + 1


def test_a_stop_that_is_due_wins_over_a_stop_request(sim, monkeypatch):
    real_line = analyst.HeuristicAnalyst.notebook_line

    def line_then_stop(self, outcome):
        training.request_stop()  # pressed while run 2 was being scored
        return real_line(self, outcome)

    monkeypatch.setattr(analyst.HeuristicAnalyst, "notebook_line", line_then_stop)
    state = training.train(max_runs=2)
    assert state.stoppedReason == "max_runs"


def test_an_error_stop_still_proposes_next_week_offline(sim, monkeypatch):
    real_propose = store_owner.propose_all
    modes: list[str] = []

    def spy(run, *, session=None, config=None):
        modes.append(config.storeAgents if config else "default")
        return real_propose(run, session=session, config=config)

    monkeypatch.setattr(store_owner, "propose_all", spy)
    sim.crash_at, sim.crash_after_write = 2, False  # the sim fails on the first experiment
    with pytest.raises(RuntimeError, match="simulated crash"):
        training.train()
    crashed = store.load_analyst_state()
    assert crashed is not None and crashed.stoppedReason == "error" and crashed.step == "chosen"
    assert "next_week_proposals" in [e["type"] for e in log_events(crashed.bestRun)]
    assert modes == ["auto", "heuristic"]  # the loop's round, then the error's: no batch


def test_a_resume_with_a_lower_max_runs_stops_before_the_pending_experiment(sim, monkeypatch):
    real_propose = store_owner.propose_all
    calls = {"n": 0}

    def stop_after_the_second_round(run, *, session=None, config=None):
        proposals = real_propose(run, session=session, config=config)
        calls["n"] += 1
        if calls["n"] == 2:
            training.request_stop()
        return proposals

    monkeypatch.setattr(store_owner, "propose_all", stop_after_the_second_round)
    stopped = training.train()
    assert (stopped.step, stopped.runsThisSession) == ("proposed", [1, 2])
    resumed = training.train(max_runs=2)
    assert resumed.stoppedReason == "max_runs" and resumed.runsThisSession == [1, 2]


def test_only_what_the_wrap_up_reads_makes_a_finished_session_redo_it(sim):
    training.train(max_runs=2)
    rounds = [e["type"] for e in log_events(2)].count("proposals")
    training.train(TrainingConfig(maxRuns=2, threshold=0.5, patience=3, maxStoresPerIteration=1))
    assert [e["type"] for e in log_events(2)].count("proposals") == rounds  # analyst limits only
    training.train(TrainingConfig(maxRuns=2, levers=Levers(hours=True, lighting=False)))
    assert [e["type"] for e in log_events(2)].count("proposals") == rounds + 1
    assert all(s.field != "lighting" for s in rundata.load_suggestions(2))


def test_new_analyst_limits_mid_iteration_rechoose_from_the_same_proposals(sim, monkeypatch):
    real_choose = analyst.HeuristicAnalyst.choose

    def choose_then_stop(self, ctx):
        choice = real_choose(self, ctx)
        training.request_stop()
        return choice

    monkeypatch.setattr(analyst.HeuristicAnalyst, "choose", choose_then_stop)
    stopped = training.train()
    assert stopped.step == "chosen"
    assert len({c["storeId"] for c in store.read_json(training.pending_path())["changes"]}) > 1
    monkeypatch.setattr(analyst.HeuristicAnalyst, "choose", real_choose)
    rounds = [e["type"] for e in log_events(1)].count("proposals")

    resumed = training.train(TrainingConfig(maxStoresPerIteration=1, maxRuns=2))
    assert resumed.runsThisSession == [1, 2]
    assert len({c["storeId"] for c in rundata.load_config(2).appliedChanges}) == 1
    assert [e["type"] for e in log_events(1)].count("proposals") == rounds  # not re-proposed
    [rescope] = [e for e in log_events(None) if e["type"] == "rescope"]
    assert (rescope["from"], rescope["to"]) == ("chosen", "proposed")


def test_a_failing_next_week_round_still_writes_the_reports(sim, monkeypatch):
    real_propose = store_owner.propose_all
    calls = {"n": 0}

    def fails_at_the_wrap_up(run, *, session=None, config=None):
        calls["n"] += 1
        if calls["n"] == 2:  # the loop proposed once; this is next week's round
            raise ConnectionError("store agents went away")
        return real_propose(run, session=session, config=config)

    monkeypatch.setattr(store_owner, "propose_all", fails_at_the_wrap_up)
    with pytest.raises(ConnectionError):
        training.train(max_runs=2)
    assert (settings.RUNS_DIR / "2" / "reports" / "s2.json").exists()
    saved = store.load_analyst_state()
    assert saved is not None and saved.stoppedReason == "max_runs" and not saved.wrappedUp
    assert "wrap_up_error" in [e["type"] for e in log_events(2)]


def test_a_fresh_session_leaves_the_process_cache_policy_as_it_found_it(sim):
    training.train(max_runs=2, fresh=True)  # e.g. inside the API process
    assert not cache.policy.fresh and not cache.policy.session_runs


def test_a_stop_requested_before_the_session_starts_is_discarded(sim):
    store.set_training_stop()
    training.request_stop()
    state = training.train(max_runs=2)
    assert state.stoppedReason == "max_runs" and state.runsThisSession == [1, 2]


def test_after_stopping_the_best_run_holds_next_weeks_proposals(sim):
    state = training.train(max_runs=2)  # stops right after run 2 became the best run
    assert state.bestRun == 2 and state.step == "scored"
    proposals = rundata.load_suggestions(2)  # the sim wrote [] here; the store agents filled it
    assert proposals
    best_configs = rundata.load_config(2).stores
    assert not check_changes(
        best_configs, proposals, store.load_map(), check_tried=False
    ).rejections
    assert any(e["type"] == "next_week_proposals" for e in log_events(2))


def test_a_different_objective_starts_a_new_session_instead_of_resuming(sim):
    first = training.train(max_runs=2)
    second = training.train(TrainingConfig(objective="visits", maxRuns=2))
    assert second.sessionId != first.sessionId and second.runsThisSession[0] == 1
    assert second.config is not None and second.config.objective == "visits"
    [start] = [
        e for e in log_events(None) if e["type"] == "start" and e["session"] == second.sessionId
    ]
    assert start["replaces"] == first.sessionId
    assert start["reason"] == "objective visitsPerKwh -> visits"


def test_the_session_budget_comes_from_the_config(sim, monkeypatch):
    real_propose = store_owner.propose_all

    def costly_propose(run, *, session=None, config=None):
        usage = llm.Usage(input_tokens=500_000)  # $1.00 of Sonnet input
        llm.record_usage("store_owner", settings.STORE_AGENT_MODEL, usage, run=run, session=session)
        return real_propose(run, session=session, config=config)

    monkeypatch.setattr(store_owner, "propose_all", costly_propose)
    state = training.train(TrainingConfig(sessionBudgetUsd=0.5))
    assert state.stoppedReason == "budget" and state.runsThisSession == [1, 2]
    assert llm.session_budget_usd(state.sessionId) == 0.5


def test_unknown_or_club_store_ids_fail_before_anything_runs(sim):
    with pytest.raises(ValueError, match="unknown store ids: zz; clubs never change: c1"):
        training.train(TrainingConfig(storeIds=["s2", "zz", "c1"]))
    assert store.load_analyst_state() is None and sim.simulations == 0
