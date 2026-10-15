"""The agents under API failure: budget pre-flight, the analyst's and the store agents' degrade
path (retries, breaker, heuristic fallback), batch recovery and structured-output repair."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from test_agents_analyst import context, response, tool_use  # pytest puts tests/ on sys.path
from test_agents_fakesim import setup_world
from test_agents_store_owner import S2_OUTPUT, FakeBatches, _message

from backend import chaos, llm, settings
from backend.agents import analyst, store_owner


@pytest.fixture(autouse=True)
def no_backoff_sleep(monkeypatch):
    monkeypatch.setattr(llm, "_sleep", lambda seconds: None)


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A baseline run on the fake sim, with offline proposals on it."""
    sim = setup_world(tmp_path, monkeypatch)
    run = sim.execute_run(sim.baseline_configs(), 42)
    return SimpleNamespace(sim=sim, run=run, proposals=store_owner.propose_all(run))


def log(run: int | None) -> list[dict]:
    folder = settings.RUNS_DIR / str(run) if run is not None else settings.RUNS_DIR
    path = folder / "llm_log.jsonl"
    return [json.loads(line) for line in path.open()] if path.exists() else []


# --- budget pre-flight ------------------------------------------------------------------------


def test_the_estimate_covers_max_output_and_halves_for_batches():
    request = {
        "model": settings.ANALYST_MODEL,
        "max_tokens": 16000,
        "system": [{"type": "text", "text": "x" * 3000}],
        "messages": [{"role": "user", "content": "y" * 3000}],
    }
    estimate = llm.estimate_usd(request)
    output_usd = 16000 * llm.PRICES_USD_PER_MTOK[settings.ANALYST_MODEL][3] / 1e6
    assert output_usd < estimate < output_usd + 0.05
    assert llm.estimate_usd(request, batch=True) == pytest.approx(estimate / 2)


def test_preflight_refuses_a_call_that_could_cross_the_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(settings, "SESSION_BUDGET_USD", 1.0)
    llm.record_usage(
        "analyst", settings.ANALYST_MODEL, llm.Usage(input_tokens=200_000), run=None, session="s"
    )  # $0.80 spent: under the cap
    small = {"model": settings.ANALYST_MODEL, "max_tokens": 1000, "messages": []}
    llm.preflight("s", small)  # $0.02 more is fine
    big = {"model": settings.ANALYST_MODEL, "max_tokens": 16000, "messages": []}
    with pytest.raises(llm.BudgetExceeded, match="would cross"):
        llm.preflight("s", big)  # up to $0.32 more could cross $1.00


def test_call_json_checks_the_estimate_before_calling(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(settings, "SPEND_CAP_USD", 0.01)
    called = []
    monkeypatch.setattr(llm, "client", lambda: called.append(1))
    with pytest.raises(llm.BudgetExceeded):
        llm.call_json(
            agent="persona",
            model=settings.PERSONA_MODEL,
            system=[],
            user="hi",
            schema={"type": "object"},
            max_tokens=100_000,
        )
    assert called == []


# --- analyst: retries, then the heuristic ------------------------------------------------------


class Erroring:
    """A Messages client whose create() raises `errors` in order, then answers `responses`."""

    def __init__(self, errors: list[Exception], responses: list) -> None:
        self.errors, self.responses, self.calls = list(errors), list(responses), 0

    def create(self, **kwargs):
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return self.responses.pop(0)


def install_messages(monkeypatch, fake) -> None:
    client = SimpleNamespace(beta=SimpleNamespace(messages=fake))
    monkeypatch.setattr(llm, "client", lambda: client)


def test_the_analyst_retries_a_rate_limit_and_still_commits(world, monkeypatch):
    commit = response(tool_use("t1", "run_sim", {"changes": S2_RUN_SIM, "hypothesis": "h"}))
    fake = Erroring([chaos.api_error(429), chaos.api_error(529)], [commit])
    install_messages(monkeypatch, fake)
    choice = analyst.MessagesAnalyst().choose(context(world))
    assert choice.hypothesis == "h" and fake.calls == 3
    assert [e["kind"] for e in log(world.run) if e["type"] == "retry"] == ["http_429", "http_529"]


S2_RUN_SIM = [{"storeId": "s2", "field": "close", "hours": [], "from": "23:00", "to": "03:00"}]


def test_the_analyst_degrades_to_the_heuristic_when_claude_stays_down(world, monkeypatch):
    fake = Erroring([chaos.api_error(529) for _ in range(50)], [])
    install_messages(monkeypatch, fake)
    choice = analyst.MessagesAnalyst().choose(context(world))
    assert choice.changes == analyst.HeuristicAnalyst().choose(context(world)).changes
    assert fake.calls == settings.RETRY_MAX_ATTEMPTS
    [fallback] = [e for e in log(world.run) if e["type"] == "fallback"]
    assert fallback["to"] == "heuristic" and fallback["kind"] == "llm_unavailable"
    assert llm.recovery_counts("sess")["fallbacks"] == 1


def test_an_open_breaker_skips_claude_for_the_rest_of_the_step(world, monkeypatch):
    fake = Erroring([], [])
    install_messages(monkeypatch, fake)
    llm._breaker.update(open=True)
    choice = analyst.MessagesAnalyst().choose(context(world))
    assert fake.calls == 0 and choice.changes
    assert [e["kind"] for e in log(world.run) if e["type"] == "fallback"] == ["circuit_open"]


def test_an_auth_error_is_fatal_and_falls_back_without_retrying(world, monkeypatch):
    fake = Erroring([chaos.api_error(401)], [])
    install_messages(monkeypatch, fake)
    choice = analyst.MessagesAnalyst().choose(context(world))
    assert fake.calls == 1 and choice.changes


def test_an_empty_answer_is_nudged_then_falls_back(world, monkeypatch):
    empty = response(stop_reason="end_turn")
    fake = Erroring([], [empty, empty])
    install_messages(monkeypatch, fake)
    choice = analyst.MessagesAnalyst().choose(context(world))
    assert choice.changes and fake.calls == 2


# --- store agents: batch failures -------------------------------------------------------------


class Messages:
    """messages.create for per-request calls (batch fallback and repair re-asks)."""

    def __init__(self, answers: list) -> None:
        self.answers, self.calls = list(answers), []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return _message(answer if isinstance(answer, str) else json.dumps(answer))


def install_store_client(monkeypatch, batches, messages: Messages | None = None) -> Messages:
    messages = messages or Messages([])
    client = SimpleNamespace(
        messages=SimpleNamespace(batches=batches, create=messages.create),
        beta=SimpleNamespace(messages=SimpleNamespace(create=messages.create)),
    )
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "client", lambda: client)
    return messages


