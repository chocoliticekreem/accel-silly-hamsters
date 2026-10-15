"""The training objective: which value it reads, which way is better, and how gains are measured.

The objective (TrainingConfig.objective, default settings.OBJECTIVE) is a contract.Kpis field
(visitsPerKwh, visits) or netValueGbp: the area's weekly margin on visits minus its energy bill
and wages, summed over non-club stores: visits x margin_per_visit(type) - kWh x price - open hours
x staff wage (backend/economics.py; price = the mean tariff). Higher is better except for `kwh`.
A gain is
always expressed so that positive means better (0.02 = 2% better than the reference).

storeProfitGbp is a one-shop session's objective (training.py): the shop's profit change per week
against the session baseline. Measured on the shop alone it is the shop's netValueGbp (per_store).
"""

from __future__ import annotations

from collections.abc import Mapping

from backend import economics
from backend.contract import Kpis, StoreKpis, StoreType

LOWER_IS_BETTER = frozenset({"kwh"})
NET_VALUE = "netValueGbp"
STORE_PROFIT = "storeProfitGbp"


def direction(objective: str) -> int:
    return -1 if objective in LOWER_IS_BETTER else 1


def per_store(objective: str) -> str:
    """The objective one store's own numbers are measured on (store agents' ranking, report
    confidence): a shop's profit is its net value."""
    return NET_VALUE if objective == STORE_PROFIT else objective


def city_value(kpis: Kpis, objective: str) -> float:
    return float(getattr(kpis, objective))


def value_per_visit(store_type: StoreType) -> float:
    """GBP of margin one visit is worth to a store of this type."""
    return economics.margin_per_visit(store_type)


def net_value_gbp(
    stores: Mapping[str, StoreKpis], types: Mapping[str, StoreType], price: float
) -> float:
    """netValueGbp from 14-day store KPIs: GBP per week, clubs and unknown stores excluded."""
    return sum(
        economics.gbp_per_week(types[sid], kpis.visits, kpis.kwh, kpis.openHours, price)
        for sid, kpis in stores.items()
        if types.get(sid, "club") != "club"
    )


def store_value(
    kpis: StoreKpis,
    objective: str,
    *,
    store_type: StoreType | None = None,
    price: float = 0.0,
) -> float:
    """The objective computed for one store (StoreKpis has no visitsPerKwh field).

    netValueGbp needs the store's type and the energy price.
    """
    if objective == "visitsPerKwh":
        return kpis.visits / kpis.kwh if kpis.kwh > 0 else 0.0
    if objective == NET_VALUE:
        if store_type is None:
            raise ValueError("netValueGbp needs the store type")
        return economics.gbp_per_week(store_type, kpis.visits, kpis.kwh, kpis.openHours, price)
    return float(getattr(kpis, objective))


def gain(new: float, reference: float, objective: str) -> float:
    """Relative improvement of `new` over `reference`, positive = better."""
    if reference == 0:
        return 0.0
    return direction(objective) * (new - reference) / abs(reference)


def expected_gain(
    visits: float,
    kwh: float,
    d_visits: float,
    d_kwh: float,
    objective: str,
    *,
    gbp_per_visit: float = 0.0,
    price: float = 0.0,
) -> float:
    """Estimated objective gain from absolute visit/kWh deltas on top of totals (visits, kwh).

    netValueGbp values a visit at gbp_per_visit (value_per_visit) and a kWh at price; any
    consistent period works since only the ratio counts. returnRate has no per-change
    estimate, so visits stand in for it.
    """
    if objective == "visitsPerKwh":
        if visits <= 0 or kwh <= 0 or kwh + d_kwh <= 0:
            return 0.0
        return ((visits + d_visits) / (kwh + d_kwh)) / (visits / kwh) - 1.0
    if objective == NET_VALUE:
        value = visits * gbp_per_visit - kwh * price
        delta = d_visits * gbp_per_visit - d_kwh * price
        return delta / abs(value) if value else 0.0
    if objective == "kwh":
        return -d_kwh / kwh if kwh > 0 else 0.0
    return d_visits / visits if visits > 0 else 0.0


def fraction(delta: float, base: float) -> float:
    """delta as a fraction of base (0 when base is 0, so a dead store never divides by zero)."""
    return delta / base if base > 0 else 0.0
