"""energy.json: store energy by type, facade lighting load, London grid carbon and power price.

Where each field comes from (the file's notes repeat every figure with its citation):
  carbonGPerKwh           NESO Carbon Intensity API, London region (regionid 13): the last 28 whole
                          UTC days of half-hourly regional estimates, averaged per Europe/London
                          clock hour. If the API cannot be used, a labelled snapshot is written
                          instead and fallback=True (the flag describes the carbon profile only).
  kwhPerM2PerOpenHour     annual electricity intensity per store type (DESNZ ND-NEED 2026 metered
  standbyKwhPerM2PerHour  medians; CIBSE TM46:2008 for refrigeration-led types and clubs), split
                          between open and closed hours with typical hours and a standby share
                          (both stated assumptions) so a store kept to typical hours reproduces it.
  lightingKw              facade + window lighting by level: an LED component estimate (assumption).
  priceGbpPerKwh          DESNZ QEP table 3.4.2, 2025 non-domestic prices, flat over the day.

The non-domestic EPC register named in the brief needs a GOV.UK One Login bearer token, which this
build does not have; EPC_NOTE says why metered medians are the better source anyway.
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, get_args
from zoneinfo import ZoneInfo

from backend import cache, store
from backend.contract import LightingLevel, Source, StoreType
from backend.pipeline.common import FetchError, cite, fetch, write_processed
from backend.schemas import EnergyFile
from backend.timeutil import open_hours_fraction

log = logging.getLogger(__name__)

STEP = "energy"
STORE_TYPES: tuple[StoreType, ...] = get_args(StoreType)
HOURS_PER_YEAR = 8760
LONDON_TZ = ZoneInfo("Europe/London")

# --- carbon intensity -----------------------------------------------------------------------

CARBON_API = "https://api.carbonintensity.org.uk"
CARBON_DOCS = "https://carbon-intensity.github.io/api-definitions/"
LONDON_REGION_ID = 13
CARBON_WINDOW_DAYS = 28
# The docs cap the national from/to query at 14 days and say nothing for the regional one, so
# requests stay inside the documented limit.
CARBON_CHUNK_DAYS = 14
MIN_READINGS_PER_HOUR = 14  # a week of both half-hours, or that hour's mean is not trusted

# Written only when the API cannot be used: the profile this module computed from the live API
# on 2026-10-15. It is labelled as a stale snapshot wherever it is written.
CARBON_FALLBACK_WINDOW = "2026-09-17 to 2026-10-14"
CARBON_FALLBACK: tuple[float, ...] = (
    151.2, 144.0, 140.5, 140.1, 144.3, 153.2, 165.3, 166.9, 150.8, 130.0, 110.0, 99.3,
    96.1, 94.8, 99.6, 117.3, 145.6, 172.2, 187.8, 184.9, 177.4, 168.0, 158.6, 157.4,
)  # fmt: skip
CARBON_FALLBACK_SOURCE = cite(
    "FALLBACK: snapshot of the NESO Carbon Intensity API London profile, "
    f"{CARBON_FALLBACK_WINDOW} (computed 2026-10-15)",
    CARBON_DOCS,
)

# --- store energy by type -------------------------------------------------------------------

ND_NEED_2026 = cite(
    "DESNZ ND-NEED 2026, England and Wales (published 30 Sep 2026): median electricity "
    "intensity by building use from metered 2024 consumption",
    "https://assets.publishing.service.gov.uk/media/"
    "6abcf5f355bc01d752a7f136/nd-need-2026-report.pdf",
)
CIBSE_TM46 = cite(
    "CIBSE TM46:2008 Energy benchmarks (typical electricity and fossil, kWh/m2 GIA per year)",
    "https://www.cibse.org/knowledge-research/knowledge-portal/tm46-energy-benchmarks",
)
TM46_REPRODUCTION = cite(
    "Clark (2013) What Colour is Your Building?, Appendix C, Tables C.4, C.6 and C.10: "
    "reproduces the TM46:2008 rows used here",
    "https://bluepools.co.uk/SiteAssets/AHU%27s/Energy%20Consumption%20Data.pdf",
)


@dataclass(frozen=True)
class TypeBasis:
    """What one store type's open and standby rates are derived from (copied into the notes)."""

    annual_kwh_per_m2: float  # electricity per m2 of floor area per year
    benchmark: str  # the published figure behind annual_kwh_per_m2
    typical_hours: tuple[str, str]  # map.json fallback defaultHours (assumption)
    days_per_year: float
    standby_share: float  # closed-hours load as a share of the open-hours load (assumption)
    standby_reason: str