class StuckBatches(FakeBatches):
    def __init__(self, outputs):
        super().__init__(outputs)
        self.cancelled = []

    def retrieve(self, batch_id):
        return SimpleNamespace(id=batch_id, processing_status="in_progress")

    def cancel(self, batch_id):
        self.cancelled.append(batch_id)


def test_a_stuck_batch_times_out_and_the_missing_stores_go_per_request(world, monkeypatch):
    monkeypatch.setattr(store_owner, "BATCH_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(store_owner, "BATCH_POLL_SECONDS", 0)
    batches = StuckBatches({})
    messages = install_store_client(
        monkeypatch,
        batches,
        Messages([S2_OUTPUT if i == 1 else {"suggestions": []} for i in range(4)]),
    )
    proposals = store_owner.propose_all(world.run, session="sess")
    assert batches.cancelled == ["msgbatch_1"]
    assert len(messages.calls) == 4  # one per store that had no batch result
    assert any(p.storeId == "s2" and p.to == "02:00" for p in proposals)
    events = log(world.run)
    assert any(e["type"] == "batch_timeout" for e in events)
    assert llm.recovery_counts("sess")["batchTimeouts"] == 1


class PartialBatches(FakeBatches):
    """s1's result errored, s3's expired; the others succeed."""

    def results(self, batch_id):
        for item in super().results(batch_id):
            sid = item.custom_id.split("-", 1)[1]
            if sid in ("s1", "s3"):
                kind = "errored" if sid == "s1" else "expired"
                yield SimpleNamespace(custom_id=item.custom_id, result=SimpleNamespace(type=kind))
            else:
                yield item


def test_partial_batch_failures_are_retried_per_request_for_those_stores_only(world, monkeypatch):
    batches = PartialBatches({"s2": S2_OUTPUT})
    messages = install_store_client(monkeypatch, batches, Messages([{"suggestions": []}] * 2))
    store_owner.propose_all(world.run, session="sess")
    assert len(messages.calls) == 2
    retried = [e for e in log(world.run) if e["type"] == "fallback" and e.get("to") == "request"]
    assert sorted(e["storeId"] for e in retried) == ["s1", "s3"]


def test_a_store_whose_retry_also_fails_gets_the_heuristic(world, monkeypatch):
    batches = PartialBatches({})
    install_store_client(
        monkeypatch, batches, Messages([chaos.api_error(400), chaos.api_error(400)])
    )
    proposals = store_owner.propose_all(world.run, session="sess")
    heuristic = [
        e for e in log(world.run) if e["type"] == "fallback" and e.get("to") == "heuristic"
    ]
    assert sorted(e["storeId"] for e in heuristic) == ["s1", "s3"]
    assert any(p.storeId == "s1" for p in proposals)  # the heuristic proposed for s1


def test_expired_batch_results_fall_back_per_request(world, monkeypatch):
    class Expired(FakeBatches):
        def results(self, batch_id):
            raise chaos.api_error(404)

    messages = install_store_client(monkeypatch, Expired({}), Messages([{"suggestions": []}] * 4))
    store_owner.propose_all(world.run, session="sess")
    assert len(messages.calls) == 4


def test_a_batch_api_outage_degrades_every_store_to_the_heuristic(world, monkeypatch):
    class Down(FakeBatches):
        def create(self, *, requests):
            raise chaos.api_error(503)

    install_store_client(monkeypatch, Down({}), Messages([chaos.api_error(503)] * 10))
    proposals = store_owner.propose_all(world.run, session="sess")
    assert proposals  # the heuristic still proposed
    assert llm.breaker_open()  # 5 failed creates + 1 per-request attempt
    fallbacks = [e for e in log(world.run) if e["type"] == "fallback"]
    assert {e["storeId"] for e in fallbacks if e.get("to") == "heuristic"} == {
        "s1",
        "s2",
        "s3",
        "s4",
    }


class Killed(BaseException):
    """Stands in for SIGKILL: nothing after it runs."""


def test_a_batch_submitted_before_a_kill_is_reattached_not_paid_twice(world, monkeypatch):
    class DiesWhilePolling(FakeBatches):
        def retrieve(self, batch_id):
            raise Killed

    first = DiesWhilePolling({"s2": S2_OUTPUT})
    install_store_client(monkeypatch, first)
    with pytest.raises(Killed):
        store_owner.propose_all(world.run, session="sess")
    assert len(first.created) == 4

    second = FakeBatches({"s2": S2_OUTPUT})
    second.created = first.created  # the server still has the batch and its requests
    monkeypatch.setattr(second, "create", lambda **kw: pytest.fail("batch submitted twice"))
    install_store_client(monkeypatch, second)
    proposals = store_owner.propose_all(world.run, session="sess")
    assert any(p.storeId == "s2" and p.to == "02:00" for p in proposals)
    assert any(e["type"] == "batch_reattached" for e in log(world.run))


# --- structured output: one repair, then skip the shop ------------------------------------------


def test_bad_json_gets_one_repair_with_the_validation_error(world, monkeypatch):
    batches = FakeBatches({"s2": "not json at all"})
    monkeypatch.setattr(batches, "results", _raw_results(batches, {"s2": "{not json"}))
    messages = install_store_client(monkeypatch, batches, Messages([S2_OUTPUT]))
    proposals = store_owner.propose_all(world.run, session="sess")
    [repair_call] = messages.calls
    assert repair_call["messages"][1] == {"role": "assistant", "content": "{not json"}
    assert "invalid JSON" in repair_call["messages"][2]["content"]
    assert any(p.storeId == "s2" and p.to == "02:00" for p in proposals)
    assert [e["storeId"] for e in log(world.run) if e["type"] == "repair"] == ["s2"]


def test_output_that_fails_the_schema_is_repaired_once_then_the_shop_is_skipped(world, monkeypatch):
    bad = {"suggestions": [{"field": "close", "to": "02:00"}]}  # missing required fields
    batches = FakeBatches({})
    monkeypatch.setattr(batches, "results", _raw_results(batches, {"s2": json.dumps(bad)}))
    messages = install_store_client(monkeypatch, batches, Messages([bad]))
    proposals = store_owner.propose_all(world.run, session="sess")
    assert len(messages.calls) == 1
    assert "suggestions[0]" in messages.calls[0]["messages"][2]["content"]
    assert not any(p.storeId == "s2" for p in proposals)  # skipped, not guessed
    [skip] = [e for e in log(world.run) if e["type"] == "skip"]
    assert skip["storeId"] == "s2" and "suggestions[0]" in skip["error"]


def test_a_repair_that_cannot_reach_claude_gives_that_shop_the_heuristic(world, monkeypatch):
    batches = FakeBatches({})
    monkeypatch.setattr(batches, "results", _raw_results(batches, {"s2": "{not json"}))
    install_store_client(monkeypatch, batches, Messages([chaos.api_error(503)] * 10))
    proposals = store_owner.propose_all(world.run, session="sess")
    assert any(p.storeId == "s2" for p in proposals)  # advice from the heuristic, not nothing
    assert not [e for e in log(world.run) if e["type"] == "skip"]
    [fallback] = [e for e in log(world.run) if e["type"] == "fallback"]
    assert fallback["storeId"] == "s2" and fallback["kind"] == "llm_unavailable"


def test_a_refusal_falls_back_to_the_heuristic_for_that_shop(world, monkeypatch):
    batches = FakeBatches({})
    monkeypatch.setattr(
        batches, "results", _raw_results(batches, {"s2": ""}, stop_reasons={"s2": "refusal"})
    )
    install_store_client(monkeypatch, batches)
    proposals = store_owner.propose_all(world.run, session="sess")
    assert any(p.storeId == "s2" for p in proposals)
    [fallback] = [e for e in log(world.run) if e["type"] == "fallback"]
    assert fallback["storeId"] == "s2" and fallback["kind"] == "refusal"


def _raw_results(batches: FakeBatches, texts: dict[str, str], stop_reasons=None):
    """results() answering raw text for some stores (and {"suggestions": []} for the rest)."""
    stop_reasons = stop_reasons or {}

    def results(batch_id):
        for request in batches.created:
            sid = request["custom_id"].split("-", 1)[1]
            body = texts.get(sid, json.dumps({"suggestions": []}))
            message = _message(body, stop_reason=stop_reasons.get(sid, "end_turn"))
            yield SimpleNamespace(
                custom_id=request["custom_id"],
                result=SimpleNamespace(type="succeeded", message=message),
            )

    return results
