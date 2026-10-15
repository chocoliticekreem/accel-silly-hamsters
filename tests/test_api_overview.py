"""GET /api/stores/{storeId}/overview and POST /api/stores/{storeId}/optimize (docs/STORE_PAGE.md).

Two worlds: hand-written run files (exact numbers for the honesty, advice and status rules) and
the fixture city with a real offline one-shop session started through the API (shape, firewall,
and only the scoped shop's settings changing). No test calls an LLM (settings.OFFLINE).
"""

from __future__ import annotations

import json
import re
import shutil
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import economics, settings, store
from backend.agents import rundata, training
from backend.api.main import app
from backend.contract import AnalystStatus, MapData, RunListItem, StoreOverview, Suggestion
from backend.schemas import AnalystState, RunConfig, StoreConfig

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SPEC = Path(__file__).resolve().parent.parent / "docs" / "STORE_PAGE.md"
SEED = 42
LOW: list[str] = ["low"] * 24


def spec_sample() -> dict:
    """The sample JSON in docs/STORE_PAGE.md."""
    text = SPEC.read_text()
    return json.loads(re.search(r"```json\n(.*?)\n```", text, re.S).group(1))


def keys(value: dict) -> set[str]:
    return set(value)


# --- hand-written runs ---------------------------------------------------------------------


def lighting(hours: range, level: str) -> list[str]:
    return [level if h in hours else "low" for h in range(24)]


def store_result(config: StoreConfig, visits: int, kwh: float) -> dict:
    return {
        "open": config.open,
        "close": config.close,
        "lighting": list(config.lighting),
        "kpis": {"visits": visits, "kwh": kwh, "returnRate": 0.3},
        "visitsByHour": [visits / 14 / 24] * 24,
    }


BASE = {
    "s1": StoreConfig(open="11:00", close="23:00", lighting=LOW),
    "s2": StoreConfig(open="11:00", close="23:00", lighting=LOW),
    "s3": StoreConfig(open="16:00", close="23:00", lighting=LOW),
}
BASE_KPIS = {"s1": (200, 300.0), "s2": (150, 200.0), "s3": (300, 150.0)}


def write_run(
    run: int,
    *,
    parent: int | None,
    configs: dict[str, StoreConfig],
    kpis: dict[str, tuple[int, float]],
    applied: list[dict] | None = None,
    suggestions: list[dict] | None = None,
    owner_events: list[dict] | None = None,
    status: str = "done",
) -> None:
    folder = store.run_dir(run)
    folder.mkdir(parents=True, exist_ok=True)
    store.write_json(
        folder / "config.json",
        RunConfig(
            run=run,
            seed=SEED,
            simVersion=settings.SIM_VERSION,
            stores=configs,
            parentRun=parent,
            appliedChanges=applied or [],
            configHash=f"h{run}",
        ),
    )
    store.write_json(
        folder / "stores.json",
        {sid: store_result(configs[sid], *kpis[sid]) for sid in configs},
    )
    store.write_json(folder / "suggestions.json", suggestions or [])
    if owner_events is not None:
        store.write_json(folder / "owner_events.json", owner_events)
    store.upsert_index(
        RunListItem(run=run, seed=SEED, status=status, kpis=None, notebook="", createdAt="t")  # type: ignore[arg-type]
    )


def suggestion(sid: str, field: str, frm: str, to: str, visits: float, kwh: float, **extra):
    return {
        "storeId": sid,
        "field": field,
        "from": frm,
        "to": to,
        "expectedDelta": {"visits": visits, "kwh": kwh},
        **extra,
    }


def save_state(state: str = "stopped", best: int | None = 3, updated: str | None = None) -> None:
    store.write_json(
        store.analyst_state_path(),
        AnalystState(
            sessionId="sess",
            state=state,  # type: ignore[arg-type]
            startedAt="2026-10-15T00:00:00Z",
            updatedAt=updated or store.now_iso(),
            backend="heuristic",
            fresh=False,
            seed=SEED,
            baselineRun=1,
            bestRun=best,
            stoppedReason="threshold" if state == "stopped" else None,
        ),
    )


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    processed, runs = tmp_path / "processed", tmp_path / "runs"
    shutil.copytree(FIXTURES, processed)
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed)
    monkeypatch.setattr(settings, "RUNS_DIR", runs)
    monkeypatch.setattr(settings, "OFFLINE", True)
    monkeypatch.setattr(settings, "READ_ONLY", False)
    runs.mkdir()
    return runs


