"""The one retry policy (llm.call_with_retries), the circuit breaker and recovery events."""

from __future__ import annotations

import json

import pytest

from backend import chaos, llm, settings


@pytest.fixture(autouse=True)
def runs(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    llm.reset_breaker()
    llm.reset_recoveries()
    yield tmp_path / "runs"
    llm.reset_breaker()
    llm.reset_recoveries()


@pytest.fixture
def sleeps(monkeypatch) -> list[float]:
    waited: list[float] = []
    monkeypatch.setattr(llm, "_sleep", waited.append)
    return waited


def events(runs_dir, run: int | None = None) -> list[dict]:
    path = (runs_dir / str(run) if run is not None else runs_dir) / "llm_log.jsonl"
    return [json.loads(line) for line in path.open()] if path.exists() else []


class Flaky:
    """Raises the given errors in order, then returns "ok"."""

    def __init__(self, *errors: Exception) -> None:
        self.errors = list(errors)
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return "ok"


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (chaos.api_error(429), "retryable"),
        (chaos.api_error(529), "retryable"),
        (chaos.api_error(500), "retryable"),
        (chaos.api_error(503), "retryable"),
        (chaos.api_error(408), "retryable"),
        (chaos.timeout_error(), "retryable"),
        (chaos.connection_error(), "retryable"),
        (chaos.api_error(401), "fatal"),
        (chaos.api_error(403), "fatal"),
        (chaos.api_error(400), "fatal"),
        (chaos.api_error(404), "fatal"),
        (ValueError("not an API error"), "fatal"),
    ],
)
def test_errors_are_classified_retryable_or_fatal(error, kind):
    assert llm.classify(error) == kind


def test_retry_after_headers_are_read_in_seconds():
    assert llm.retry_after_seconds(chaos.api_error(429, retry_after="7")) == 7.0
    assert llm.retry_after_seconds(chaos.api_error(429, retry_after_ms="1500")) == 1.5
    assert llm.retry_after_seconds(chaos.api_error(429, retry_after="soon")) is None
    assert llm.retry_after_seconds(chaos.api_error(429)) is None
    assert llm.retry_after_seconds(chaos.timeout_error()) is None


def test_backoff_is_exponential_with_full_jitter(monkeypatch):
    monkeypatch.setattr(llm._rng, "uniform", lambda low, high: high)  # the top of the range
    caps = [llm.backoff_wait(attempt) for attempt in range(1, 8)]
    base, top = settings.RETRY_BASE_SECONDS, settings.RETRY_MAX_WAIT_SECONDS
    assert caps == [min(top, base * 2 ** (a - 1)) for a in range(1, 8)]
    monkeypatch.setattr(llm._rng, "uniform", lambda low, high: low)
    assert llm.backoff_wait(3) == 0.0  # full jitter: anywhere from zero


def test_a_rate_limit_is_retried_then_succeeds_and_each_retry_is_logged(runs, sleeps):
    fn = Flaky(chaos.api_error(429), chaos.api_error(529))
    assert llm.call_with_retries(fn, agent="store_owner", run=3, session="s") == "ok"
    assert fn.calls == 3 and len(sleeps) == 2
    retries = [e for e in events(runs, 3) if e["type"] == "retry"]
    assert [r["attempt"] for r in retries] == [1, 2]
    assert [r["kind"] for r in retries] == ["http_429", "http_529"]
    assert all(r["outcome"] == "retrying" and r["wait"] >= 0 for r in retries)
    assert llm.recovery_counts("s")["retries"] == 2


def test_retry_after_is_honoured(sleeps):
    fn = Flaky(chaos.api_error(429, retry_after="4"))
    llm.call_with_retries(fn, agent="analyst")
    assert sleeps == [4.0]


