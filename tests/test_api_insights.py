"""GET /api/stores/{storeId}/insights against a real 14-day sim run on the fixture city."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import settings, store
from backend.api.main import app
from backend.contract import StoreInsights
from backend.sim import runner

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def city(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path, int]:
    root = tmp_path_factory.mktemp("insights")
    processed, runs = root / "processed", root / "runs"
    shutil.copytree(FIXTURES, processed)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(settings, "PROCESSED_DIR", processed)
        mp.setattr(settings, "RUNS_DIR", runs)
        run = runner.execute_run(runner.baseline_configs(), settings.DEFAULT_SEED)
    return processed, runs, run


@pytest.fixture
def client(city: tuple[Path, Path, int], monkeypatch: pytest.MonkeyPatch) -> TestClient:
    processed, runs, _ = city
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed)
    monkeypatch.setattr(settings, "RUNS_DIR", runs)
    return TestClient(app)


def non_club_stores() -> list[tuple[str, str]]:
    return [(s.id, s.name) for s in store.load_map().stores if s.type != "club"]


def test_insights_for_every_shop_validate_and_stay_store_scoped(
    client: TestClient, city: tuple[Path, Path, int]
) -> None:
    run = city[2]
    shops = non_club_stores()
    assert shops
    for store_id, _ in shops:
        response = client.get(f"/api/stores/{store_id}/insights?run={run}")
        assert response.status_code == 200, response.text
        body = response.json()
        StoreInsights.model_validate(body)
        assert body["storeId"] == store_id and body["run"] == run
        assert len(body["hourly"]["visits"]) == 24
        text = json.dumps(body)
        for other_id, other_name in shops:
            if other_id != store_id:
                assert f'"{other_id}"' not in text, f"{store_id} leaks {other_id}"
                assert other_name not in text, f"{store_id} leaks {other_name}"


def test_default_run_is_the_latest_finished_run(
    client: TestClient, city: tuple[Path, Path, int]
) -> None:
    store_id = non_club_stores()[0][0]
    assert client.get(f"/api/stores/{store_id}/insights").json()["run"] == city[2]


def test_clubs_unknown_stores_and_unknown_runs_are_404(
    client: TestClient, city: tuple[Path, Path, int]
) -> None:
    run = city[2]
    clubs = [s.id for s in store.load_map().stores if s.type == "club"]
    for path in (
        *(f"/api/stores/{c}/insights?run={run}" for c in clubs),
        f"/api/stores/nope/insights?run={run}",
        f"/api/stores/{non_club_stores()[0][0]}/insights?run=999",
    ):
        assert client.get(path).status_code == 404, path


def test_missing_processed_energy_is_503(
    client: TestClient,
    city: tuple[Path, Path, int],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    processed = tmp_path / "processed"
    shutil.copytree(city[0], processed)
    (processed / "energy.json").unlink()
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed)
    response = client.get(f"/api/stores/{non_club_stores()[0][0]}/insights?run={city[2]}")
    assert response.status_code == 503
    assert "run the pipeline" in response.json()["detail"]