@pytest.fixture
def client(world: Path) -> TestClient:
    return TestClient(app)


S1_CLOSE = {"storeId": "s1", "field": "close", "from": "23:00", "to": "03:00"}
S1_LIGHTS = {"storeId": "s1", "field": "lighting", "hours": list(range(18, 24))}
S1_LIGHTS |= {"from": "low", "to": "high"}


@pytest.fixture
def history(world: Path) -> None:
    """Run 1 baseline; run 2 opens s1 till 03:00 (profitable for s1 after the wages for the 4
    extra hours); run 3 (the area's best) lights s1 18-24 high and shortens s3 (both cost those
    shops money); run 4 changes s2 only."""
    write_run(1, parent=None, configs=BASE, kpis=BASE_KPIS)
    run2 = {**BASE, "s1": StoreConfig(open="11:00", close="03:00", lighting=LOW)}
    write_run(
        2,
        parent=1,
        configs=run2,
        kpis={**BASE_KPIS, "s1": (500, 340.0)},
        applied=[{**S1_CLOSE, "expectedDelta": {"visits": 0.5, "kwh": 0.1}}],
        suggestions=[
            suggestion("s1", "open", "11:00", "10:00", 0.2, 0.05),
            suggestion("s1", "close", "23:00", "03:00", 0.5, 0.1, reason="Fixture Club crowds"),
            suggestion("s1", "lighting", "low", "high", 0.2, 0.3, hours=list(range(18, 24))),
            suggestion("s1", "open", "11:00", "10:30", 0.01, 0.02, confidence="high"),
            suggestion("s2", "close", "23:00", "01:00", 0.9, 0.1),
        ],
        owner_events=[
            {"day": 2, "t": 1440, "storeId": sid, "action": "hours_changed"}
            for sid in "s1 s1 s2".split()
        ],
    )
    run3 = {
        **run2,
        "s1": StoreConfig(open="11:00", close="03:00", lighting=lighting(range(18, 24), "high")),
        "s3": StoreConfig(open="18:00", close="23:00", lighting=LOW),
    }
    write_run(
        3,
        parent=2,
        configs=run3,
        kpis={**BASE_KPIS, "s1": (505, 1300.0), "s3": (200, 140.0)},
        applied=[{**S1_LIGHTS, "expectedDelta": {"visits": 0.2, "kwh": 0.3}}],
    )
    run4 = {**BASE, "s2": StoreConfig(open="10:00", close="23:00", lighting=LOW)}
    write_run(4, parent=1, configs=run4, kpis={**BASE_KPIS, "s2": (160, 205.0)})
    save_state("stopped", best=3)


def price() -> float:
    return economics.area_price_gbp_per_kwh()


def profit(
    kind: str, base: tuple[int, float], now: tuple[int, float], hours_added_a_day: float
) -> float:
    d_hours = hours_added_a_day * 14
    return economics.gbp_per_week(kind, now[0] - base[0], now[1] - base[1], d_hours, price())  # type: ignore[arg-type]


def test_shape_matches_the_spec_sample(client: TestClient, history: None) -> None:
    body = client.get("/api/stores/s1/overview").json()
    StoreOverview.model_validate(body)
    sample = spec_sample()
    assert keys(body) - {"ownerChanges"} == keys(sample)
    assert keys(body["numbers"]) == keys(sample["numbers"])
    for name in ("customersPerWeek", "energyCostPerWeekGbp", "kwhPerWeek"):
        assert keys(body["numbers"][name]) == keys(sample["numbers"][name])
    assert body["advice"] and keys(body["advice"][0]) == keys(sample["advice"][0])
    for item in body["history"]:
        assert keys(item) == keys(sample["history"][0])
    assert body["note"] == "Simulated, not guaranteed."
    assert body["ownerChanges"] == 2  # this shop's adaptations in the run, not s2's


