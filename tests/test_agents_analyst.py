"""Analyst backends: heuristic choice, measured notebook lines, and the Messages / Managed Agents
paths against scripted fake clients (no network)."""

from __future__ import annotations

import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from test_agents_fakesim import setup_world  # pytest puts tests/ on sys.path

from backend import cache, llm, settings, store
from backend.agents import analyst, prompts, rundata, store_owner
from backend.agents.analyst_tools import MESSAGES_TOOLS
from backend.agents.changes import make_suggestion
from backend.agents.experiment import AnalystContext, IterationOutcome, expected_city_gain
from backend.agents.rules import check_changes
from backend.agents.wording import change_label
from backend.schemas import Levers, TrainingConfig


@pytest.fixture
def world(tmp_path, monkeypatch):
    sim = setup_world(tmp_path, monkeypatch)
    run = sim.execute_run(sim.baseline_configs(), 42)
    proposals = store_owner.propose_all(run)
    return SimpleNamespace(sim=sim, run=run, proposals=proposals)


def context(world, **overrides) -> AnalystContext:
    files = rundata.RunFiles.load(world.run)
    fields = dict(
        session="sess",
        seed=42,
        objective=settings.OBJECTIVE,
        run_number=2,
        max_runs=10,
        best_run=world.run,
        best_objective=files.summary.objectiveValue,
        base_configs=files.config.stores,
        proposals=world.proposals,
        map_data=store.load_map(),
        notebook=store.load_notebook(),
    )
    fields.update(overrides)
    return AnalystContext(**fields)


S2_CHANGES = [
    {"storeId": "s2", "field": "close", "hours": [], "from": "23:00", "to": "03:00"},
    {"storeId": "s2", "field": "lighting", "hours": [0, 1, 2], "from": "off", "to": "low"},
]


# --- heuristic ------------------------------------------------------------------------------


def test_heuristic_tests_the_biggest_expected_gains_first(world):
    choice = analyst.HeuristicAnalyst().choose(context(world))
    stores = [c.storeId for c in choice.changes]
    assert stores[:2] == ["s2", "s2"]  # the takeaway's spill-out story has the largest gain
    assert len(set(stores)) <= settings.MAX_STORES_PER_ITERATION
    assert all(stores.count(s) <= settings.MAX_CHANGES_PER_STORE_PER_WEEK for s in stores)
    assert choice.expected_gain and choice.expected_gain > 0.02
    assert choice.hypothesis.startswith("Opened Kebab Co till 03:00")
    assert len(choice.hypothesis.split()) <= analyst.HYPOTHESIS_WORDS


def test_heuristic_caps_stores_per_iteration(world, monkeypatch):
    monkeypatch.setattr(settings, "MAX_STORES_PER_ITERATION", 2)
    choice = analyst.HeuristicAnalyst().choose(context(world))
    assert len({c.storeId for c in choice.changes}) == 2


def test_heuristic_skips_a_config_already_in_the_run_cache(world, monkeypatch):
    ctx = context(world)
    first = analyst.HeuristicAnalyst().choose(ctx)
    first_key = cache.run_key(
        check_changes(ctx.base_configs, first.changes, ctx.map_data).configs, 42
    )
    real_lookup = cache.run_lookup
    monkeypatch.setattr(
        cache, "run_lookup", lambda key: 7 if key == first_key else real_lookup(key)
    )
    second = analyst.HeuristicAnalyst().choose(ctx)
    assert second.changes and second.changes != first.changes
    log = (settings.RUNS_DIR / str(world.run) / "llm_log.jsonl").read_text()
    assert '"type": "skip_cached"' in log


def test_heuristic_stops_when_nothing_is_worth_testing(world):
    choice = analyst.HeuristicAnalyst().choose(context(world, proposals=[]))
    assert choice.stop and choice.changes == []


# --- both levers get tested (the hours slot) ---------------------------------------------------


