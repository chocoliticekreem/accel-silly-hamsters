"""API tests: every endpoint against the data contract in docs/FRONTEND_PROMPT.md.

Responses are checked two ways: they validate against the backend/contract.py models, and they
carry exactly the keys of the contract's sample JSON (parsed from the doc itself), plus only the
additive extras listed in backend/CONTRACT_CHANGES.md. Each test runs on a temporary copy of the
runs/0 sample (settings.RUNS_DIR / PROCESSED_DIR monkeypatched), never on the real runs/ dir.
"""

from __future__ import annotations

import importlib
import json
import re
import shutil
import sys
import threading
import types
from collections.abc import Iterator
from functools import cache as memoize
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter
from test_agents_fakesim import FakeSim, setup_world  # pytest puts tests/ on sys.path
from test_agents_training import lock_held_elsewhere

from backend import cache, settings, store
from backend.agents import training
from backend.api import apply
from backend.api.main import app
from backend.api.routers import training as training_router
from backend.contract import (
    AnalystStatus,
    DayData,
    Kpis,
    MapData,
    RunListItem,
    StoreReport,
    StoreRunResult,
    Suggestion,
)
from backend.schemas import (
    AnalystState,
    CalibrationFile,
    CalibrationVenue,
    Levers,
    NotebookEntry,
    RunConfig,
    RunSummary,
    StoreConfig,
    TrainingConfig,
)

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_DIR = ROOT / "runs" / "0"

# Additive keys allowed on top of the contract samples; each must be documented in
# backend/CONTRACT_CHANGES.md (checked by test_every_allowed_extra_is_documented).
MAP_EXTRAS = frozenset({"sources", "licensedHours", "defaultHours", "floorArea", "osmId"})
RUN_EXTRAS = frozenset({"costPerStoreWeekGbp"})  # in the contract text, not its sample JSON
SUGGESTION_EXTRAS = frozenset({"confidence", "reason"})
REPORT_EXTRAS = frozenset({"note", "fetchedAt"}) | SUGGESTION_EXTRAS
ANALYST_EXTRAS = frozenset({"baselineRun"})
NO_EXTRAS: frozenset[str] = frozenset()


# --- contract samples -----------------------------------------------------------------------


@memoize
def contract_samples() -> dict[str, list[Any]]:
    """JSON samples per endpoint from the doc's "Data contract" section (fenced blocks first,
    then inline `{...}` spans), keyed like "GET /api/map"."""
    text = (ROOT / "docs" / "FRONTEND_PROMPT.md").read_text()
    section = text.split("## Data contract", 1)[1].split("\n## ", 1)[0]
    samples: dict[str, list[Any]] = {}
    for block in section.split("\n### ")[1:]:
        heading, _, body = block.partition("\n")
        match = re.search(r"`([A-Z]+ [^`?]+)", heading)
        assert match, heading
        found = [json.loads(m) for m in re.findall(r"```json\n(.*?)\n```", body, re.S)]
        found += [json.loads(m) for m in re.findall(r"`(\{.*?\})`", body)]
        samples[match.group(1)] = found
    return samples


def sample(endpoint: str, index: int = 0) -> Any:
    return contract_samples()[endpoint][index]


def assert_keys_match(actual: Any, expected: Any, extras: frozenset[str], where: str = "$") -> None:
    """`actual` has the sample's keys at every level, plus only the listed extras.

    In a list of objects, keys present in every sample item are required and keys present in
    only some are optional (Building.storeId, EntryPoint.name, Suggestion.hours).
    """
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{where}: expected an object, got {actual!r}"
        _check_object(actual, [expected], extras, where)
    elif isinstance(expected, list) and expected and all(isinstance(i, dict) for i in expected):
        assert isinstance(actual, list), f"{where}: expected a list, got {actual!r}"
        for index, item in enumerate(actual):
            assert isinstance(item, dict), f"{where}[{index}]: expected an object"
            _check_object(item, expected, extras, f"{where}[{index}]")


def _check_object(actual: dict, samples: list[dict], extras: frozenset[str], where: str) -> None:
    required = set.intersection(*(set(s) for s in samples))
    allowed = set().union(*(set(s) for s in samples))
    missing = required - actual.keys()
    unexpected = actual.keys() - allowed - extras
    assert not missing, f"{where}: missing contract keys {sorted(missing)}"
    assert not unexpected, f"{where}: keys outside the contract {sorted(unexpected)}"
    for key in actual.keys() & allowed:
        expected = next(s[key] for s in samples if key in s)
        assert_keys_match(actual[key], expected, extras, f"{where}.{key}")


def test_key_check_catches_drift() -> None:
    with pytest.raises(AssertionError, match="outside the contract"):
        assert_keys_match({"a": 1, "from_": 2}, {"a": 0}, NO_EXTRAS)
    with pytest.raises(AssertionError, match="missing contract keys"):
        assert_keys_match([{"id": "b1"}], [{"id": "b0", "kind": "office"}], NO_EXTRAS)
    assert_keys_match([{"id": "b1"}], [{"id": "b0", "storeId": "s1"}, {"id": "b2"}], NO_EXTRAS)


def test_every_allowed_extra_is_documented() -> None:
    changes = (ROOT / "backend" / "CONTRACT_CHANGES.md").read_text()
    for key in MAP_EXTRAS | RUN_EXTRAS | REPORT_EXTRAS | ANALYST_EXTRAS:
        assert f"`{key}`" in changes, key
    assert "none are breaking" in changes.lower()


def test_every_contract_endpoint_is_served() -> None:
    def normalise(path: str) -> str:
        return re.sub(r"\{[^}]+\}", "{}", path)

    served = {
        f"{method.upper()} {normalise(path)}"
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }
    additive = {
        "GET /files/reports/{run}/{storeId}.pdf",
        "GET /api/runs/{run}/summary",
        "GET /api/notebook",
        "GET /api/health",
        "GET /api/training",
        "PUT /api/training/config",
        "POST /api/training/start",
        "POST /api/training/stop",
    }
    changes = (ROOT / "backend" / "CONTRACT_CHANGES.md").read_text()
    for endpoint in additive:
        assert f"New `{endpoint}`" in changes, endpoint
    for endpoint in [*contract_samples(), *additive]:
        method, path = endpoint.split(" ", 1)
        assert f"{method} {normalise(path)}" in served, endpoint


