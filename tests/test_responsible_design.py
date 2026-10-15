"""Responsible design: the misuse blocks in docs/RESPONSIBLE_DESIGN.md that no other test proved.

Each test drives the real code path (API, store agents, analyst, LLM plumbing) on temporary
dirs (settings.RUNS_DIR / PROCESSED_DIR monkeypatched), never on the real runs/ or data/.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import zlib
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, get_args

import pytest
from fastapi.testclient import TestClient
from test_agents_analyst import context  # pytest puts tests/ on sys.path
from test_agents_fakesim import STORES, setup_world

from backend import llm, settings, store
from backend.agents import analyst, prompts, report, rundata, store_owner
from backend.agents.rules import check_changes
from backend.api.main import app
from backend.contract import DayData, Source, StoreReport, Suggestion, dump
from backend.schemas import CalibrationFile, CalibrationVenue, RunSummary, StoreConfig
from backend.sim import runner

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SYNTHETIC_ID = re.compile(r"r\d+|v\d+-\d+")  # returning regulars / one-off visitors
RUN_ITEM_KEYS = {"run", "seed", "status", "kpis", "notebook", "createdAt", "costPerStoreWeekGbp"}
WRITE_ROUTES = {
    ("POST", "/api/decision"),
    ("POST", "/api/apply"),
    ("PUT", "/api/training/config"),
    ("POST", "/api/training/start"),
    ("POST", "/api/training/stop"),
    ("POST", "/api/stores/{store_id}/optimize"),
}
SHOPS = [sid for sid, (_, kind, _, _) in STORES.items() if kind != "club"]


def walk(value: Any) -> tuple[set[str], list[str], set[float]]:
    """Every dict key, string and float anywhere in a JSON value."""
    keys: set[str] = set()
    strings: list[str] = []
    floats: set[float] = set()
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            keys.update(item)
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, str):
            strings.append(item)
        elif isinstance(item, float):
            floats.add(item)
    return keys, strings, floats


def names_a_store(text: str, store_id: str, name: str) -> bool:
    return name in text or re.search(rf"\b{re.escape(store_id)}\b", text) is not None


def pdf_text(pdf: bytes) -> str:
    """The text fpdf2 drew on the page, its lines joined by spaces (core fonts: latin-1)."""
    lines: list[str] = []
    for stream in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", pdf, re.S):
        content = zlib.decompress(stream).decode("latin-1")
        for line in re.findall(r"\((.*?)(?<!\\)\) Tj", content):
            lines.append(re.sub(r"\\(.)", r"\1", line))
    return " ".join(lines)


def text_response(text: str) -> SimpleNamespace:
    """A Messages API reply carrying `text`, with 1,000 input and 200 output tokens."""
    usage = SimpleNamespace(
        input_tokens=1000,
        output_tokens=200,
        cache_read_input_tokens=0,
        cache_creation_input_tokens=0,
    )
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)], stop_reason="end_turn", usage=usage
    )


def served_routes() -> set[tuple[str, str]]:
    """(METHOD, path template) for every endpoint the API serves."""
    return {
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }


def snapshot(root: Path) -> dict[str, str]:
    """sha256 of every file under root, by relative path."""
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


# --- the fixture city, simulated for real (area views, synthetic citizens) --------------------


@pytest.fixture(scope="module")
def city(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path, int]:
    root = tmp_path_factory.mktemp("responsible")
    processed, runs = root / "processed", root / "runs"
    shutil.copytree(FIXTURES, processed)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(settings, "PROCESSED_DIR", processed)
        mp.setattr(settings, "RUNS_DIR", runs)
        mp.setattr(settings, "OWNER_ADAPTATION", False)
        run = runner.execute_run(runner.baseline_configs(), settings.DEFAULT_SEED)
    return processed, runs, run


@pytest.fixture
def city_client(city: tuple[Path, Path, int], monkeypatch: pytest.MonkeyPatch) -> TestClient:
    processed, runs, _ = city
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed)
    monkeypatch.setattr(settings, "RUNS_DIR", runs)
    return TestClient(app)


def test_area_endpoints_carry_area_totals_only(
    city_client: TestClient, city: tuple[Path, Path, int]
) -> None:
    """Council and landlord: the area view names no shop and carries no shop's own numbers."""
    run = city[2]
    stores = store.load_map().stores
    results = rundata.load_stores(run)
    stats = rundata.load_stats(run)
    shop_numbers = {
        value
        for sid in results
        for value in (results[sid].kpis.kwh, stats[sid].energyCostGbp, stats[sid].co2Kg)
        if not float(value).is_integer()
    }
    assert shop_numbers

    summary = city_client.get(f"/api/runs/{run}/summary")
    assert summary.status_code == 200
    body = summary.json()
    RunSummary.model_validate(body)
    keys, strings, floats = walk(body)
    assert not keys & {s.id for s in stores}
    for text in strings:
        assert not any(names_a_store(text, s.id, s.name) for s in stores), text
    assert not floats & shop_numbers

    # The runs list carries area KPIs only. Its free-text notebook line is left out here: a
    # training session's line names the store it changed (docs/RESPONSIBLE_DESIGN.md, gaps).
    [item] = city_client.get("/api/runs").json()
    assert set(item) <= RUN_ITEM_KEYS
    assert item["kpis"] == body["kpis"]
    assert not walk(item["kpis"])[2] & shop_numbers