def test_default_run_is_this_shops_best_not_the_area_best(
    client: TestClient, history: None
) -> None:
    body = client.get("/api/stores/s1/overview").json()
    assert body["run"] == 2 and body["bestRun"] == 2 and body["baselineRun"] == 1
    assert body["status"] == "best_found"
    assert [h["run"] for h in body["history"]] == [1, 2, 3]  # run 4 did not touch s1
    assert [h["best"] for h in body["history"]] == [False, True, False]
    assert body["history"][0]["label"] == "Your current settings"
    assert body["history"][1]["label"] == "Open till 03:00"
    assert body["history"][1]["changes"] == ["Close 23:00 → 03:00"]
    assert body["history"][2]["label"] == "Lights 18–00 high"
    assert body["history"][2]["changes"] == ["Lights 18–00 low → high"]
    expected = round(profit("takeaway", BASE_KPIS["s1"], (500, 340.0), 4))  # 23:00 -> 03:00
    assert body["history"][1]["profitChangePerWeekGbp"] == expected
    assert body["numbers"]["profitChangePerWeekGbp"] == expected
    assert body["numbers"]["customersPerWeek"] == {"value": 250, "change": 1.5}
    assert body["numbers"]["kwhPerWeek"]["value"] == 170.0


def test_area_best_run_that_costs_the_shop_money_says_going_back_is_better(
    client: TestClient, history: None
) -> None:
    body = client.get("/api/stores/s1/overview?run=3").json()
    loss = profit("takeaway", BASE_KPIS["s1"], (505, 1300.0), 4)
    best = profit("takeaway", BASE_KPIS["s1"], (500, 340.0), 4)
    assert loss < 0 < best
    assert body["run"] == 3 and body["bestRun"] == 2
    assert body["numbers"]["profitChangePerWeekGbp"] == round(loss)
    assert body["headline"] == (
        "Your settings from an earlier test did better: going back to them is about "
        f"£{round(best - loss)} a week better for you."
    )
    # s3's only change (in the area-best run) lost more margin than the wages it saved: its best
    # is its original settings.
    s3 = client.get("/api/stores/s3/overview?run=3").json()
    assert [(h["run"], h["best"]) for h in s3["history"]] == [(1, True), (3, False)]
    assert s3["bestRun"] == 1
    assert s3["headline"].startswith("Your original settings did better: going back is about £")
    assert client.get("/api/stores/s3/overview").json()["run"] == 1


def test_advice_is_this_shops_top_three_by_gbp_with_status_and_certainty(
    client: TestClient, history: None
) -> None:
    advice = client.get("/api/stores/s1/overview?run=2").json()["advice"]
    assert len(advice) == 3
    assert [a["gbpPerWeek"] for a in advice] == sorted(
        (a["gbpPerWeek"] for a in advice), reverse=True
    )
    assert all(a["suggestion"]["storeId"] == "s1" for a in advice)
    by_field = {(a["suggestion"]["field"], a["suggestion"]["to"]): a for a in advice}
    close = by_field[("close", "03:00")]
    assert close["status"] == "applied"  # run 2 already has it
    assert close["text"] == (
        f"Stay open until 03:00: about 125 more customers a week, "
        f"£{round(close['gbpPerWeek'])} a week after staff and power."
    )
    assert close["certainty"] == "worth testing"  # no confidence -> medium
    assert "reason" not in close["suggestion"]  # named another shop: dropped (firewall)
    assert by_field[("lighting", "high")]["status"] == "tested_worse"  # run 3 lost money
    assert by_field[("open", "10:00")]["status"] == "new"
    d_visits, d_kwh = 500 * 0.5, 340 * 0.1
    assert close["gbpPerWeek"] == round(  # run 2 already closes at 03:00: no hours added
        economics.gbp_per_week("takeaway", d_visits, d_kwh, 0.0, price())
    )
    assert advice[0]["text"] == client.get("/api/stores/s1/overview?run=2").json()["headline"]


def test_opening_earlier_advice_pays_the_wages_for_the_hours_it_adds(
    client: TestClient, history: None
) -> None:
    advice = client.get("/api/stores/s1/overview?run=2").json()["advice"]
    by_field = {(a["suggestion"]["field"], a["suggestion"]["to"]): a for a in advice}
    result = rundata.load_stores(2)["s1"]
    assert result.kpis.openHours == 16 * 14  # 11:00-03:00 every day
    opening = by_field[("open", "10:00")]
    change = Suggestion.model_validate(opening["suggestion"])
    assert economics.suggestion_open_hours_delta(result, change) == pytest.approx(14)  # +1h a day
    lights = Suggestion.model_validate(by_field[("lighting", "high")]["suggestion"])
    assert economics.suggestion_open_hours_delta(result, lights) == 0.0
    # takeaway: 100 more visits x £9 x 60% and 17 kWh more over 2 weeks, minus 14 hours x 2 on
    # shift x £12.71
    takings = 500 * 0.2 / 2 * 9 * 0.60 - 340 * 0.05 / 2 * price()
    wages = 14 / 2 * 2 * 12.71
    assert opening["gbpPerWeek"] == round(takings - wages)
    assert 0 < opening["gbpPerWeek"] < takings - 1