# --- fixtures -------------------------------------------------------------------------------


@pytest.fixture
def runs_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    runs = tmp_path / "runs"
    shutil.copytree(SAMPLE_DIR, runs / "0")
    monkeypatch.setattr(settings, "RUNS_DIR", runs)
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    return runs


@pytest.fixture
def client(runs_dir: Path) -> TestClient:
    return TestClient(app)


def read(path: Path) -> Any:
    return json.loads(path.read_text())


def add_run(runs: Path, run: int, *, status: str = "done", report: bool = True) -> RunConfig:
    """A real run built from the sample files, recorded in runs/index.json."""
    shutil.copytree(
        runs / "0",
        runs / str(run),
        ignore=shutil.ignore_patterns("map.json", "run.json", *(() if report else ("reports",))),
    )
    config = RunConfig.model_validate(read(runs / "0" / "config.json"))
    config = config.model_copy(update={"run": run})
    store.write_json(runs / str(run) / "config.json", config)
    item = RunListItem.model_validate(read(runs / "0" / "run.json"))
    store.upsert_index(
        item.model_copy(update={"run": run, "status": status, "notebook": f"r{run}"})
    )
    return config


def write_processed_map(runs: Path) -> MapData:
    map_data = MapData.model_validate(read(runs / "0" / "map.json"))
    store.write_json(settings.PROCESSED_DIR / "map.json", map_data)
    return map_data


def dict_keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in dict_keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in dict_keys(v)}
    return set()


# --- the runs/0 sample ----------------------------------------------------------------------


def test_sample_run_is_complete_valid_and_small() -> None:
    files = {p.relative_to(SAMPLE_DIR).as_posix() for p in SAMPLE_DIR.rglob("*") if p.is_file()}
    days = {f"days/{d}.json" for d in range(1, 15)}
    expected = {"run.json", "config.json", "stores.json", "suggestions.json", "summary.json"}
    expected |= {"owner_events.json", "street_events.json"}
    assert files == expected | days | {"map.json", "reports/s3.json", "reports/s3.pdf"}
    assert sum(p.stat().st_size for p in SAMPLE_DIR.rglob("*") if p.is_file()) < 300_000

    map_data = MapData.model_validate(read(SAMPLE_DIR / "map.json"))
    store_ids = {s.id for s in map_data.stores}
    assert RunListItem.model_validate(read(SAMPLE_DIR / "run.json")).run == 0
    config = RunConfig.model_validate(read(SAMPLE_DIR / "config.json"))
    assert set(config.stores) == store_ids
    stores = TypeAdapter(dict[str, StoreRunResult]).validate_python(
        read(SAMPLE_DIR / "stores.json")
    )
    assert len(stores) >= 3 and set(stores) <= store_ids
    summary = RunSummary.model_validate(read(SAMPLE_DIR / "summary.json"))
    assert not dict_keys(summary.model_dump()) & store_ids  # area view carries no store ids
    report = StoreReport.model_validate(read(SAMPLE_DIR / "reports" / "s3.json"))
    assert report.pdfUrl == "/files/reports/0/s3.pdf"
    assert (SAMPLE_DIR / "reports" / "s3.pdf").read_bytes().startswith(b"%PDF")

    s3, contract_s3 = stores["s3"], sample("GET /api/runs/{run}/stores")["s3"]
    assert (s3.open, s3.close) == (contract_s3["open"], contract_s3["close"])
    assert s3.kpis.model_dump() == contract_s3["kpis"]
    assert s3.lighting[:8] == contract_s3["lighting"][:8]
    assert s3.visitsByHour[:8] == contract_s3["visitsByHour"][:8]
    assert read(SAMPLE_DIR / "suggestions.json") == sample("GET /api/runs/{run}/suggestions")


@pytest.mark.parametrize("day", range(1, 15))
def test_sample_day_agents_stay_in_bounds_and_in_their_day(day: int) -> None:
    map_data = MapData.model_validate(read(SAMPLE_DIR / "map.json"))
    bounds, store_ids = map_data.bounds, {s.id for s in map_data.stores}
    data = DayData.model_validate(read(SAMPLE_DIR / "days" / f"{day}.json"))
    assert data.day == day and 5 <= len(data.agents) <= 20
    assert len({a.id for a in data.agents}) == len(data.agents)
    start, end = (day - 1) * 1440, day * 1440
    for agent in data.agents:
        times = [t for t, _, _ in agent.path]
        assert times == sorted(times) and start <= times[0] and times[-1] < end, agent.id
        for _, x, z in agent.path:
            assert bounds.minX <= x <= bounds.maxX and bounds.minZ <= z <= bounds.maxZ, agent.id
        for visit in agent.visits:
            assert visit.storeId in store_ids
            assert times[0] <= visit.tIn <= visit.tOut <= times[-1], agent.id


# --- GET /api/health, /api/map --------------------------------------------------------------


def test_health(client: TestClient, runs_dir: Path) -> None:
    body = client.get("/api/health").json()
    assert body == {
        "ok": True,
        "simVersion": settings.SIM_VERSION,
        "mapSource": "sample",
        "realRuns": 0,
    }
    add_run(runs_dir, 4)
    write_processed_map(runs_dir)
    assert client.get("/api/health").json()["mapSource"] == "processed"
    assert client.get("/api/health").json()["realRuns"] == 1


def test_map_serves_the_sample_until_the_pipeline_map_exists(
    client: TestClient, runs_dir: Path
) -> None:
    response = client.get("/api/map")
    assert response.status_code == 200
    body = response.json()
    MapData.model_validate(body)
    assert_keys_match(body, sample("GET /api/map"), MAP_EXTRAS)
    assert body == read(runs_dir / "0" / "map.json")

    processed = write_processed_map(runs_dir)
    processed.stores[0].osmId = "node/123"
    store.write_json(settings.PROCESSED_DIR / "map.json", processed)
    body = client.get("/api/map").json()
    assert body["stores"][0]["osmId"] == "node/123"
    assert_keys_match(body, sample("GET /api/map"), MAP_EXTRAS)