def test_sim_citizens_are_synthetic_with_no_personal_fields(
    city_client: TestClient, city: tuple[Path, Path, int]
) -> None:
    """Tracking real individuals: every simulated person is an archetype id and a path."""
    run = city[2]
    archetypes = {p.id for p in store.load_personas().personas}
    seen = 0
    for day in range(1, 15):
        response = city_client.get(f"/api/runs/{run}/days/{day}")
        assert response.status_code == 200
        data = response.json()
        DayData.model_validate(data)
        for agent in data["agents"]:
            assert set(agent) == {"id", "persona", "returning", "path", "visits"}
            assert SYNTHETIC_ID.fullmatch(agent["id"]), agent["id"]
            assert agent["persona"] in archetypes
            assert all(len(point) == 3 for point in agent["path"])  # [t, x, z] only
            assert all(set(visit) == {"storeId", "tIn", "tOut"} for visit in agent["visits"])
            seen += 1
    assert seen > 100


# --- a small world on the fake sim: reports, owner decisions, every read endpoint --------------


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[SimpleNamespace]:
    """Baseline run, a best run changing s2 and s4, every shop's report, and a measured
    calibration venue per shop whose source names that shop (as BestTime's labels do)."""
    sim = setup_world(tmp_path, monkeypatch)
    venues = [
        CalibrationVenue(
            name=name,
            storeId=sid,
            type=kind,
            weekday=[50.0] * 24,
            weekend=[60.0] * 24,
            measured=True,
            source=Source(
                label=f"BestTime foot-traffic forecast: {name}", url="https://besttime.app"
            ),
        )
        for sid, (name, kind, _, _) in STORES.items()
        if kind != "club"
    ]
    store.write_json(settings.PROCESSED_DIR / "calibration.json", CalibrationFile(venues=venues))
    baseline = sim.execute_run(sim.baseline_configs(), 42)
    proposals = [p for p in store_owner.propose_all(baseline) if p.storeId in ("s2", "s4")]
    base_configs = rundata.load_config(baseline).stores
    configs = check_changes(base_configs, proposals, store.load_map()).configs
    best = sim.execute_run(
        configs, 42, parent_run=baseline, applied_changes=[dump(p) for p in proposals]
    )
    report.write_reports(best, baseline)
    yield SimpleNamespace(baseline=baseline, best=best, client=TestClient(app), root=tmp_path)


def test_a_store_report_and_its_pdf_name_no_other_store(world: SimpleNamespace) -> None:
    """A shop spying on a competitor: the weekly report cites only this shop's own sources."""
    client, best = world.client, world.best
    numbers: dict[str, set[float]] = {sid: set() for sid in STORES}
    for run in (world.baseline, best):
        results, stats = rundata.load_stores(run), rundata.load_stats(run)
        for sid in STORES:
            kpis = results[sid].kpis
            values = (float(kpis.visits), kpis.kwh, stats[sid].energyCostGbp)
            numbers[sid] |= {v for v in values if v}  # 0.0 is in every report with no change
    for sid in SHOPS:
        response = client.get(f"/api/stores/{sid}/report?run={best}")
        assert response.status_code == 200
        body = response.json()
        StoreReport.model_validate(body)
        name = STORES[sid][0]
        labels = [e["label"] for e in body["evidence"]]
        assert f"BestTime foot-traffic forecast: {name}" in labels  # its own venue, cited
        pdf = pdf_text(client.get(f"/files/reports/{best}/{sid}.pdf").content)
        assert f"Weekly report: {name}" in pdf
        text = json.dumps(body)
        in_report = walk(body)[2]
        for other, (other_name, *_) in STORES.items():
            if other != sid:
                assert f'"{other}"' not in text and other_name not in text, (sid, other)
                assert other_name not in pdf, (sid, other)
                assert not in_report & numbers[other], (sid, other)


