"""The training objective: which KPI it reads, which way is better, and how gains are measured.

settings.OBJECTIVE names a contract.Kpis field. Higher is better except for `kwh`. A gain is always
expressed so that positive means better (0.02 = 2% better than the reference).
"""

from __future__ import annotations

from backend.contract import Kpis, StoreKpis

LOWER_IS_BETTER = frozenset({"kwh"})


def direction(objective: str) -> int:
    return -1 if objective in LOWER_IS_BETTER else 1


def city_value(kpis: Kpis, objective: str) -> float:
    return float(getattr(kpis, objective))


def store_value(kpis: StoreKpis, objective: str) -> float:
    """The objective computed for one store (StoreKpis has no visitsPerKwh field)."""
    if objective == "visitsPerKwh":
        return kpis.visits / kpis.kwh if kpis.kwh > 0 else 0.0
    return float(getattr(kpis, objective))


def gain(new: float, reference: float, objective: str) -> float:
    """Relative improvement of `new` over `reference`, positive = better."""
    if reference == 0:
        return 0.0
    return direction(objective) * (new - reference) / abs(reference)


def expected_gain(
    visits: float, kwh: float, d_visits: float, d_kwh: float, objective: str
) -> float:
    """Estimated objective gain from absolute visit/kWh deltas on top of totals (visits, kwh).

    returnRate has no per-change estimate, so visits stand in for it.
    """
    if objective == "visitsPerKwh":
        if visits <= 0 or kwh <= 0 or kwh + d_kwh <= 0:
            return 0.0
        return ((visits + d_visits) / (kwh + d_kwh)) / (visits / kwh) - 1.0
    if objective == "kwh":
        return -d_kwh / kwh if kwh > 0 else 0.0
    return d_visits / visits if visits > 0 else 0.0


def fraction(delta: float, base: float) -> float:
    """delta as a fraction of base (0 when base is 0, so a dead store never divides by zero)."""
    return delta / base if base > 0 else 0.0
