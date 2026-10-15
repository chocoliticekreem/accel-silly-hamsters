"""Helpers every API router uses: run-file reads with 404s that say what is missing, the sample
run fallbacks, and contract serialization.

The API reads the files the sim and the agents write (layout in backend/store.py) on every
request and caches nothing, so a run that finishes while the server is up shows on the next call.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, TypeVar

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, TypeAdapter, ValidationError

from backend import contract, settings, store
from backend.contract import MapData

SAMPLE_RUN = 0  # runs/0: the hand-made sample, served until the sim has produced real runs

MapSource = Literal["processed", "sample", "missing"]
T = TypeVar("T")


def contract_json(value: BaseModel | Sequence[BaseModel] | Mapping[str, BaseModel]) -> JSONResponse:
    """A JSON response with contract field names (contract.dump: Suggestion.from_ -> "from")."""
    content: Any
    if isinstance(value, BaseModel):
        content = contract.dump(value)
    elif isinstance(value, Mapping):
        content = {key: contract.dump(item) for key, item in value.items()}
    else:
        content = [contract.dump(item) for item in value]
    return JSONResponse(content)


def display_path(path: Path) -> str:
    """A path for error messages: relative to the repo (or to the runs dir's parent in tests)."""
    for base in (settings.ROOT, settings.RUNS_DIR.parent):
        if path.is_relative_to(base):
            return path.relative_to(base).as_posix()
    return path.name


def validation_summary(error: ValidationError) -> str:
    """One line for an error message: how many errors, and where and what the first one is."""
    first = error.errors()[0]
    location = ".".join(str(part) for part in first["loc"]) or "(root)"
    return f"{error.error_count()} error(s), first at {location}: {first['msg']}"


def read_file(path: Path, type_: type[T]) -> T:
    """Parse a JSON file as `type_`.

    404 when the file is missing; 500 naming the file when it is corrupt or no longer matches its
    model, which means a writer and the contract have drifted apart.
    """
    try:
        data = store.read_json(path)
    except ValueError as e:
        raise HTTPException(500, f"{display_path(path)} is not valid JSON: {e}") from e
    if data is None:
        raise HTTPException(404, f"{display_path(path)} not found")
    try:
        return TypeAdapter(type_).validate_python(data)
    except ValidationError as e:
        detail = f"{display_path(path)} does not match its schema: {validation_summary(e)}"
        raise HTTPException(500, detail) from e


def run_path(run: int) -> Path:
    """runs/{run}/, or 404 when that run does not exist."""
    directory = store.run_dir(run)
    if not directory.is_dir():
        raise HTTPException(404, f"run {run} not found")
    return directory


def _status_hint(run: int) -> str:
    item = next((r for r in store.load_index() if r.run == run), None)
    return f" (status: {item.status})" if item is not None and item.status != "done" else ""


def run_file(run: int, name: str) -> Path:
    """An existing file inside runs/{run}/ (`name` may include a subdirectory, e.g. "days/3.json").

    404 says which file is missing, plus the run status while it is still queued or running.
    """
    directory = run_path(run)
    path = directory / name
    inside = path.resolve().is_relative_to(directory.resolve())
    if not inside or not path.is_file():
        raise HTTPException(404, f"run {run} has no {name}{_status_hint(run) if inside else ''}")
    return path


def read_run_file(run: int, name: str, type_: type[T]) -> T:
    """Parse runs/{run}/{name} as `type_`, with run_file's 404s and read_file's 500s."""
    return read_file(run_file(run, name), type_)


def sample_map_path() -> Path:
    """runs/0/map.json: the sample map served while data/processed/map.json is missing."""
    return store.run_dir(SAMPLE_RUN) / "map.json"


def map_source() -> MapSource:
    """Which map GET /api/map serves: the pipeline's, else the run-0 sample, else none."""
    if store.processed_path("map.json").is_file():
        return "processed"
    if sample_map_path().is_file():
        return "sample"
    return "missing"


def load_map() -> MapData:
    """data/processed/map.json, or the sample map while the pipeline has not produced one."""
    source = map_source()
    if source == "processed":
        return read_file(store.processed_path("map.json"), MapData)
    if source == "sample":
        return read_file(sample_map_path(), MapData)
    raise HTTPException(404, "no map: data/processed/map.json is missing; run the pipeline")
