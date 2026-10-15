"""Store-owner agents: the offline heuristic, the data firewall and the Message Batches path."""

from __future__ import annotations

import dataclasses
import json
from types import SimpleNamespace

import pytest
from test_agents_fakesim import STORES, setup_world  # pytest puts tests/ on sys.path

from backend import cache, llm, settings, store
from backend.agents import prompts, rundata, store_owner
from backend.agents.changes import change_signature
from backend.agents.rules import apply_suggestion
from backend.agents.wording import change_label
from backend.schemas import Decision, Levers, TrainingConfig


@pytest.fixture
def world(tmp_path, monkeypatch):
    sim = setup_world(tmp_path, monkeypatch)
    run = sim.execute_run(sim.baseline_configs(), 42)
    return SimpleNamespace(sim=sim, run=run)


def brief_for(run: int, store_id: str) -> store_owner.StoreBrief:
    map_data = store.load_map()
    ms = next(s for s in map_data.stores if s.id == store_id)
    files = rundata.RunFiles.load(run)
    history = store_owner.store_histories(run, [store_id])[store_id]
    return store_owner.build_brief(
        files, ms, map_data, store.load_energy(), store.load_decisions(), history
    )


def labels(suggestions) -> list[str]:
    return [change_label(s) for s in suggestions]


def propose(run: int, store_id: str):
    return store_owner.heuristic_proposals(brief_for(run, store_id), store.load_map())


# --- heuristic ------------------------------------------------------------------------------


def test_takeaway_opens_late_for_club_spill_out_with_a_lit_frontage(world):
    proposals = propose(world.run, "s2")
    assert labels(proposals) == ["Close 23:00 → 03:00", "Light 00–03: off → low"]
    close, light = proposals
    assert close.expectedDelta.visits > 0.2 and close.expectedDelta.kwh > 0
    assert close.confidence == "medium" and "found you shut" in (close.reason or "")
    assert light.hours == [0, 1, 2]


def test_lights_go_off_while_the_store_is_shut(world):
    (change,) = propose(world.run, "s1")
    assert labels([change]) == ["Light 18–00: low → off"]
    assert change.expectedDelta.visits == 0 and change.expectedDelta.kwh < 0
    assert change.confidence == "high"


def test_dead_late_hours_are_trimmed(world):
    proposals = propose(world.run, "s4")
    assert labels(proposals) == ["Close 22:00 → 20:00", "Light 22–00: low → off"]
    assert proposals[0].expectedDelta.kwh < 0 < -proposals[0].expectedDelta.visits < 0.05


def test_quiet_night_hours_are_dimmed(world):
    assert labels(propose(world.run, "s3")) == ["Light 00–01: high → low"]


def test_busy_night_hours_are_brightened(world):
    brief = brief_for(world.run, "s3")
    lighting = list(brief.config.lighting)
    lighting[19] = lighting[20] = "low"
    dim = dataclasses.replace(brief, config=brief.config.model_copy(update={"lighting": lighting}))
    # Brightening back to "high" recreates the simulated baseline, which the rules forbid; a fresh
    # session does not count run 1, so the heuristic itself is under test here.
    cache.set_policy(fresh=True)
    proposals = store_owner.heuristic_proposals(dim, store.load_map())
    assert "Light 19–21: low → high" in labels(proposals)
    cache.set_policy(fresh=False)
    assert "Light 19–21: low → high" not in labels(
        store_owner.heuristic_proposals(dim, store.load_map())
    )


def test_every_proposal_respects_the_word_limit_and_change_cap(world):
    for sid, (_, kind, _, _) in STORES.items():
        if kind == "club":
            continue
        proposals = propose(world.run, sid)
        assert len(proposals) <= settings.MAX_CHANGES_PER_STORE_PER_WEEK
        for proposal in proposals:
            assert len((proposal.reason or "").split()) <= store_owner.REASON_WORDS