def expected(world, changes) -> float:
    files = rundata.RunFiles.load(world.run)
    return expected_city_gain(changes, files, settings.OBJECTIVE, store.load_map())


def lighting_of(world, store_id):
    return next(p for p in world.proposals if p.storeId == store_id and p.field == "lighting")


def test_every_experiment_carries_the_best_hours_change(world):
    s1_light, s3_light = lighting_of(world, "s1"), lighting_of(world, "s3")
    trim = make_suggestion("s4", "close", "22:00", "21:00", visits=-0.001, kwh=-0.004)
    weaker = make_suggestion("s2", "close", "23:00", "23:30", visits=0.0005, kwh=0.0001)
    proposals = [s1_light, s3_light, trim, weaker]
    # ranked by expected gain alone, a two-store experiment would be lighting cuts only
    assert expected(world, [s1_light]) > expected(world, [s3_light]) > expected(world, [trim])
    assert expected(world, [trim]) > expected(world, [weaker]) > 0

    choice = analyst.HeuristicAnalyst().choose(
        context(world, proposals=proposals, config=TrainingConfig(maxStoresPerIteration=2))
    )
    assert choice.changes == [s1_light, trim]  # the top store, then the best hours change
    assert choice.hypothesis.startswith("Lights off at Dawn Cafe")


@pytest.mark.parametrize(
    "config",
    [
        TrainingConfig(levers=Levers(hours=False, lighting=True), maxStoresPerIteration=2),
        TrainingConfig(maxStoresPerIteration=1),  # no room for both levers
    ],
)
def test_no_hours_slot_with_one_lever_or_one_store_per_experiment(world, config):
    s1_light, s3_light = lighting_of(world, "s1"), lighting_of(world, "s3")
    trim = make_suggestion("s4", "close", "22:00", "21:00", visits=-0.001, kwh=-0.004)
    ctx = context(world, proposals=[s1_light, s3_light, trim], config=config)
    by_store = {"s1": [s1_light], "s3": [s3_light], "s4": [trim]}
    assert analyst.hours_slot(ctx, rundata.RunFiles.load(world.run), by_store) == []
    choice = analyst.HeuristicAnalyst().choose(ctx)
    assert all(c.field == "lighting" for c in choice.changes)
    assert choice.changes[0] == s1_light


def test_no_hours_slot_without_lighting_proposals_or_a_positive_hours_change(world):
    files = rundata.RunFiles.load(world.run)
    trim = make_suggestion("s4", "close", "22:00", "21:00", visits=-0.001, kwh=-0.004)
    losing = make_suggestion("s4", "close", "22:00", "23:00", visits=0.0, kwh=0.2)
    assert expected(world, [losing]) < 0
    hours_only = context(world, proposals=[trim])
    assert analyst.hours_slot(hours_only, files, {"s4": [trim]}) == []
    no_gain = context(world, proposals=[lighting_of(world, "s1"), losing])
    by_store = {"s1": [lighting_of(world, "s1")], "s4": [losing]}
    assert analyst.hours_slot(no_gain, files, by_store) == []


def test_a_tried_hours_slot_hands_over_to_the_next_hours_idea(world):
    s1_light, s3_light = lighting_of(world, "s1"), lighting_of(world, "s3")
    trim = make_suggestion("s4", "close", "22:00", "21:00", visits=-0.001, kwh=-0.004)
    weaker = make_suggestion("s2", "close", "23:00", "23:30", visits=0.0005, kwh=0.0001)
    tried = rundata.load_config(world.run).stores["s4"].model_copy(update={"close": "21:00"})
    cache.run_record("simulated-before", 99, {"s4": tried})  # s4 closing at 21:00 alone ran
    ctx = context(
        world,
        proposals=[s1_light, s3_light, trim, weaker],
        config=TrainingConfig(maxStoresPerIteration=2),
    )
    choice = analyst.HeuristicAnalyst().choose(ctx)
    assert choice.changes == [s1_light, weaker]  # diversity holds with the next hours change