def test_map_missing_everywhere_is_404(client: TestClient, runs_dir: Path) -> None:
    (runs_dir / "0" / "map.json").unlink()
    response = client.get("/api/map")
    assert response.status_code == 404
    assert "run the pipeline" in response.json()["detail"]


# --- GET /api/runs and per-run files --------------------------------------------------------


def test_runs_lists_the_sample_while_no_real_runs_exist(client: TestClient) -> None:
    body = client.get("/api/runs").json()
    TypeAdapter(list[RunListItem]).validate_python(body)
    assert [r["run"] for r in body] == [0]
    assert_keys_match(body, sample("GET /api/runs"), RUN_EXTRAS)
    assert "costPerStoreWeekGbp" in body[0]


def test_runs_hides_the_sample_once_real_runs_exist(client: TestClient, runs_dir: Path) -> None:
    store.upsert_index(RunListItem.model_validate(read(runs_dir / "0" / "run.json")))
    assert [r["run"] for r in client.get("/api/runs").json()] == [0]
    add_run(runs_dir, 4)
    add_run(runs_dir, 5, status="queued")
    store.update_index(5, kpis=None)
    body = client.get("/api/runs").json()
    assert [(r["run"], r["status"]) for r in body] == [(4, "done"), (5, "queued")]
    assert_keys_match(body[:1], sample("GET /api/runs"), RUN_EXTRAS)
    assert body[1]["kpis"] is None


def test_run_stores(client: TestClient) -> None:
    body = client.get("/api/runs/0/stores").json()
    TypeAdapter(dict[str, StoreRunResult]).validate_python(body)
    contract_store = sample("GET /api/runs/{run}/stores")["s3"]
    for store_id, result in body.items():
        assert_keys_match(result, contract_store, NO_EXTRAS, f"$.{store_id}")
        assert len(result["lighting"]) == 24 and len(result["visitsByHour"]) == 24


def test_run_day_is_the_file_on_disk(client: TestClient, runs_dir: Path) -> None:
    response = client.get("/api/runs/0/days/5")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.content == (runs_dir / "0" / "days" / "5.json").read_bytes()
    body = response.json()
    DayData.model_validate(body)
    assert_keys_match(body, sample("GET /api/runs/{run}/days/{day}"), NO_EXTRAS)


@pytest.mark.parametrize(
    ("path", "status"),
    [
        ("/api/runs/0/days/0", 404),
        ("/api/runs/0/days/15", 404),
        ("/api/runs/9/days/1", 404),
        ("/api/runs/0/days/one", 422),
        ("/api/runs/x/stores", 422),
        ("/api/runs/9/stores", 404),
        ("/api/runs/9/suggestions", 404),
        ("/api/runs/9/summary", 404),
        ("/api/stores/s3/report?run=9", 404),
        ("/api/stores/s3/report?run=latest", 422),
        ("/api/stores/nope/report", 404),
        ("/files/reports/0/nope.pdf", 404),
        ("/files/reports/9/s3.pdf", 404),
    ],
)
def test_unknown_run_day_store_and_bad_input(client: TestClient, path: str, status: int) -> None:
    assert client.get(path).status_code == status


def test_missing_file_of_a_queued_run_names_the_status(client: TestClient, runs_dir: Path) -> None:
    (runs_dir / "6").mkdir()
    store.upsert_index(
        RunListItem(run=6, seed=42, status="queued", kpis=None, notebook="", createdAt="now")
    )
    response = client.get("/api/runs/6/stores")
    assert response.status_code == 404
    assert response.json()["detail"] == "run 6 has no stores.json (status: queued)"


def test_run_suggestions_use_the_contract_field_names(client: TestClient) -> None:
    body = client.get("/api/runs/0/suggestions").json()
    TypeAdapter(list[Suggestion]).validate_python(body)
    assert_keys_match(body, sample("GET /api/runs/{run}/suggestions"), SUGGESTION_EXTRAS)
    assert body == sample("GET /api/runs/{run}/suggestions")
    assert all("from" in s and "from_" not in s for s in body)


def test_run_summary_has_no_store_ids(client: TestClient, runs_dir: Path) -> None:
    body = client.get("/api/runs/0/summary").json()
    RunSummary.model_validate(body)
    store_ids = {s["id"] for s in read(runs_dir / "0" / "map.json")["stores"]}
    assert not dict_keys(body) & store_ids


def test_data_file_that_drifted_from_the_contract_is_a_named_500(
    client: TestClient, runs_dir: Path
) -> None:
    stores = read(runs_dir / "0" / "stores.json")
    stores["s3"]["lighting"] = stores["s3"]["lighting"][:23]
    store.write_json(runs_dir / "0" / "stores.json", stores)
    response = client.get("/api/runs/0/stores")
    assert response.status_code == 500
    assert response.json()["detail"].startswith("runs/0/stores.json does not match its schema")

    (runs_dir / "analyst_state.json").write_text(json.dumps({"state": "paused"}))
    response = client.get("/api/analyst")
    assert response.status_code == 500
    assert "AnalystState" in response.json()["detail"]


# --- GET /api/analyst, /api/notebook --------------------------------------------------------


def test_analyst_before_it_has_ever_run(client: TestClient) -> None:
    body = client.get("/api/analyst").json()
    assert body == {
        "state": "stopped",
        "startedAt": None,
        "iterations": 0,
        "bestRun": None,
        "stoppedReason": None,
    }
    assert_keys_match(body, sample("GET /api/analyst"), NO_EXTRAS)


def test_analyst_from_the_checkpoint(client: TestClient) -> None:
    store.save_analyst_state(
        AnalystState(
            sessionId="sess-1",
            state="running",
            startedAt="2026-10-15T23:00:00Z",
            updatedAt="2026-10-16T08:12:00Z",
            backend="heuristic",
            fresh=False,
            seed=42,
            bestRun=9,
            iterations=10,
            stoppedReason=None,
        )
    )
    body = client.get("/api/analyst").json()
    AnalystStatus.model_validate(body)
    assert body == sample("GET /api/analyst")


def test_notebook(client: TestClient) -> None:
    assert client.get("/api/notebook").json() == []
    entry = NotebookEntry(run=3, line="Opened Cafe till 03:00", objectiveValue=2.1, at="t")
    store.append_notebook(entry)
    assert client.get("/api/notebook").json() == [entry.model_dump(mode="json")]


