"""The analyst: chooses which store proposals to test each iteration and writes the lab notebook.

training.py owns the loop; the analyst only decides. Every backend implements AnalystBackend:

  heuristic  deterministic (offline): rank stores by the expected area gain of their proposals,
             test the top settings.MAX_STORES_PER_ITERATION, skip configs already simulated
  messages   settings.ANALYST_MODEL in a Messages API tool-use loop (manual loop so every call is
             budget-checked, ledgered and logged): get_kpis, get_store_stats, propose_config,
             run_sim. Adaptive thinking, effort high, prompt caching on tools + system.
  managed    a Managed Agents session with the same custom tools, a memory store as the lab
             notebook, an outcome (rubric) as the stop criterion and a session budget as the
             spend cap. Written from the claude-api skill docs and the installed SDK's types; it
             has never run against the live API here (no key).

select_backend() picks one from settings.ANALYST_BACKEND ("auto" = messages when Claude
credentials exist, else heuristic). LLM backends fall back to the heuristic for an iteration when
the model does not commit to an experiment (logged).
"""

from __future__ import annotations

import re
from dataclasses import asdict
from typing import Protocol

import anthropic

from backend import cache, llm, settings, store
from backend.agents import prompts
from backend.agents.analyst_tools import MANAGED_TOOLS, MESSAGES_TOOLS, AnalystTools, ToolResult
from backend.agents.changes import affected_hours
from backend.agents.experiment import (
    AnalystContext,
    Choice,
    IterationOutcome,
    expected_city_gain,
    iteration_brief,
)
from backend.agents.objective import fraction
from backend.agents.rules import check_changes
from backend.agents.rundata import RunFiles, store_names
from backend.agents.wording import (
    LEVEL_RANK,
    NIGHT_HOURS,
    change_phrase,
    clamp_words,
    lengthens,
    signed_pct,
)
from backend.contract import MapData, Suggestion
from backend.schemas import RunSummary

AGENT = "analyst"
NOTEBOOK_WORDS = 12
HYPOTHESIS_WORDS = 20


class AnalystBackend(Protocol):
    name: str

    def choose(self, ctx: AnalystContext) -> Choice:
        """Pick this iteration's changes (rule-valid on ctx.base_configs) and a hypothesis."""
        ...

    def notebook_line(self, outcome: IterationOutcome) -> str:
        """One lab-notebook line (<= 12 words) from the measured result of a run."""
        ...

    def close(self, reason: str) -> None:
        """Training stopped; release anything the backend holds open."""
        ...


# --- notebook lines (measured, shared by every backend) --------------------------------------


def baseline_notebook_line(summary: RunSummary) -> str:
    kpis = summary.kpis
    return clamp_words(
        f"Baseline: {kpis.visits} visits, {kpis.visitsPerKwh:.2f} visits/kWh", NOTEBOOK_WORDS
    )


def _measured_effect(change: Suggestion, sid: str, parent: RunFiles, child: RunFiles) -> str:
    before, after = parent.stores[sid], child.stores[sid]
    config = parent.config.stores[sid]
    if change.field == "lighting":
        adds = LEVEL_RANK[change.to] > LEVEL_RANK.get(change.from_, 0)
    else:
        adds = lengthens(change, config)
    if not adds:
        return f"{signed_pct(fraction(after.kpis.kwh - before.kpis.kwh, before.kpis.kwh))} kWh"
    hours = affected_hours(change, config)
    if hours and sum(h in NIGHT_HOURS for h in hours) * 2 >= len(hours):
        night_before = sum(before.visitsByHour[h] for h in NIGHT_HOURS)
        night_after = sum(after.visitsByHour[h] for h in NIGHT_HOURS)
        if night_before > 0:
            return f"{signed_pct(fraction(night_after - night_before, night_before))} night visits"
        return f"{night_after - night_before:+.0f} night visits/day"
    return (
        f"{signed_pct(fraction(after.kpis.visits - before.kpis.visits, before.kpis.visits))} visits"
    )


