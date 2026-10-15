"""Per-store results, store stats and run KPIs (docs/BUILD_NOTES.md, "Energy and KPIs").

Clubs are fixed anchors: they get a StoreRunResult and StoreStats like every store, but they
are left out of the run KPIs and the city metrics.

The run KPIs and city metrics are computed from the rounded per-store values, so anyone can
recompute summary.json from stores.json + store_stats.json exactly (run_kpis, city_metrics).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from backend import timeutil
from backend.contract import DAYS, Kpis, StoreKpis, StoreRunResult
from backend.schemas import StoreConfig, StoreStats
from backend.sim import energy as energy_model
from backend.sim.engine import SimOutput, World

WEEKDAYS_IN_RUN = sum(not timeutil.is_weekend_day(d) for d in range(1, DAYS + 1))
WEEKEND_DAYS_IN_RUN = DAYS - WEEKDAYS_IN_RUN


@dataclass
class CityMetrics:
    demand_by_hour_kw: list[float]
    peak_kw: float
    peak_hour: int
    co2_kg: float
    energy_cost_gbp: float


@dataclass
class RunResults:
    stores: dict[str, StoreRunResult]
    stats: dict[str, StoreStats]
    kpis: Kpis
    city: CityMetrics
    footfall_by_hour: list[float]
    agents: dict[str, int]


def store_kwh(world: World, out: SimOutput) -> np.ndarray:
    """kWh per (store, day, hour) for the run's schedule."""
    schedule = out.schedule
    return energy_model.run_kwh(
        world.energy, world.stores, world.floor_area, schedule.open_fraction, schedule.lit
    )


def _round(values: np.ndarray, digits: int = 3) -> list[float]:
    return [round(float(v), digits) for v in values]


def build_results(world: World, configs: Mapping[str, StoreConfig], out: SimOutput) -> RunResults:
    """Everything a run reports, from one simulation. Needs a config for every store."""
    missing = [s.id for s in world.stores if s.id not in configs]
    if missing:
        raise ValueError(f"no config for stores: {missing}")
    n = world.n_stores
    by_hour = np.zeros((n, 24))
    weekday = np.zeros((n, 24))
    weekend = np.zeros((n, 24))
    visit_days: list[dict[str, set[int]]] = [defaultdict(set) for _ in range(n)]
    by_persona: list[Counter[str]] = [Counter() for _ in range(n)]
    for trip in out.trips:
        for store, t_in, _ in trip.visits:
            hour, day = (t_in // 60) % 24, timeutil.day_of(t_in)
            by_hour[store, hour] += 1
            (weekend if timeutil.is_weekend_day(day) else weekday)[store, hour] += 1
            visit_days[store][trip.agent_id].add(day)
            by_persona[store][trip.persona] += 1
    kwh = store_kwh(world, out)
    stores: dict[str, StoreRunResult] = {}
    stats: dict[str, StoreStats] = {}
    for i, s in enumerate(world.stores):
        config = configs[s.id]
        unique = len(visit_days[i])
        repeat = sum(len(days) >= 2 for days in visit_days[i].values())
        stores[s.id] = StoreRunResult(
            open=config.open,
            close=config.close,
            lighting=config.lighting,
            kpis=StoreKpis(
                visits=int(by_hour[i].sum()),
                kwh=round(float(kwh[i].sum()), 2),
                returnRate=round(repeat / unique, 4) if unique else 0.0,
            ),
            visitsByHour=_round(by_hour[i] / DAYS),
        )
        stats[s.id] = StoreStats(
            visitsByHourWeekday=_round(weekday[i] / WEEKDAYS_IN_RUN),
            visitsByHourWeekend=_round(weekend[i] / WEEKEND_DAYS_IN_RUN),
            footfallNearbyByHour=_round(out.footfall_near[i] / DAYS),
            foundClosedByHour=_round(out.found_closed[i] / DAYS),
            kwhByHour=_round(kwh[i].mean(axis=0)),
            uniqueVisitors=unique,
            repeatVisitors=repeat,
            visitsByPersona=dict(sorted(by_persona[i].items())),
            energyCostGbp=round(energy_model.cost_gbp(kwh[i], world.energy), 2),
            co2Kg=round(energy_model.co2_kg(kwh[i], world.energy), 2),
        )
    club_ids = {s.id for s in world.stores if s.type == "club"}
    returning = {t.agent_id for t in out.trips if t.returning}
    one_off = sum(not t.returning for t in out.trips)
    return RunResults(
        stores=stores,
        stats=stats,
        kpis=run_kpis(stores, stats, club_ids),
        city=city_metrics(stats, club_ids),
        footfall_by_hour=_round(out.area_footfall / DAYS),
        agents={"returning": len(returning), "oneOff": one_off, "total": len(returning) + one_off},
    )


def run_kpis(
    stores: Mapping[str, StoreRunResult], stats: Mapping[str, StoreStats], club_ids: set[str]
) -> Kpis:
    """Run KPIs from per-store results, clubs excluded. returnRate = sum of repeat visitors /
    sum of unique visitors over the stores."""
    ids = [sid for sid in stores if sid not in club_ids]
    visits = sum(stores[sid].kpis.visits for sid in ids)
    kwh = round(sum(stores[sid].kpis.kwh for sid in ids), 2)
    unique = sum(stats[sid].uniqueVisitors for sid in ids)
    repeat = sum(stats[sid].repeatVisitors for sid in ids)
    return Kpis(
        visits=visits,
        kwh=kwh,
        visitsPerKwh=round(visits / kwh, 4) if kwh > 0 else 0.0,
        returnRate=round(repeat / unique, 4) if unique else 0.0,
    )


def city_metrics(stats: Mapping[str, StoreStats], club_ids: set[str]) -> CityMetrics:
    """City demand curve (sum of stores by hour, average day), its peak, CO2 and energy cost."""
    ids = [sid for sid in stats if sid not in club_ids]
    curve = [
        round(sum(stats[sid].kwhByHour[h] for sid in ids), 3) if ids else 0.0 for h in range(24)
    ]
    peak_hour = int(np.argmax(curve))
    return CityMetrics(
        demand_by_hour_kw=curve,
        peak_kw=curve[peak_hour],
        peak_hour=peak_hour,
        co2_kg=round(sum(stats[sid].co2Kg for sid in ids), 2),
        energy_cost_gbp=round(sum(stats[sid].energyCostGbp for sid in ids), 2),
    )