def test_the_report_pdf_says_simulated_not_guaranteed(world: SimpleNamespace) -> None:
    """Honest labels travel with the PDF an owner may forward, not only with the app."""
    for sid in SHOPS:
        body = world.client.get(f"/api/stores/{sid}/report?run={world.best}").json()
        pdf = pdf_text(world.client.get(f"/files/reports/{world.best}/{sid}.pdf").content)
        assert "Simulated, not guaranteed. Approve or reject each change in the app." in pdf
        assert f"Confidence: {body['confidence']} (" in pdf


def test_reading_any_page_changes_nothing_on_disk(world: SimpleNamespace) -> None:
    """Nothing changes without an explicit request: six routes write, and no GET writes."""
    routes = served_routes()
    assert {(method, path) for method, path in routes if method != "GET"} == WRITE_ROUTES

    before = snapshot(world.root)
    store_ids = [s.id for s in store.load_map().stores]
    statuses: dict[str, int] = {}
    for method, template in sorted(routes):
        if method != "GET":
            continue
        path = template.replace("{run}", str(world.best)).replace("{day}", "1")
        for sid in store_ids if "{store_id}" in path else [""]:
            url = re.sub(r"\{[^}]+\}", "unknown", path.replace("{store_id}", sid))
            statuses[url] = world.client.get(url).status_code
    assert snapshot(world.root) == before
    for sid in SHOPS:
        for page in ("report", "insights", "overview"):
            assert statuses[f"/api/stores/{sid}/{page}"] == 200, (sid, page)


def test_approve_records_the_decision_and_applies_nothing(world: SimpleNamespace) -> None:
    """The owner's Approve is recorded for the agents to read; it changes no run or config."""
    client, best = world.client, world.best
    before = snapshot(world.root)
    runs_before = client.get("/api/runs").json()
    implicit = client.post(
        f"/api/decision?run={best}", json={"storeId": "s2", "suggestionIndex": 0}
    )
    assert implicit.status_code == 422  # approve or reject must be said, never assumed
    assert snapshot(world.root) == before

    body = {"storeId": "s2", "suggestionIndex": 0, "decision": "approve"}
    assert client.post(f"/api/decision?run={best}", json=body).status_code == 200
    after = snapshot(world.root)
    assert set(after) - set(before) == {"runs/decisions.json"}
    assert {path: digest for path, digest in after.items() if path in before} == before
    assert client.get("/api/runs").json() == runs_before
    [decision] = store.load_decisions()
    change = StoreReport.model_validate(client.get(f"/api/stores/s2/report?run={best}").json())
    assert (decision.storeId, decision.run, decision.decision) == ("s2", best, "approve")
    assert decision.suggestion == dump(change.changes[0])


def test_the_backend_serves_no_incidents(world: SimpleNamespace) -> None:
    """Safety layer: no synthetic incident is ever attached to a real venue by this API."""
    assert not [path for _, path in served_routes() if "incident" in path]
    for run in (world.baseline, world.best):
        assert world.client.get(f"/api/runs/{run}/incidents").status_code == 404


# --- store agents: independent advice, own levers only ----------------------------------------


class CapturingBatches:
    """Message Batches stand-in: records every request and answers with no suggestions."""

    def __init__(self) -> None:
        self.requests: list[dict] = []

    def create(self, *, requests: list[dict]) -> SimpleNamespace:
        self.requests = list(requests)
        return SimpleNamespace(id="msgbatch_test", processing_status="ended")

    def retrieve(self, batch_id: str) -> SimpleNamespace:
        return SimpleNamespace(id=batch_id, processing_status="ended")

    def results(self, batch_id: str) -> Iterator[SimpleNamespace]:
        for request in self.requests:
            message = text_response('{"suggestions": []}')
            yield SimpleNamespace(
                custom_id=request["custom_id"],
                result=SimpleNamespace(type="succeeded", message=message),
            )


