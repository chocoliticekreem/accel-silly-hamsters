"""Money maths for store advice, in one place: the insights engine uses it, the owner report will.

SPEND_GBP_PER_VISIT matches the frontend mock (apps/web/src/sim/economics.ts: SPEND_GBP). The mock
still uses a flat 30% margin and no wages; it only feeds the no-backend demo.
A run is 14 days = 2 weeks, so 14-day deltas are halved to get per-week figures.
"""

from __future__ import annotations

from statistics import fmean

from backend import settings, store, timeutil
from backend.contract import DAYS, StoreKpis, StoreRunResult, StoreType, Suggestion
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
# Gross margin: the share of takings left after the cost of the food, drink or goods sold. Wages
# are counted separately per open hour (below). Typical UK figures, our estimate per type, until
# the owner gives their own.
GROSS_MARGIN: dict[StoreType, float] = {
    "cafe": 0.65,
    "restaurant": 0.65,
    "takeaway": 0.60,
    "bar": 0.60,
    "shop": 0.35,
    "offlicence": 0.25,
    "club": 0.0,
}
# Wages for keeping the doors open one more hour: staff on shift x the UK National Living Wage
# (GBP 12.71 for 21+, from April 2026). Without it every extra hour looks free and the advice
# drifts to 24/7. Defaults by type until the owner gives their own rota.
NATIONAL_LIVING_WAGE_GBP = 12.71
STAFF_ON_SHIFT: dict[StoreType, int] = {
    "cafe": 1,
    "restaurant": 3,
    "takeaway": 2,
    "bar": 2,
    "shop": 1,
    "offlicence": 1,
    "club": 0,
}
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


def margin_per_visit(store_type: StoreType) -> float:
    """GBP one visit leaves after the cost of what was sold."""
    return SPEND_GBP_PER_VISIT[store_type] * GROSS_MARGIN[store_type]


def staff_gbp_per_open_hour(store_type: StoreType) -> float:
    return STAFF_ON_SHIFT[store_type] * NATIONAL_LIVING_WAGE_GBP


def profit_vs(store_type: StoreType, base: StoreKpis, now: StoreKpis, price: float) -> float:
    """One shop's profit change per week in a run (`now`) against another run (`base`), from
    their 14-day KPIs: gbp_per_week of the visit, kWh and open-hour differences."""
    return gbp_per_week(
        store_type,
        now.visits - base.visits,
        now.kwh - base.kwh,
        now.openHours - base.openHours,
        price,
    )


def window_minutes(open_hhmm: str, close_hhmm: str) -> int:
    """Minutes a daily window is open (a close at or before the open wraps past midnight)."""
    length = (timeutil.to_minutes(close_hhmm) - timeutil.to_minutes(open_hhmm)) % (24 * 60)
    return length or 24 * 60


def open_hours_delta(
    open_hours_14d: float, open_hhmm: str, close_hhmm: str, new_open: str, new_close: str
) -> float:
    """Change in the run's open hours when the daily window moves, scaled from the hours the
    shop was actually open (days it was shut stay shut)."""
    old = window_minutes(open_hhmm, close_hhmm)
    return open_hours_14d * (window_minutes(new_open, new_close) / old - 1)


def suggestion_open_hours_delta(result: StoreRunResult, change: Suggestion) -> float:
    """Open hours over the run that one open/close suggestion adds (lighting adds none)."""
    if change.field == "lighting":
        return 0.0
    new_open = change.to if change.field == "open" else result.open
    new_close = change.to if change.field == "close" else result.close
    return open_hours_delta(result.kpis.openHours, result.open, result.close, new_open, new_close)


def weekly_margin_gbp(store_type: StoreType, kpis: StoreKpis) -> float:
    """What the shop keeps per week from its customers (margin on takings, before energy)."""
    return kpis.visits / WEEKS_PER_RUN * margin_per_visit(store_type)


def gbp_per_week(
    store_type: StoreType,
    delta_visits_14d: float,
    delta_kwh_14d: float,
    delta_open_hours_14d: float,
    price: float,
) -> float:
    """The owner's profit change per week: margin on the extra visits minus the extra energy
    bill and the wages for the extra open hours. Positive = the owner is better off."""
    margin = delta_visits_14d / WEEKS_PER_RUN * margin_per_visit(store_type)
    energy_bill = delta_kwh_14d / WEEKS_PER_RUN * price
    wages = delta_open_hours_14d / WEEKS_PER_RUN * staff_gbp_per_open_hour(store_type)
    return margin - energy_bill - wages