def kpis(visits_per_kwh: float) -> Kpis:
    return Kpis(visits=1000, kwh=1000 / visits_per_kwh, visitsPerKwh=visits_per_kwh, returnRate=0.3)


def test_analyst_without_a_session_reads_the_real_runs(client: TestClient, runs_dir: Path) -> None:
    for run, value in ((4, 1.0), (5, 1.4), (7, 1.2)):
        add_run(runs_dir, run)
        store.update_index(run, kpis=kpis(value), createdAt=f"2026-10-14T2{run - 4}:00:00Z")
    add_run(runs_dir, 8, status="queued")
    store.update_index(8, kpis=None)
    body = client.get("/api/analyst").json()
    AnalystStatus.model_validate(body)
    assert body == {
        "state": "stopped",
        "startedAt": "2026-10-14T20:00:00Z",  # the first real run's createdAt
        "iterations": 0,
        "bestRun": 5,  # best visitsPerKwh among finished real runs
        "stoppedReason": None,
        "baselineRun": 4,
    }
    assert_keys_match(body, sample("GET /api/analyst"), ANALYST_EXTRAS)


def test_analyst_baseline_comes_from_the_session_else_the_first_real_run(
    client: TestClient, runs_dir: Path
) -> None:
    state = AnalystState(
        sessionId="s",
        state="stopped",
        startedAt="t",
        updatedAt="t",
        backend="heuristic",
        fresh=False,
        seed=42,
        baselineRun=3,
        bestRun=9,
        iterations=4,
        stoppedReason="stopped",
    )
    store.save_analyst_state(state)
    body = client.get("/api/analyst").json()
    assert (body["baselineRun"], body["bestRun"], body["stoppedReason"]) == (3, 9, "stopped")
    add_run(runs_dir, 6)
    store.save_analyst_state(state.model_copy(update={"baselineRun": None}))  # just started
    assert client.get("/api/analyst").json()["baselineRun"] == 6


# --- training controls: GET /api/training, PUT config, POST start / stop -------------------


def test_training_overview(client: TestClient, runs_dir: Path) -> None:
    body = client.get("/api/training").json()
    assert set(body) == {"config", "options", "status", "running"}
    assert TrainingConfig.model_validate(body["config"]) == TrainingConfig()
    assert body["running"] is False
    assert body["status"] == client.get("/api/analyst").json()
    options = body["options"]
    objectives = ["visitsPerKwh", "netValueGbp", "visits", "storeProfitGbp"]
    assert options["objective"] == {"values": objectives}
    assert options["threshold"] == {"min": 0.0, "max": 1.0}
    assert options["patience"] == {"min": 1}
    assert options["maxRuns"] == {"min": 2, "max": 50}
    assert options["maxStoresPerIteration"] == {"min": 1, "max": 24}
    assert options["maxChangesPerStore"] == {"min": 1, "max": 2}
    assert options["sessionBudgetUsd"] == {"min": 0.01, "max": settings.SPEND_CAP_USD}
    assert options["levers"] == {"values": ["hours", "lighting"], "minEnabled": 1}
    assert [s["id"] for s in options["storeIds"]["stores"]] == ["s1", "s2", "s3", "s4"]  # no club
    assert options["analystBackend"]["values"] == ["auto", "heuristic", "messages", "managed"]
    assert options["storeAgents"]["values"] == ["auto", "heuristic", "batch"]


def test_put_training_config_validates_and_saves(client: TestClient, runs_dir: Path) -> None:
    write_processed_map(runs_dir)  # storeIds are checked against the processed map
    body = {"objective": "netValueGbp", "threshold": 0.01, "storeIds": ["s3"]}
    body["levers"] = {"hours": True, "lighting": False}
    response = client.put("/api/training/config", json=body)
    assert response.status_code == 200
    saved = TrainingConfig.model_validate(response.json())
    assert saved == TrainingConfig(
        objective="netValueGbp", threshold=0.01, storeIds=["s3"], levers=Levers(lighting=False)
    )
    assert store.load_training_config() == saved
    assert client.get("/api/training").json()["config"] == response.json()


@pytest.mark.parametrize(
    "body",
    [
        {"threshold": 2},
        {"maxRuns": 1},
        {"maxChangesPerStore": 3},
        {"levers": {"hours": False, "lighting": False}},
        {"storeIds": []},
        {"storeIds": ["zz"]},
        {"storeIds": ["c1"]},
        {"sessionBudgetUsd": 1000},
        {"objective": "kwh"},
        {"turbo": True},
    ],
)
def test_put_training_config_rejects_bad_values(
    client: TestClient, runs_dir: Path, body: dict[str, Any]
) -> None:
    write_processed_map(runs_dir)
    assert client.put("/api/training/config", json=body).status_code == 422
    assert not store.training_config_path().exists()


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PUT", "/api/training/config", {}),
        ("PUT", "/api/training/config", {"threshold": 2}),  # read-only wins over a bad body
        ("POST", "/api/training/start", {}),
        ("POST", "/api/training/start", {"config": {"maxRuns": 1}}),
        ("POST", "/api/training/stop", None),
    ],
)
def test_training_writes_are_403_on_a_read_only_deployment(
    client: TestClient,
    runs_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> None:
    monkeypatch.setattr(settings, "READ_ONLY", True)
    response = client.request(method, path, json=body)
    assert response.status_code == 403
    assert response.json()["detail"].startswith("read-only deployment")
    assert not store.training_config_path().exists() and not store.training_stop_path().exists()
    assert client.get("/api/training").status_code == 200  # reads still work


def test_start_needs_the_pipelines_map(client: TestClient, runs_dir: Path) -> None:
    response = client.post("/api/training/start")
    assert response.status_code == 503
    assert "run the pipeline" in response.json()["detail"]
    assert store.load_analyst_state() is None


@pytest.fixture
def trainer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[TestClient, FakeSim]]:
    """The API on the agents' fake sim, so POST /api/training/start really trains (offline)."""
    sim = setup_world(tmp_path, monkeypatch)
    yield TestClient(app), sim
    wait_for_training()  # before monkeypatch restores RUNS_DIR under a running session