def store_agent_inputs(
    root: Path, monkeypatch: pytest.MonkeyPatch, s1: StoreConfig | None = None
) -> dict[str, dict]:
    """Every store agent's full Claude request (system + user) on a fresh world's baseline run,
    optionally with competitor s1 trading other hours and lighting."""
    sim = setup_world(root, monkeypatch)
    configs = sim.baseline_configs()
    if s1 is not None:
        configs["s1"] = s1
    run = sim.execute_run(configs, 42)
    batches = CapturingBatches()
    client = SimpleNamespace(messages=SimpleNamespace(batches=batches))
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "client", lambda: client)
    store_owner.propose_all(run, session=root.name)
    return {r["custom_id"].split("-", 1)[1]: r["params"] for r in batches.requests}


def test_a_competitors_data_never_reaches_a_store_agents_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Competitors coordinating through us: the fake sim keeps every shop's results independent,
    so if a rival's new hours and lighting changed one byte of my agent's request, the rival's
    data would be in it."""
    before = store_agent_inputs(tmp_path / "before", monkeypatch)
    rival = StoreConfig(open="07:00", close="16:00", lighting=["high"] * 24)
    after = store_agent_inputs(tmp_path / "after", monkeypatch, s1=rival)
    assert sorted(before) == sorted(after) == SHOPS
    for sid in ("s2", "s3", "s4"):
        assert after[sid] == before[sid], sid
    assert after["s1"] != before["s1"]  # the agent does see its own shop's change


def test_a_store_agent_can_only_change_its_own_hours_or_lighting() -> None:
    """No price lever and no advice for another shop, whatever the model writes."""
    item = prompts.STORE_SCHEMA["properties"]["suggestions"]["items"]
    assert item["properties"]["field"]["enum"] == ["open", "close", "lighting"]
    assert "storeId" not in item["properties"] and item["additionalProperties"] is False
    assert get_args(Suggestion.model_fields["field"].annotation) == ("open", "close", "lighting")
    delta = {"visits": 0.0, "kwh": 0.0}
    rogue = {
        "suggestions": [
            {
                "storeId": "s1",
                "field": "close",
                "hours": [],
                "from": "18:00",
                "to": "16:00",
                "expectedDelta": delta,
                "confidence": "low",
                "reason": "Close when the cafe next door closes.",
            },
            {
                "field": "price",
                "hours": [],
                "from": "4.50",
                "to": "5.50",
                "expectedDelta": delta,
                "confidence": "low",
                "reason": "Match the rival's prices.",
            },
        ]
    }
    suggestions, errors = store_owner.parse_store_output("s2", rogue)
    assert [s.storeId for s in suggestions] == ["s2"]
    assert len(errors) == 1


def test_a_models_wild_estimate_is_clamped() -> None:
    """Honest numbers: a model claiming +5,000% visits is cut to +300% before it is ranked or
    priced on the store page; a loss is never larger than everything (-100%)."""
    wild = {
        "suggestions": [
            {
                "field": "close",
                "hours": [],
                "from": "23:00",
                "to": "03:00",
                "expectedDelta": {"visits": 50.0, "kwh": -7.0},
                "confidence": "high",
                "reason": "Huge crowd.",
            }
        ]
    }
    [suggestion], errors = store_owner.parse_store_output("s2", wild)
    assert errors == []
    assert suggestion.expectedDelta.visits == store_owner.MAX_EXPECTED_DELTA == 3.0
    assert suggestion.expectedDelta.kwh == -1.0


# --- spend caps, runaway loops, the audit log ---------------------------------------------------


class RecordingMessages:
    """Messages API stand-in: records every request and answers each with `reply`."""

    def __init__(self, reply: SimpleNamespace) -> None:
        self.reply = reply
        self.sent: list[dict] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.sent.append(kwargs)
        return self.reply


def test_the_global_spend_cap_stops_every_session_before_the_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """$30 across all sessions: a new session with its whole $15 left still cannot spend."""
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(settings, "LLM_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(settings, "SPEND_CAP_USD", 30.0)
    monkeypatch.setattr(settings, "SESSION_BUDGET_USD", 15.0)
    messages = RecordingMessages(text_response("{}"))
    client = SimpleNamespace(messages=messages)
    monkeypatch.setattr(llm, "client", lambda: client)

    def spend(usd: float, session: str) -> None:
        tokens = round(usd * 1e6 / llm.PRICES_USD_PER_MTOK[settings.ANALYST_MODEL][0])
        usage = llm.Usage(input_tokens=tokens)
        llm.record_usage("analyst", settings.ANALYST_MODEL, usage, run=None, session=session)

    spend(14.99, "monday")
    spend(15.00, "tuesday")
    assert llm.spent_usd() == pytest.approx(29.99)
    llm.check_budget("wednesday")  # $0.01 of headroom: the call may go ahead
    spend(1.00, "tuesday")
    for session in (None, "wednesday"):
        with pytest.raises(llm.BudgetExceeded, match="spend cap reached"):
            llm.check_budget(session)
    with pytest.raises(llm.BudgetExceeded):
        llm.call_json(
            agent="persona-builder",
            model=settings.PERSONA_MODEL,
            system=llm.system_blocks("Describe groups."),
            user="Shoreditch",
            schema={"type": "object"},
            session="wednesday",
        )
    assert messages.sent == []
    assert not (settings.RUNS_DIR / "llm_log.jsonl").exists()


def test_the_analyst_cannot_loop_past_twelve_turns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Runaway agent: a model that keeps calling tools without committing to an experiment is cut
    off after MAX_TURNS calls and the deterministic heuristic decides."""
    sim = setup_world(tmp_path, monkeypatch)
    run = sim.execute_run(sim.baseline_configs(), 42)
    world = SimpleNamespace(run=run, proposals=store_owner.propose_all(run))
    calls: list[dict] = []

    def create(**kwargs: Any) -> SimpleNamespace:
        calls.append(kwargs)
        block = SimpleNamespace(
            type="tool_use", id=f"t{len(calls)}", name="get_kpis", input={"run": run}
        )
        return SimpleNamespace(
            content=[block], stop_reason="tool_use", usage=text_response("").usage
        )

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
    monkeypatch.setattr(llm, "client", lambda: client)
    choice = analyst.MessagesAnalyst().choose(context(world))

    assert len(calls) == analyst.MessagesAnalyst.MAX_TURNS == 12
    assert choice.changes == analyst.HeuristicAnalyst().choose(context(world)).changes
    log = [json.loads(line) for line in (settings.RUNS_DIR / str(run) / "llm_log.jsonl").open()]
    [fallback] = [e for e in log if e["type"] == "fallback"]
    assert fallback["reason"] == "no experiment after 12 turns"
    assert len(llm.load_ledger()) == 12  # every one of the 12 calls was costed


