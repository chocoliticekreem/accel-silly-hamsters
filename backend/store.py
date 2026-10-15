"""All file I/O for processed data and runs. No database: JSON files on disk.

Writers: sim.runner (run files, index), agents (suggestions, notebook, analyst state, reports),
api (decisions, queued runs). Readers: everyone. Writes are atomic and durable (temp file, fsync,
rename, fsync of the directory) so the API never serves a half-written file and a crash or full
disk never leaves one. State files (checkpoint, notebook, run index, decisions, run cache) keep
their last good copy as .bak and load through read_json_recovering.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from backend import settings
from backend.contract import MapData, RunListItem
from backend.schemas import (
    AnalystState,
    CalibrationFile,
    Decision,
    DemandFile,
    EnergyFile,
    NotebookEntry,
    PersonasFile,
    TrainingConfig,
)

T = TypeVar("T", bound=BaseModel)
_lock = threading.RLock()


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def backup_path(path: Path) -> Path:
    return path.with_name(path.name + ".bak")


def _fsync_dir(directory: Path) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:  # some filesystems cannot open a directory: the rename is still atomic
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _keep_backup(path: Path) -> None:
    """Point path.bak at the current file when it is good JSON (a hard link: no copy, no window
    without either file). A corrupt current file never replaces a good backup."""
    try:
        with open(path) as f:
            json.load(f)
    except (OSError, ValueError):
        return
    bak, tmp = backup_path(path), path.with_name(f".{path.name}.bak.tmp")
    tmp.unlink(missing_ok=True)
    try:
        os.link(path, tmp)
    except OSError:  # no hard links here: copy instead
        tmp.write_bytes(path.read_bytes())
    os.replace(tmp, bak)


def write_json(path: Path, obj: Any, *, backup: bool = False) -> None:
    """Atomic, durable write: temp file, fsync, rename, fsync the directory. A crash or a full
    disk at any point leaves the old file or the new one, never half of one (and no temp file).
    backup=True also keeps the previous good copy as path.bak (read_json_recovering)."""
    if isinstance(obj, BaseModel):
        obj = obj.model_dump(mode="json", by_alias=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Day files are the bulk of a run (agent keyframes); keep them compact.
    compact = path.parent.name == "days"
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(
                obj, f, separators=(",", ":") if compact else None, indent=None if compact else 2
            )
            f.flush()
            os.fsync(f.fileno())
        if backup and path.exists():
            _keep_backup(path)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    _fsync_dir(path.parent)


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with open(path) as f:
        return json.load(f)


def read_json_recovering(path: Path, default: Any = None, *, model: type[BaseModel] | None = None):
    """read_json for state files written with backup=True: a missing, half-written or corrupt
    file (bad JSON, or not a valid `model`) falls back to its .bak, logged as a "restore" event.
    With no good copy at all: `default` for an unreadable file (logged), but a readable file that
    no longer matches its schema raises (contract drift is a bug to see, not data to drop)."""
    problem: str | None = None
    drift: ValidationError | None = None
    for candidate in (path, backup_path(path)):
        if not candidate.exists():
            continue
        try:
            data = read_json(candidate)
            if model is not None:
                for item in data if isinstance(data, list) else [data]:
                    model.model_validate(item)
        except ValidationError as e:
            drift = drift or e
            problem = problem or f"ValidationError: {str(e)[:160]}"
            continue
        except (OSError, ValueError) as e:  # half-written, empty or garbage
            problem = problem or f"{type(e).__name__}: {str(e)[:160]}"
            continue
        if candidate != path or problem is not None:
            _restored(path, problem or "missing", "restored from .bak")
        return data
    if drift is not None:
        raise drift
    if problem is not None:
        _restored(path, problem, "no good copy: starting over")
    return default


def _restored(path: Path, problem: str, outcome: str) -> None:
    from backend import llm  # llm imports store

    llm.record_recovery(
        "restore",
        agent="store",
        file=path.name,
        kind="corrupt_file",
        error=problem,
        outcome=outcome,
    )


def read_model(path: Path, model: type[T]) -> T:
    data = read_json(path)
    if data is None:
        raise FileNotFoundError(path)
    return model.model_validate(data)


# --- processed data -------------------------------------------------------------------------


def processed_path(name: str) -> Path:
    return settings.PROCESSED_DIR / name


def load_map() -> MapData:
    return read_model(processed_path("map.json"), MapData)


def load_personas() -> PersonasFile:
    return read_model(processed_path("personas.json"), PersonasFile)


def load_demand() -> DemandFile:
    return read_model(processed_path("demand.json"), DemandFile)


def load_energy() -> EnergyFile:
    return read_model(processed_path("energy.json"), EnergyFile)


def load_calibration() -> CalibrationFile:
    return read_model(processed_path("calibration.json"), CalibrationFile)


# --- runs -----------------------------------------------------------------------------------


def run_dir(run: int) -> Path:
    return settings.RUNS_DIR / str(run)


def index_path() -> Path:
    return settings.RUNS_DIR / "index.json"


def load_index() -> list[RunListItem]:
    rows = read_json_recovering(index_path(), [], model=RunListItem)
    return [RunListItem.model_validate(r) for r in rows]


def upsert_index(item: RunListItem) -> None:
    with _lock:
        items = {r.run: r for r in load_index()}
        items[item.run] = item
        write_json(
            index_path(), [items[k].model_dump(mode="json") for k in sorted(items)], backup=True
        )


def update_index(run: int, **fields: Any) -> None:
    with _lock:
        items = {r.run: r for r in load_index()}
        if run not in items:
            raise KeyError(f"run {run} not in index")
        items[run] = items[run].model_copy(update=fields)
        write_json(
            index_path(), [items[k].model_dump(mode="json") for k in sorted(items)], backup=True
        )


def reserve_run_id() -> int:
    """Next free run id (>= 1; run 0 is the hand-made sample). Creates the dir to claim it."""
    with _lock:
        settings.RUNS_DIR.mkdir(parents=True, exist_ok=True)
        existing = [int(p.name) for p in settings.RUNS_DIR.iterdir() if p.name.isdigit()]
        existing += [r.run for r in load_index()]
        run = max([0, *existing]) + 1
        run_dir(run).mkdir(parents=True)
        return run


def real_runs() -> list[RunListItem]:
    """Runs produced by the sim (run 0, the hand-made sample, is excluded once real runs exist)."""
    items = load_index()
    real = [r for r in items if r.run != 0]
    return real if real else items


# --- notebook, analyst state, decisions -----------------------------------------------------


def notebook_path() -> Path:
    return settings.RUNS_DIR / "notebook.json"


def load_notebook() -> list[NotebookEntry]:
    rows = read_json_recovering(notebook_path(), [], model=NotebookEntry)
    return [NotebookEntry.model_validate(e) for e in rows]


def append_notebook(entry: NotebookEntry) -> None:
    with _lock:
        entries = [e for e in load_notebook() if e.run != entry.run] + [entry]
        write_json(notebook_path(), [e.model_dump(mode="json") for e in entries], backup=True)
        if any(r.run == entry.run for r in load_index()):
            update_index(entry.run, notebook=entry.line)


def analyst_state_path() -> Path:
    return settings.RUNS_DIR / "analyst_state.json"


def load_analyst_state() -> AnalystState | None:
    data = read_json_recovering(analyst_state_path(), model=AnalystState)
    return AnalystState.model_validate(data) if data else None


def save_analyst_state(state: AnalystState) -> None:
    state.updatedAt = now_iso()
    write_json(analyst_state_path(), state, backup=True)


def training_config_path() -> Path:
    return settings.RUNS_DIR / "training_config.json"


def load_training_config() -> TrainingConfig:
    """The saved training config; the defaults (from settings) when none was saved."""
    data = read_json(training_config_path())
    return TrainingConfig.model_validate(data) if data else TrainingConfig()


def save_training_config(config: TrainingConfig) -> None:
    write_json(training_config_path(), config)


def training_lock_path() -> Path:
    """Locked (flock) by the process running a training session, for as long as it runs."""
    return settings.RUNS_DIR / "training.lock"


def training_stop_path() -> Path:
    """Present while a stop was requested: training stops at its next step boundary."""
    return settings.RUNS_DIR / "training_stop.flag"


def set_training_stop() -> None:
    path = training_stop_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(now_iso() + "\n")


def clear_training_stop() -> None:
    training_stop_path().unlink(missing_ok=True)


def decisions_path() -> Path:
    return settings.RUNS_DIR / "decisions.json"


def load_decisions() -> list[Decision]:
    rows = read_json_recovering(decisions_path(), [], model=Decision)
    return [Decision.model_validate(d) for d in rows]


def append_decision(decision: Decision) -> None:
    with _lock:
        items = [d.model_dump(mode="json") for d in load_decisions()]
        items.append(decision.model_dump(mode="json"))
        write_json(decisions_path(), items, backup=True)