def measured_notebook_line(outcome: IterationOutcome, map_data: MapData) -> str:
    """E.g. "Opened Kebab Co till 03:00 +2 more → +18% night visits" (<= 12 words).

    The effect is measured on the lead store (the one that moved most); a run that did not beat
    the best run says so ("(not kept)"), since its changes are not carried forward.
    """
    if not outcome.applied:
        return "No changes applied"
    parent, child = RunFiles.load(outcome.parent_run), RunFiles.load(outcome.run)
    names = store_names(map_data)
    by_store: dict[str, list[Suggestion]] = {}
    for change in outcome.applied:
        by_store.setdefault(change.storeId, []).append(change)

    def size(sid: str) -> float:
        a, b = parent.stores[sid].kpis, child.stores[sid].kpis
        return max(
            abs(fraction(b.visits - a.visits, a.visits)), abs(fraction(b.kwh - a.kwh, a.kwh))
        )

    lead_store = max(sorted(by_store), key=size)
    changes = by_store[lead_store]
    lead = next((c for c in changes if c.field != "lighting"), changes[0])
    phrase = change_phrase(
        lead, names.get(lead_store, lead_store), parent.config.stores[lead_store]
    )
    more = f" +{len(by_store) - 1} more" if len(by_store) > 1 else ""
    effect = _measured_effect(lead, lead_store, parent, child)
    kept = "" if outcome.is_best else " (not kept)"
    line = f"{phrase}{more} → {effect}{kept}"
    if len(line.split()) > NOTEBOOK_WORDS:
        line = f"{phrase} → {effect}{kept}"
    return clamp_words(line, NOTEBOOK_WORDS)


def _hypothesis(changes: list[Suggestion], ctx: AnalystContext, gain: float) -> str:
    names = store_names(ctx.map_data)
    lead = changes[0]
    phrase = change_phrase(
        lead, names.get(lead.storeId, lead.storeId), ctx.base_configs[lead.storeId]
    )
    stores = {c.storeId for c in changes}
    more = f" (+{len(stores) - 1} more stores)" if len(stores) > 1 else ""
    return clamp_words(
        f"{phrase}{more} should lift {ctx.objective} by about {gain * 100:+.1f}%", HYPOTHESIS_WORDS
    )


# --- heuristic ------------------------------------------------------------------------------


def _selections(ranked: list[str], cap: int):
    """Store sets to try, best first: sliding windows of the ranking, then single stores."""
    seen: set[tuple[str, ...]] = set()
    for start in range(len(ranked)):
        window = tuple(ranked[start : start + cap])
        if window not in seen:
            seen.add(window)
            yield list(window)
    for sid in ranked:
        if (sid,) not in seen:
            seen.add((sid,))
            yield [sid]


class HeuristicAnalyst:
    """Deterministic analyst: biggest expected area gain first, never a simulated config."""

    name = "heuristic"

    def choose(self, ctx: AnalystContext) -> Choice:
        files = RunFiles.load(ctx.best_run)
        by_store: dict[str, list[Suggestion]] = {}
        for proposal in ctx.proposals:
            by_store.setdefault(proposal.storeId, []).append(proposal)
        gains = {
            sid: expected_city_gain(changes, files, ctx.objective, ctx.map_data)
            for sid, changes in by_store.items()
        }
        ranked = sorted((sid for sid in by_store if gains[sid] > 0), key=lambda s: (-gains[s], s))
        for selection in _selections(ranked, settings.MAX_STORES_PER_ITERATION):
            changes = [c for sid in selection for c in by_store[sid]]
            result = check_changes(ctx.base_configs, changes, ctx.map_data)
            if result.rejections:
                continue
            cached = cache.run_lookup(cache.run_key(result.configs, ctx.seed))
            if cached is not None:
                llm.log_event(
                    ctx.best_run,
                    {"agent": AGENT, "type": "skip_cached", "stores": selection, "run": cached},
                )
                continue
            gain = expected_city_gain(result.accepted, files, ctx.objective, ctx.map_data)
            return Choice(result.accepted, _hypothesis(result.accepted, ctx, gain), gain)
        return Choice([], "No untried proposal with a positive expected gain", stop=True)

    def notebook_line(self, outcome: IterationOutcome) -> str:
        return measured_notebook_line(outcome, store.load_map())

    def close(self, reason: str) -> None:
        return None


