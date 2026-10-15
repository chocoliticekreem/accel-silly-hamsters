"""Shared Claude API plumbing: client, structured JSON calls, cost ledger and audit log.

Every agent call goes through here so that tokens, cost (GBP) and prompt-cache hits are recorded
in one ledger (runs/costs.jsonl) and every prompt/response lands in runs/{run}/llm_log.jsonl.

Offline mode: when no credentials are configured (or OFFLINE=1) `available()` is False and the
agents use their deterministic heuristic backends instead of calling Claude.
"""

from __future__ import annotations

import json
import os
import random
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Any, TypeVar

from backend import cache, settings
from backend.schemas import CostSummary
from backend.store import now_iso

T = TypeVar("T")
_lock = threading.Lock()
_client = None

# USD per million tokens: (input, 5-minute cache write, cache read, output).
# Source: https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-15).
PRICES_USD_PER_MTOK: dict[str, tuple[float, float, float, float]] = {
    "claude-opus-5-5": (4.00, 5.00, 0.20, 20.00),
    "claude-sonnet-5-5": (2.00, 2.50, 0.10, 10.00),
    "claude-haiku-5-5": (0.10, 0.125, 0.01, 0.50),
}
# Haiku 5.5 bills every token of a request at higher rates once its prompt (input + cache
# reads + cache writes) exceeds 100k tokens.
LONG_PROMPT_PRICES_USD_PER_MTOK: dict[str, tuple[int, tuple[float, float, float, float]]] = {
    "claude-haiku-5-5": (100_000, (0.50, 0.625, 0.05, 2.50)),
}
BATCH_DISCOUNT = 0.5
WEB_SEARCH_USD = 10.0 / 1000

# Server-side refusal fallback (opt-in, Claude API only; rejected on the Batches API). The
# "default" form is documented for these models only.
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}


def available() -> bool:
    if settings.OFFLINE:
        return False
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))


def client():
    """The process's Anthropic client. Its own retries are off: call_with_retries is the one
    retry policy, so a request is never retried by two layers."""
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(max_retries=0, timeout=settings.LLM_TIMEOUT_SECONDS)
    return _client


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    web_search_requests: int = 0

    @classmethod
    def from_api(cls, usage: Any) -> Usage:
        server_tools = getattr(usage, "server_tool_use", None)
        return cls(
            input_tokens=getattr(usage, "input_tokens", 0) or 0,
            output_tokens=getattr(usage, "output_tokens", 0) or 0,
            cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
            cache_write_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
            web_search_requests=getattr(server_tools, "web_search_requests", 0) or 0,
        )

    def prompt_tokens(self) -> int:
        return self.input_tokens + self.cache_read_tokens + self.cache_write_tokens

    def _prices(self, model: str) -> tuple[float, float, float, float]:
        if model not in PRICES_USD_PER_MTOK:
            raise LLMError(f"no price for model {model!r}: add it to PRICES_USD_PER_MTOK")
        threshold_and_prices = LONG_PROMPT_PRICES_USD_PER_MTOK.get(model)
        if threshold_and_prices and self.prompt_tokens() > threshold_and_prices[0]:
            return threshold_and_prices[1]
        return PRICES_USD_PER_MTOK[model]

    def cost_usd(self, model: str, *, batch: bool = False) -> float:
        inp, write, read, out = self._prices(model)
        tokens_usd = (
            self.input_tokens * inp
            + self.cache_write_tokens * write
            + self.cache_read_tokens * read
            + self.output_tokens * out
        ) / 1e6
        return tokens_usd * (BATCH_DISCOUNT if batch else 1.0) + (
            self.web_search_requests * WEB_SEARCH_USD
        )

    def saved_by_cache_usd(self, model: str, *, batch: bool = False) -> float:
        inp, _, read, _ = self._prices(model)
        usd = self.cache_read_tokens * (inp - read) / 1e6
        return usd * (BATCH_DISCOUNT if batch else 1.0)


# --- ledger + audit log ---------------------------------------------------------------------


