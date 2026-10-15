"""Shared test setup.

The pre-existing sim tests pin the pre-adaptation behaviour, so owner adaptation is off by default
in tests; tests of the self-learning city switch it on (tests/test_sim_owners.py).
"""

from __future__ import annotations

import pytest

from backend import economics, llm, settings


@pytest.fixture(autouse=True)
def _owner_adaptation_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "OWNER_ADAPTATION", False)


@pytest.fixture(autouse=True)
def _fresh_llm_state():
    """The circuit breaker, recovery counts and per-session caps are process-wide: every test
    starts closed, at zero and on the settings caps."""
    llm.reset_breaker()
    llm.reset_recoveries()
    llm._session_budgets_usd.clear()
    yield
    llm._session_budgets_usd.clear()
    llm.reset_breaker()
    llm.reset_recoveries()


@pytest.fixture(autouse=True)
def _one_person_per_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hand-worked money in tests counts sim visits as people; test_economics_scale opts out."""
    monkeypatch.setattr(economics, "people_per_agent", lambda: 1.0)