def test_a_fatal_error_is_not_retried(runs, sleeps):
    fn = Flaky(chaos.api_error(401))
    with pytest.raises(llm.LLMUnavailable, match="fatal"):
        llm.call_with_retries(fn, agent="analyst", run=1)
    assert fn.calls == 1 and sleeps == []
    [error] = [e for e in events(runs, 1) if e["type"] == "llm_error"]
    assert error["outcome"] == "fatal" and error["kind"] == "http_401"


def test_retries_stop_at_the_attempt_cap(sleeps, monkeypatch):
    monkeypatch.setattr(settings, "BREAKER_THRESHOLD", 100)
    fn = Flaky(*[chaos.api_error(500) for _ in range(20)])
    with pytest.raises(llm.LLMUnavailable, match="gave up after 5 attempts"):
        llm.call_with_retries(fn, agent="analyst")
    assert fn.calls == settings.RETRY_MAX_ATTEMPTS == 5


def test_total_retry_time_is_capped(sleeps, monkeypatch):
    monkeypatch.setattr(settings, "BREAKER_THRESHOLD", 100)
    monkeypatch.setattr(settings, "RETRY_TOTAL_SECONDS", 70.0)
    fn = Flaky(*[chaos.api_error(503, retry_after="50") for _ in range(20)])
    with pytest.raises(llm.LLMUnavailable, match="retry time"):
        llm.call_with_retries(fn, agent="analyst")
    assert sleeps == [30.0, 30.0]  # retry-after capped at the max wait; a third would pass 70s
    assert fn.calls == 3


def test_the_breaker_opens_after_consecutive_failures_and_resets_per_step(runs, sleeps):
    threshold = settings.BREAKER_THRESHOLD
    fn = Flaky(*[chaos.connection_error() for _ in range(threshold)])
    for _ in range(2):
        with pytest.raises(llm.LLMError):
            llm.call_with_retries(fn, agent="store_owner", run=2, session="s")
    assert llm.breaker_open() and fn.calls == threshold
    untouched = Flaky()
    with pytest.raises(llm.CircuitOpen):
        llm.call_with_retries(untouched, agent="store_owner", run=2, session="s")
    assert untouched.calls == 0
    assert any(e["type"] == "breaker_open" for e in events(runs, 2))

    llm.reset_breaker()  # the training loop does this at every step boundary
    assert llm.call_with_retries(untouched, agent="store_owner") == "ok"


def test_a_success_resets_the_consecutive_failure_count(sleeps):
    failures = min(settings.BREAKER_THRESHOLD, settings.RETRY_MAX_ATTEMPTS) - 1
    for _ in range(3):  # 3 x 4 failures, never 6 in a row
        fn = Flaky(*[chaos.api_error(529) for _ in range(failures)])
        assert llm.call_with_retries(fn, agent="analyst") == "ok"
    assert not llm.breaker_open()


def test_a_fatal_error_opens_the_breaker_at_once(sleeps):
    with pytest.raises(llm.LLMUnavailable):
        llm.call_with_retries(Flaky(chaos.api_error(401)), agent="analyst")
    assert llm.breaker_open()


def test_the_client_leaves_retries_to_our_policy(monkeypatch):
    monkeypatch.setattr(llm, "_client", None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    client = llm.client()
    assert client.max_retries == 0
    monkeypatch.setattr(llm, "_client", None)


def test_recovery_counts_cover_every_kind_and_survive_a_restart():
    llm.record_recovery("fallback", agent="analyst", session="s", reason="x")
    llm.record_recovery("repair", agent="store_owner", session="s")
    llm.record_recovery("quarantine", agent="training", session="s")
    counts = llm.recovery_counts("s")
    assert counts["fallbacks"] == 1 and counts["repairs"] == 1 and counts["quarantined"] == 1
    assert counts["retries"] == 0 and counts["resumed"] == 0
    llm.reset_recoveries()
    llm.load_recoveries("s", counts)  # a resumed session continues its counts
    llm.record_recovery("fallback", agent="analyst", session="s")
    assert llm.recovery_counts("s")["fallbacks"] == 2
