"""Fault injection for chaos testing. Off unless CHAOS is set; seeded, so a chaos run repeats.

    CHAOS="llm_429:0.3,llm_timeout:0.1,bad_json:0.2,sim_crash:0.05,kill_after_step:3"
    CHAOS_SEED=7   (default 0)

Each fault is a probability per opportunity, except kill_after_step:N (SIGKILL this process right
after its Nth checkpoint). The faults enter through the seams the agents already have:

  llm_429 llm_529 llm_500 llm_timeout llm_conn llm_auth
                 raised by llm.call_with_retries before the real call (every Claude request,
                 batch create/poll/results), as the SDK would raise them
  bad_json refusal empty
                 the fake Claude client (FAKE_LLM=1, backend/fake_llm.py) answers with broken
                 JSON, a refusal or no text
  batch_stuck    the fake client's batch never leaves "in_progress"
  batch_partial  one fake batch result comes back "errored" (or "expired")
  sim_crash sim_nan sim_zero
                 training's sim seam: the run raises, or its objective is NaN, or it has no visits
  kill_after_step:N

Nothing here runs unless CHAOS is set (enabled() is False), so production paths pay one dict
lookup per call.
"""

from __future__ import annotations

import os
import random
import signal

import anthropic
import httpx2

API_URL = "https://api.anthropic.com/v1/messages"

FAULTS = {
    "llm_429",
    "llm_529",
    "llm_500",
    "llm_timeout",
    "llm_conn",
    "llm_auth",
    "bad_json",
    "refusal",
    "empty",
    "batch_stuck",
    "batch_partial",
    "sim_crash",
    "sim_nan",
    "sim_zero",
    "kill_after_step",
}
LLM_FAULTS = ("llm_auth", "llm_429", "llm_529", "llm_500", "llm_timeout", "llm_conn")


# --- synthetic SDK errors (also used by the tests) -------------------------------------------


def _request() -> httpx2.Request:
    return httpx2.Request("POST", API_URL)


def api_error(
    status: int, *, retry_after: str | None = None, retry_after_ms: str | None = None
) -> anthropic.APIStatusError:
    """The SDK exception for an HTTP `status` answer, with optional retry-after headers."""
    headers = {}
    if retry_after is not None:
        headers["retry-after"] = retry_after
    if retry_after_ms is not None:
        headers["retry-after-ms"] = retry_after_ms
    response = httpx2.Response(status, headers=headers, request=_request())
    body = {"type": "error", "error": {"type": "chaos", "message": f"chaos: HTTP {status}"}}
    client = anthropic.Anthropic(api_key="chaos-not-a-key")
    return client._make_status_error(f"chaos: HTTP {status}", body=body, response=response)


def timeout_error() -> anthropic.APITimeoutError:
    return anthropic.APITimeoutError(request=_request())


def connection_error() -> anthropic.APIConnectionError:
    return anthropic.APIConnectionError(message="chaos: connection reset", request=_request())


# --- configuration -----------------------------------------------------------------------------


class Chaos:
    def __init__(self, spec: str = "", seed: int = 0) -> None:
        self.rates: dict[str, float] = {}
        self.kill_after_step: int | None = None
        for item in filter(None, (part.strip() for part in spec.split(","))):
            name, _, value = item.partition(":")
            if name not in FAULTS:
                raise ValueError(f"unknown chaos fault {name!r}: use one of {sorted(FAULTS)}")
            if name == "kill_after_step":
                self.kill_after_step = int(value)
            else:
                self.rates[name] = float(value or 1.0)
        self.rng = random.Random(seed)
        self.injected: dict[str, int] = {}
        self.checkpoints = 0

    def enabled(self) -> bool:
        return bool(self.rates) or self.kill_after_step is not None

    def fires(self, fault: str) -> bool:
        rate = self.rates.get(fault, 0.0)
        if rate <= 0.0 or self.rng.random() >= rate:
            return False
        self.injected[fault] = self.injected.get(fault, 0) + 1
        return True


_chaos = Chaos(os.getenv("CHAOS", ""), int(os.getenv("CHAOS_SEED", "0")))


def configure(spec: str, seed: int = 0) -> Chaos:
    """Replace the process's chaos settings (CLI chaos-demo, tests)."""
    global _chaos
    _chaos = Chaos(spec, seed)
    return _chaos


def current() -> Chaos:
    return _chaos


def fires(fault: str) -> bool:
    return _chaos.fires(fault)


def inject_llm() -> None:
    """Raise one synthetic API error, as the SDK would, when an llm_* fault fires."""
    if not _chaos.rates:
        return
    for fault in LLM_FAULTS:
        if _chaos.fires(fault):
            if fault == "llm_timeout":
                raise timeout_error()
            if fault == "llm_conn":
                raise connection_error()
            status = {"llm_auth": 401, "llm_429": 429, "llm_529": 529, "llm_500": 500}[fault]
            raise api_error(status, retry_after="1" if status == 429 else None)


def after_checkpoint() -> None:
    """kill_after_step:N: SIGKILL this process right after its Nth checkpoint (no cleanup runs,
    as with an OOM kill or a pulled plug)."""
    if _chaos.kill_after_step is None:
        return
    _chaos.checkpoints += 1
    if _chaos.checkpoints >= _chaos.kill_after_step:
        os.kill(os.getpid(), signal.SIGKILL)