def test_the_hours_slot_keeps_a_lit_frontage_for_its_new_hours(world):
    s1_light, s3_light = lighting_of(world, "s1"), lighting_of(world, "s3")
    late = make_suggestion("s2", "close", "23:00", "23:30", visits=0.0008, kwh=0.0002)
    lit = make_suggestion("s2", "lighting", "low", "high", hours=[23], visits=0.0004, kwh=0.0002)
    elsewhere = make_suggestion("s4", "lighting", "low", "off", hours=[22, 23], visits=0, kwh=-0.01)
    proposals = [s1_light, s3_light, late, lit, elsewhere]
    files = rundata.RunFiles.load(world.run)
    by_store = {"s1": [s1_light], "s3": [s3_light], "s2": [late, lit], "s4": [elsewhere]}
    ctx = context(world, proposals=proposals, config=TrainingConfig(maxStoresPerIteration=2))
    assert analyst.hours_slot(ctx, files, by_store) == [late, lit]  # 23:00-00:00 is new for s2
    assert expected(world, [s1_light]) > expected(world, [late, lit]) > 0


def test_the_hours_slot_is_tested_alone_when_its_store_ranks_below_zero(world):
    close = make_suggestion("s2", "close", "23:00", "03:00", visits=0.3, kwh=0.05)
    costly_light = make_suggestion(
        "s2", "lighting", "low", "high", hours=[12, 13, 14, 15], visits=0.0, kwh=3.0
    )
    assert expected(world, [close, costly_light]) < 0 < expected(world, [close])
    choice = analyst.HeuristicAnalyst().choose(context(world, proposals=[close, costly_light]))
    assert choice.changes == [close] and not choice.stop


def test_get_kpis_reports_the_sessions_objective(world):
    ctx = context(world, objective="netValueGbp", config=TrainingConfig(objective="netValueGbp"))
    kpis = json.loads(analyst.AnalystTools(ctx).get_kpis(world.run).text)
    assert kpis["objective"] == "netValueGbp"
    assert kpis["objectiveValue"] == rundata.objective_value(world.run, "netValueGbp")
    assert kpis["objectiveValue"] != rundata.load_summary(world.run).objectiveValue


def test_analyst_tools_reject_changes_outside_the_session_scope(world):
    config = TrainingConfig(storeIds=["s2"], levers=Levers(hours=True, lighting=False))
    tools = analyst.AnalystTools(context(world, config=config))
    s1_light = {"storeId": "s1", "field": "lighting", "hours": [18], "from": "low", "to": "off"}
    report = json.loads(tools.propose_config([*S2_CHANGES, s1_light]).text)
    assert not report["ok"]
    assert [c["field"] for c in report["accepted"]] == ["close"]
    reasons = " | ".join(report["problems"])
    assert "lighting lever is off" in reasons and "s1 is frozen" not in reasons
    frozen = json.loads(
        tools.propose_config(
            [{"storeId": "s4", "field": "close", "hours": [], "from": "22:00", "to": "20:00"}]
        ).text
    )
    assert "s4 is frozen" in " ".join(frozen["problems"])


# --- notebook lines -------------------------------------------------------------------------


def _experiment(world, changes_json):
    ctx = context(world)
    tools = analyst.AnalystTools(ctx)
    changes = tools.to_suggestions(changes_json)
    configs = check_changes(ctx.base_configs, changes, ctx.map_data).configs
    run = world.sim.execute_run(configs, 42, parent_run=world.run)
    return IterationOutcome(
        run=run, parent_run=world.run, applied=changes, objective_value=0.0, gain=0.1, is_best=True
    )


