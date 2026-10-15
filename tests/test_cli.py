"""CLI: `train` flags override the saved training config; `train-config show|set` validate it."""

from __future__ import annotations

import json

import pytest
from test_agents_fakesim import setup_world  # pytest puts tests/ on sys.path

from backend import cli, store
from backend.agents import training
from backend.schemas import AnalystState, Levers, TrainingConfig


@pytest.fixture
def world(tmp_path, monkeypatch):
    return setup_world(tmp_path, monkeypatch)


@pytest.fixture
def trained(world, monkeypatch):
    """The configs `train` would run with; nothing is trained."""
    calls: list[dict] = []

    def fake_train(config=None, *, fresh=False, max_runs=None, seed=None):
        calls.append({"config": config, "fresh": fresh, "max_runs": max_runs, "seed": seed})
        return AnalystState(
            sessionId="cli",
            state="stopped",
            startedAt="t",
            updatedAt="t",
            backend="heuristic",
            fresh=fresh,
            seed=config.seed,
            config=config,
        )

    monkeypatch.setattr(training, "train", fake_train)
    return calls


def exit_message(argv: list[str]) -> str:
    with pytest.raises(SystemExit) as exc:
        cli.main(argv)
    return str(exc.value.code)


def test_train_flags_override_the_saved_config_for_one_session(trained):
    saved = TrainingConfig(threshold=0.05, maxRuns=12, objective="visits")
    store.save_training_config(saved)
    cli.main(
        [
            "train",
            "--objective", "netValueGbp",
            "--threshold", "0.002",
            "--patience", "3",
            "--max-runs", "8",
            "--stores-per-iteration", "2",
            "--changes-per-store", "1",
            "--levers", "hours",
            "--stores", "s1,s2",
            "--budget-usd", "3",
            "--backend", "heuristic",
            "--store-agents", "heuristic",
            "--seed", "7",
            "--fresh",
        ]
    )  # fmt: skip
    [call] = trained
    assert call["fresh"] is True and call["max_runs"] is None and call["seed"] is None
    assert call["config"] == TrainingConfig(
        objective="netValueGbp",
        threshold=0.002,
        patience=3,
        maxRuns=8,
        maxStoresPerIteration=2,
        maxChangesPerStore=1,
        seed=7,
        levers=Levers(hours=True, lighting=False),
        storeIds=["s1", "s2"],
        sessionBudgetUsd=3,
        analystBackend="heuristic",
        storeAgents="heuristic",
    )
    assert store.load_training_config() == saved  # flags are for this session only


def test_train_without_flags_runs_the_saved_config(trained):
    saved = TrainingConfig(threshold=0.01, storeIds=["s2"])
    store.save_training_config(saved)
    cli.main(["train"])
    assert trained == [{"config": saved, "fresh": False, "max_runs": None, "seed": None}]
    cli.main(["train", "--stores", "all", "--levers", "hours,lighting"])
    assert trained[1]["config"] == saved.model_copy(update={"storeIds": None})


def test_bad_train_flags_exit_before_anything_runs(trained, capsys):
    assert exit_message(["train", "--threshold", "2"]) == (
        "invalid training config: threshold: Input should be less than or equal to 1"
    )
    assert "unknown store ids: zz" in exit_message(["train", "--stores", "s1,zz"])
    assert "clubs never change: c1" in exit_message(["train", "--stores", "c1"])
    assert exit_message(["train", "--levers", "neon"]) == "2"  # argparse usage error
    assert "unknown lever neon" in capsys.readouterr().err
    assert exit_message(["train", "--objective", "kwh"]) == "2"
    assert trained == []


