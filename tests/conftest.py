"""Shared test setup.

The pre-existing sim tests pin the pre-adaptation behaviour, so owner adaptation is off by default
in tests; tests of the self-learning city switch it on (tests/test_sim_owners.py).
"""

from __future__ import annotations

import pytest

from backend import llm, settings


@pytest.fixture(autouse=True)
def _owner_adaptation_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "OWNER_ADAPTATION", False)


@pytest.fixture(autouse=True)
def _fresh_llm_state():
    """The circuit breaker and recovery counts are process-wide: every test starts closed."""
    llm.reset_breaker()
    llm.reset_recoveries()
    yield
    llm.reset_breaker()
    llm.reset_recoveries()