def wait_for_training() -> None:
    thread = training_router._thread
    if thread is not None:
        thread.join(timeout=60)
        assert not thread.is_alive()


def test_start_trains_in_the_background_with_the_body_config(
    trainer: tuple[TestClient, FakeSim],
) -> None:
    client, _ = trainer
    config = {"maxRuns": 2, "levers": {"hours": True, "lighting": False}}
    response = client.post("/api/training/start", json={"config": config, "fresh": True})
    assert response.status_code == 200
    assert response.json()["state"] == "running"
    wait_for_training()
    status = client.get("/api/analyst").json()
    assert status == {
        "state": "stopped",
        "startedAt": status["startedAt"],
        "iterations": 2,
        "bestRun": 2,
        "stoppedReason": "max_runs",
        "baselineRun": 1,
    }
    overview = client.get("/api/training").json()
    assert overview["running"] is False
    assert overview["config"] == TrainingConfig.model_validate(config).model_dump(mode="json")
    state = store.load_analyst_state()
    assert state is not None and state.fresh and state.config == TrainingConfig(**config)


def test_one_session_at_a_time_and_stop_asks_it_to_stop(
    trainer: tuple[TestClient, FakeSim], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = trainer
    release = threading.Event()
    real_run = training.run

    def held_run(session: training.Session) -> AnalystState:
        release.wait(timeout=30)
        return real_run(session)

    monkeypatch.setattr(training, "run", held_run)
    try:
        assert client.post("/api/training/start").status_code == 200
        assert client.get("/api/training").json()["running"] is True
        assert client.post("/api/training/start").status_code == 409
        assert client.put("/api/training/config", json={"threshold": 0.01}).status_code == 409
        stop = client.post("/api/training/stop")
        assert stop.status_code == 200
        assert stop.json()["state"] == "running"  # it stops at the next step boundary
        assert training.stop_requested()
    finally:
        release.set()
    wait_for_training()
    status = client.get("/api/analyst").json()
    assert (status["state"], status["stoppedReason"]) == ("stopped", "stopped")
    assert not training.stop_requested()
    assert client.put("/api/training/config", json={"threshold": 0.01}).status_code == 200


def test_start_refuses_a_session_another_process_is_running(
    trainer: tuple[TestClient, FakeSim],
) -> None:
    client, sim = trainer
    now = store.now_iso()
    cli_session = AnalystState(
        sessionId="cli-sess",
        state="running",
        startedAt=now,
        updatedAt=now,
        backend="heuristic",
        fresh=False,
        seed=42,
        owner="laptop:4242",
    )
    store.save_analyst_state(cli_session)
    store.set_training_stop()  # the CLI session's pending stop request
    with lock_held_elsewhere(store.training_lock_path()):  # e.g. `cli train` in a terminal
        response = client.post("/api/training/start", json={"config": {"maxRuns": 3}})
    assert response.status_code == 409
    assert response.json()["detail"].startswith(
        "session cli-sess (laptop:4242) is still running in another process"
    )
    assert store.training_stop_path().exists() and sim.simulations == 0
    assert not store.training_config_path().exists()  # a refused start saves nothing
    assert store.load_analyst_state() == cli_session


@pytest.mark.parametrize(
    "body", [{"config": {"maxRuns": 1}}, {"config": {"storeIds": ["c1"]}}, {"fresh": "x"}]
)
def test_start_with_a_bad_config_starts_nothing(
    trainer: tuple[TestClient, FakeSim], body: dict[str, Any]
) -> None:
    client, sim = trainer
    assert client.post("/api/training/start", json=body).status_code == 422
    assert store.load_analyst_state() is None and sim.simulations == 0
    assert not store.training_config_path().exists()


# --- GET /api/stores/{storeId}/report and the PDF -------------------------------------------


def test_report_defaults_to_the_sample_run(client: TestClient) -> None:
    body = client.get("/api/stores/s3/report").json()
    StoreReport.model_validate(body)
    assert_keys_match(body, sample("GET /api/stores/{storeId}/report"), REPORT_EXTRAS)
    assert body["pdfUrl"] == "/files/reports/0/s3.pdf"
    assert client.get("/api/stores/s3/report?run=0").json() == body


def test_report_default_run_follows_the_analyst_then_the_latest_done_run(
    client: TestClient, runs_dir: Path
) -> None:
    for run in (4, 7):
        add_run(runs_dir, run)
        report = read(runs_dir / str(run) / "reports" / "s3.json")
        report["pdfUrl"] = f"/files/reports/{run}/s3.pdf"
        store.write_json(runs_dir / str(run) / "reports" / "s3.json", report)
    add_run(runs_dir, 8, status="queued")
    assert client.get("/api/stores/s3/report").json()["pdfUrl"].endswith("/7/s3.pdf")
    state = AnalystState(
        sessionId="s",
        state="stopped",
        startedAt="t",
        updatedAt="t",
        backend="heuristic",
        fresh=False,
        seed=42,
        bestRun=4,
        stoppedReason="threshold",
    )
    store.save_analyst_state(state)
    assert client.get("/api/stores/s3/report").json()["pdfUrl"].endswith("/4/s3.pdf")


def test_report_without_a_finished_real_run_is_404(client: TestClient, runs_dir: Path) -> None:
    add_run(runs_dir, 4, status="running")
    response = client.get("/api/stores/s3/report")
    assert response.status_code == 404
    assert "pass ?run=" in response.json()["detail"]


def test_report_pdf(client: TestClient, runs_dir: Path) -> None:
    pdf_url = client.get("/api/stores/s3/report").json()["pdfUrl"]
    response = client.get(pdf_url)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content == (runs_dir / "0" / "reports" / "s3.pdf").read_bytes()


# --- POST /api/decision ---------------------------------------------------------------------


def test_decision_contract_sample_is_recorded(client: TestClient, runs_dir: Path) -> None:
    request, expected = contract_samples()["POST /api/decision"]
    response = client.post("/api/decision", json=request)
    assert response.status_code == 200
    assert response.json() == expected
    [decision] = read(runs_dir / "decisions.json")
    report_change = read(runs_dir / "0" / "reports" / "s3.json")["changes"][0]
    assert decision["storeId"] == "s3" and decision["run"] == 0
    assert decision["decision"] == "approve" and decision["reason"] == "optional"
    assert decision["suggestion"] == report_change


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"storeId": "zz", "suggestionIndex": 0, "decision": "approve"}, 404),
        ({"storeId": "s1", "suggestionIndex": 0, "decision": "approve"}, 404),
        ({"storeId": "s3", "suggestionIndex": 1, "decision": "approve"}, 422),
        ({"storeId": "s3", "suggestionIndex": -1, "decision": "reject"}, 422),
        ({"storeId": "s3", "suggestionIndex": 0, "decision": "maybe"}, 422),
        ({"storeId": "s3", "decision": "approve"}, 422),
        ({"storeId": "s3", "suggestionIndex": 0, "decision": "approve", "extra": 1}, 422),
    ],
)
def test_decision_validation(
    client: TestClient, runs_dir: Path, body: dict[str, Any], status: int
) -> None:
    assert client.post("/api/decision", json=body).status_code == status
    assert not (runs_dir / "decisions.json").exists()