def _append_jsonl(path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock, open(path, "a") as f:
        f.write(json.dumps(record, default=str) + "\n")


def log_event(run: int | None, event: dict) -> None:
    """Append one replayable audit record (prompt, tool call, response, rule rejection...)."""
    path = (
        settings.RUNS_DIR / str(run) if run is not None else settings.RUNS_DIR
    ) / "llm_log.jsonl"
    _append_jsonl(path, {"at": now_iso(), **event})


def record_usage(
    agent: str,
    model: str,
    usage: Usage,
    *,
    run: int | None,
    batch: bool = False,
    session: str | None = None,
    cached_response: bool = False,
) -> float:
    """Add one call to the cost ledger. Returns its cost in GBP."""
    cost_usd = 0.0 if cached_response else usage.cost_usd(model, batch=batch)
    cost_gbp = cost_usd * settings.GBP_PER_USD
    saved = usage.saved_by_cache_usd(model, batch=batch) * settings.GBP_PER_USD
    _append_jsonl(
        settings.RUNS_DIR / "costs.jsonl",
        {
            "at": now_iso(),
            "agent": agent,
            "model": model,
            "run": run,
            "session": session,
            "batch": batch,
            "cachedResponse": cached_response,
            **asdict(usage),
            "costUsd": round(cost_usd, 6),
            "costGbp": round(cost_gbp, 6),
            "savedByCachingGbp": round(saved, 6),
        },
    )
    return cost_gbp


def load_ledger() -> list[dict]:
    path = settings.RUNS_DIR / "costs.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def cost_summary(
    *, runs: set[int] | None = None, session: str | None = None, store_weeks: float = 1.0
) -> CostSummary:
    """Aggregate the ledger for some runs and/or an analyst session."""
    rows = [
        r
        for r in load_ledger()
        if (runs is None or r.get("run") in runs)
        and (session is None or r.get("session") == session)
    ]
    by_agent: dict[str, float] = {}
    for r in rows:
        by_agent[r["agent"]] = by_agent.get(r["agent"], 0.0) + r["costGbp"]
    total = sum(r["costGbp"] for r in rows)
    return CostSummary(
        calls=len(rows),
        inputTokens=sum(r["input_tokens"] for r in rows),
        outputTokens=sum(r["output_tokens"] for r in rows),
        cacheReadTokens=sum(r["cache_read_tokens"] for r in rows),
        cacheWriteTokens=sum(r["cache_write_tokens"] for r in rows),
        costGbp=round(total, 4),
        savedByCachingGbp=round(sum(r["savedByCachingGbp"] for r in rows), 4),
        costPerStoreWeekGbp=round(total / store_weeks, 4) if store_weeks else 0.0,
        byAgent={k: round(v, 4) for k, v in sorted(by_agent.items())},
    )


# --- structured JSON call -------------------------------------------------------------------


class LLMError(RuntimeError):
    pass


class BudgetExceeded(LLMError):
    """A spend cap was reached. Training catches this, checkpoints and stops ("budget")."""


class LLMUnavailable(LLMError):
    """A call failed for good: a fatal error, or retries ran out (attempts or total time).
    Agents catch LLMError and degrade to their heuristic."""


class CircuitOpen(LLMUnavailable):
    """The breaker is open: no Claude call until the training loop's next step."""


# --- recovery events and counts -------------------------------------------------------------

# Event type -> AgentSession.recoveries key. Every error, retry, fallback and recovery is one
# event in the agent log (GET /api/agents/log) and one count in the session.
RECOVERY_COUNTS = {
    "retry": "retries",
    "fallback": "fallbacks",
    "repair": "repairs",
    "skip": "skipped",
    "resume": "resumed",
    "quarantine": "quarantined",
    "restore": "restored",
    "llm_error": "errors",
    "breaker_open": "breakerOpens",
    "batch_timeout": "batchTimeouts",
    "lock_takeover": "lockTakeovers",
}
_recoveries: dict[str | None, dict[str, int]] = {}
_step: str | None = None  # the training step in progress, for event context


def set_step(step: str | None) -> None:
    global _step
    _step = step


def reset_recoveries() -> None:
    _recoveries.clear()


def load_recoveries(session: str, counts: dict[str, int]) -> None:
    """Continue a resumed session's counts from its checkpoint."""
    _recoveries[session] = {**{k: 0 for k in RECOVERY_COUNTS.values()}, **counts}


def recovery_counts(session: str | None) -> dict[str, int]:
    return dict(_recoveries.get(session) or {k: 0 for k in RECOVERY_COUNTS.values()})


def record_recovery(
    event: str, *, agent: str, run: int | None = None, session: str | None = None, **fields: Any
) -> None:
    """Log one error/retry/fallback/recovery event (a RECOVERY_COUNTS type) and count it.
    Fields: kind (what failed), attempt, wait (seconds), outcome, plus anything specific."""
    counts = _recoveries.setdefault(session, {k: 0 for k in RECOVERY_COUNTS.values()})
    key = RECOVERY_COUNTS[event]
    counts[key] = counts.get(key, 0) + 1
    log_event(run, {"agent": agent, "type": event, "step": _step, "session": session, **fields})


