"""Durable state files: fsync'd atomic writes, a .bak of the last good copy, recovery from a
corrupt or half-written checkpoint, notebook or index, and a full disk that leaves the old file."""

from __future__ import annotations

import errno
import json
import os

import pytest

from backend import cache, settings, store
from backend.contract import RunListItem
from backend.schemas import AnalystState, NotebookEntry


@pytest.fixture(autouse=True)
def runs(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    return tmp_path / "runs"


def state(session: str, step: str = "baseline") -> AnalystState:
    return AnalystState(
        sessionId=session,
        state="running",
        startedAt="2026-10-15T09:00:00Z",
        updatedAt="2026-10-15T09:00:00Z",
        backend="heuristic",
        fresh=False,
        seed=42,
        step=step,
    )


def events(runs) -> list[dict]:
    path = runs / "llm_log.jsonl"
    return [json.loads(line) for line in path.open()] if path.exists() else []


def test_writes_are_fsynced_before_the_rename(runs, monkeypatch):
    synced: list[int] = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: synced.append(fd) or real_fsync(fd))
    store.write_json(runs / "x.json", {"a": 1})
    assert len(synced) >= 2  # the file, then its directory
    assert store.read_json(runs / "x.json") == {"a": 1}


def test_a_full_disk_leaves_the_previous_file_and_no_temp_files(runs, monkeypatch):
    path = runs / "analyst_state.json"
    store.save_analyst_state(state("good"))

    def full(*args, **kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    with monkeypatch.context() as patch, pytest.raises(OSError, match="No space"):
        patch.setattr(json, "dump", full)
        store.save_analyst_state(state("lost"))
    assert store.load_analyst_state().sessionId == "good"
    assert [p.name for p in path.parent.iterdir() if p.name.endswith(".tmp")] == []


def test_the_checkpoint_keeps_its_last_good_copy(runs):
    store.save_analyst_state(state("a", "baseline"))
    store.save_analyst_state(state("a", "proposed"))
    backup = store.read_json(store.backup_path(store.analyst_state_path()))
    assert backup["step"] == "baseline"


@pytest.mark.parametrize("damage", ["half", "garbage", "empty", "wrong_shape"])
def test_a_corrupt_checkpoint_is_recovered_from_the_backup(runs, damage):
    store.save_analyst_state(state("a", "baseline"))
    store.save_analyst_state(state("a", "proposed"))
    path = store.analyst_state_path()
    text = path.read_text()
    path.write_text(
        {
            "half": text[: len(text) // 2],
            "garbage": "\x00\x01not json",
            "empty": "",
            "wrong_shape": json.dumps({"sessionId": 3}),
        }[damage]
    )
    loaded = store.load_analyst_state()
    assert loaded is not None and loaded.sessionId == "a" and loaded.step == "baseline"
    [restore] = [e for e in events(runs) if e["type"] == "restore"]
    assert restore["file"] == "analyst_state.json" and restore["outcome"] == "restored from .bak"


def test_a_corrupt_checkpoint_without_a_backup_starts_over_instead_of_crashing(runs):
    store.analyst_state_path().parent.mkdir(parents=True)
    store.analyst_state_path().write_text("{half")
    assert store.load_analyst_state() is None
    [restore] = [e for e in events(runs) if e["type"] == "restore"]
    assert restore["outcome"] == "no good copy: starting over"


def test_a_checkpoint_killed_between_the_two_renames_is_found_in_the_backup(runs):
    store.save_analyst_state(state("a", "baseline"))
    store.save_analyst_state(state("a", "proposed"))
    store.analyst_state_path().unlink()  # killed after .bak was made, before the new file landed
    assert store.load_analyst_state().step == "baseline"


def test_a_corrupt_notebook_and_index_recover_their_last_good_copy(runs):
    for run in (1, 2):
        store.upsert_index(
            RunListItem(run=run, seed=42, status="done", kpis=None, notebook="", createdAt="t")
        )
        store.append_notebook(
            NotebookEntry(run=run, line=f"run {run}", objectiveValue=1.0, at="t", objective="x")
        )
    store.notebook_path().write_text("[{")
    store.index_path().write_text("")
    assert [e.run for e in store.load_notebook()] == [1]
    assert [r.run for r in store.load_index()] == [1, 2]  # the copy before the last write


def test_a_run_with_a_corrupt_summary_is_not_reused_from_the_run_cache(runs, monkeypatch):
    monkeypatch.setattr(settings, "PROCESSED_DIR", runs.parent / "processed")
    run_dir = store.run_dir(5)
    run_dir.mkdir(parents=True)
    (run_dir / "summary.json").write_text('{"run": 5, "kpis": {')
    cache.run_record("key-5", 5, {})
    assert cache.run_lookup("key-5") is None