def test_train_config_show_and_set(world, capsys):
    cli.main(["train-config", "show"])
    assert json.loads(capsys.readouterr().out) == TrainingConfig().model_dump(mode="json")

    cli.main(["train-config", "set", "threshold=0.01", "levers=hours", "storeIds=s1,s2"])
    expected = TrainingConfig(threshold=0.01, levers=Levers(lighting=False), storeIds=["s1", "s2"])
    assert json.loads(capsys.readouterr().out) == expected.model_dump(mode="json")
    assert store.load_training_config() == expected

    cli.main(["train-config", "set", "storeIds=all", "maxRuns=8", "objective=netValueGbp"])
    expected = expected.model_copy(update={"storeIds": None, "maxRuns": 8})
    assert store.load_training_config() == expected.model_copy(update={"objective": "netValueGbp"})


@pytest.mark.parametrize(
    ("assignments", "message"),
    [
        (["maxRuns=1"], "invalid training config: maxRuns: Input should be greater than or equal"),
        (["sessionBudgetUsd=99"], "global spend cap"),
        (["levers=neon"], "levers: unknown lever neon"),
        (["storeIds=c1"], "clubs never change: c1"),
        (["speed=fast"], "expected key=value with key one of objective, threshold"),
        (["threshold"], "expected key=value"),
        ([], "nothing to set"),
    ],
)
def test_train_config_set_rejects_bad_input_and_saves_nothing(world, assignments, message):
    store.save_training_config(TrainingConfig(threshold=0.03))
    assert message in exit_message(["train-config", "set", *assignments])
    assert store.load_training_config() == TrainingConfig(threshold=0.03)


def test_train_exits_cleanly_when_another_process_runs_the_session(world, monkeypatch):
    def busy(*args, **kwargs):
        raise training.SessionBusy("session s is still running in process host:1: stop it first")

    monkeypatch.setattr(training, "train", busy)
    assert exit_message(["train"]) == "session s is still running in process host:1: stop it first"


def test_reports_are_rewritten_on_the_sessions_objective(world, monkeypatch, capsys):
    training.train(TrainingConfig(objective="netValueGbp", maxRuns=2))
    seen: list[dict] = []
    real_write = training.report.write_reports

    def spy(best_run, baseline_run, **kwargs):
        seen.append(kwargs)
        return real_write(best_run, baseline_run, **kwargs)

    monkeypatch.setattr(training.report, "write_reports", spy)
    cli.main(["reports", "--run", "2"])
    assert seen == [{"objective": "netValueGbp"}]


def test_chaos_demo_runs_a_session_under_faults_and_prints_the_recoveries(world, tmp_path, capsys):
    from backend import chaos, llm, settings

    demo = tmp_path / "demo-runs"
    real_runs = settings.RUNS_DIR
    summary = cli.chaos_demo(runs_dir=demo, spec=cli.DEMO_CHAOS, seed=1, max_runs=4, wait_scale=0)
    out = capsys.readouterr().out
    assert "Recoveries" in out and "Faults injected" in out
    assert summary["stoppedReason"] in ("threshold", "max_runs") and summary["bestRun"]
    assert sum(summary["recoveries"].values()) > 0
    assert (demo / "analyst_state.json").exists()
    # everything it switched on for the demo is switched back off
    assert settings.RUNS_DIR == real_runs and not settings.FAKE_LLM
    assert not chaos.current().enabled() and type(llm._client).__name__ != "FakeClient"


def test_chaos_demo_never_writes_into_the_real_runs_dir(world):
    from backend import settings

    with pytest.raises(SystemExit, match="refusing"):
        cli.chaos_demo(runs_dir=settings.ROOT / "runs", spec="", seed=0, max_runs=2)


def test_train_runs_end_to_end_with_flags(world, capsys):
    cli.main(["train", "--max-runs", "2", "--levers", "hours", "--store-agents", "heuristic"])
    state = AnalystState.model_validate(json.loads(capsys.readouterr().out))
    assert state.stoppedReason == "max_runs" and state.runsThisSession == [1, 2]
    assert state.config is not None and state.config.levers == Levers(lighting=False)
    assert store.load_analyst_state() == state
