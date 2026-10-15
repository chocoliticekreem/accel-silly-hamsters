"""Street events: what owners and citizens both see, per day (docs/OWNER_ACTIONS.md).

Deterministic per seed. Real-world sources would be TfL road disruptions, club and event listings;
in the sim they are generated here:

  roadworks      1-2 works on real shopping streets, 07:00-19:00 for 1-3 days. Citizens avoid the
                 street: stop-ins at its shops drop by `severity`. Severity >= CLOSED_SEVERITY
                 means the street is closed to shoppers.
  heavy_traffic  weekday rush hours on the main roads (the widest streets): fewer stop-ins.
  club_night     every club night from demand.json (already modelled: no extra effect).
  event          one weekend market day on a shopping street: more stop-ins.

Effects reach the sim through store_factors: a (n_stores, ticks) multiplier on each store's
choice weight. Footfall routes are unchanged (people still walk the street, they stop less).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

from backend import timeutil
from backend.contract import DAYS, MINUTES_PER_DAY
from backend.sim import citizens

if TYPE_CHECKING:
    from backend.sim.engine import World

CLOSED_SEVERITY = 0.85  # roadworks this severe close the street to shoppers
TRAFFIC_EFFECT = 0.8  # heavy traffic cuts stop-ins by TRAFFIC_EFFECT x severity
EVENT_EFFECT = 0.6  # a market day lifts stop-ins by EVENT_EFFECT x severity
WORKS_HOURS = ("07:00", "19:00")
RUSH_HOURS = (("07:30", "09:30"), ("16:30", "19:00"))
MARKET_HOURS = ("09:00", "17:00")


@dataclass(frozen=True)
class StreetEvent:
    day: int
    from_t: int  # sim minute
    to_t: int
    kind: str  # roadworks | heavy_traffic | club_night | event
    street_id: str
    label: str
    severity: float  # 0..1
    street: str = ""  # street key (name) whose shops it affects

    def to_json(self) -> dict:
        return {
            "day": self.day,
            "fromT": self.from_t,
            "toT": self.to_t,
            "kind": self.kind,
            "streetId": self.street_id,
            "label": self.label,
            "severity": self.severity,
        }


def street_key(name: str, street_id: str) -> str:
    """Streets split into several map ids share a name; events cover the whole named street."""
    return name or street_id


def store_streets(world: World) -> list[str]:
    """The street key each store's door faces (its nearest street segment)."""
    owners: list[str] = []
    segs: list[tuple[float, float, float, float]] = []
    for street in world.map.streets:
        for p, q in zip(street.points, street.points[1:], strict=False):
            if p != q:
                segs.append((*p, *q))
                owners.append(street_key(street.name, street.id))
    if not segs:
        return [""] * world.n_stores
    arr = np.asarray(segs, dtype=float)
    a, ab = arr[:, :2], arr[:, 2:] - arr[:, :2]
    out = []
    for x, z in world.doors:
        t = np.clip(((x - a[:, 0]) * ab[:, 0] + (z - a[:, 1]) * ab[:, 1]) / (ab**2).sum(1), 0, 1)
        proj = a + ab * t[:, None]
        out.append(owners[int(np.argmin(np.hypot(proj[:, 0] - x, proj[:, 1] - z)))])
    return out


def _window(day: int, hours: tuple[str, str]) -> tuple[int, int]:
    start = (day - 1) * MINUTES_PER_DAY
    return start + timeutil.to_minutes(hours[0]), start + timeutil.to_minutes(hours[1])