def test_notebook_line_is_measured_and_short(world):
    outcome = _experiment(world, S2_CHANGES)
    line = analyst.measured_notebook_line(outcome, store.load_map())
    assert line.startswith("Opened Kebab Co till 03:00 → +") and line.endswith("night visits")
    assert len(line.split()) <= 12


def test_notebook_line_reports_energy_for_cuts(world):
    trim = [{"storeId": "s4", "field": "close", "hours": [], "from": "22:00", "to": "20:00"}]
    line = analyst.measured_notebook_line(_experiment(world, trim), store.load_map())
    assert line.startswith("Closed Corner Shop at 20:00 → -") and line.endswith("kWh")


def test_baseline_notebook_line():
    summary = SimpleNamespace(kpis=SimpleNamespace(visits=18230, visitsPerKwh=2.0))
    assert analyst.baseline_notebook_line(summary) == "Baseline: 18230 visits, 2.00 visits/kWh"


# --- messages: scripted Messages API client --------------------------------------------------


def _usage():
    return SimpleNamespace(
        input_tokens=3000,
        output_tokens=400,
        cache_read_input_tokens=5000,
        cache_creation_input_tokens=0,
    )


def tool_use(tool_id, name, tool_input):
    return SimpleNamespace(type="tool_use", id=tool_id, name=name, input=tool_input)


def text(value):
    return SimpleNamespace(type="text", text=value)


def response(*blocks, stop_reason="tool_use"):
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason, usage=_usage())


class ScriptedMessages:
    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return self.responses.pop(0)


@pytest.fixture
def messages_client(monkeypatch):
    def install(responses):
        scripted = ScriptedMessages(responses)
        client = SimpleNamespace(beta=SimpleNamespace(messages=scripted))
        monkeypatch.setattr(llm, "client", lambda: client)
        return scripted

    return install