def test_every_claude_call_is_logged_with_its_cost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Audit trail: the shared call path writes the request, the response and a ledger row."""
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(settings, "LLM_CACHE_DIR", tmp_path / "cache")
    messages = RecordingMessages(text_response('{"ok": true}'))
    client = SimpleNamespace(messages=messages)
    monkeypatch.setattr(llm, "client", lambda: client)
    sent = messages.sent

    data, _ = llm.call_json(
        agent="persona-builder",
        model=settings.PERSONA_MODEL,
        system=llm.system_blocks("Describe groups, never individuals."),
        user="Shoreditch guide pages",
        schema={"type": "object"},
        run=7,
        session="sess",
    )

    assert data == {"ok": True} and len(sent) == 1
    log = [json.loads(line) for line in (settings.RUNS_DIR / "7" / "llm_log.jsonl").open()]
    assert [e["type"] for e in log] == ["request", "response"]
    assert all(e["agent"] == "persona-builder" and e["at"] for e in log)
    assert log[0]["request"]["model"] == settings.PERSONA_MODEL
    assert log[0]["request"]["messages"] == sent[0]["messages"]
    assert log[1]["text"] == '{"ok": true}' and log[1]["usage"]["input_tokens"] == 1000
    [row] = llm.load_ledger()
    assert (row["agent"], row["model"], row["run"], row["session"]) == (
        "persona-builder",
        settings.PERSONA_MODEL,
        7,
        "sess",
    )
    input_usd, _, _, output_usd = llm.PRICES_USD_PER_MTOK[settings.PERSONA_MODEL]
    assert row["costUsd"] == pytest.approx((1000 * input_usd + 200 * output_usd) / 1e6)