def generate(world: World, seed: int) -> list[StreetEvent]:
    """The run's street events, oldest first. Same world + seed gives the same events."""
    rng = citizens.rng_for(seed, "street-events")
    streets: dict[str, str] = {}  # key -> first map id with that name
    widths: dict[str, float] = {}
    for street in world.map.streets:
        key = street_key(street.name, street.id)
        streets.setdefault(key, street.id)
        widths[key] = max(widths.get(key, 0.0), street.width)
    on_street = store_streets(world)
    shops = Counter(k for k, club in zip(on_street, world.is_club, strict=True) if not club and k)
    events: list[StreetEvent] = []

    # Roadworks: the busiest shopping streets are the likeliest to be dug up.
    candidates = sorted(shops, key=lambda k: (-shops[k], k))
    works_streets: list[str] = []
    if candidates:
        weights = np.array([shops[k] for k in candidates], dtype=float)
        n_works = min(len(candidates), 2)
        picks = rng.choice(len(candidates), size=n_works, replace=False, p=weights / weights.sum())
        for n, pick in enumerate(sorted(int(p) for p in picks)):
            key = candidates[pick]
            works_streets.append(key)
            start = int(rng.integers(3, 12))
            length = int(rng.integers(1, 4))
            low, high = (0.55, 0.75) if n == 0 else (0.5, 0.95)
            severity = round(float(rng.uniform(low, high)), 2)
            closed = severity >= CLOSED_SEVERITY
            label = f"{'Street closed for works' if closed else 'Roadworks'}, {key}"
            for day in range(start, min(start + length, DAYS + 1)):
                f, t = _window(day, WORKS_HOURS)
                events.append(
                    StreetEvent(day, f, t, "roadworks", streets[key], label, severity, key)
                )

    # Heavy traffic: weekday rush hours on the main roads.
    widest = max(widths.values(), default=0.0)
    main_roads = sorted(k for k, w in widths.items() if w >= widest and widest > 0)
    for day in range(1, DAYS + 1):
        if timeutil.is_weekend_day(day):
            continue
        for hours in RUSH_HOURS:
            f, t = _window(day, hours)
            for key in main_roads:
                severity = round(float(rng.uniform(0.25, 0.6)), 2)
                label = f"Heavy traffic, {key}"
                events.append(
                    StreetEvent(day, f, t, "heavy_traffic", streets[key], label, severity, key)
                )

    # Club nights (from demand.json; the sim already models them).
    for i, nights in sorted(world.club_nights.items()):
        club = world.stores[i]
        key = on_street[i]
        cap = max((n.capacity for ns in world.club_nights.values() for n in ns), default=1)
        for day in range(1, DAYS + 1):
            for night in nights:
                if timeutil.weekday_of_day(day) not in night.days:
                    continue
                f = (day - 1) * MINUTES_PER_DAY + timeutil.to_minutes(night.open)
                length = (
                    timeutil.to_minutes(night.close) - timeutil.to_minutes(night.open)
                ) % MINUTES_PER_DAY or MINUTES_PER_DAY
                events.append(
                    StreetEvent(
                        day,
                        f,
                        f + length,
                        "club_night",
                        streets.get(key, key),
                        f"Club night, {club.name}",
                        round(min(1.0, night.capacity / max(cap, 1)), 2),
                        key,
                    )
                )

    # One weekend market day on a shopping street without works.
    market = [k for k in candidates if k not in works_streets] or candidates
    if market:
        key = market[0]
        day = int(
            rng.choice([d for d in range(1, DAYS + 1) if timeutil.weekday_of_day(d) == "sun"])
        )
        f, t = _window(day, MARKET_HOURS)
        severity = round(float(rng.uniform(0.4, 0.7)), 2)
        events.append(
            StreetEvent(day, f, t, "event", streets[key], f"Market day, {key}", severity, key)
        )

    return sorted(events, key=lambda e: (e.from_t, e.kind, e.street_id))


def store_factors(world: World, events: list[StreetEvent], ticks: int) -> np.ndarray:
    """(n_stores, ticks) multiplier on each store's choice weight from the street events."""
    factor = np.ones((world.n_stores, ticks))
    on_street = np.array(store_streets(world), dtype=object)
    for e in events:
        if e.kind == "roadworks":
            mult = 1.0 - e.severity
        elif e.kind == "heavy_traffic":
            mult = 1.0 - TRAFFIC_EFFECT * e.severity
        elif e.kind == "event":
            mult = 1.0 + EVENT_EFFECT * e.severity
        else:
            continue
        rows = np.flatnonzero((on_street == e.street) & ~world.is_club)
        lo, hi = e.from_t // citizens.TICK, min(e.to_t // citizens.TICK, ticks)
        factor[rows, lo:hi] *= mult
    return factor
