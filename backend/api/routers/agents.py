"""GET /api/agents/session and GET /api/agents/log: the agents' work, for the Agents view.

Read-only views over files the training loop already writes:
  runs/analyst_state.json        the analyst checkpoint (step, best run, patience, spend)
  runs/llm_log.jsonl,
  runs/{run}/llm_log.jsonl       audit log: hand-offs, proposals, hypotheses, experiments, results

The log is filtered to the events that tell the story of a session and projected to scalar fields:
no prompts or responses, no per-store id lists (counts only), strings capped. Area-level view.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from backend import llm, settings, store
from backend.agents import training
from backend.api import common
from backend.contract import AgentEvent, AgentSession

router = APIRouter(tags=["agents"])

# The events that tell the story of a training session (see backend/agents/*.py, backend/llm.py).
STORY_EVENTS = {
    "start",
    "resume",
    "handoff",
    "proposals",
    "hypothesis",
    "tool_call",
    "experiment",
    "result",
    "no_experiment",
    "rule_rejection",
    "outcome_evaluation",
    "memory_store",
    "reports_written",
    "session_cost",
    "budget_stop",
    "stopped",
    "error",
    # errors and recoveries (llm.RECOVERY_COUNTS): kind, step, attempt, wait, outcome
    "retry",
    "fallback",
    "repair",
    "skip",
    "quarantine",
    "restore",
    "llm_error",
    "breaker_open",
    "batch_timeout",
    "batch_reattached",
    "lock_takeover",
    "reconcile",
}
# Fields never sent: model inputs/outputs and anything that lists individual stores.
DROP = {
    "prompt",
    "response",
    "messages",
    "system",
    "input",
    "output",
    "heuristicStores",
    "stores_list",
    "storeId",
    "trace",
}
MAX_STR = 240


def _project(raw: dict, run: int | None) -> AgentEvent | None:
    if raw.get("type") not in STORY_EVENTS:
        return None
    data: dict[str, str | int | float | bool | None] = {}
    for k, v in raw.items():
        if k in {"at", "agent", "type"} or k in DROP:
            continue
        if isinstance(v, (bool, int, float)) or v is None:
            data[k] = v
        elif isinstance(v, str):
            data[k] = v[:MAX_STR]
        elif isinstance(v, list) and k == "changes":
            data["changesCount"] = len(v)
        elif isinstance(v, list):
            data[f"{k}Count"] = len(v)
    return AgentEvent(
        at=str(raw.get("at", "")),
        agent=str(raw.get("agent", "")),
        type=str(raw["type"]),
        run=run if run is not None else (raw["run"] if isinstance(raw.get("run"), int) else None),
        data=data,
    )


def _read(path: Path, run: int | None) -> list[AgentEvent]:
    out: list[AgentEvent] = []
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(raw, dict) and (event := _project(raw, run)) is not None:
            out.append(event)
    return out


@router.get("/api/agents/session", response_model=AgentSession)
def get_session():
    """The analyst checkpoint in full. 404 before the analyst has ever run."""
    training.reconcile_stale()  # a trainer that died mid-session no longer reads "running"
    state = store.load_analyst_state()
    if state is None:
        raise HTTPException(404, "no training session yet")
    # Only the contract's fields: scopeStore and the session's config (its storeIds) stay out of
    # the area view (data firewall: no shop ids in area-level views).
    session = AgentSession.model_validate(state.model_dump(include=set(AgentSession.model_fields)))
    session.recoveries = {**{k: 0 for k in llm.RECOVERY_COUNTS.values()}, **state.recoveries}
    return common.contract_json(session)


@router.get("/api/agents/log", response_model=list[AgentEvent])
def get_log(run: int | None = Query(None, ge=0), limit: int = Query(300, ge=1, le=2000)):
    """The session's story, oldest first: every run's log plus the session-level log.

    ?run= scopes it to one run."""
    runs_dir = settings.RUNS_DIR
    events: list[AgentEvent] = []
    if run is None:
        events += _read(runs_dir / "llm_log.jsonl", None)
        if runs_dir.exists():
            for d in runs_dir.iterdir():
                if d.is_dir() and d.name.isdigit():
                    events += _read(d / "llm_log.jsonl", int(d.name))
    else:
        events += _read(runs_dir / str(run) / "llm_log.jsonl", run)
    events.sort(key=lambda e: e.at)
    return common.contract_json(events[-limit:])
