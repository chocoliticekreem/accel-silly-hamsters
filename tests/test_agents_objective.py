"""The training objectives: netValueGbp maths (backend/economics.py), gains and their direction."""

from __future__ import annotations

import pytest

from backend.agents import objective
from backend.contract import StoreKpis, StoreType


def kpis(visits: int, kwh: float) -> StoreKpis:
    return StoreKpis(visits=visits, kwh=kwh, returnRate=0.0)


def test_net_value_is_weekly_margin_on_visits_minus_the_energy_bill():
    stores = {"s1": kpis(140, 70.0), "s2": kpis(280, 100.0), "c1": kpis(900, 500.0)}
    types: dict[str, StoreType] = {"s1": "cafe", "s2": "takeaway", "c1": "club"}
    # 14 days = 2 weeks; cafe £6 and takeaway £9 a visit at a 30% margin; clubs excluded
    cafe = 140 / 2 * 6 * 0.3 - 70 / 2 * 0.27
    takeaway = 280 / 2 * 9 * 0.3 - 100 / 2 * 0.27
    value = objective.net_value_gbp(stores, types, price=0.27)
    assert value == pytest.approx(cafe + takeaway)
    assert value == pytest.approx(116.55 + 364.5)


def test_store_value_on_net_value_needs_the_store_type():
    assert objective.store_value(
        kpis(140, 70.0), "netValueGbp", store_type="cafe", price=0.27
    ) == pytest.approx(116.55)
    with pytest.raises(ValueError, match="store type"):
        objective.store_value(kpis(140, 70.0), "netValueGbp")
    assert objective.store_value(kpis(140, 70.0), "visitsPerKwh") == 2.0


def test_expected_net_value_gain_prices_visits_and_kwh():
    # value 100 x 1.8 - 50 x 0.27 = 166.5; +10 visits and +5 kWh add 18 - 1.35 = 16.65
    gain = objective.expected_gain(
        100, 50, 10, 5, "netValueGbp", gbp_per_visit=objective.value_per_visit("cafe"), price=0.27
    )
    assert objective.value_per_visit("cafe") == pytest.approx(1.8)
    assert gain == pytest.approx(16.65 / 166.5)
    saving = objective.expected_gain(100, 50, 0, -5, "netValueGbp", gbp_per_visit=1.8, price=0.27)
    assert saving == pytest.approx(1.35 / 166.5)


def test_gains_are_positive_when_better_even_from_a_loss():
    assert objective.gain(-50.0, -100.0, "netValueGbp") == pytest.approx(0.5)  # loss halved
    assert objective.gain(90.0, 100.0, "netValueGbp") == pytest.approx(-0.1)
    assert objective.gain(90.0, 100.0, "kwh") == pytest.approx(0.1)  # less energy is better
    assert objective.expected_gain(100, 50, 10, 0, "visits") == pytest.approx(0.1)