# debt: cafe, restaurant and bar share one metered hospitality median. ceiling: per-type
# differences come only from hours and standby share. upgrade: when per-type metered intensities
# (BEES sub-sector tables or real store bills) are available.
HOSPITALITY = "ND-NEED 2026 Hospitality median, metered 2024"
TYPE_BASES: dict[StoreType, TypeBasis] = {
    "cafe": TypeBasis(
        160.0,
        HOSPITALITY,
        ("07:00", "18:00"),
        365,
        0.20,
        "display chillers and fridges stay on overnight; the espresso machine is on a timer",
    ),
    "restaurant": TypeBasis(
        160.0,
        HOSPITALITY,
        ("12:00", "23:00"),
        365,
        0.15,
        "only the walk-in fridge and freezer run while kitchen and dining room are off",
    ),
    "takeaway": TypeBasis(
        310.0,
        "TM46 Small food store: TM46 has no takeaway category and this is the closest "
        "all-electric, refrigerated counter-service format",
        ("11:00", "23:00"),
        365,
        0.30,
        "fridges, freezers and drinks chillers on a small floor area",
    ),
    "bar": TypeBasis(
        160.0,
        HOSPITALITY,
        ("16:00", "00:00"),
        365,
        0.25,
        "cellar cooling and bottle fridges run around the clock",
    ),
    "shop": TypeBasis(
        108.0,
        "ND-NEED 2026 Shops median, metered 2024",
        ("10:00", "19:00"),
        365,
        0.20,
        "a mix of corner shops with drinks chillers and non-food shops with little left on",
    ),
    "offlicence": TypeBasis(
        310.0,
        "TM46 Small food store",
        ("08:00", "23:00"),
        365,
        0.40,
        "glass-door drinks chillers dominate the load and never switch off",
    ),
    "club": TypeBasis(
        150.0,
        "TM46 Entertainment halls, the closest category for a late-night music venue",
        ("22:00", "03:00"),
        156,
        0.10,
        "cellar cooling and bar fridges against a large sound, lighting and ventilation load; "
        "3 club nights a week",
    ),
}

DERIVATION_NOTE = (
    "kWh/m2 derivation: E = annual electricity intensity, H = typical open hours per year, "
    "f = standby share (closed-hours load / open-hours load). open = E / (H + f x (8760 - H)) and "
    "standby = f x open, so a store kept to its typical hours uses exactly E a year; dividing E "
    "by H alone would count the closed-hours load twice. Each extra open hour costs "
    "(open - standby) per m2."
)
CROSS_CHECK_NOTE = (
    "Cross-check, CIBSE TM46:2008 typical electricity (kWh/m2 GIA/yr): Restaurant 90 and Bar or "
    "pub 130 (both assume gas cooking and heating: fossil 370 and 350), General retail 165, Small "
    "food store 310, Entertainment halls 150. TM46 Restaurant would put a 100 m2 cafe at ~25 "
    "kWh/day, below an all-electric espresso cafe, so cafes, restaurants and bars use the metered "
    "ND-NEED hospitality median (ND-NEED publishes no split within hospitality)."
)
OVERLAP_NOTE = (
    "Benchmarks cover a building's whole electricity use including its lighting. Facade and "
    "window lighting (lightingKw) is added on top, so stores with lights on most hours model "
    "slightly above their benchmark."
)
FLOOR_AREA_NOTE = (
    "Floor area bases differ: ND-NEED divides by VOA floor area, TM46 by gross internal area, "
    "and map.json floor areas come from footprints. Clark (2013) puts the spread between "
    "measurement bases at up to ~25%, inside the benchmark uncertainty."
)

# --- facade and window lighting -------------------------------------------------------------

LIGHTING_KW: dict[LightingLevel, float] = {"off": 0.0, "low": 0.25, "high": 0.6}
LIGHTING_NOTE = (
    "lightingKw (assumption: LED fittings on a typical small shopfront, independent of floor "
    "area): off = 0; low 0.25 kW = illuminated fascia sign 0.10 + window display dimmed 0.15; "
    "high 0.60 kW = sign 0.10 + window display at full 0.30 + facade wall-washers and canopy "
    "0.20. Older halogen fittings would draw 2-3x more."
)

