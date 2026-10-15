"""Money maths for store advice, in one place: the insights engine uses it, the owner report will.

SPEND_GBP_PER_VISIT and GROSS_MARGIN are the same constants as the frontend mock
(apps/web/src/mock/report.ts: SPEND_GBP and GROSS_MARGIN); change both together.
A run is 14 days = 2 weeks, so 14-day deltas are halved to get per-week figures.
"""

from __future__ import annotations

from statistics import fmean

from backend import settings, store
from backend.contract import DAYS, StoreKpis, StoreType
from backend.schemas import EnergyFile

# Average spend per visit (GBP). Clubs are fixed anchors and never get advice.
SPEND_GBP_PER_VISIT: dict[StoreType, float] = {
    "cafe": 6,
    "restaurant": 22,
    "takeaway": 9,
    "bar": 14,
    "shop": 15,
    "offlicence": 8,
    "club": 0,
}
# Share of extra takings the owner keeps, so the GBP line is profit, not revenue.
GROSS_MARGIN = 0.3
WEEKS_PER_RUN = DAYS / 7


def price_gbp_per_kwh(energy: EnergyFile) -> float:
    """Mean of energy.json's hourly tariff."""
    return fmean(energy.priceGbpPerKwh)


def area_price_gbp_per_kwh() -> float:
    """price_gbp_per_kwh of data/processed/energy.json, else settings.DEFAULT_PRICE_GBP_PER_KWH."""
    try:
        return price_gbp_per_kwh(store.load_energy())
    except FileNotFoundError:
        return settings.DEFAULT_PRICE_GBP_PER_KWH


def profit_vs(store_type: StoreType, base: StoreKpis, now: StoreKpis, price: float) -> float:
    """One shop's profit change per week in a run (`now`) against another run (`base`), from
    their 14-day KPIs: gbp_per_week of the visit and kWh differences."""
    return gbp_per_week(store_type, now.visits - base.visits, now.kwh - base.kwh, price)


def weekly_margin_gbp(store_type: StoreType, kpis: StoreKpis) -> float:
    """What the shop keeps per week from its customers (margin on takings, before energy)."""
    return kpis.visits / WEEKS_PER_RUN * SPEND_GBP_PER_VISIT[store_type] * GROSS_MARGIN


def gbp_per_week(
    store_type: StoreType, delta_visits_14d: float, delta_kwh_14d: float, price: float
) -> float:
    """The owner's profit change per week: margin on the extra visits minus the extra energy
    bill. Positive = the owner is better off."""
    margin = delta_visits_14d / WEEKS_PER_RUN * SPEND_GBP_PER_VISIT[store_type] * GROSS_MARGIN
    energy_bill = delta_kwh_14d / WEEKS_PER_RUN * price
    return margin - energy_bill
