"""Money maths for store advice, in one place: the insights engine uses it, the owner report will.

SPEND_GBP_PER_VISIT and GROSS_MARGIN are the same constants as the frontend mock
(apps/web/src/mock/report.ts: SPEND_GBP and GROSS_MARGIN); change both together.
A run is 14 days = 2 weeks, so 14-day deltas are halved to get per-week figures.
"""

from __future__ import annotations

from statistics import fmean

from backend.contract import DAYS, StoreType
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


def gbp_per_week(
    store_type: StoreType, delta_visits_14d: float, delta_kwh_14d: float, price: float
) -> float:
    """The owner's profit change per week: margin on the extra visits minus the extra energy
    bill. Positive = the owner is better off."""
    margin = delta_visits_14d / WEEKS_PER_RUN * SPEND_GBP_PER_VISIT[store_type] * GROSS_MARGIN
    energy_bill = delta_kwh_14d / WEEKS_PER_RUN * price
    return margin - energy_bill