# --- the one retry policy, and the circuit breaker --------------------------------------------

_rng = random.Random()
_sleep = time.sleep
_breaker = {"failures": 0, "open": False}


def classify(error: BaseException) -> str:
    """ "retryable" (rate limit, overload, 5xx, 408/409, timeout, connection) or "fatal"."""
    import anthropic

    if isinstance(error, anthropic.APIConnectionError):  # includes APITimeoutError
        return "retryable"
    if isinstance(error, anthropic.APIStatusError):
        code = error.status_code
        return "retryable" if code in (408, 409, 429) or code >= 500 else "fatal"
    return "fatal"


def _error_kind(error: BaseException) -> str:
    import anthropic

    if isinstance(error, anthropic.APITimeoutError):
        return "timeout"
    if isinstance(error, anthropic.APIConnectionError):
        return "connection"
    if isinstance(error, anthropic.APIStatusError):
        return f"http_{error.status_code}"
    return type(error).__name__


def retry_after_seconds(error: BaseException) -> float | None:
    """The server's retry-after-ms / retry-after (seconds) header, when it sent one."""
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    for name, scale in (("retry-after-ms", 1000.0), ("retry-after", 1.0)):
        value = headers.get(name)
        if value is None:
            continue
        try:
            return max(0.0, float(value) / scale)
        except ValueError:
            continue
    return None


def backoff_wait(attempt: int) -> float:
    """Exponential backoff with full jitter: uniform(0, min(max wait, base x 2^(attempt-1)))."""
    ceiling = min(settings.RETRY_MAX_WAIT_SECONDS, settings.RETRY_BASE_SECONDS * 2 ** (attempt - 1))
    return _rng.uniform(0.0, ceiling)


def reset_breaker() -> None:
    """Close the breaker (the training loop calls this at every step boundary)."""
    _breaker.update(failures=0, open=False)


def breaker_open() -> bool:
    return bool(_breaker["open"])


def _failed_attempt(fatal: bool, *, agent: str, run: int | None, session: str | None) -> None:
    _breaker["failures"] = settings.BREAKER_THRESHOLD if fatal else _breaker["failures"] + 1
    if not _breaker["open"] and _breaker["failures"] >= settings.BREAKER_THRESHOLD:
        _breaker["open"] = True
        record_recovery(
            "breaker_open",
            agent=agent,
            run=run,
            session=session,
            failures=_breaker["failures"],
            outcome="heuristic for the rest of the step",
        )


def call_with_retries(
    fn: Callable[[], T],
    *,
    agent: str,
    run: int | None = None,
    session: str | None = None,
    what: str = "messages.create",
) -> T:
    """Run one Claude API call under the retry policy and the circuit breaker.

    Retryable errors are retried with backoff_wait (or the server's retry-after, capped at
    RETRY_MAX_WAIT_SECONDS) up to RETRY_MAX_ATTEMPTS attempts and RETRY_TOTAL_SECONDS of waiting;
    fatal errors are not. Raises LLMUnavailable when it gives up and CircuitOpen while the breaker
    is open. Each retry and the final error is a recovery event in the agent log.
    """
    from backend import chaos

    if _breaker["open"]:
        raise CircuitOpen(f"{agent}: circuit open, Claude calls paused until the next step")
    waited = 0.0
    attempt = 0
    while True:
        attempt += 1
        try:
            chaos.inject_llm()
            result = fn()
        except Exception as e:
            fatal = classify(e) == "fatal"
            _failed_attempt(fatal, agent=agent, run=run, session=session)
            hint = retry_after_seconds(e)
            wait = min(
                settings.RETRY_MAX_WAIT_SECONDS, hint if hint is not None else backoff_wait(attempt)
            )
            reason = None
            if fatal:
                reason = "fatal"
            elif _breaker["open"]:
                reason = "circuit open"
            elif attempt >= settings.RETRY_MAX_ATTEMPTS:
                reason = f"gave up after {attempt} attempts"
            elif waited + wait > settings.RETRY_TOTAL_SECONDS:
                reason = f"retry time cap {settings.RETRY_TOTAL_SECONDS:.0f}s reached"
            error = f"{_error_kind(e)}: {str(e)[:200]}"
            record_recovery(
                "retry" if reason is None else "llm_error",
                agent=agent,
                run=run,
                session=session,
                what=what,
                kind=_error_kind(e),
                attempt=attempt,
                wait=0.0 if reason else round(wait, 3),
                outcome=reason or "retrying",
                error=error,
            )
            if reason is not None:
                exc = CircuitOpen if _breaker["open"] and not fatal else LLMUnavailable
                raise exc(f"{agent}: {reason}: {error}") from e
            _sleep(wait)
            waited += wait
            continue
        _breaker["failures"] = 0
        return result


