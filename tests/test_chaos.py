"""Chaos: full training sessions through the agents' online code paths (backend/fake_llm.py)
with faults injected everywhere (backend/chaos.py), and a trainer SIGKILLed at every step
boundary in turn. Offline, seeded, free."""

from __future__ import annotations

import json
import math
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest
from test_agents_fakesim import setup_world  # pytest puts tests/ on sys.path

from backend import chaos, llm, settings, store
from backend.agents import rundata, store_owner, training
from backend.schemas import TrainingConfig

HEAVY = (
    "llm_429:0.3,llm_529:0.1,llm_500:0.1,llm_timeout:0.1,llm_conn:0.05,"
    "bad_json:0.2,refusal:0.05,empty:0.05,batch_stuck:0.3,batch_partial:0.3,"
    "sim_crash:0.1,sim_nan:0.05,sim_zero:0.05"
)
ONLINE = TrainingConfig(analystBackend="messages", storeAgents="batch", maxRuns=6)
TRAINER = Path(__file__).with_name("chaos_trainer.py")


@pytest.fixture
def online(tmp_path, monkeypatch):
    """The fake world with the fake Claude client: online agents, no key, no network."""
    sim = setup_world(tmp_path, monkeypatch)
    monkeypatch.setattr(settings, "FAKE_LLM", True)
    monkeypatch.setattr(llm, "_client", None)
    monkeypatch.setattr(llm, "_sleep", lambda seconds: None)  # backoff waits, compressed
    monkeypatch.setattr(store_owner, "BATCH_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(store_owner, "BATCH_POLL_SECONDS", 0)
    yield sim
    chaos.configure("")


def test_the_chaos_spec_is_parsed_and_off_by_default():
    assert not chaos.Chaos("").enabled()
    c = chaos.Chaos("llm_429:0.3,kill_after_step:3,bad_json")
    assert c.rates == {"llm_429": 0.3, "bad_json": 1.0} and c.kill_after_step == 3
    with pytest.raises(ValueError, match="unknown chaos fault"):
        chaos.Chaos("llm_teapot:0.5")


def test_the_same_seed_injects_the_same_faults():
    a, b = chaos.Chaos("llm_429:0.5", seed=7), chaos.Chaos("llm_429:0.5", seed=7)
    assert [a.fires("llm_429") for _ in range(50)] == [b.fires("llm_429") for _ in range(50)]


def test_without_chaos_the_fake_client_runs_every_online_path(online):
    state = training.train(ONLINE)
    assert state.backend == "messages" and state.stoppedReason in ("threshold", "max_runs")
    assert state.bestRun != state.baselineRun
    agents = {r["agent"] for r in llm.load_ledger()}
    assert {"store_owner", "analyst", "report"} <= agents
    assert any(r["batch"] for r in llm.load_ledger())  # the store agents ran as a batch
    assert sum(state.recoveries.values()) == 0  # no chaos, nothing to recover from


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_a_session_under_heavy_chaos_finishes_with_a_valid_best_run(online, seed):
    chaos.configure(HEAVY, seed=seed)
    state = training.train(ONLINE)

    assert state.state == "stopped" and state.stoppedReason in ("threshold", "max_runs")
    assert state.error is None
    best = rundata.load_summary(state.bestRun)
    assert math.isfinite(best.objectiveValue) and best.kpis.visits > 0
    assert state.bestRun not in state.quarantinedRuns
    assert state.bestObjective == pytest.approx(
        rundata.objective_value(state.bestRun, "visitsPerKwh")
    )
    index = store.load_index()
    assert len({r.run for r in index}) == len(index)  # no duplicated runs
    assert {r.status for r in index} <= {"done", "failed"}  # nothing left "running"
    assert {r.run for r in index if r.status == "failed"} == set(state.quarantinedRuns)
    injected = chaos.current().injected
    assert sum(injected.values()) >= 10, injected
    assert state.recoveries["retries"] > 0 and state.recoveries["fallbacks"] > 0
    assert (settings.RUNS_DIR / str(state.bestRun) / "reports").exists()  # owners got reports


def test_a_fatal_auth_error_degrades_the_whole_session_to_the_heuristics(online):
    chaos.configure("llm_auth:1.0")
    state = training.train(ONLINE)
    assert state.stoppedReason in ("threshold", "max_runs") and state.bestRun != state.baselineRun
    assert state.recoveries["breakerOpens"] >= 1 and state.recoveries["fallbacks"] >= 1
    assert llm.load_ledger() == [] or all(r["cachedResponse"] for r in llm.load_ledger())


# --- SIGKILL at every step boundary, then resume ------------------------------------------------


def _trainer(runs_root: Path, chaos_spec: str = "") -> subprocess.CompletedProcess:
    env = {**os.environ, "CHAOS": chaos_spec, "CHAOS_SEED": "0", "FAKE_LLM": "1"}
    env.pop("ANTHROPIC_API_KEY", None)
    return subprocess.run(
        [sys.executable, str(TRAINER), str(runs_root)],
        cwd=str(settings.ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )


def _final(runs_root: Path) -> dict:
    runs = runs_root / "runs"
    state = json.loads((runs / "analyst_state.json").read_text())
    notebook = json.loads((runs / "notebook.json").read_text())
    index = json.loads((runs / "index.json").read_text())
    ledger = [json.loads(line) for line in (runs / "costs.jsonl").read_text().splitlines()]
    return {
        "runs": state["runsThisSession"],
        "best": (state["bestRun"], state["bestObjective"]),
        "stopped": (state["state"], state["stoppedReason"]),
        "quarantined": state["quarantinedRuns"],
        "notebook": [(e["run"], e["line"]) for e in notebook],
        "index": [(r["run"], r["status"]) for r in index],
        "dirs": sorted(int(p.name) for p in runs.iterdir() if p.name.isdigit()),
        "calls": len(ledger),
        "spentUsd": round(sum(r["costUsd"] for r in ledger), 6),
    }


def test_a_trainer_killed_at_every_step_boundary_resumes_to_the_same_result(tmp_path):
    reference = tmp_path / "reference"
    done = _trainer(reference)
    assert done.returncode == 0, done.stderr[-2000:]
    expected = _final(reference)
    checkpoints = int(done.stdout.strip().splitlines()[-1].split("=")[1])
    assert checkpoints >= 8

    for step in range(1, checkpoints):
        root = tmp_path / f"kill_{step}"
        killed = _trainer(root, f"kill_after_step:{step}")
        assert killed.returncode == -signal.SIGKILL, (step, killed.stderr[-2000:])
        resumed = _trainer(root)
        assert resumed.returncode == 0, (step, resumed.stderr[-2000:])
        got = _final(root)
        assert got == expected, f"killed after checkpoint {step}"