def test_firewall_no_other_shop_in_the_payload(client: TestClient, history: None) -> None:
    map_data = store.load_map()
    for sid in ("s1", "s2", "s3"):
        for run in ("", "?run=3"):
            text = json.dumps(client.get(f"/api/stores/{sid}/overview{run}").json())
            for other in map_data.stores:
                if other.id != sid:
                    assert f'"{other.id}"' not in text, f"{sid} leaks {other.id}"
                    assert other.name not in text, f"{sid} leaks {other.name}"


def test_status_not_started_and_improving(client: TestClient, world: Path) -> None:
    write_run(1, parent=None, configs=BASE, kpis=BASE_KPIS)
    body = client.get("/api/stores/s1/overview").json()
    assert body["status"] == "not_started" and body["bestRun"] is None and body["run"] == 1
    assert [h["best"] for h in body["history"]] == [False]
    assert body["headline"].startswith("No changes tested for your shop yet")
    assert "ownerChanges" not in body  # run without owner_events.json
    run2 = {**BASE, "s1": StoreConfig(open="11:00", close="01:00", lighting=LOW)}
    write_run(2, parent=1, configs=run2, kpis={**BASE_KPIS, "s1": (400, 320.0)})
    save_state("running", best=2)
    body = client.get("/api/stores/s1/overview").json()
    assert body["status"] == "improving" and body["run"] == 2
    assert body["headline"].startswith("Keep these settings: about 200 customers a week")


def test_404s(client: TestClient, world: Path) -> None:
    assert client.get("/api/stores/s1/overview").status_code == 404  # no runs yet
    write_run(1, parent=None, configs=BASE, kpis=BASE_KPIS)
    write_run(2, parent=1, configs=BASE, kpis=BASE_KPIS, status="running")
    assert client.get("/api/stores/c1/overview").status_code == 404  # club
    assert client.get("/api/stores/nope/overview").status_code == 404
    assert client.get("/api/stores/s1/overview?run=99").status_code == 404
    assert client.get("/api/stores/s1/overview?run=2").status_code == 404  # not finished
    assert client.get("/api/stores/s1/overview").status_code == 200


def test_a_run_where_the_shop_closed_for_good_is_never_its_best(
    client: TestClient, history: None
) -> None:
    path = store.run_dir(2) / "stores.json"
    results = json.loads(path.read_text())
    results["s1"]["closedFromDay"] = 8
    path.write_text(json.dumps(results))
    body = client.get("/api/stores/s1/overview").json()
    assert body["bestRun"] != 2
    assert not any(h["best"] for h in body["history"] if h["run"] == 2)