# --- messages (Messages API tool-use loop) ---------------------------------------------------


def _block_dict(block) -> dict:
    if hasattr(block, "model_dump"):
        return block.model_dump(mode="json", exclude_none=True)
    return {k: v for k, v in vars(block).items() if not k.startswith("_")}


NUDGE = (
    "Finish this iteration: call run_sim with your chosen changes and a one-line hypothesis, or "
    "reply STOP if no experiment is worth running."
)


class MessagesAnalyst:
    """Claude (settings.ANALYST_MODEL) chooses each experiment in a short tool-use conversation.

    One fresh conversation per iteration, seeded with the notebook and the measured result of the
    last run, so a restart loses nothing. The conversation ends at the first accepted run_sim.
    """

    name = "messages"
    MAX_TURNS = 12
    MAX_TOKENS = 16000

    def _request(self, system: list[dict], messages: list[dict]) -> dict:
        return {
            "model": settings.ANALYST_MODEL,
            "max_tokens": self.MAX_TOKENS,
            "system": system,
            "tools": MESSAGES_TOOLS,
            "messages": messages,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": "high"},
            "cache_control": {"type": "ephemeral"},
        }

    def choose(self, ctx: AnalystContext) -> Choice:
        client = llm.client()
        tools = AnalystTools(ctx)
        system = llm.system_blocks(prompts.ANALYST_SYSTEM)
        brief = iteration_brief(ctx, RunFiles.load(ctx.best_run))
        messages: list[dict] = [
            {"role": "user", "content": prompts.analyst_iteration_prompt(brief)}
        ]
        llm.log_event(
            ctx.best_run,
            {"agent": AGENT, "type": "request", **self._request(system, messages)},
        )
        nudged = False
        for turn in range(self.MAX_TURNS):
            llm.check_budget(ctx.session)
            response = client.beta.messages.create(
                **self._request(system, messages), betas=[llm.FALLBACK_BETA], fallbacks="default"
            )
            usage = llm.Usage.from_api(response.usage)
            llm.record_usage(
                AGENT, settings.ANALYST_MODEL, usage, run=ctx.best_run, session=ctx.session
            )
            llm.log_event(
                ctx.best_run,
                {
                    "agent": AGENT,
                    "type": "response",
                    "turn": turn,
                    "stopReason": response.stop_reason,
                    "requestId": getattr(response, "_request_id", None),
                    "content": [_block_dict(b) for b in response.content],
                    "usage": asdict(usage),
                },
            )
            if response.stop_reason in ("refusal", "max_tokens"):
                return self._fallback(ctx, f"stop_reason={response.stop_reason}")
            messages.append({"role": "assistant", "content": response.content})
            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if not tool_uses:
                text = " ".join(b.text for b in response.content if b.type == "text")
                if re.search(r"\bSTOP\b", text):
                    return Choice([], clamp_words(text, HYPOTHESIS_WORDS) or "STOP", stop=True)
                if nudged:
                    return self._fallback(ctx, "model ended without run_sim")
                nudged = True
                messages.append({"role": "user", "content": NUDGE})
                llm.log_event(ctx.best_run, {"agent": AGENT, "type": "nudge", "text": NUDGE})
                continue
            results, committed = self._run_tools(ctx, tools, tool_uses)
            if committed is not None:
                return committed
            messages.append({"role": "user", "content": results})
        return self._fallback(ctx, f"no experiment after {self.MAX_TURNS} turns")

    def _run_tools(
        self, ctx: AnalystContext, tools: AnalystTools, tool_uses: list
    ) -> tuple[list[dict], Choice | None]:
        results: list[dict] = []
        committed: Choice | None = None
        for tool_use in tool_uses:
            result: ToolResult = tools.dispatch(tool_use.name, dict(tool_use.input))
            llm.log_event(
                ctx.best_run,
                {
                    "agent": AGENT,
                    "type": "tool_call",
                    "tool": tool_use.name,
                    "input": dict(tool_use.input),
                    "result": result.text,
                    "isError": result.is_error,
                },
            )
            block: dict = {
                "type": "tool_result",
                "tool_use_id": tool_use.id,
                "content": result.text,
            }
            if result.is_error:
                block["is_error"] = True
            results.append(block)
            if result.committed is not None and committed is None:
                committed = result.committed
        return results, committed

    def _fallback(self, ctx: AnalystContext, reason: str) -> Choice:
        llm.log_event(
            ctx.best_run, {"agent": AGENT, "type": "fallback", "to": "heuristic", "reason": reason}
        )
        return HeuristicAnalyst().choose(ctx)

    def notebook_line(self, outcome: IterationOutcome) -> str:
        return measured_notebook_line(outcome, store.load_map())

    def close(self, reason: str) -> None:
        return None


