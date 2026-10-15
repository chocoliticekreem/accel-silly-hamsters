"""Sim visits are agents; one stands for economics.people_per_agent() real people. Takings scale up
to real people; wages and kWh are real already and do not."""

from __future__ import annotations

import pytest

from backend import economics


def test_takings_scale_to_real_people_but_wages_and_energy_do_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    one = economics.gbp_per_week("cafe", 140, 70, 14, 0.30)
    monkeypatch.setattr(economics, "people_per_agent", lambda: 19.0)
    nineteen = economics.gbp_per_week("cafe", 140, 70, 14, 0.30)
    # cafe: 140 visits a fortnight = 70 a week x GBP 6 x 0.65 = 273.0; energy 35 kWh x 0.30 = 10.5
    # and wages 7 h x 12.71 = 88.97 are real already, so only the takings grow.
    assert one == pytest.approx(273.0 - 10.5 - 88.97)
    assert nineteen == pytest.approx(273.0 * 19 - 10.5 - 88.97)
    assert economics.margin_per_visit("cafe") == pytest.approx(6 * 0.65 * 19)


def test_people_per_agent_falls_back_to_one_without_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.undo()  # drop conftest's fixed 1.0 to reach the real function
    monkeypatch.setattr(economics, "real_people_per_agent", lambda: None)
    assert economics.people_per_agent() == 1.0