def test_messages_analyst_runs_a_budgeted_tool_loop(world, messages_client, monkeypatch):
    budget_checks = []
    real_check = llm.check_budget
    monkeypatch.setattr(
        llm,
        "check_budget",
        lambda session=None: budget_checks.append(session) or real_check(session),
    )
    bad = [{"storeId": "s2", "field": "close", "hours": [], "from": "23:00", "to": "05:00"}]
    scripted = messages_client(
        [
            response(
                tool_use("t1", "get_kpis", {"run": world.run}),
                tool_use("t2", "get_store_stats", {"run": world.run, "storeId": "s2"}),
            ),
            response(tool_use("t3", "run_sim", {"changes": bad, "hypothesis": "till 5am"})),
            response(tool_use("t4", "propose_config", {"changes": S2_CHANGES})),
            response(
                tool_use("t5", "run_sim", {"changes": S2_CHANGES, "hypothesis": "Spill-out pays"})
            ),
        ]
    )
    choice = analyst.MessagesAnalyst().choose(context(world))

    assert [change_label(c) for c in choice.changes] == [
        "Close 23:00 → 03:00",
        "Light 00–03: off → low",
    ]
    assert choice.hypothesis == "Spill-out pays"
    assert choice.changes[0].expectedDelta.visits > 0.2  # the store agent's estimate carried over
    assert len(scripted.calls) == 4 and budget_checks == ["sess"] * 4

    first = scripted.calls[0]
    assert first["model"] == settings.ANALYST_MODEL
    assert first["thinking"] == {"type": "adaptive"}
    assert first["output_config"] == {"effort": "high"}
    assert first["cache_control"] == {"type": "ephemeral"}
    system = prompts.analyst_system(TrainingConfig())
    assert first["system"] == [
        {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
    ]
    assert first["tools"] == MESSAGES_TOOLS and all(t["strict"] for t in first["tools"])
    assert first["betas"] == [llm.FALLBACK_BETA] and first["fallbacks"] == "default"

    second_turn = scripted.calls[1]["messages"]
    results = second_turn[-1]["content"]
    assert [r["tool_use_id"] for r in results] == ["t1", "t2"]  # parallel results, one message
    assert json.loads(results[0]["content"])["run"] == world.run
    third_turn = scripted.calls[2]["messages"][-1]["content"][0]
    assert third_turn["is_error"] is True and "licensed hours" in third_turn["content"]

    ledger = llm.load_ledger()
    assert len(ledger) == 4 and {r["agent"] for r in ledger} == {"analyst"}
    log = [
        json.loads(line) for line in (settings.RUNS_DIR / str(world.run) / "llm_log.jsonl").open()
    ]
    assert [e["tool"] for e in log if e["type"] == "tool_call"] == [
        "get_kpis",
        "get_store_stats",
        "run_sim",
        "propose_config",
        "run_sim",
    ]
    assert any(e["type"] == "rule_rejection" and e["agent"] == "analyst" for e in log)


def test_messages_analyst_can_decide_to_stop(world, messages_client):
    messages_client([response(text("Nothing left beats 2%. STOP"), stop_reason="end_turn")])
    choice = analyst.MessagesAnalyst().choose(context(world))
    assert choice.stop and choice.changes == []


def test_messages_analyst_falls_back_to_heuristic_when_it_never_commits(world, messages_client):
    scripted = messages_client(
        [
            response(text("Thinking about it."), stop_reason="end_turn"),
            response(text("Still thinking."), stop_reason="end_turn"),
        ]
    )
    choice = analyst.MessagesAnalyst().choose(context(world))
    assert choice.changes == analyst.HeuristicAnalyst().choose(context(world)).changes
    assert scripted.calls[1]["messages"][-1] == {"role": "user", "content": analyst.NUDGE}
    log = (settings.RUNS_DIR / str(world.run) / "llm_log.jsonl").read_text()
    assert '"type": "fallback"' in log


def test_messages_analyst_stops_at_the_budget_before_calling(world, messages_client, monkeypatch):
    scripted = messages_client([response(tool_use("t1", "get_kpis", {"run": world.run}))] * 3)
    calls = {"n": 0}

    def check(session=None):
        calls["n"] += 1
        if calls["n"] == 2:
            raise llm.BudgetExceeded("session budget reached")

    monkeypatch.setattr(llm, "check_budget", check)
    with pytest.raises(llm.BudgetExceeded):
        analyst.MessagesAnalyst().choose(context(world))
    assert len(scripted.calls) == 1


# --- managed: scripted Managed Agents client --------------------------------------------------


def ev(kind, event_id, **fields):
    return SimpleNamespace(type=kind, id=event_id, **fields)


def idle(event_id, reason):
    return ev("session.status_idle", event_id, stop_reason=SimpleNamespace(type=reason))


class FakeSessions:
    def __init__(self, scripts: list[list]) -> None:
        self.scripts = list(scripts)  # one list of events per stream connection
        self.history: list = []
        self.sent: list[dict] = []
        self.sent_to: list[str] = []  # the session id of each event in `sent`
        self.created: list[dict] = []
        self.events = SimpleNamespace(stream=self._stream, send=self._send, list=self._list)

    def create(self, **kwargs):
        self.created.append(kwargs)
        return SimpleNamespace(id=f"sesn_{len(self.created)}")

    @contextmanager
    def _stream(self, session_id):
        events = self.scripts.pop(0) if self.scripts else []

        def generate():
            for event in events:
                self.history.append(event)
                yield event

        yield generate()

    def _send(self, session_id, *, events):
        for event in events:
            self.sent.append(event)
            self.sent_to.append(session_id)
            if event["type"] == "user.custom_tool_result":
                self.history.append(
                    ev(
                        "user.custom_tool_result",
                        f"echo_{len(self.sent)}",
                        custom_tool_use_id=event["custom_tool_use_id"],
                    )
                )

    def _list(self, session_id, order="asc"):
        return list(self.history)


class FakeManagedClient:
    def __init__(self, scripts: list[list]) -> None:
        self.counts = {"agents": 0, "environments": 0, "memory_stores": 0}
        self.memory_updates: list[dict] = []
        self.sessions = FakeSessions(scripts)
        memories = SimpleNamespace(
            create=lambda store_id, path, content: SimpleNamespace(id="mem_1"),
            update=lambda memory_id, **kw: self.memory_updates.append({"id": memory_id, **kw}),
        )
        self.beta = SimpleNamespace(
            agents=SimpleNamespace(create=self._make("agents", "agent_1", version=3)),
            environments=SimpleNamespace(create=self._make("environments", "env_1")),
            memory_stores=SimpleNamespace(
                create=self._make("memory_stores", "memstore_1"), memories=memories
            ),
            sessions=self.sessions,
        )
        self.agent_kwargs: dict = {}

    def _make(self, kind, object_id, **extra):
        def create(**kwargs):
            self.counts[kind] += 1
            if kind == "agents":
                self.agent_kwargs = kwargs
            return SimpleNamespace(id=object_id, **extra)

        return create


def model_usage():
    return SimpleNamespace(
        input_tokens=2000,
        output_tokens=300,
        cache_read_input_tokens=1000,
        cache_creation_input_tokens=0,
    )


@pytest.fixture
def managed_client(monkeypatch):
    def install(scripts):
        client = FakeManagedClient(scripts)
        monkeypatch.setattr(llm, "client", lambda: client)
        return client

    return install


def test_managed_analyst_runs_a_budgeted_outcome_session(world, managed_client):
    client = managed_client(
        [
            [
                ev("span.model_request_end", "e0", model_usage=model_usage()),
                ev("agent.custom_tool_use", "e1", name="get_kpis", input={"run": world.run}),
                ev(
                    "agent.tool_use",
                    "e2",
                    name="bash",
                    input={"command": "ls"},
                    evaluated_permission="ask",
                ),
                ev(
                    "agent.custom_tool_use",
                    "e3",
                    name="run_sim",
                    input={"changes": S2_CHANGES, "hypothesis": "Spill-out pays"},
                ),
                idle("e4", "requires_action"),
            ],
            [
                ev(
                    "span.outcome_evaluation_end",
                    "e5",
                    result="satisfied",
                    explanation="Plateau reached",
                    usage=model_usage(),
                ),
                idle("e6", "end_turn"),
            ],
        ]
    )
    ctx = context(world)
    choice = analyst.ManagedAnalyst().choose(ctx)

    assert [change_label(c) for c in choice.changes] == [
        "Close 23:00 → 03:00",
        "Light 00–03: off → low",
    ]
    assert client.counts == {"agents": 1, "environments": 1, "memory_stores": 1}
    tools = client.agent_kwargs["tools"]
    assert tools[0]["type"] == "agent_toolset_20260401"
    assert {t["name"] for t in tools[1:]} == {
        "get_kpis",
        "get_store_stats",
        "propose_config",
        "run_sim",
    }
    created = client.sessions.created[0]
    assert created["agent"] == {"type": "agent", "id": "agent_1", "version": 3}
    assert created["budget"] == {
        "type": "limit",
        "max_list_cost": {"amount": "1500", "currency": "USD"},
    }
    assert created["resources"][0]["type"] == "memory_store"
    sent = client.sessions.sent
    assert [e["type"] for e in sent[:2]] == ["user.message", "user.define_outcome"]
    assert sent[1]["rubric"]["type"] == "text"
    result = next(e for e in sent if e["type"] == "user.custom_tool_result")
    assert (
        result["custom_tool_use_id"] == "e1"
        and json.loads(result["content"][0]["text"])["run"] == world.run
    )
    deny = next(e for e in sent if e["type"] == "user.tool_confirmation")
    assert deny == {
        "type": "user.tool_confirmation",
        "tool_use_id": "e2",
        "result": "deny",
        "deny_message": "Unattended run: this tool call needs a human.",
    }
    state = store.read_json(analyst.managed_state_path())
    assert state["sessions"]["sess"]["pendingRunSim"] == "e3"
    assert [r["agent"] for r in llm.load_ledger()] == ["analyst"]

    # A new process (restart) reuses the agent, environment, store and session, answers the
    # pending run_sim with the measured result, and stops when the outcome is satisfied.
    outcome = IterationOutcome(
        run=world.run,
        parent_run=world.run,
        applied=choice.changes,
        objective_value=1.2,
        gain=0.05,
        is_best=True,
    )
    second = analyst.ManagedAnalyst().choose(context(world, last_outcome=outcome))
    assert second.stop and second.hypothesis == "Plateau reached"
    assert client.counts == {"agents": 1, "environments": 1, "memory_stores": 1}
    assert len(client.sessions.created) == 1
    answer = [e for e in client.sessions.sent if e.get("custom_tool_use_id") == "e3"]
    assert len(answer) == 1 and '"measured"' in answer[0]["content"][0]["text"]
    assert (
        store.read_json(analyst.managed_state_path())["sessions"]["sess"]["pendingRunSim"] is None
    )
    agents = [r["agent"] for r in llm.load_ledger()]
    assert agents.count("analyst") == 1 and agents.count("analyst-grader") == 1  # no double count


def test_managed_analyst_prompts_an_idle_agent_after_a_fallback(world, managed_client):
    client = managed_client(
        [
            [idle("e1", "end_turn"), idle("e2", "end_turn")],
            [
                ev(
                    "agent.custom_tool_use",
                    "e3",
                    name="run_sim",
                    input={"changes": S2_CHANGES, "hypothesis": "Spill-out pays"},
                )
            ],
        ]
    )
    first = analyst.ManagedAnalyst().choose(context(world))
    assert first.changes == analyst.HeuristicAnalyst().choose(context(world)).changes
    nudges = [e for e in client.sessions.sent if e["type"] == "user.message"]
    assert len(nudges) == 2 and nudges[1]["content"][0]["text"] == analyst.NUDGE

    second = analyst.ManagedAnalyst().choose(context(world))
    assert change_label(second.changes[0]) == "Close 23:00 → 03:00"
    report_back = [e for e in client.sessions.sent if e["type"] == "user.message"][-1]
    assert '"measured"' in report_back["content"][0]["text"]  # a message, not a stuck stream


def test_managed_analyst_raises_at_the_session_budget(world, managed_client):
    managed_client([[idle("e1", "budget_reached")]])
    with pytest.raises(llm.BudgetExceeded):
        analyst.ManagedAnalyst().choose(context(world))


def test_managed_agent_follows_the_session_config_and_budget(world, managed_client):
    client = managed_client([[idle("e1", "budget_reached")]])
    backend = analyst.ManagedAnalyst()
    backend.ensure_resources(TrainingConfig())
    backend.ensure_resources(TrainingConfig())
    assert client.counts["agents"] == 1  # same prompt: the stored agent is reused
    narrow = TrainingConfig(maxStoresPerIteration=2, levers=Levers(hours=True, lighting=False))
    backend.ensure_resources(narrow)
    assert client.counts["agents"] == 2  # its limits are in the prompt: a new agent
    assert client.agent_kwargs["system"] == prompts.analyst_system_managed(narrow)

    llm.set_session_budget("sess-narrow", 3.0)
    with pytest.raises(llm.BudgetExceeded):  # the scripted session idles at its budget
        analyst.ManagedAnalyst().choose(context(world, session="sess-narrow", config=narrow))
    created = client.sessions.created[-1]
    assert created["budget"]["max_list_cost"] == {"amount": "300", "currency": "USD"}
    outcome = next(e for e in client.sessions.sent if e["type"] == "user.define_outcome")
    assert "2 consecutive experiments gain less than 2%" in outcome["description"]
    assert "No experiment changed more than 2 stores" in outcome["rubric"]["content"]


def test_managed_session_is_renewed_when_its_budget_or_config_changes(world, managed_client):
    run_sim = ev(
        "agent.custom_tool_use",
        "e1",
        name="run_sim",
        input={"changes": S2_CHANGES, "hypothesis": "Spill-out pays"},
    )
    client = managed_client([[run_sim], [], []])
    analyst.ManagedAnalyst().choose(context(world))
    assert len(client.sessions.created) == 1

    llm.set_session_budget("sess", 20.0)  # e.g. resumed after a budget stop with a higher cap
    with pytest.raises(llm.LLMError):  # the scripted stream ends; only the session matters here
        analyst.ManagedAnalyst().choose(context(world))
    assert len(client.sessions.created) == 2
    assert client.sessions.created[1]["budget"]["max_list_cost"]["amount"] == "2000"
    entry = store.read_json(analyst.managed_state_path())["sessions"]["sess"]
    assert entry["budgetCapUsd"] == 20.0 and not entry["pendingRunSim"]
    interrupts = [
        to
        for to, e in zip(client.sessions.sent_to, client.sessions.sent, strict=True)
        if e["type"] == "user.interrupt"
    ]
    assert interrupts == ["sesn_1"]  # the superseded session (and its open run_sim) is closed

    with pytest.raises(llm.LLMError):  # a new rubric needs a new session too
        analyst.ManagedAnalyst().choose(context(world, config=TrainingConfig(threshold=0.01)))
    assert len(client.sessions.created) == 3
    log = (settings.RUNS_DIR / str(world.run) / "llm_log.jsonl").read_text()
    assert log.count('"type": "managed_session_renewed"') == 2


def test_analyst_prompts_name_the_session_limits():
    narrow = TrainingConfig(
        objective="netValueGbp",
        threshold=0.002,
        patience=3,
        maxRuns=8,
        maxStoresPerIteration=2,
        maxChangesPerStore=1,
        levers=Levers(hours=True, lighting=False),
        storeIds=["s1", "s13"],
    )
    system = prompts.analyst_system(narrow)
    assert "raise the area's netValueGbp" in system and "net value in GBP a week" in system
    assert "below 0.2% for\n3 runs in a row, after 8 runs" in system
    assert "changes opening hours only, for only s1, s13 (every other store is frozen)" in system
    assert "Test at most 2 stores per experiment, at most\n  1 changes each" in system
    assert "Put the best hours change in every experiment" not in system  # one lever only
    both = prompts.analyst_system(TrainingConfig(maxStoresPerIteration=2))
    assert "Put the best hours change in every experiment" in both
    assert "below 2% for\n2 runs in a row, after 10 runs" in both


def test_managed_notebook_line_syncs_the_memory_store(world, managed_client):
    client = managed_client([])
    backend = analyst.ManagedAnalyst()
    backend.ensure_resources()
    line = backend.notebook_line(_experiment(world, S2_CHANGES))
    (update,) = client.memory_updates
    assert update["id"] == "mem_1" and update["memory_store_id"] == "memstore_1"
    assert line in update["content"] and update["content"].startswith(analyst.NOTEBOOK_HEADER)


# --- backend selection ----------------------------------------------------------------------


def test_select_backend_degrades_to_heuristic_offline(world, monkeypatch):
    assert isinstance(analyst.select_backend("auto"), analyst.HeuristicAnalyst)
    assert isinstance(analyst.select_backend("managed"), analyst.HeuristicAnalyst)
    monkeypatch.setattr(llm, "available", lambda: True)
    assert isinstance(analyst.select_backend("auto"), analyst.MessagesAnalyst)
    assert isinstance(analyst.select_backend("managed"), analyst.ManagedAnalyst)
    with pytest.raises(ValueError):
        analyst.select_backend("random")
