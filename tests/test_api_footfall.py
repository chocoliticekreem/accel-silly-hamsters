"""GET /api/runs/{run}/footfall and GET /api/health peoplePerAgent: the background crowd's data.

Each test runs on a temporary copy of the runs/0 sample (settings.RUNS_DIR / PROCESSED_DIR
monkeypatched), never on the real runs/ dir.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections.abc import Sequence
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import settings, store
from backend.api import footfall
from backend.api.main import app
from backend.contract import DAYS, DayAgent, DayData, RunFootfall, RunListItem, Visit
from backend.schemas import DemandFile, EntryDemand
from backend.sim import citizens

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_DIR = ROOT / "runs" / "0"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


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


def add_run(runs: Path, run: int) -> None:
    """A finished real run with the sample's day files, recorded in runs/index.json."""
    shutil.copytree(runs / "0" / "days", runs / str(run) / "days")
    item = RunListItem.model_validate(json.loads((runs / "0" / "run.json").read_text()))
    store.upsert_index(item.model_copy(update={"run": run, "status": "done"}))


def brute_force(day: DayData) -> list[float]:
    """Mean agents on the street per clock hour, by checking every agent at every minute."""
    start = (day.day - 1) * 1440
    hours = []
    for hour in range(24):
        total = 0
        for minute in range(start + hour * 60, start + (hour + 1) * 60):
            for agent in day.agents:
                t0, t1 = agent.path[0][0], agent.path[-1][0]
                inside = any(v.tIn <= minute < v.tOut for v in agent.visits)
                total += t0 <= minute <= t1 and not inside
        hours.append(round(total / 60, 2))
    return hours


def agent(id_: str, times: list[int], visits: Sequence[tuple[int, int]] = ()) -> DayAgent:
    return DayAgent(
        id=id_,
        persona="tourist",
        returning=False,
        path=[(t, 0.0, 0.0) for t in times],
        visits=[Visit(storeId="s1", tIn=a, tOut=b) for a, b in visits],
    )


# --- GET /api/runs/{run}/footfall -----------------------------------------------------------


def test_footfall_counts_agents_on_the_street_minute_by_minute(
    client: TestClient, runs_dir: Path
) -> None:
    response = client.get("/api/runs/0/footfall")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"run", "onStreetByDayHour"}
    result = RunFootfall.model_validate(body)
    assert result.run == 0 and len(result.onStreetByDayHour) == DAYS
    for d in range(1, DAYS + 1):
        day = DayData.model_validate_json((runs_dir / "0" / "days" / f"{d}.json").read_bytes())
        assert result.onStreetByDayHour[d - 1] == brute_force(day), f"day {d}"
    assert any(any(hours) for hours in result.onStreetByDayHour)
    store_ids = {s["id"] for s in json.loads((runs_dir / "0" / "map.json").read_text())["stores"]}
    assert not any(f'"{s}"' in response.text for s in store_ids)  # area totals only


def test_on_street_skips_store_visits_clips_to_the_day_and_counts_a_trip_once() -> None:
    day2 = 1440
    day = DayData(
        day=2,
        agents=[
            # 08:00-08:30 with 10 minutes inside a store: on the street for 21 minutes
            agent("v2-1", [day2 + 480, day2 + 510], [(day2 + 490, day2 + 500)]),
            # last night's trip, listed in today's file too: 00:00-00:20 of this day count
            agent("r1", [day2 - 10, day2 + 20]),
            agent("r1", [day2 - 10, day2 + 20]),
            # the same regular's trip today is another trip (another start)
            agent("r1", [day2 + 1430, day2 + 1460]),
        ],
    )
    hours = footfall.on_street_by_hour(day)
    assert hours[8] == round(21 / 60, 2)
    assert hours[0] == round(21 / 60, 2)
    assert hours[23] == round(10 / 60, 2)
    assert sum(hours) == pytest.approx(hours[0] + hours[8] + hours[23])


def test_footfall_is_cached_in_the_run_and_rebuilt_when_stale(
    client: TestClient, runs_dir: Path
) -> None:
    add_run(runs_dir, 4)
    fresh = client.get("/api/runs/4/footfall").json()
    cache = runs_dir / "4" / footfall.CACHE_FILE
    assert json.loads(cache.read_text()) == {"version": footfall.CACHE_VERSION, "footfall": fresh}

    def write_cache(body: object, version: int = footfall.CACHE_VERSION) -> None:
        cache.write_text(json.dumps({"version": version, "footfall": body}))

    marked = {**fresh, "onStreetByDayHour": [[7.0] * 24] * DAYS}
    write_cache(marked)
    assert client.get("/api/runs/4/footfall").json() == marked  # served from the cache

    write_cache(marked, version=footfall.CACHE_VERSION - 1)
    assert client.get("/api/runs/4/footfall").json() == fresh  # counted by older rules: rebuilt

    write_cache(marked)
    later = cache.stat().st_mtime + 10
    os.utime(runs_dir / "4" / "days" / "3.json", (later, later))
    assert client.get("/api/runs/4/footfall").json() == fresh  # a newer day file: rebuilt

    cache.write_text("{not json")
    os.utime(cache, (later + 10, later + 10))
    assert client.get("/api/runs/4/footfall").json() == fresh  # unreadable cache: rebuilt