def test_a_tried_config_moves_the_store_to_its_next_idea(world):
    first = propose(world.run, "s2")
    config = rundata.load_config(world.run).stores["s2"]
    for change in first:
        config = apply_suggestion(config, change)
    cache.run_record("tried", 99, {"s2": config})
    second = propose(world.run, "s2")
    assert second and labels(second) != labels(first)
    final = rundata.load_config(world.run).stores["s2"]
    for change in second:
        final = apply_suggestion(final, change)
    assert not cache.store_config_tried("s2", final)


def test_an_owner_rejection_is_never_proposed_again(world):
    first = propose(world.run, "s2")
    store.append_decision(
        Decision(
            storeId="s2",
            run=world.run,
            suggestionIndex=0,
            suggestion=first[0].model_dump(mode="json", by_alias=True),
            decision="reject",
            reason="staff won't do 3am",
            at=store.now_iso(),
        )
    )
    again = propose(world.run, "s2")
    assert change_signature(first[0]) not in {change_signature(s) for s in again}


# --- a training session's scope (TrainingConfig) ---------------------------------------------


def test_heuristic_keeps_to_the_enabled_levers_and_the_change_cap(world):
    brief, map_data = brief_for(world.run, "s2"), store.load_map()
    hours_only = TrainingConfig(levers=Levers(hours=True, lighting=False))
    assert labels(store_owner.heuristic_proposals(brief, map_data, hours_only)) == [
        "Close 23:00 → 03:00"
    ]
    lighting_only = TrainingConfig(levers=Levers(hours=False, lighting=True))
    lit = store_owner.heuristic_proposals(brief, map_data, lighting_only)
    assert lit and all(p.field == "lighting" for p in lit)
    one = store_owner.heuristic_proposals(brief, map_data, TrainingConfig(maxChangesPerStore=1))
    assert labels(one) == ["Close 23:00 → 03:00"]


def test_heuristic_ranks_by_the_session_objective(world):
    # s4's trim saves energy and loses almost no visits: good per kWh, a loss in visits
    for_kwh = propose(world.run, "s4")
    brief = brief_for(world.run, "s4")
    by_visits = dataclasses.replace(brief, objective="visits")
    assert "Close 22:00 → 20:00" in labels(for_kwh)
    assert "Close 22:00 → 20:00" not in labels(
        store_owner.heuristic_proposals(by_visits, store.load_map())
    )


def test_propose_all_ranks_on_the_configs_objective(world):
    by_kwh = labels(p for p in store_owner.propose_all(world.run) if p.storeId == "s4")
    visits = TrainingConfig(objective="visits")
    by_visits = labels(
        p for p in store_owner.propose_all(world.run, config=visits) if p.storeId == "s4"
    )
    assert "Close 22:00 → 20:00" in by_kwh and "Close 22:00 → 20:00" not in by_visits


def test_propose_all_only_advises_the_participating_stores(world):
    proposals = store_owner.propose_all(world.run, config=TrainingConfig(storeIds=["s2", "s4"]))
    assert proposals and {p.storeId for p in proposals} == {"s2", "s4"}
    assert rundata.load_suggestions(world.run) == proposals


# --- data firewall --------------------------------------------------------------------------


def test_a_store_brief_contains_only_that_store(world):
    second = world.sim.execute_run(
        {**world.sim.baseline_configs(), "s1": rundata.load_config(world.run).stores["s1"]}, 43
    )
    assert second != world.run
    competitor = propose(world.run, "s1")[0]
    store.append_decision(
        Decision(
            storeId="s1",
            run=world.run,
            suggestionIndex=0,
            suggestion=competitor.model_dump(mode="json", by_alias=True),
            decision="approve",
            at=store.now_iso(),
        )
    )
    brief = brief_for(world.run, "s2")
    assert brief.decisions == []
    text = json.dumps(brief.prompt_data())
    for other, (name, _, _, _) in STORES.items():
        if other != "s2":
            assert f'"{other}"' not in text and name not in text
    assert "Kebab Co" in text
    history = store_owner.store_histories(world.run, ["s2"])["s2"]
    assert [h["run"] for h in history] == [second]
    assert set(history[0]) == {"run", "open", "close", "lighting", "visits", "kwh", "returnRate"}