def test_decision_indexes_the_run_suggestions_when_there_is_no_report(
    client: TestClient, runs_dir: Path
) -> None:
    add_run(runs_dir, 4, report=False)
    body = {"storeId": "s3", "suggestionIndex": 1, "decision": "reject", "reason": "too dark"}
    assert client.post("/api/decision", json=body).status_code == 200
    assert client.post("/api/decision?run=0", json=body).status_code == 422
    [decision] = read(runs_dir / "decisions.json")
    assert decision["run"] == 4
    assert decision["suggestion"] == sample("GET /api/runs/{run}/suggestions")[1]


# --- POST /api/apply ------------------------------------------------------------------------


class FakeRunner:
    """Stands in for backend.sim.runner.execute_run; records each call."""

    def __init__(self, result: int | None = None, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result, self.error = result, error

    def __call__(self, stores: dict[str, StoreConfig], seed: int, **kwargs: Any) -> int:
        status = next(r.status for r in store.load_index() if r.run == kwargs["run_id"])
        self.calls.append({"stores": stores, "seed": seed, "status_during_run": status, **kwargs})
        if self.error is not None:
            raise self.error
        return kwargs["run_id"] if self.result is None else self.result


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch) -> FakeRunner:
    fake = FakeRunner()
    monkeypatch.setattr("backend.sim.runner.execute_run", fake)
    return fake


@pytest.fixture
def no_rules(monkeypatch: pytest.MonkeyPatch) -> None:
    """Simulate the parallel build state where backend.agents.rules does not exist yet."""
    monkeypatch.setitem(sys.modules, apply.RULES_MODULE, None)


class FakeRules(types.ModuleType):
    """Stands in for backend.agents.rules: `decide` maps the selected suggestions to
    (accepted, rejections); calls to check_changes and log_rejections are recorded."""

    def __init__(self, decide: Any = None) -> None:
        super().__init__(apply.RULES_MODULE)
        self.decide: Any = decide or (lambda suggestions: (suggestions, []))
        self.checks: list[dict[str, Any]] = []
        self.logged: list[tuple[Any, ...]] = []

    def check_changes(self, base, suggestions, map_data, *, check_tried=True):
        self.checks.append(
            {"map_data": map_data, "check_tried": check_tried, "n": len(suggestions)}
        )
        accepted, rejections = self.decide(suggestions)
        configs = apply.apply_suggestions(base, accepted)
        return types.SimpleNamespace(configs=configs, accepted=accepted, rejections=rejections)

    def log_rejections(self, run, rejections, *, agent):
        self.logged.append((run, rejections, agent))


def install_rules(monkeypatch: pytest.MonkeyPatch, rules: types.ModuleType) -> None:
    monkeypatch.setitem(sys.modules, apply.RULES_MODULE, rules)


def apply_body(run: int = 4, **fields: Any) -> dict[str, Any]:
    return {"run": run, "scope": "store", "storeIds": ["s3"], **fields}


def test_apply_queues_a_run_with_the_store_suggestions(
    client: TestClient, runs_dir: Path, runner: FakeRunner, no_rules: None
) -> None:
    add_run(runs_dir, 4)
    request = {**sample("POST /api/apply", 0), "run": 4}
    response = client.post("/api/apply", json=request)
    assert response.status_code == 200
    assert response.json() == {"queuedRun": 5}
    assert_keys_match(response.json(), sample("POST /api/apply", 2), NO_EXTRAS)

    [call] = runner.calls
    s3 = call["stores"]["s3"]
    assert (s3.open, s3.close) == ("07:00", "03:00")
    assert s3.lighting[1:3] == ["low", "low"]
    base_s1 = RunConfig.model_validate(read(runs_dir / "4" / "config.json")).stores["s1"]
    assert call["stores"]["s1"] == base_s1
    assert call["seed"] == 42 and call["parent_run"] == 4 and call["run_id"] == 5
    assert call["applied_changes"] == sample("GET /api/runs/{run}/suggestions")
    assert call["status_during_run"] == "running"
    queued = next(r for r in store.load_index() if r.run == 5)
    assert queued.kpis is None and queued.notebook == "Applied 2 change(s) from run 4: s3"
    assert (runs_dir / "5").is_dir()


def test_apply_all_uses_the_contract_sample(
    client: TestClient, runs_dir: Path, runner: FakeRunner, no_rules: None
) -> None:
    add_run(runs_dir, 4)
    response = client.post("/api/apply", json=sample("POST /api/apply", 1))
    assert response.json() == {"queuedRun": 5}
    assert len(runner.calls[0]["applied_changes"]) == 2


def test_apply_returns_the_cached_run_without_simulating(
    client: TestClient, runs_dir: Path, runner: FakeRunner, no_rules: None
) -> None:
    config = add_run(runs_dir, 4)
    suggestions = TypeAdapter(list[Suggestion]).validate_python(
        read(runs_dir / "4" / "suggestions.json")
    )
    configs = apply.apply_suggestions(config.stores, suggestions)
    (runs_dir / "7").mkdir()
    store.write_json(runs_dir / "7" / "summary.json", read(runs_dir / "0" / "summary.json"))
    cache.run_record(cache.run_key(configs, config.seed), 7, configs)

    response = client.post("/api/apply", json=apply_body())
    assert response.json() == {"queuedRun": 7}
    assert runner.calls == []
    assert not (runs_dir / "8").exists()
    assert [r.run for r in store.load_index()] == [4]