# --- managed (Managed Agents session) ---------------------------------------------------------

MANAGED_AGENT_NAME = "Smart City Sim analyst"
MANAGED_ENV_NAME = "smart-city-sim-analyst"
NOTEBOOK_STORE_NAME = "lab-notebook"
NOTEBOOK_PATH = "/runs.md"
NOTEBOOK_HEADER = "# Lab notebook: one measured line per run\n"
NOTEBOOK_INSTRUCTIONS = (
    "Lab notebook. runs.md has one measured line per run, written by the training loop: read it "
    "before choosing an experiment and never edit it. Keep your own notes in other files."
)
TERMINAL_OUTCOMES = frozenset({"satisfied", "failed", "max_iterations_reached", "interrupted"})

# Built-in tools for the agent's container: file tools reach the mounted notebook; web is off.
AGENT_TOOLSET = {
    "type": "agent_toolset_20260401",
    "default_config": {"enabled": True, "permission_policy": {"type": "auto"}},
    "configs": [
        {"name": "web_fetch", "enabled": False},
        {"name": "web_search", "enabled": False},
    ],
}


def managed_state_path():
    return settings.RUNS_DIR / "managed_analyst.json"


def _after(history: list, last_event_id: str | None) -> list:
    """Events after the last one processed (all of them when nothing was processed yet)."""
    if last_event_id is None:
        return history
    ids = [getattr(e, "id", None) for e in history]
    return history[ids.index(last_event_id) + 1 :] if last_event_id in ids else history