def test_footfall_is_served_when_the_cache_cannot_be_written(
    client: TestClient, runs_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_run(runs_dir, 4)

    def read_only(path: Path, obj: object) -> None:
        raise PermissionError(f"read-only: {path}")

    monkeypatch.setattr(store, "write_json", read_only)
    response = client.get("/api/runs/4/footfall")
    assert response.status_code == 200
    RunFootfall.model_validate(response.json())
    assert not (runs_dir / "4" / footfall.CACHE_FILE).exists()


def test_footfall_of_the_sample_run_is_never_written_into_runs_0(
    client: TestClient, runs_dir: Path
) -> None:
    assert client.get("/api/runs/0/footfall").status_code == 200
    assert not (runs_dir / "0" / footfall.CACHE_FILE).exists()


def test_footfall_404_names_a_missing_day_file(client: TestClient, runs_dir: Path) -> None:
    add_run(runs_dir, 5)
    (runs_dir / "5" / "days" / "7.json").unlink()
    response = client.get("/api/runs/5/footfall")
    assert response.status_code == 404
    assert response.json()["detail"] == "run 5 has no days/7.json"


# --- GET /api/health peoplePerAgent ---------------------------------------------------------


def write_processed(demand: DemandFile | Path, map_path: Path) -> None:
    settings.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy(map_path, settings.PROCESSED_DIR / "map.json")
    if isinstance(demand, Path):
        shutil.copy(demand, settings.PROCESSED_DIR / "demand.json")
    else:
        store.write_json(settings.PROCESSED_DIR / "demand.json", demand)


def test_health_publishes_the_pipeline_scale(client: TestClient, runs_dir: Path) -> None:
    assert "peoplePerAgent" not in client.get("/api/health").json()  # no demand.json yet
    processed = ROOT / "data" / "processed"
    write_processed(processed / "demand.json", processed / "map.json")
    demand = store.load_demand()
    stated = re.search(r"Scale: 1 sim agent ~ (\d+) real arrivals", " ".join(demand.notes))
    assert stated, "demand.py no longer states its scale in demand.json's notes"
    # the committed demand keeps its daily arrivals inside citizens.GENERAL_ARRIVALS_PER_DAY,
    # so the sim samples them as they are and the published scale is the stated one
    assert citizens.arrival_scale(demand, store.load_map().entryPoints) == 1.0
    assert client.get("/api/health").json()["peoplePerAgent"] == float(stated.group(1))


def test_people_per_agent_divides_by_the_sims_arrival_rescaling(runs_dir: Path) -> None:
    demand = DemandFile.model_validate_json((FIXTURES / "demand.json").read_bytes())
    write_processed(demand, FIXTURES / "map.json")
    assert footfall.people_per_agent() is None  # the hand-made fixture states no scale

    # a hundred times the fixture's arrivals: far more than the sim's daily band keeps
    busy = demand.model_copy(
        update={
            "entryPoints": {
                k: EntryDemand(
                    weekday=[v * 100 for v in e.weekday], weekend=[v * 100 for v in e.weekend]
                )
                for k, e in demand.entryPoints.items()
            },
            "notes": [
                *demand.notes,
                "Units: sim agents. Scale: 1 sim agent ~ 1,200 real arrivals.",
            ],
        }
    )
    write_processed(busy, FIXTURES / "map.json")
    sampled = citizens.arrival_scale(busy, store.load_map().entryPoints)
    assert sampled < 1  # the sim samples only part of them, so each of its agents stands for more
    assert footfall.people_per_agent() == round(1200 / sampled, 1)


def test_health_survives_a_corrupt_demand_file(client: TestClient, runs_dir: Path) -> None:
    write_processed(FIXTURES / "demand.json", FIXTURES / "map.json")
    (settings.PROCESSED_DIR / "demand.json").write_text("{broken")
    response = client.get("/api/health")
    assert response.status_code == 200
    assert "peoplePerAgent" not in response.json()