# --- electricity price ----------------------------------------------------------------------

DESNZ_PRICES = cite(
    "DESNZ QEP table 3.4.2: prices of fuels purchased by non-domestic consumers in the UK, "
    "including CCL (published 29 Sep 2026)",
    "https://www.gov.uk/government/statistical-data-sets/"
    "gas-and-electricity-prices-in-the-non-domestic-sector",
)
# 2025 annual averages, pence per kWh, including Climate Change Levy, excluding VAT.
# debt: one flat average delivered price for every store and hour. ceiling: ignores time-of-use
# tariffs and overstates the marginal unit rate. upgrade: when a store shares its own tariff.
PRICE_2025_VERY_SMALL_PENCE = 34.93  # 0-20 MWh/yr
PRICE_2025_SMALL_PENCE = 29.09  # 20-499 MWh/yr
PRICE_GBP_PER_KWH = round((PRICE_2025_VERY_SMALL_PENCE + PRICE_2025_SMALL_PENCE) / 2 / 100, 4)
PRICE_NOTE = (
    f"priceGbpPerKwh: flat £{PRICE_GBP_PER_KWH}/kWh, the midpoint of DESNZ QEP 3.4.2 2025 annual "
    "non-domestic electricity prices incl. CCL, excl. VAT: Very Small band (0-20 MWh/yr) "
    f"{PRICE_2025_VERY_SMALL_PENCE} p/kWh and Small band (20-499 MWh/yr) "
    f"{PRICE_2025_SMALL_PENCE} p/kWh, because the modelled independents straddle the 20 MWh/yr "
    "boundary. These are average delivered prices (standing charges spread per kWh), so the "
    "unit rate a saved kWh avoids is somewhat lower. DESNZ publishes no time-of-day split, "
    "hence flat. DESNZ flags the Very Small series as subject to revision."
)

EPC_NOTE = (
    "EPC: the non-domestic EPC register (epc.opendatacommunities.org) now redirects to "
    "get-energy-performance-data.communities.gov.uk, whose API needs a GOV.UK One Login bearer "
    "token (checked 2026-10-15; this build has none), so it is not used. Non-domestic EPCs are "
    "modelled asset ratings, not metered use, so metered ND-NEED medians are the closer source."
)
FALLBACK_SCOPE_NOTE = (
    "fallback describes the carbon profile only: True means the API could not be used and the "
    "snapshot was written. Intensities, lighting and price are published figures plus the "
    "assumptions stated here in every build."
)
STATIC_NOTES = (
    DERIVATION_NOTE,
    CROSS_CHECK_NOTE,
    OVERLAP_NOTE,
    FLOOR_AREA_NOTE,
    LIGHTING_NOTE,
    PRICE_NOTE,
    EPC_NOTE,
    FALLBACK_SCOPE_NOTE,
)


# --- derivations ----------------------------------------------------------------------------


def typical_open_hours(basis: TypeBasis) -> float:
    """Open hours per year at the type's typical hours."""
    return sum(open_hours_fraction(*basis.typical_hours)) * basis.days_per_year


def type_rates(basis: TypeBasis) -> tuple[float, float]:
    """(kWh per m2 per open hour, kWh per m2 per closed hour) for one store type.

    The annual figure is split so a store kept to its typical hours reproduces it exactly:
    annual = open_rate * open_hours + standby_share * open_rate * closed_hours.
    """
    open_hours = typical_open_hours(basis)
    closed_hours = HOURS_PER_YEAR - open_hours
    open_rate = basis.annual_kwh_per_m2 / (open_hours + basis.standby_share * closed_hours)
    return open_rate, basis.standby_share * open_rate


def type_note(store_type: StoreType, basis: TypeBasis) -> str:
    open_rate, standby_rate = type_rates(basis)
    open_hours = typical_open_hours(basis)
    hours_per_day = open_hours / basis.days_per_year
    day_kwh = 100 * (open_rate * hours_per_day + standby_rate * (24 - hours_per_day))
    open_at, close_at = basis.typical_hours
    return (
        f"{store_type}: {basis.annual_kwh_per_m2:g} kWh/m2/yr ({basis.benchmark}); open "
        f"{open_at}-{close_at} ({hours_per_day:g} h) on {basis.days_per_year:g} days = "
        f"{open_hours:g} h/yr (assumption); standby share {basis.standby_share:g} "
        f"({basis.standby_reason}) -> {open_rate:.4f} kWh/m2 per open hour, {standby_rate:.4f} "
        f"closed; 100 m2 on an open day = {day_kwh:.1f} kWh before facade lighting."
    )