def test_apply_marks_the_run_failed_when_the_runner_raises(
    client: TestClient, runs_dir: Path, monkeypatch: pytest.MonkeyPatch, no_rules: None
) -> None:
    monkeypatch.setattr(
        "backend.sim.runner.execute_run", FakeRunner(error=RuntimeError("sim crashed"))
    )
    add_run(runs_dir, 4)
    assert client.post("/api/apply", json=apply_body()).json() == {"queuedRun": 5}
    failed = next(r for r in store.load_index() if r.run == 5)
    assert (failed.status, failed.notebook) == ("failed", "Run failed: RuntimeError")


def test_apply_marks_the_run_failed_when_the_runner_reuses_another_run(
    client: TestClient, runs_dir: Path, monkeypatch: pytest.MonkeyPatch, no_rules: None
) -> None:
    monkeypatch.setattr("backend.sim.runner.execute_run", FakeRunner(result=3))
    add_run(runs_dir, 4)
    client.post("/api/apply", json=apply_body())
    duplicate = next(r for r in store.load_index() if r.run == 5)
    assert (duplicate.status, duplicate.notebook) == ("failed", "Same config as run 3; not re-run")


def test_apply_goes_through_the_hard_rules(
    client: TestClient, runs_dir: Path, runner: FakeRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_run(runs_dir, 4)
    processed_map = write_processed_map(runs_dir)

    def decide(suggestions: list[Suggestion]) -> tuple[list[Suggestion], list[Any]]:
        lighting = [x for x in suggestions if x.field == "lighting"]
        return [x for x in suggestions if x not in lighting], [(x, "night") for x in lighting]

    rules = FakeRules(decide)
    install_rules(monkeypatch, rules)
    assert client.post("/api/apply", json=apply_body()).json() == {"queuedRun": 5}
    [check] = rules.checks
    assert check == {"map_data": processed_map, "check_tried": False, "n": 2}
    [(logged_run, logged, agent)] = rules.logged
    assert (logged_run, len(logged), agent) == (4, 1, "manual_apply")
    [call] = runner.calls
    assert call["applied_changes"] == sample("GET /api/runs/{run}/suggestions")[:1]
    assert call["stores"]["s3"].close == "03:00" and call["stores"]["s3"].lighting[1] == "off"


def test_apply_rejected_by_every_rule_is_409(
    client: TestClient, runs_dir: Path, runner: FakeRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_run(runs_dir, 4)
    write_processed_map(runs_dir)
    install_rules(monkeypatch, FakeRules(lambda suggestions: ([], ["outside licence"])))
    response = client.post("/api/apply", json=apply_body())
    assert response.status_code == 409
    assert response.json()["detail"]["rejections"] == ["outside licence"]
    assert runner.calls == [] and not (runs_dir / "5").exists()


@pytest.mark.parametrize("cause", ["no check_changes", "no processed map"])
def test_apply_refuses_when_the_rules_cannot_run(
    client: TestClient,
    runs_dir: Path,
    runner: FakeRunner,
    monkeypatch: pytest.MonkeyPatch,
    cause: str,
) -> None:
    add_run(runs_dir, 4)
    if cause == "no check_changes":
        write_processed_map(runs_dir)
        install_rules(monkeypatch, types.ModuleType(apply.RULES_MODULE))
    else:
        install_rules(monkeypatch, FakeRules())
    assert client.post("/api/apply", json=apply_body()).status_code == 503
    assert runner.calls == [] and not (runs_dir / "5").exists()


def test_apply_with_the_real_hard_rules(
    client: TestClient, runs_dir: Path, runner: FakeRunner
) -> None:
    """Integration with backend.agents.rules as written: the sample's s3 lighting change passes,
    its close 23:00 -> 03:00 (a 20 h day for a cafe) is rejected by the day-length cap, a close
    outside s1's licence (10:00-04:00) is rejected, and both rejections are logged."""
    pytest.importorskip(apply.RULES_MODULE)
    add_run(runs_dir, 4)
    write_processed_map(runs_dir)
    outside_licence = {
        "storeId": "s1",
        "field": "close",
        "from": "23:00",
        "to": "05:00",
        "expectedDelta": {"visits": 0.1, "kwh": 0.1},
    }
    store.write_json(
        runs_dir / "4" / "suggestions.json",
        [*sample("GET /api/runs/{run}/suggestions"), outside_licence],
    )
    response = client.post("/api/apply", json={"run": 4, "scope": "all"})
    assert response.json() == {"queuedRun": 5}
    [call] = runner.calls
    close_s3, light_s3 = sample("GET /api/runs/{run}/suggestions")
    assert call["applied_changes"] == [light_s3]
    assert call["stores"]["s1"].close == "23:00"
    log = [json.loads(line) for line in (runs_dir / "4" / "llm_log.jsonl").read_text().splitlines()]
    rejections = {e["suggestion"]["storeId"]: e for e in log if e.get("type") == "rule_rejection"}
    assert set(rejections) == {"s1", "s3"}
    assert all(e["agent"] == "manual_apply" for e in rejections.values())
    assert rejections["s1"]["suggestion"] == outside_licence
    assert "licensed hours" in rejections["s1"]["reason"]
    assert rejections["s3"]["suggestion"] == close_s3
    assert "longer than a cafe usually trades" in rejections["s3"]["reason"]

    response = client.post("/api/apply", json={"run": 4, "scope": "store", "storeIds": ["s1"]})
    assert response.status_code == 409
    [detail] = response.json()["detail"]["rejections"]
    assert detail["suggestion"] == outside_licence and "licensed hours" in detail["reason"]


@pytest.mark.parametrize(
    "error",
    [
        ModuleNotFoundError("No module named 'shapely'", name="shapely"),
        ImportError("cannot import name 'licence_window'"),
    ],
)
def test_apply_fails_closed_when_the_rules_module_is_broken(
    client: TestClient,
    runs_dir: Path,
    runner: FakeRunner,
    monkeypatch: pytest.MonkeyPatch,
    error: ImportError,
) -> None:
    real_import = importlib.import_module

    def import_module(name: str, package: str | None = None) -> types.ModuleType:
        if name == apply.RULES_MODULE:
            raise error
        return real_import(name, package)

    monkeypatch.setattr(importlib, "import_module", import_module)
    add_run(runs_dir, 4)
    response = client.post("/api/apply", json=apply_body())
    assert response.status_code == 503
    assert response.json()["detail"].startswith("hard rules unavailable, nothing applied")
    assert runner.calls == [] and not (runs_dir / "5").exists()


@pytest.mark.parametrize(
    ("body", "status", "detail"),
    [
        (apply_body(run=0), 409, "sample run cannot be applied; run the sim first"),
        (apply_body(run=9), 404, "run 9 not found"),
        ({"run": 4, "scope": "store"}, 422, "scope 'store' needs a non-empty storeIds list"),
        (apply_body(storeIds=[]), 422, "scope 'store' needs a non-empty storeIds list"),
        (apply_body(storeIds=["s3", "zz"]), 404, "run 4 has no store zz"),
        (apply_body(storeIds=["s1"]), 409, "run 4 has no suggestions for s1"),
        ({"run": 4, "scope": "some"}, 422, None),
    ],
)
def test_apply_validation(
    client: TestClient,
    runs_dir: Path,
    runner: FakeRunner,
    no_rules: None,
    body: dict[str, Any],
    status: int,
    detail: str | None,
) -> None:
    add_run(runs_dir, 4)
    response = client.post("/api/apply", json=body)
    assert response.status_code == status
    if detail is not None:
        assert response.json()["detail"] == detail
    assert runner.calls == []


def test_apply_on_a_run_that_has_not_finished_is_404(
    client: TestClient, runs_dir: Path, runner: FakeRunner, no_rules: None
) -> None:
    add_run(runs_dir, 4)
    (runs_dir / "4" / "suggestions.json").unlink()
    response = client.post("/api/apply", json=apply_body())
    assert response.status_code == 404
    assert response.json()["detail"] == "run 4 has no suggestions.json"


def test_apply_without_rules_refuses_an_invalid_suggestion(
    client: TestClient, runs_dir: Path, runner: FakeRunner, no_rules: None
) -> None:
    add_run(runs_dir, 4)
    bad = {**sample("GET /api/runs/{run}/suggestions")[1], "to": "medium"}
    store.write_json(runs_dir / "4" / "suggestions.json", [bad])
    response = client.post("/api/apply", json=apply_body())
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "run 4 has an invalid suggestion: "
        "not a lighting level: 'medium' (expected off, low or high)"
    )
    assert runner.calls == [] and not (runs_dir / "5").exists()


# --- apply helpers (pure) -------------------------------------------------------------------


def change(
    field: str, to: str, *, frm: str = "x", hours: list[int] | None = None, sid: str = "s3"
) -> Suggestion:
    data = {
        "storeId": sid,
        "field": field,
        "from": frm,
        "to": to,
        "expectedDelta": {"visits": 0.0, "kwh": 0.0},
    }
    return Suggestion.model_validate({**data, **({"hours": hours} if hours is not None else {})})


@pytest.fixture
def base() -> dict[str, StoreConfig]:
    return RunConfig.model_validate(read(SAMPLE_DIR / "config.json")).stores


def test_apply_suggestions_sets_window_and_lighting_without_touching_base(
    base: dict[str, StoreConfig],
) -> None:
    before = {k: v.model_dump() for k, v in base.items()}
    out = apply.apply_suggestions(
        base,
        [
            change("open", "6:30"),
            change("close", "03:00"),
            change("lighting", "high", hours=[0, 23]),
        ],
    )
    assert (out["s3"].open, out["s3"].close) == ("06:30", "03:00")
    assert out["s3"].lighting[0] == out["s3"].lighting[23] == "high"
    assert out["s3"].lighting[1:23] == base["s3"].lighting[1:23]
    assert {k: v.model_dump() for k, v in base.items()} == before
    assert out["s1"] == base["s1"] and out["s1"] is not base["s1"]


@pytest.mark.parametrize(
    "bad",
    [
        change("close", "25:00"),
        change("close", "7pm"),
        change("open", "12:75"),
        change("lighting", "medium", hours=[1]),
        change("lighting", "low", hours=[24]),
        change("lighting", "low"),
        change("close", "03:00", sid="zz"),
    ],
)
def test_apply_suggestions_rejects_malformed_values(
    base: dict[str, StoreConfig], bad: Suggestion
) -> None:
    with pytest.raises(ValueError):
        apply.apply_suggestions(base, [bad])


def test_select_suggestions() -> None:
    items = [change("close", "03:00"), change("close", "01:00", sid="s1")]
    assert apply.select_suggestions(items, None) == items
    assert apply.select_suggestions(items, ["s1"]) == items[1:]


# --- CORS -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("origin", "allowed"),
    [
        ("http://localhost:5173", True),
        ("http://127.0.0.1:4173", True),
        ("http://localhost", True),
        ("https://example.com", False),
        ("http://localhost.example.com", False),
    ],
)
def test_cors_allows_local_dev_servers_on_any_port(
    client: TestClient, origin: str, allowed: bool
) -> None:
    response = client.options(
        "/api/runs", headers={"Origin": origin, "Access-Control-Request-Method": "GET"}
    )
    assert (response.headers.get("access-control-allow-origin") == origin) is allowed


def test_calibration_is_404_until_the_pipeline_builds_it(client: TestClient) -> None:
    response = client.get("/api/calibration")
    assert response.status_code == 404
    assert "run the pipeline" in response.json()["detail"]


def test_calibration_serves_the_processed_file_with_placeholder_flags(client: TestClient) -> None:
    flat = [0.0] * 24
    calibration = CalibrationFile(
        fallback=True,
        notes=["PLACEHOLDER, NOT MEASURED"],
        venues=[
            CalibrationVenue(
                name="Typical cafe",
                storeId="s3",
                type="cafe",
                weekday=flat,
                weekend=flat,
                measured=False,
                source=None,
            )
        ],
    )
    store.write_json(settings.PROCESSED_DIR / "calibration.json", calibration)
    body = client.get("/api/calibration").json()
    assert CalibrationFile.model_validate(body) == calibration
    assert body["venues"][0]["measured"] is False
    assert body["fallback"] is True