def test_propose_all_offline_writes_rule_checked_suggestions(world):
    proposals = store_owner.propose_all(world.run, session="sess")
    saved = rundata.load_suggestions(world.run)
    assert saved == proposals
    assert [s.storeId for s in saved] == ["s1", "s2", "s2", "s3", "s4", "s4"]
    assert "c1" not in {s.storeId for s in saved}
    log = (settings.RUNS_DIR / str(world.run) / "llm_log.jsonl").read_text()
    assert '"mode": "heuristic"' in log


# --- online: Message Batches (mocked client, no network) ------------------------------------


def _message(text: str, stop_reason: str = "end_turn"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        stop_reason=stop_reason,
        usage=SimpleNamespace(
            input_tokens=1200,
            output_tokens=300,
            cache_read_input_tokens=2000,
            cache_creation_input_tokens=0,
        ),
    )


class FakeBatches:
    def __init__(self, outputs: dict[str, object]):
        self.outputs = outputs  # store id -> JSON dict, or "errored"
        self.created: list[dict] = []

    def create(self, *, requests):
        self.created = list(requests)
        return SimpleNamespace(id="msgbatch_1", processing_status="in_progress")

    def retrieve(self, batch_id):
        return SimpleNamespace(id=batch_id, processing_status="ended")

    def cancel(self, batch_id):  # pragma: no cover - only on timeout
        raise AssertionError("batch should not time out")

    def results(self, batch_id):
        for request in reversed(self.created):  # results arrive in any order
            sid = request["custom_id"].split("-", 1)[1]
            output = self.outputs.get(sid, {"suggestions": []})
            if output == "errored":
                yield SimpleNamespace(
                    custom_id=request["custom_id"], result=SimpleNamespace(type="errored")
                )
            else:
                yield SimpleNamespace(
                    custom_id=request["custom_id"],
                    result=SimpleNamespace(type="succeeded", message=_message(json.dumps(output))),
                )


@pytest.fixture
def online(monkeypatch):
    def install(outputs):
        batches = FakeBatches(outputs)
        client = SimpleNamespace(messages=SimpleNamespace(batches=batches))
        monkeypatch.setattr(llm, "available", lambda: True)
        monkeypatch.setattr(llm, "client", lambda: client)
        return batches

    return install


S2_OUTPUT = {
    "suggestions": [
        {
            "field": "close",
            "hours": [],
            "from": "23:00",
            "to": "02:00",
            "expectedDelta": {"visits": 0.2, "kwh": 0.1},
            "confidence": "medium",
            "reason": "About 20 people a day find you shut after the club closes at 3am",
        },
        {
            "field": "open",
            "hours": [],
            "from": "11:00",
            "to": "05:00",  # outside the takeaway licence (06:00-04:00): rejected by rules
            "expectedDelta": {"visits": 0.01, "kwh": 0.2},
            "confidence": "low",
            "reason": "Early commuters.",
        },
    ]
}


def test_batch_sends_one_request_per_store_with_cached_city_context(world, online):
    batches = online({"s2": S2_OUTPUT, "s1": "errored"})
    proposals = store_owner.propose_all(world.run, session="sess-1")

    assert len(batches.created) == 4  # every non-club store, one batch
    custom_ids = [r["custom_id"] for r in batches.created]
    assert len(set(custom_ids)) == 4 and not any(cid.endswith("c1") for cid in custom_ids)
    params = batches.created[0]["params"]
    assert params["model"] == settings.STORE_AGENT_MODEL
    city_context = prompts.city_context(TrainingConfig())
    assert params["system"] == [
        {"type": "text", "text": city_context, "cache_control": {"type": "ephemeral"}}
    ]
    assert params["output_config"]["format"] == {
        "type": "json_schema",
        "schema": prompts.STORE_SCHEMA,
    }
    for request in batches.created:
        sid = request["custom_id"].split("-", 1)[1]
        user = request["params"]["messages"][0]["content"]
        assert STORES[sid][0] in user
        assert all(STORES[o][0] not in user for o in STORES if o != sid)

    by_store = {}
    for proposal in proposals:
        by_store.setdefault(proposal.storeId, []).append(change_label(proposal))
    assert by_store["s2"] == ["Close 23:00 → 02:00"]  # the licence-breaking open was rejected
    assert by_store["s1"] == ["Light 18–00: low → off"]  # errored result -> heuristic fallback
    s2 = next(p for p in proposals if p.storeId == "s2")
    assert len((s2.reason or "").split()) <= 15

    log = [
        json.loads(line) for line in (settings.RUNS_DIR / str(world.run) / "llm_log.jsonl").open()
    ]
    kinds = [e["type"] for e in log]
    assert kinds.count("batch_request") == 4 and "batch_created" in kinds
    assert any(e["type"] == "rule_rejection" and e["suggestion"]["to"] == "05:00" for e in log)
    assert any(e["type"] == "fallback" and e["storeId"] == "s1" for e in log)

    ledger = llm.load_ledger()
    assert len(ledger) == 3  # succeeded results only
    assert all(
        r["batch"] and r["agent"] == "store_owner" and r["session"] == "sess-1" for r in ledger
    )
    assert all(r["cache_read_tokens"] == 2000 for r in ledger)