def spent_usd(*, session: str | None = None) -> float:
    return sum(
        r.get("costUsd", r["costGbp"] / settings.GBP_PER_USD)
        for r in load_ledger()
        if session is None or r.get("session") == session
    )


# Per-session caps (TrainingConfig.sessionBudgetUsd), set by training when a session starts, so
# every budget check for that session uses its cap without each caller passing it along.
_session_budgets_usd: dict[str, float] = {}


def set_session_budget(session: str, usd: float) -> None:
    _session_budgets_usd[session] = usd


def session_budget_usd(session: str | None) -> float:
    """The session's cap: its own when training set one, else settings.SESSION_BUDGET_USD."""
    if session is None:
        return settings.SESSION_BUDGET_USD
    return _session_budgets_usd.get(session, settings.SESSION_BUDGET_USD)


def check_budget(session: str | None = None) -> None:
    """Raise BudgetExceeded before a call once the global or the session cap is reached.

    Call this before every Claude request or batch submission. The ledger lives in
    runs/costs.jsonl, so deleting runs/ resets the count: keep a Console spend limit as the
    real backstop.
    """
    total = spent_usd()
    if total >= settings.SPEND_CAP_USD:
        raise BudgetExceeded(f"spend cap reached: ${total:.2f} of ${settings.SPEND_CAP_USD:.2f}")
    if session is not None:
        in_session = spent_usd(session=session)
        cap = session_budget_usd(session)
        if in_session >= cap:
            raise BudgetExceeded(f"session budget reached: ${in_session:.2f} of ${cap:.2f}")


def system_blocks(*stable_parts: str) -> list[dict]:
    """System prompt as text blocks, stable-first, with a cache breakpoint on the last one."""
    blocks: list[dict[str, Any]] = [{"type": "text", "text": p} for p in stable_parts if p]
    if blocks:
        blocks[-1]["cache_control"] = {"type": "ephemeral"}
    return blocks


def json_schema_format(schema: dict) -> dict:
    return {"type": "json_schema", "schema": schema}


def call_json(
    *,
    agent: str,
    model: str,
    system: list[dict],
    user: str | list[dict],
    schema: dict,
    run: int | None = None,
    session: str | None = None,
    max_tokens: int = 8000,
    effort: str = "medium",
    cache_response: bool = False,
) -> tuple[dict, Usage]:
    """One Messages API call constrained to `schema` (structured outputs). Returns (data, usage).

    cache_response=True reuses a stored response for an identical request (deterministic,
    non-training calls only: persona extraction, report wording). Training calls leave it off.
    """
    request = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "output_config": {"format": json_schema_format(schema), "effort": effort},
    }
    key = cache.llm_key(model, request)
    if cache_response:
        hit = cache.llm_get(key)
        if hit is not None:
            usage = Usage(**hit["usage"])
            record_usage(agent, model, usage, run=run, session=session, cached_response=True)
            log_event(run, {"agent": agent, "type": "cached_response", "key": key})
            return hit["data"], usage

    check_budget(session)
    log_event(run, {"agent": agent, "type": "request", "request": request})
    if model in FALLBACK_MODELS:
        response = client().beta.messages.create(
            **request, betas=[FALLBACK_BETA], fallbacks="default"
        )
    else:
        response = client().messages.create(**request)
    usage = Usage.from_api(response.usage)
    record_usage(agent, model, usage, run=run, session=session)
    text = next((b.text for b in response.content if b.type == "text"), "")
    log_event(
        run,
        {
            "agent": agent,
            "type": "response",
            "stopReason": response.stop_reason,
            "requestId": getattr(response, "_request_id", None),
            "text": text,
            "usage": asdict(usage),
        },
    )
    if response.stop_reason in ("refusal", "max_tokens"):
        raise LLMError(f"{agent}: stop_reason={response.stop_reason}")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"{agent}: response was not valid JSON: {e}") from e
    if cache_response:
        cache.llm_put(key, {"data": data, "usage": asdict(usage), "at": now_iso()})
    return data, usage


def ledger_total_gbp(*, session: str | None = None) -> float:
    return sum(
        r["costGbp"] for r in load_ledger() if session is None or r.get("session") == session
    )