class ManagedAnalyst:
    """The analyst as a Managed Agents session that spans the whole training session.

    The agent drives: it reads the brief, calls the custom tools (answered here), and commits each
    experiment with run_sim. choose() returns at that point, leaving the run_sim call pending; the
    training loop runs the experiment, and the next choose() answers the pending call with the
    measured result plus the new proposals. The outcome grader decides when the agent is done
    (rubric = the training stop rule); the session budget caps its spend.

    Agent, environment and memory store are created once and their ids persisted in
    runs/managed_analyst.json, with one Managed Agents session per training session.
    """

    name = "managed"
    MAX_NUDGES = 1

    def __init__(self) -> None:
        self._client = None
        self._seen: set[str] = set()
        self._nudges = 0
        self._current_session: str | None = None

    @property
    def client(self):
        if self._client is None:
            self._client = llm.client()
        return self._client

    def _load(self) -> dict:
        return store.read_json(managed_state_path(), {})

    def _save(self, state: dict) -> None:
        store.write_json(managed_state_path(), state)

    def ensure_resources(self) -> dict:
        """Create the agent, its environment and the notebook memory store once; reuse the ids."""
        state = self._load()
        changed = False
        if not state.get("agentId"):
            agent = self.client.beta.agents.create(
                name=MANAGED_AGENT_NAME,
                model={"id": settings.ANALYST_MODEL, "effort": "high"},
                system=prompts.ANALYST_SYSTEM_MANAGED,
                tools=[AGENT_TOOLSET, *MANAGED_TOOLS],
                description="Chooses sim experiments for Shoreditch store owners.",
            )
            state.update(agentId=agent.id, agentVersion=agent.version)
            changed = True
        if not state.get("environmentId"):
            environment = self.client.beta.environments.create(
                name=MANAGED_ENV_NAME,
                config={
                    "type": "cloud",
                    "networking": {
                        "type": "limited",
                        "allow_package_managers": False,
                        "allow_mcp_servers": False,
                    },
                },
            )
            state["environmentId"] = environment.id
            changed = True
        if not state.get("memoryStoreId"):
            memory_store = self.client.beta.memory_stores.create(
                name=NOTEBOOK_STORE_NAME,
                description="Smart City Sim lab notebook: one measured line per experiment run.",
            )
            memory = self.client.beta.memory_stores.memories.create(
                memory_store.id, path=NOTEBOOK_PATH, content=NOTEBOOK_HEADER
            )
            state.update(memoryStoreId=memory_store.id, notebookMemoryId=memory.id)
            changed = True
        if changed:
            self._save(state)
            llm.log_event(None, {"agent": AGENT, "type": "managed_resources", **state})
        return state

    def _session_entry(self, ctx: AnalystContext, state: dict) -> dict:
        sessions = state.setdefault("sessions", {})
        if ctx.session in sessions:
            return sessions[ctx.session]
        remaining_usd = max(0.01, settings.SESSION_BUDGET_USD - llm.spent_usd(session=ctx.session))
        session = self.client.beta.sessions.create(
            agent={"type": "agent", "id": state["agentId"], "version": state["agentVersion"]},
            environment_id=state["environmentId"],
            title=f"Smart City Sim analyst {ctx.session}",
            resources=[
                {
                    "type": "memory_store",
                    "memory_store_id": state["memoryStoreId"],
                    "access": "read_write",
                    "instructions": NOTEBOOK_INSTRUCTIONS,
                }
            ],
            budget={
                "type": "limit",
                "max_list_cost": {
                    "amount": str(max(1, int(remaining_usd * 100))),
                    "currency": "USD",
                },
            },
            metadata={"trainingSession": ctx.session},
        )
        entry = {"sessionId": session.id, "started": False, "pendingRunSim": None}
        sessions[ctx.session] = entry
        self._save(state)
        llm.log_event(
            ctx.best_run,
            {
                "agent": AGENT,
                "type": "managed_session",
                "sessionId": session.id,
                "budgetUsd": round(remaining_usd, 2),
                "trace": f"https://platform.claude.com/workspaces/default/sessions/{session.id}",
            },
        )
        return entry

    def _send(self, ctx: AnalystContext, session_id: str, events: list[dict]) -> None:
        llm.log_event(ctx.best_run, {"agent": AGENT, "type": "managed_send", "events": events})
        self.client.beta.sessions.events.send(session_id, events=events)

    def _tool_result(self, ctx: AnalystContext, session_id: str, tool_use_id: str, result) -> None:
        self._send(
            ctx,
            session_id,
            [
                {
                    "type": "user.custom_tool_result",
                    "custom_tool_use_id": tool_use_id,
                    "content": [{"type": "text", "text": result.text}],
                    "is_error": result.is_error,
                }
            ],
        )

    def choose(self, ctx: AnalystContext) -> Choice:
        llm.check_budget(ctx.session)
        state = self.ensure_resources()
        entry = self._session_entry(ctx, state)
        session_id = entry["sessionId"]
        self._current_session = session_id
        self._nudges = 0
        tools = AnalystTools(ctx)
        brief = iteration_brief(ctx, RunFiles.load(ctx.best_run))
        with self.client.beta.sessions.events.stream(session_id) as stream:
            if not entry["started"]:
                self._kickoff(ctx, state, entry, brief)
                return self._drain(ctx, state, entry, tools, stream, set())
            history = list(self.client.beta.sessions.events.list(session_id, order="asc"))
            answered = {
                e.custom_tool_use_id for e in history if e.type == "user.custom_tool_result"
            }
            for event in _after(history, entry.get("lastEventId")):
                choice = self._process(ctx, state, entry, tools, event, answered)
                if choice is not None:
                    return choice
            self._report_back(ctx, state, entry, brief, answered)
            return self._drain(ctx, state, entry, tools, stream, answered)

    def _kickoff(self, ctx: AnalystContext, state: dict, entry: dict, brief: dict) -> None:
        self._send(
            ctx,
            entry["sessionId"],
            [
                {
                    "type": "user.message",
                    "content": [{"type": "text", "text": prompts.analyst_iteration_prompt(brief)}],
                },
                {
                    "type": "user.define_outcome",
                    "description": prompts.managed_outcome_description(ctx.max_runs),
                    "rubric": {"type": "text", "content": prompts.managed_rubric(ctx.max_runs)},
                    "max_iterations": 5,
                },
            ],
        )
        entry["started"] = True
        self._save(state)

    def _report_back(
        self, ctx: AnalystContext, state: dict, entry: dict, brief: dict, answered: set[str]
    ) -> None:
        """Give the agent the last run's measured result and this iteration's proposals: as the
        answer to its pending run_sim call, or as a new message when there is none (e.g. after an
        iteration fell back to the heuristic while the agent sat idle)."""
        measured = ctx.last_outcome.to_brief() if ctx.last_outcome else None
        text = prompts.analyst_result_message({"measured": measured, "next": brief})
        pending = entry.get("pendingRunSim")
        if pending:
            if pending not in answered:
                self._tool_result(ctx, entry["sessionId"], pending, ToolResult(text))
                answered.add(pending)
            entry["pendingRunSim"] = None
            self._save(state)
            return
        self._send(
            ctx,
            entry["sessionId"],
            [{"type": "user.message", "content": [{"type": "text", "text": text}]}],
        )

    def _drain(
        self,
        ctx: AnalystContext,
        state: dict,
        entry: dict,
        tools: AnalystTools,
        stream,
        answered: set[str],
    ) -> Choice:
        for event in stream:
            choice = self._process(ctx, state, entry, tools, event, answered)
            if choice is not None:
                return choice
        raise llm.LLMError("managed analyst event stream ended unexpectedly")

    def _process(
        self,
        ctx: AnalystContext,
        state: dict,
        entry: dict,
        tools: AnalystTools,
        event,
        answered: set[str],
    ) -> Choice | None:
        """Handle one session event (live or caught up from history). Returns a Choice when the
        iteration is decided; raises at the budget or when the session dies."""
        event_id = getattr(event, "id", None)
        if event_id and event_id in self._seen:
            return None
        if event_id:
            self._seen.add(event_id)
        try:
            if event.type == "agent.custom_tool_use":
                if event.id in answered:
                    return None
                answered.add(event.id)
                return self._handle_tool_use(ctx, state, entry, tools, event)
            self._on_event(ctx, entry, event)
            if event.type == "session.status_terminated":
                raise llm.LLMError("managed analyst session terminated")
            if event.type == "session.status_idle":
                return self._on_idle(ctx, entry, event)
            return None
        finally:
            if event_id:
                entry["lastEventId"] = event_id
                self._save(state)

    def _on_idle(self, ctx: AnalystContext, entry: dict, event) -> Choice | None:
        reason = event.stop_reason.type
        if reason == "requires_action":
            return None
        if reason == "budget_reached":
            raise llm.BudgetExceeded("managed analyst session budget reached")
        outcome = entry.get("outcome")
        if outcome:
            return Choice([], outcome["explanation"] or "Outcome reached", stop=True)
        if reason != "end_turn" or self._nudges >= self.MAX_NUDGES:
            return self._fallback(ctx, f"session idle ({reason}) without an experiment")
        self._nudges += 1
        self._send(
            ctx,
            entry["sessionId"],
            [{"type": "user.message", "content": [{"type": "text", "text": NUDGE}]}],
        )
        return None

    def _handle_tool_use(
        self, ctx: AnalystContext, state: dict, entry: dict, tools: AnalystTools, event
    ) -> Choice | None:
        result = tools.dispatch(event.name, dict(event.input))
        llm.log_event(
            ctx.best_run,
            {
                "agent": AGENT,
                "type": "tool_call",
                "tool": event.name,
                "input": dict(event.input),
                "result": result.text,
                "isError": result.is_error,
            },
        )
        if result.committed is not None:
            entry["pendingRunSim"] = event.id
            self._save(state)
            return result.committed
        self._tool_result(ctx, entry["sessionId"], event.id, result)
        return None

    def _on_event(self, ctx: AnalystContext, entry: dict, event) -> None:
        kind = event.type
        if kind in ("agent.tool_use", "agent.mcp_tool_use"):
            if getattr(event, "evaluated_permission", None) == "ask":
                # Unattended run: nobody is watching, so a paused call is denied, never allowed.
                self._send(
                    ctx,
                    entry["sessionId"],
                    [
                        {
                            "type": "user.tool_confirmation",
                            "tool_use_id": event.id,
                            "result": "deny",
                            "deny_message": "Unattended run: this tool call needs a human.",
                        }
                    ],
                )
        elif kind == "agent.message":
            text = " ".join(b.text for b in event.content if getattr(b, "type", "") == "text")
            llm.log_event(ctx.best_run, {"agent": AGENT, "type": "managed_message", "text": text})
        elif kind == "span.model_request_end":
            usage = llm.Usage.from_api(event.model_usage)
            llm.record_usage(
                AGENT, settings.ANALYST_MODEL, usage, run=ctx.best_run, session=ctx.session
            )
        elif kind == "span.outcome_evaluation_end":
            usage = llm.Usage.from_api(event.usage)
            llm.record_usage(
                f"{AGENT}-grader",
                settings.ANALYST_MODEL,
                usage,
                run=ctx.best_run,
                session=ctx.session,
            )
            llm.log_event(
                ctx.best_run,
                {
                    "agent": AGENT,
                    "type": "outcome_evaluation",
                    "result": event.result,
                    "explanation": event.explanation,
                },
            )
            if event.result in TERMINAL_OUTCOMES:
                entry["outcome"] = {"result": event.result, "explanation": event.explanation}
        elif kind == "session.error":
            llm.log_event(
                ctx.best_run, {"agent": AGENT, "type": "managed_error", "event": _block_dict(event)}
            )

    def _fallback(self, ctx: AnalystContext, reason: str) -> Choice:
        llm.log_event(
            ctx.best_run, {"agent": AGENT, "type": "fallback", "to": "heuristic", "reason": reason}
        )
        return HeuristicAnalyst().choose(ctx)

    def notebook_line(self, outcome: IterationOutcome) -> str:
        map_data = store.load_map()
        line = measured_notebook_line(outcome, map_data)
        state = self._load()
        if state.get("memoryStoreId") and state.get("notebookMemoryId"):
            earlier = [
                f"Run {e.run}: {e.line}" for e in store.load_notebook() if e.run != outcome.run
            ]
            content = NOTEBOOK_HEADER + "\n".join([*earlier, f"Run {outcome.run}: {line}"]) + "\n"
            try:
                self.client.beta.memory_stores.memories.update(
                    state["notebookMemoryId"],
                    memory_store_id=state["memoryStoreId"],
                    content=content,
                )
            except anthropic.APIError as e:
                llm.log_event(
                    outcome.run, {"agent": AGENT, "type": "notebook_sync_error", "error": str(e)}
                )
        return line

    def close(self, reason: str) -> None:
        """Stop the agent's current turn. A pending run_sim stays recorded so a resumed training
        session can still answer it."""
        llm.log_event(None, {"agent": AGENT, "type": "managed_close", "reason": reason})
        if self._current_session is None:
            return
        try:
            self.client.beta.sessions.events.send(
                self._current_session, events=[{"type": "user.interrupt"}]
            )
        except anthropic.APIError as e:
            llm.log_event(None, {"agent": AGENT, "type": "managed_close_error", "error": str(e)})


def select_backend(name: str | None = None) -> AnalystBackend:
    """The configured analyst backend; LLM backends degrade to the heuristic when offline."""
    requested = name or settings.ANALYST_BACKEND
    chosen = requested
    if requested == "auto":
        chosen = "messages" if llm.available() else "heuristic"
    if chosen in ("messages", "managed") and not llm.available():
        llm.log_event(
            None,
            {"agent": AGENT, "type": "fallback", "requested": requested, "reason": "offline"},
        )
        chosen = "heuristic"
    backends: dict[str, type] = {
        "heuristic": HeuristicAnalyst,
        "messages": MessagesAnalyst,
        "managed": ManagedAnalyst,
    }
    if chosen not in backends:
        raise ValueError(
            f"unknown ANALYST_BACKEND {requested!r}: use auto|heuristic|messages|managed"
        )
    return backends[chosen]()