# --- carbon intensity -----------------------------------------------------------------------


@dataclass(frozen=True)
class CarbonProfile:
    hourly: list[float]
    sources: list[Source]
    note: str
    live: bool


def carbon_window(now: datetime) -> tuple[datetime, datetime]:
    """[start, end) covering the last CARBON_WINDOW_DAYS whole UTC days before `now`."""
    end = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return end - timedelta(days=CARBON_WINDOW_DAYS), end


def _api_time(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%MZ")


def _parse_api_time(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC)


def parse_regional_rows(body: Any) -> list[tuple[datetime, float]]:
    """(period start, gCO2/kWh) pairs from a regional from/to response for one region.

    The live API returns `data` as one region object while the docs show a one-item list; both
    are accepted. Regional values are model estimates ("forecast"): no regional "actual" exists.
    Raises KeyError, IndexError, TypeError or ValueError on a malformed body.
    """
    region = body["data"]
    if isinstance(region, list):
        region = region[0]
    rows = []
    for row in region["data"]:
        value = row["intensity"].get("forecast")
        if value is not None:
            rows.append((_parse_api_time(row["from"]), float(value)))
    return rows


def fetch_london_intensity(
    start: datetime, end: datetime
) -> tuple[dict[datetime, float], list[Source]]:
    """Half-hourly London intensity keyed by period start (UTC) for [start, end), with citations.

    Fetched in CARBON_CHUNK_DAYS pieces through the scrape cache. Each response also carries the
    half-hour ending at its `from`, so rows outside the piece are dropped. Raises FetchError.
    """
    readings: dict[datetime, float] = {}
    sources: list[Source] = []
    piece_start = start
    while piece_start < end:
        piece_end = min(piece_start + timedelta(days=CARBON_CHUNK_DAYS), end)
        url = (
            f"{CARBON_API}/regional/intensity/{_api_time(piece_start)}/{_api_time(piece_end)}"
            f"/regionid/{LONDON_REGION_ID}"
        )
        body, fetched_at = fetch("carbon", url, headers={"Accept": "application/json"})
        for period_start, value in parse_regional_rows(body):
            if piece_start <= period_start < piece_end:
                readings[period_start] = value
        last_day = piece_end - timedelta(days=1)
        label = (
            f"NESO Carbon Intensity API (CC BY 4.0), London regionid {LONDON_REGION_ID}, "
            f"half-hourly estimates {piece_start:%Y-%m-%d} to {last_day:%Y-%m-%d}"
        )
        sources.append(cite(label, url, fetched_at))
        piece_start = piece_end
    return readings, sources


def hourly_profile(readings: dict[datetime, float]) -> list[float]:
    """Mean intensity per Europe/London clock hour (index = hour).

    Raises ValueError when any hour has fewer than MIN_READINGS_PER_HOUR readings.
    """
    by_hour: list[list[float]] = [[] for _ in range(24)]
    for period_start, value in readings.items():
        by_hour[period_start.astimezone(LONDON_TZ).hour].append(value)
    thin = [hour for hour, values in enumerate(by_hour) if len(values) < MIN_READINGS_PER_HOUR]
    if thin:
        raise ValueError(f"fewer than {MIN_READINGS_PER_HOUR} readings for clock hours {thin}")
    return [round(sum(values) / len(values), 1) for values in by_hour]


def carbon_profile(now: datetime) -> CarbonProfile:
    """The live London profile for the window before `now`, or the labelled snapshot."""
    start, end = carbon_window(now)
    try:
        readings, sources = fetch_london_intensity(start, end)
        hourly = hourly_profile(readings)
    except (FetchError, KeyError, IndexError, TypeError, ValueError) as e:
        log.warning("carbon intensity unavailable, writing the snapshot profile: %s", e)
        return CarbonProfile(
            hourly=list(CARBON_FALLBACK),
            sources=[CARBON_FALLBACK_SOURCE],
            note=(
                f"carbonGPerKwh: FALLBACK. Carbon Intensity API unusable ({e}); this is a "
                f"snapshot of the London profile for {CARBON_FALLBACK_WINDOW} (UTC days) that "
                "this module computed from the API on 2026-10-15. Not current data."
            ),
            live=False,
        )
    low = min(range(24), key=hourly.__getitem__)
    high = max(range(24), key=hourly.__getitem__)
    last_day = end - timedelta(days=1)
    note = (
        f"carbonGPerKwh: live. Mean of {len(readings)} half-hourly London (regionid "
        f"{LONDON_REGION_ID}) estimates, {start:%Y-%m-%d} to {last_day:%Y-%m-%d} (UTC days), "
        f"grouped by Europe/London clock hour: lowest {hourly[low]:g} g at {low:02d}:00, highest "
        f"{hourly[high]:g} g at {high:02d}:00. Regional values are NESO model estimates (the "
        "API's 'forecast'; no regional 'actual' is published)."
    )
    return CarbonProfile(hourly=hourly, sources=sources, note=note, live=True)


# --- build ----------------------------------------------------------------------------------


def energy_file(now: datetime) -> EnergyFile:
    """Assemble energy.json, fetching the carbon window that ends before `now`."""
    carbon = carbon_profile(now)
    rates = {t: type_rates(TYPE_BASES[t]) for t in STORE_TYPES}
    return EnergyFile(
        kwhPerM2PerOpenHour={t: round(open_rate, 5) for t, (open_rate, _) in rates.items()},
        standbyKwhPerM2PerHour={t: round(standby, 5) for t, (_, standby) in rates.items()},
        lightingKw=dict(LIGHTING_KW),
        carbonGPerKwh=carbon.hourly,
        priceGbpPerKwh=[PRICE_GBP_PER_KWH] * 24,
        sources=[*carbon.sources, ND_NEED_2026, CIBSE_TM46, TM46_REPRODUCTION, DESNZ_PRICES],
        fallback=not carbon.live,
        notes=[
            carbon.note,
            *(type_note(t, TYPE_BASES[t]) for t in STORE_TYPES),
            *STATIC_NOTES,
        ],
    )


def _cache_inputs() -> dict[str, Any]:
    """Everything that shapes energy.json apart from the live carbon readings."""
    return {
        "types": {t: asdict(b) for t, b in TYPE_BASES.items()},
        "lightingKw": LIGHTING_KW,
        "priceGbpPerKwh": PRICE_GBP_PER_KWH,
        "carbon": {
            "region": LONDON_REGION_ID,
            "days": CARBON_WINDOW_DAYS,
            "fallback": CARBON_FALLBACK,
        },
        "notes": STATIC_NOTES,
    }


def build(refresh: bool = False) -> EnergyFile:
    """Build data/processed/energy.json.

    Reuses the file while the constants above are unchanged, so runs stay comparable. Rebuilds on
    refresh, when a constant changes, or when the last build fell back (so the next run retries
    the Carbon Intensity API). Re-fetching instead of reading data/raw is the cache policy's
    job: callers set cache.set_policy(refresh=True), as pipeline.run_all and main() do.
    """
    inputs = _cache_inputs()
    if not refresh and cache.pipeline_up_to_date(STEP, inputs):
        existing = store.load_energy()
        if not existing.fallback:
            return existing
    energy = energy_file(datetime.now(UTC))
    write_processed("energy.json", energy)
    cache.pipeline_mark(STEP, inputs)
    return energy


def main() -> None:
    parser = argparse.ArgumentParser(description="Build data/processed/energy.json")
    parser.add_argument("--refresh", action="store_true", help="re-fetch instead of data/raw")
    args = parser.parse_args()
    cache.set_policy(refresh=args.refresh)
    energy = build(refresh=args.refresh)
    carbon = energy.carbonGPerKwh
    low = min(range(24), key=carbon.__getitem__)
    high = max(range(24), key=carbon.__getitem__)
    print(
        f"energy.json: fallback={energy.fallback}, carbon {carbon[low]:g} g at {low:02d}:00 to "
        f"{carbon[high]:g} g at {high:02d}:00, price £{energy.priceGbpPerKwh[0]}/kWh"
    )


if __name__ == "__main__":
    main()
