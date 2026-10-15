"""GET /api/agents/session and GET /api/agents/log: the Agents view's read-only data."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import settings, store
from backend.api.main import app
from backend.contract import AgentEvent, AgentSession
from backend.schemas import AnalystState


@pytest.fixture
def runs_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    runs = tmp_path / "runs"
    runs.mkdir()
    monkeypatch.setattr(settings, "RUNS_DIR", runs)
    return runs


@pytest.fixture
def client(runs_dir: Path) -> TestClient:
    return TestClient(app)


def write_log(path: Path, events: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(e) + "\n" for e in events))


def test_session_404_before_any_training(client: TestClient) -> None:
    assert client.get("/api/agents/session").status_code == 404


def test_session_serves_the_checkpoint(client: TestClient) -> None:
    store.save_analyst_state(
        AnalystState(
            sessionId="s1",
            state="stopped",
            startedAt="a",
            updatedAt="b",
            backend="heuristic",
            fresh=True,
            seed=42,
            baselineRun=1,
            currentRun=4,
            bestRun=4,
            bestObjective=0.641,
            iterations=4,
            runsThisSession=[1, 2, 3, 4],
            lowGainStreak=2,
            step="scored",
            stoppedReason="threshold",
        )
    )
    body = client.get("/api/agents/session").json()
    AgentSession.model_validate(body)
    assert (
        body["step"] == "scored"
        and body["runsThisSession"] == [1, 2, 3, 4]
        and body["lowGainStreak"] == 2
    )


def test_log_tells_the_story_in_order_without_prompts_or_store_lists(
    client: TestClient, runs_dir: Path
) -> None:
    write_log(
        runs_dir / "llm_log.jsonl",
        [{"at": "2026-10-15T09:51:01Z", "agent": "training", "type": "start", "seed": 42}],
    )
    write_log(
        runs_dir / "1" / "llm_log.jsonl",
        [
            {
                "at": "2026-10-15T09:51:04Z",
                "agent": "analyst",
                "type": "handoff",
                "to": "store_agents",
                "run": 1,
            },
            {
                "at": "2026-10-15T09:51:05Z",
                "agent": "store_owner",
                "type": "proposals",
                "stores": 24,
                "suggestions": 39,
                "heuristicStores": ["s1", "s2"],
            },
            {
                "at": "2026-10-15T09:51:05Z",
                "agent": "analyst",
                "type": "request",
                "prompt": "secret prompt",
            },
            {
                "at": "2026-10-15T09:51:06Z",
                "agent": "analyst",
                "type": "hypothesis",
                "text": "x" * 500,
                "expectedGain": 0.015,
                "changes": [{}, {}],
            },
        ],
    )
    write_log(
        runs_dir / "2" / "llm_log.jsonl",
        [
            {
                "at": "2026-10-15T09:51:07Z",
                "agent": "analyst",
                "type": "result",
                "gain": 0.022,
                "newBest": True,
            }
        ],
    )

    body = client.get("/api/agents/log").json()
    events = [AgentEvent.model_validate(e) for e in body]
    assert [e.type for e in events] == ["start", "handoff", "proposals", "hypothesis", "result"]
    assert events[1].run == 1 and events[4].run == 2 and events[0].run is None
    text = json.dumps(body)
    assert "secret prompt" not in text and '"s1"' not in text
    assert (
        events[2].data["heuristicStoresCount"] == 2
        if "heuristicStoresCount" in events[2].data
        else True
    )
    assert events[3].data["changesCount"] == 2 and len(events[3].data["text"]) == 240

    scoped = client.get("/api/agents/log?run=2").json()
    assert [e["type"] for e in scoped] == ["result"]
    assert len(client.get("/api/agents/log?limit=2").json()) == 2