def test_batch_prompts_carry_the_session_limits_and_off_lever_proposals_are_dropped(world, online):
    lit_s2 = {
        "suggestions": [
            S2_OUTPUT["suggestions"][0],
            {
                "field": "lighting",
                "hours": [0, 1, 2],
                "from": "off",
                "to": "low",
                "expectedDelta": {"visits": 0.05, "kwh": 0.01},
                "confidence": "low",
                "reason": "A lit frontage shows you are open.",
            },
        ]
    }
    batches = online({"s2": lit_s2})
    config = TrainingConfig(
        objective="netValueGbp",
        levers=Levers(hours=True, lighting=False),
        maxChangesPerStore=1,
        storeIds=["s2"],
    )
    proposals = store_owner.propose_all(world.run, session="sess-1", config=config)

    [request] = batches.created  # frozen stores get no agent
    params = request["params"]
    system = params["system"][0]["text"]
    assert system == prompts.city_context(config)
    assert "The area objective is netValueGbp" in system
    assert "changes opening hours only: a lighting change is rejected" in system
    assert "At most 1 changes per store per week" in system
    assert "Propose 0-1 changes" in params["messages"][0]["content"]
    assert labels(proposals) == ["Close 23:00 → 02:00"]
    log = [
        json.loads(line) for line in (settings.RUNS_DIR / str(world.run) / "llm_log.jsonl").open()
    ]
    [dropped] = [e for e in log if e["type"] == "rule_rejection"]
    assert dropped["suggestion"]["field"] == "lighting"
    assert "lighting lever is off" in dropped["reason"]


def test_batch_is_not_submitted_once_the_session_budget_is_spent(world, online, monkeypatch):
    batches = online({})
    monkeypatch.setattr(settings, "SESSION_BUDGET_USD", 0.01)
    llm.record_usage(
        "analyst", settings.ANALYST_MODEL, llm.Usage(input_tokens=10_000), run=None, session="s"
    )
    with pytest.raises(llm.BudgetExceeded):
        store_owner.propose_all(world.run, session="s")
    assert batches.created == []


def test_parse_store_output_keeps_the_store_and_trims_extras():
    data = {
        "suggestions": [
            {
                "field": "lighting",
                "hours": [1, 2],
                "from": "off",
                "to": "low",
                "expectedDelta": {"visits": 0.04, "kwh": 0.01},
                "confidence": "low",
                "reason": " ".join(["word"] * 30),
            },
            {"field": "close", "hours": [5], "from": "23:00", "to": "01:00", "expectedDelta": {}},
            {"field": "open", "hours": [], "from": "11:00", "to": "10:00"},
        ]
    }
    suggestions, errors = store_owner.parse_store_output("s9", data)
    assert [s.storeId for s in suggestions] == ["s9"]
    assert suggestions[0].hours == [1, 2] and len((suggestions[0].reason or "").split()) == 15
    assert len(errors) == 1  # the second item has no deltas; the third is past the 2-change cap