def test_owner_sees_real_customers_not_sim_agents(
    client: TestClient, history: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(economics, "people_per_agent", lambda: 19.0)
    body = client.get("/api/stores/s1/overview?run=2").json()
    assert body["numbers"]["customersPerWeek"] == {"value": 250 * 19, "change": 1.5}
    assert body["numbers"]["kwhPerWeek"]["value"] == 170.0  # energy is real already


# --- POST /api/stores/{storeId}/optimize -----------------------------------------------------


@pytest.fixture
def fake_train(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    calls: list[dict] = []

    def train(**kwargs):
        calls.append(kwargs)
        state = store.load_analyst_state()
        assert state is not None and state.state == "running"
        assert state.scopeStore == kwargs["scope_store"]
        return state

    monkeypatch.setattr(training, "train", train)
    return calls


def test_optimize_starts_a_scoped_session(client: TestClient, fake_train: list[dict]) -> None:
    response = client.post("/api/stores/s1/optimize", json={"maxRuns": 4})
    assert response.status_code == 202, response.text
    body = response.json()
    AnalystStatus.model_validate(body)
    assert body["state"] == "running" and body["iterations"] == 0
    assert fake_train == [{"max_runs": 4, "scope_store": "s1"}]
    assert store.load_analyst_state().scopeStore == "s1"
    session = client.get("/api/agents/session").json()  # the area view stays anonymous
    assert "scopeStore" not in session and "config" not in session
    # still "running" (the fake never stops it): a second start is refused
    assert client.post("/api/stores/s2/optimize").status_code == 409
    assert len(fake_train) == 1


def test_optimize_defaults_and_validation(client: TestClient, fake_train: list[dict]) -> None:
    assert client.post("/api/stores/s1/optimize").status_code == 202
    assert fake_train[-1] == {"max_runs": 6, "scope_store": "s1"}
    save_state("stopped")
    assert client.post("/api/stores/s1/optimize", json={"maxRuns": 11}).status_code == 422
    assert client.post("/api/stores/s1/optimize", json={"maxRuns": 1}).status_code == 422
    assert client.post("/api/stores/c1/optimize").status_code == 404
    assert client.post("/api/stores/nope/optimize").status_code == 404
    assert len(fake_train) == 1


def test_optimize_409_while_running_and_403_read_only(
    client: TestClient, fake_train: list[dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    save_state("running")
    assert client.post("/api/stores/s1/optimize").status_code == 409
    stale = (datetime.now(UTC) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_state("running", updated=stale)  # a session that died with the server
    assert client.post("/api/stores/s1/optimize").status_code == 202
    monkeypatch.setattr(settings, "READ_ONLY", True)
    save_state("stopped")
    assert client.post("/api/stores/s1/optimize").status_code == 403
    assert len(fake_train) == 1


# --- the fixture city: a real offline one-shop session through the API -------------------------


@pytest.fixture(scope="module")
def city(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Path, Path]]:
    root = tmp_path_factory.mktemp("overview")
    processed, runs = root / "processed", root / "runs"
    shutil.copytree(FIXTURES, processed)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(settings, "PROCESSED_DIR", processed)
        mp.setattr(settings, "RUNS_DIR", runs)
        mp.setattr(settings, "OFFLINE", True)
        mp.setattr(settings, "READ_ONLY", False)
        mp.setattr(settings, "OWNER_ADAPTATION", False)
        # TestClient runs the background session before post() returns.
        response = TestClient(app).post("/api/stores/s1/optimize", json={"maxRuns": 3})
        assert response.status_code == 202, response.text
    yield processed, runs


@pytest.fixture
def city_client(city: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch) -> TestClient:
    processed, runs = city
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed)
    monkeypatch.setattr(settings, "RUNS_DIR", runs)
    return TestClient(app)


def test_real_scoped_session_changes_only_that_shop(city_client: TestClient) -> None:
    state = store.load_analyst_state()
    assert state is not None and state.state == "stopped" and state.error is None
    assert state.scopeStore == "s1" and state.backend == "heuristic"
    assert state.stoppedReason in ("max_runs", "threshold")
    baseline = rundata.load_config(state.baselineRun)
    assert len(state.runsThisSession) >= 2  # at least one experiment
    for run in state.runsThisSession[1:]:
        config = rundata.load_config(run)
        changed = {sid for sid, c in config.stores.items() if c != baseline.stores[sid]}
        assert changed <= {"s1"}, f"run {run} changed {changed}"
        assert all(c["storeId"] == "s1" for c in config.appliedChanges)
    reports = settings.RUNS_DIR / str(state.bestRun) / "reports"
    if state.bestRun != state.baselineRun:
        assert [p.name for p in reports.glob("*.json") if not p.name.endswith(".meta.json")] == [
            "s1.json"
        ]


def test_real_overview_validates_and_stays_store_scoped(city_client: TestClient) -> None:
    map_data = MapData.model_validate(store.read_json(settings.PROCESSED_DIR / "map.json"))
    shops = [s for s in map_data.stores if s.type != "club"]
    for shop in shops:
        response = city_client.get(f"/api/stores/{shop.id}/overview")
        assert response.status_code == 200, response.text
        body = response.json()
        StoreOverview.model_validate(body)
        assert body["storeId"] == shop.id and len(body["advice"]) <= 3
        text = json.dumps(body)
        for other in map_data.stores:
            if other.id != shop.id:
                assert f'"{other.id}"' not in text, f"{shop.id} leaks {other.id}"
                assert other.name not in text, f"{shop.id} leaks {other.name}"
    s1 = city_client.get("/api/stores/s1/overview").json()
    profits = [h["profitChangePerWeekGbp"] for h in s1["history"]]
    if len(s1["history"]) > 1:
        best = next(h for h in s1["history"] if h["best"])
        assert best["profitChangePerWeekGbp"] == max(profits)
        assert s1["run"] == s1["bestRun"] == best["run"] and s1["status"] == "best_found"
    # every other shop kept its baseline settings: only the baseline in their history
    s2 = city_client.get("/api/stores/s2/overview").json()
    assert [h["run"] for h in s2["history"]] == [s2["baselineRun"]]
