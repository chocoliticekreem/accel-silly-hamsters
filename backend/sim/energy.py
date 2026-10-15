"""Store energy, carbon and cost (docs/BUILD_NOTES.md, "Energy and KPIs").

kWh in a clock hour = open fraction x floorArea x kwhPerM2PerOpenHour[type]
                    + closed fraction x floorArea x standbyKwhPerM2PerHour[type]
                    + lightingKw[level]
Lighting costs energy whenever it is on, open or closed. One hour at that load is its kWh, so
an hourly kWh value is also the average kW in that hour (the city demand curve).
"""

from __future__ import annotations

import numpy as np

from backend.contract import Building, LightingLevel, MapStore, StoreType
from backend.schemas import EnergyFile

LEVELS: tuple[LightingLevel, ...] = ("off", "low", "high")


def floor_area(store: MapStore, building: Building | None) -> float:
    """m2 from map.json, else the building footprint (w x d)."""
    if store.floorArea is not None:
        return store.floorArea
    return building.w * building.d if building is not None else 0.0


def store_kwh(
    energy: EnergyFile,
    store_type: StoreType,
    area_m2: float,
    open_fraction: np.ndarray,
    lighting: np.ndarray,
) -> np.ndarray:
    """kWh per (day, hour). open_fraction: (days, 24) in 0..1; lighting: (days, 24) LEVELS index."""
    open_rate = energy.kwhPerM2PerOpenHour.get(store_type, 0.0)
    standby_rate = energy.standbyKwhPerM2PerHour.get(store_type, 0.0)
    light_kw = np.array([energy.lightingKw.get(level, 0.0) for level in LEVELS])
    base = open_fraction * area_m2 * open_rate + (1.0 - open_fraction) * area_m2 * standby_rate
    return base + light_kw[lighting]


def run_kwh(
    energy: EnergyFile,
    stores: list[MapStore],
    areas_m2: np.ndarray,
    open_fraction: np.ndarray,
    lighting: np.ndarray,
) -> np.ndarray:
    """kWh per (store, day, hour) for a whole run; inputs are (n_stores, days, 24)."""
    return np.stack(
        [
            store_kwh(energy, s.type, float(areas_m2[i]), open_fraction[i], lighting[i])
            for i, s in enumerate(stores)
        ]
    )


def co2_kg(kwh: np.ndarray, energy: EnergyFile) -> float:
    """Sum of kWh_h x carbon_h / 1000 over an array whose last axis is the clock hour."""
    return float((kwh * np.asarray(energy.carbonGPerKwh)).sum() / 1000.0)


def cost_gbp(kwh: np.ndarray, energy: EnergyFile) -> float:
    """Sum of kWh_h x price_h over an array whose last axis is the clock hour."""
    return float((kwh * np.asarray(energy.priceGbpPerKwh)).sum())
