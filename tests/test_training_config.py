"""TrainingConfig: validation, defaults from settings, persistence (runs/training_config.json)."""

from __future__ import annotations

import importlib
import json

import pytest
from pydantic import ValidationError
from test_agents_fakesim import map_data  # pytest puts tests/ on sys.path

from backend import settings, store
from backend.schemas import TRAINING_RANGES, AnalystState, Levers, TrainingConfig


def test_defaults_come_from_settings(monkeypatch):
    monkeypatch.setattr(settings, "THRESHOLD", 0.05)
    monkeypatch.setattr(settings, "MAX_RUNS", 7)
    monkeypatch.setattr(settings, "SESSION_BUDGET_USD", 4.0)
    config = TrainingConfig()
    assert (config.threshold, config.maxRuns, config.sessionBudgetUsd) == (0.05, 7, 4.0)
    assert config.objective == "visitsPerKwh" and config.seed == settings.DEFAULT_SEED
    assert config.levers == Levers(hours=True, lighting=True) and config.storeIds is None
    assert (config.analystBackend, config.storeAgents) == (settings.ANALYST_BACKEND, "auto")


def test_a_settings_default_out_of_range_fails_loudly(monkeypatch):
    monkeypatch.setattr(settings, "OBJECTIVE", "kwh")
    with pytest.raises(ValidationError, match="objective"):
        TrainingConfig()


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("objective", "kwh", "'visitsPerKwh', 'netValueGbp' or 'visits'"),
        ("threshold", 1.5, "less than or equal to 1"),
        ("patience", 0, "greater than or equal to 1"),
        ("maxRuns", 1, "greater than or equal to 2"),
        ("maxStoresPerIteration", 25, "less than or equal to 24"),
        ("maxChangesPerStore", 3, "less than or equal to 2"),
        ("seed", -1, "greater than or equal to 0"),
        ("levers", {"hours": False, "lighting": False}, "enable at least one lever"),
        ("levers", {"hours": True, "neon": True}, "Extra inputs are not permitted"),
        ("storeIds", [], "at least 1 item"),
        ("storeIds", ["s1", "s1"], "store ids must be unique"),
        ("sessionBudgetUsd", 30.5, "global spend cap of $30"),
        ("analystBackend", "gpt", "'auto', 'heuristic', 'messages' or 'managed'"),
        ("storeAgents", "chat", "'auto', 'heuristic' or 'batch'"),
        ("speed", "fast", "Extra inputs are not permitted"),
    ],
)
def test_bad_values_are_rejected(field, value, message):
    with pytest.raises(ValidationError, match=message.replace("$", r"\$")):
        TrainingConfig.model_validate({field: value})


def test_every_range_bound_is_accepted_and_one_step_past_it_rejected():
    """TRAINING_RANGES is what GET /api/training serves as options: it must match validation."""
    for field, (low, high) in TRAINING_RANGES.items():
        top = settings.SPEND_CAP_USD if field == "sessionBudgetUsd" else high
        step = 1 if isinstance(low, int) and not isinstance(low, bool) else 0.01
        TrainingConfig.model_validate({field: low})
        with pytest.raises(ValidationError):
            TrainingConfig.model_validate({field: low - step})
        if top is not None:
            TrainingConfig.model_validate({field: top})
            with pytest.raises(ValidationError):
                TrainingConfig.model_validate({field: top + step})


def test_values_from_text_are_coerced():
    config = TrainingConfig.model_validate({"maxRuns": "8", "threshold": "0.002"})
    assert (config.maxRuns, config.threshold) == (8, 0.002)


def test_the_saved_config_round_trips_and_a_missing_file_means_defaults(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    assert store.load_training_config() == TrainingConfig()
    config = TrainingConfig(
        objective="netValueGbp", storeIds=["s1", "s13"], levers=Levers(lighting=False)
    )
    store.save_training_config(config)
    assert store.load_training_config() == config
    saved = json.loads(store.training_config_path().read_text())
    assert saved["levers"] == {"hours": True, "lighting": False}
    store.write_json(store.training_config_path(), {"threshold": 0.05})  # partial: defaults fill
    assert store.load_training_config() == TrainingConfig(threshold=0.05)


def test_store_ids_are_checked_against_the_map():
    TrainingConfig().check_store_ids(map_data())  # null = every non-club store
    TrainingConfig(storeIds=["s1", "s4"]).check_store_ids(map_data())
    with pytest.raises(ValueError, match="storeIds: unknown store ids: zz; clubs never change: c1"):
        TrainingConfig(storeIds=["s1", "zz", "c1"]).check_store_ids(map_data())
    assert TrainingConfig(storeIds=["s1"]).takes_part("s1")
    assert not TrainingConfig(storeIds=["s1"]).takes_part("s2")


def test_analyst_state_keeps_reading_checkpoints_written_before_configs():
    old = {
        "sessionId": "s",
        "state": "stopped",
        "startedAt": "t",
        "updatedAt": "t",
        "backend": "heuristic",
        "fresh": False,
        "seed": 42,
        "stoppedReason": "threshold",
    }
    assert AnalystState.model_validate(old).config is None
    assert AnalystState.model_validate({**old, "stoppedReason": "stopped"}).stoppedReason


def test_runs_dir_and_read_only_come_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "scratch-runs"))
    monkeypatch.setenv("VERCEL", "1")
    try:
        importlib.reload(settings)
        assert settings.RUNS_DIR == tmp_path / "scratch-runs" and settings.READ_ONLY
        monkeypatch.delenv("VERCEL")
        monkeypatch.setenv("READ_ONLY", "1")
        importlib.reload(settings)
        assert settings.READ_ONLY
    finally:
        monkeypatch.undo()
        importlib.reload(settings)
