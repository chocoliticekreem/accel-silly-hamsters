"""Citizens: who arrives when (the arrival plan), the returning pool with memory, store choice.

Determinism. Every random draw comes from a numpy Generator keyed by (seed, stream, ...) through
SeedSequence, so draws for one day, entry, club night or trip never depend on another's. The
arrival plan (counts, times, personas, returning or one-off, pool member, stops) uses only the
seed and the data, never the store configs, so changing one store's hours cannot reshuffle who
arrives. Store choice is an exponential race: every candidate store gets an Exp(1) draw in a
fixed order and the lowest draw / weight wins. That is exact weighted sampling, and changing one
store's weight only changes trips where that store wins or stops winning.
"""

from __future__ import annotations

import math
import zlib
from dataclasses import dataclass

import numpy as np

from backend import timeutil
from backend.contract import DAYS, MINUTES_PER_DAY, EntryPoint, MapStore
from backend.schemas import DemandFile, Persona

TICK = 5
TICKS_PER_HOUR = 60 // TICK

# demand.json carries sim-scale arrival rates (BUILD_NOTES: 2,000-4,000 a weekday on the 1.5 km
# map); the renderer and the day-file budget (< 3 MB) take at most ~4,000 general arrivals a day.
# The sim keeps demand's shape (entry x hour x weekday/weekend) and scales its level into this
# band of general arrivals per day (club-goers come on top).
GENERAL_ARRIVALS_PER_DAY = (550.0, 4000.0)
# Club-goers per club night = ClubNight.capacity x this. demand.json writes capacity in sim
# agents already, so 1.0; raise it only to exaggerate the spill-out crowd for a demo.
CLUB_ATTENDANCE_SCALE = 1.0
CLUB_SPILL_SHARE = 0.7  # of club-goers still inside at close (the spill-out crowd)
CLUB_ARRIVAL_LEAD_MIN = 30  # first club-goers arrive this long before doors open

# Store choice.
DECAY_M = 150.0  # distance decay length for ordinary stops
LATE_DECAY_M = 80.0  # post-club food/drink: only what is close by
VISIBLE_M = 50.0  # an agent can see whether a store this close is open
OUTSIDE_WEIGHT = 0.15  # weight of "no store, move on" in every choice
NIGHT_HOURS = frozenset([*range(17, 24), *range(0, 7)])
LIGHT_EFFECT = {"off": -0.6, "low": 0.0, "high": 0.6}  # x lightingSensitivity, open + night only
LATE_FOOD_TYPES = ("takeaway", "bar", "offlicence")
LATE_LIGHT_SENSITIVITY = 0.8  # floor on sensitivity for post-club food seekers
SPILL_FOOD_PROB = 0.75  # spill-out agents who look for late food/drink at all

# Memory of returning agents.
HOUR_BAND = 3  # found-closed memory is kept per store x 3-hour band
CLOSED_PENALTY = 0.2  # weight multiplier per remembered found-closed (capped below)
CLOSED_MEMORY_CAP = 3
SATISFACTION_LEARN = 0.5  # satisfaction moves this far toward 1 after each visit
SATISFACTION_BOOST = 1.0  # weight multiplier up to (1 + boost) for a fully satisfied regular

# Exits: back the way they came is likelier; nearer exits are likelier.
EXIT_DECAY_M = 200.0
ORIGIN_EXIT_BONUS = 3.0

N_BANDS = 24 // HOUR_BAND


def rng_for(seed: int, *keys: int | str) -> np.random.Generator:
    """An independent Generator per key tuple (strings hashed with crc32, stable across runs)."""
    entropy = [seed % 2**63] + [k if isinstance(k, int) else zlib.crc32(k.encode()) for k in keys]
    return np.random.default_rng(np.random.SeedSequence(entropy))


def ceil_tick(t: int) -> int:
    return -(-t // TICK) * TICK


def band_of(minute: int) -> int:
    return (minute % MINUTES_PER_DAY) // 60 // HOUR_BAND


@dataclass
class PersonaModel:
    """A persona with its data pre-resolved against this map's stores and entries."""

    index: int
    persona: Persona
    active: np.ndarray  # (24,) arrival weight by hour, normalised to sum 1
    entry_kind: dict[str, float]  # normalised over street/station
    prefs: np.ndarray  # (n_stores,) preference for each store's type; 0 for clubs
    late_prefs: np.ndarray  # (n_stores,) post-club food/drink preference
    dwell: np.ndarray  # (n_stores, 2) min/max dwell minutes
    returning_p: float  # probability an arrival of this persona is a regular

    @property
    def id(self) -> str:
        return self.persona.id


def persona_models(
    personas: list[Persona], stores: list[MapStore], demand: DemandFile
) -> list[PersonaModel]:
    """Resolve personas against the stores; scale returningProb so the expected returning share
    of arrivals matches demand.returningShare."""
    mean_returning = sum(p.share * p.returningProb for p in personas) / max(
        1e-9, sum(p.share for p in personas)
    )
    factor = demand.returningShare / mean_returning if mean_returning > 0 else 0.0
    models = []
    for i, p in enumerate(personas):
        active = np.asarray(p.activeHours, dtype=float)
        active = active / active.sum() if active.sum() > 0 else np.full(24, 1 / 24)
        kinds_total = sum(p.entryKinds.values())
        entry_kind: dict[str, float] = (
            {k: v / kinds_total for k, v in p.entryKinds.items()}
            if kinds_total > 0
            else {"street": 0.5, "station": 0.5}
        )
        prefs = np.array(
            [0.0 if s.type == "club" else p.storePrefs.get(s.type, 0.0) for s in stores]
        )
        late = np.array(
            [p.storePrefs.get(s.type, 0.0) if s.type in LATE_FOOD_TYPES else 0.0 for s in stores]
        )
        dwell = np.array([p.dwellMinutes.get(s.type, (10, 30)) for s in stores], dtype=float)
        models.append(
            PersonaModel(
                index=i,
                persona=p,
                active=active,
                entry_kind=entry_kind,
                prefs=prefs,
                late_prefs=late,
                dwell=dwell.reshape(-1, 2),
                returning_p=min(1.0, max(0.0, p.returningProb * factor)),
            )
        )
    return models


# --- the returning pool -------------------------------------------------------------------------


@dataclass
class Memory:
    closed: np.ndarray  # (n_stores, N_BANDS) remembered found-closed count
    satisfaction: np.ndarray  # (n_stores,) 0..1

    @classmethod
    def empty(cls, n_stores: int) -> Memory:
        return cls(np.zeros((n_stores, N_BANDS), dtype=np.int8), np.zeros(n_stores))

    def factor(self, minute: int) -> np.ndarray:
        """Multiplier on every store's choice weight from this regular's experience."""
        closed = self.closed[:, band_of(minute)]
        return (1.0 + SATISFACTION_BOOST * self.satisfaction) * CLOSED_PENALTY**closed

    def found_closed(self, store: int, minute: int) -> None:
        b = band_of(minute)
        self.closed[store, b] = min(CLOSED_MEMORY_CAP, self.closed[store, b] + 1)

    def visited(self, store: int, minute: int) -> None:
        self.closed[store, band_of(minute)] = 0
        self.satisfaction[store] += SATISFACTION_LEARN * (1.0 - self.satisfaction[store])


@dataclass
class Regular:
    id: str
    persona: int
    memory: Memory
    busy_until: int = -1  # minute the regular's last trip ended


def build_pool(models: list[PersonaModel], size: int, n_stores: int) -> list[Regular]:
    """Fixed pool of regulars; persona mix proportional to share x returningProb (largest
    remainder, no randomness, so the pool is identical for every seed)."""
    weights = np.array([m.persona.share * m.persona.returningProb for m in models])
    if size <= 0 or weights.sum() <= 0:
        return []
    exact = weights / weights.sum() * size
    counts = np.floor(exact).astype(int)
    for i in np.argsort(-(exact - counts), kind="stable")[: size - counts.sum()]:
        counts[i] += 1
    pool: list[Regular] = []
    for model, count in zip(models, counts, strict=True):
        for _ in range(count):
            pool.append(Regular(f"r{len(pool) + 1}", model.index, Memory.empty(n_stores)))
    return pool


# --- the arrival plan ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClubVisit:
    store: int  # store index of the club
    opens: int  # sim minute the doors open
    leave: int  # sim minute this club-goer leaves (on the tick grid)
    spill: bool  # still inside at close: part of the spill-out crowd


@dataclass(frozen=True)
class Arrival:
    day: int  # plan day (a club night belongs to the day it starts)
    t: int  # spawn minute, on the tick grid
    entry: int  # entry index (into World.entries)
    persona: int
    agent_id: str
    returning: bool
    stops: int  # ordinary store stops wanted on this trip
    club: ClubVisit | None = None


class _Availability:
    """When each regular can next be picked: one trip a day, and an evening or club trip keeps
    them out until 08:00 the next day, so a regular's trips never overlap in time."""

    def __init__(self, by_persona: dict[int, list[Regular]]) -> None:
        self.members = by_persona
        # Per persona, aligned with its members: the minute each one is free again.
        self.free_from = {p: np.full(len(m), -1, dtype=np.int64) for p, m in by_persona.items()}

    def pick(
        self, rng: np.random.Generator, persona: int, t: int, block_until: int
    ) -> Regular | None:
        """A uniformly random free member of the persona (in pool order), or None."""
        if persona not in self.members:
            return None
        free = np.flatnonzero(self.free_from[persona] <= t)
        if len(free) == 0:
            return None
        chosen = int(free[int(rng.integers(len(free)))])
        self.free_from[persona][chosen] = block_until
        return self.members[persona][chosen]


def arrival_scale(demand: DemandFile, entries: list[EntryPoint]) -> float:
    """Factor that brings demand.json's mean daily arrivals into GENERAL_ARRIVALS_PER_DAY."""
    ids = {e.id for e in entries}
    weekday = sum(sum(d.weekday) for k, d in demand.entryPoints.items() if k in ids)
    weekend = sum(sum(d.weekend) for k, d in demand.entryPoints.items() if k in ids)
    days = range(1, DAYS + 1)
    mean = sum(weekend if timeutil.is_weekend_day(d) else weekday for d in days) / len(days)
    if mean <= 0:
        return 0.0
    low, high = GENERAL_ARRIVALS_PER_DAY
    return min(max(mean, low), high) / mean


def _stops(rng: np.random.Generator, lo: float, hi: float) -> int:
    """Uniform on [lo, hi], stochastically rounded so the mean is (lo + hi) / 2."""
    x = rng.uniform(lo, hi) if hi > lo else lo
    whole = math.floor(x)
    return int(whole + (rng.random() < x - whole))


def _pick(rng: np.random.Generator, weights: np.ndarray) -> int:
    total = weights.sum()
    if total <= 0:
        return int(rng.integers(len(weights)))
    return int(
        np.searchsorted(np.cumsum(weights), rng.random() * total, side="right").clip(
            0, len(weights) - 1
        )
    )


@dataclass(frozen=True)
class _Draft:
    order: tuple[int, ...]  # deterministic tie-break after the spawn time
    t: int
    entry: int
    persona: int
    returning: bool
    stops: int
    club: ClubVisit | None = None


def plan_arrivals(
    seed: int,
    models: list[PersonaModel],
    entries: list[EntryPoint],
    stores: list[MapStore],
    demand: DemandFile,
    pool: list[Regular],
    days: int,
) -> list[list[Arrival]]:
    """Everyone who comes to the area, per plan day (index 0 = day 1), sorted by spawn time.

    Depends on the seed and the data only, never on store configs.
    """
    scale = arrival_scale(demand, entries)
    by_persona: dict[int, list[Regular]] = {}
    for regular in pool:
        by_persona.setdefault(regular.persona, []).append(regular)
    availability = _Availability(by_persona)
    store_index = {s.id: i for i, s in enumerate(stores)}
    plan = []
    for day in range(1, days + 1):
        drafts = _general_drafts(seed, day, models, entries, demand, scale)
        drafts += _club_drafts(seed, day, models, entries, demand, store_index)
        drafts.sort(key=lambda d: (d.t, d.order))
        pick_rng = rng_for(seed, "pool-pick", day)
        one_off = 0
        arrivals = []
        for d in drafts:
            member: Regular | None = None
            if d.returning:
                evening = (d.t % MINUTES_PER_DAY) >= 17 * 60 or d.club is not None
                block = day * MINUTES_PER_DAY + (8 * 60 if evening else 0)
                member = availability.pick(pick_rng, d.persona, d.t, block)
            if member is None:
                one_off += 1
                agent_id = f"v{day}-{one_off}"
            else:
                agent_id = member.id
            arrivals.append(
                Arrival(
                    day=day,
                    t=d.t,
                    entry=d.entry,
                    persona=d.persona,
                    agent_id=agent_id,
                    returning=member is not None,
                    stops=d.stops,
                    club=d.club,
                )
            )
        plan.append(arrivals)
    return plan


def _general_drafts(
    seed: int,
    day: int,
    models: list[PersonaModel],
    entries: list[EntryPoint],
    demand: DemandFile,
    scale: float,
) -> list[_Draft]:
    weekend = timeutil.is_weekend_day(day)
    day_start = (day - 1) * MINUTES_PER_DAY
    week_mult = np.array([m.persona.weekendMultiplier if weekend else 1.0 for m in models])
    share = np.array([m.persona.share for m in models])
    active = np.array([m.active for m in models])  # (personas, 24)
    drafts: list[_Draft] = []
    for e_idx, entry in enumerate(entries):
        rates = demand.entryPoints.get(entry.id)
        if rates is None:
            continue
        hourly = rates.weekend if weekend else rates.weekday
        kind_w = np.array([m.entry_kind.get(entry.kind, 0.0) for m in models])
        for hour in range(24):
            rng = rng_for(seed, "arrivals", day, entry.id, hour)
            count = int(rng.poisson(max(0.0, hourly[hour] * scale)))
            if count == 0:
                continue
            weights = share * active[:, hour] * week_mult * kind_w
            for n in range(count):
                slot = int(rng.integers(TICKS_PER_HOUR))
                persona = models[_pick(rng, weights)]
                drafts.append(
                    _Draft(
                        order=(0, e_idx, hour, n),
                        t=day_start + hour * 60 + slot * TICK,
                        entry=e_idx,
                        persona=persona.index,
                        returning=bool(rng.random() < persona.returning_p),
                        stops=_stops(rng, *persona.persona.stopsPerTrip),
                    )
                )
    return drafts


def _club_drafts(
    seed: int,
    day: int,
    models: list[PersonaModel],
    entries: list[EntryPoint],
    demand: DemandFile,
    store_index: dict[str, int],
) -> list[_Draft]:
    weekday = timeutil.weekday_of_day(day)
    kind_counts = {k: sum(e.kind == k for e in entries) for k in ("street", "station")}
    drafts: list[_Draft] = []
    for night in demand.clubNights:
        if weekday not in night.days or night.clubId not in store_index:
            continue
        club = store_index[night.clubId]
        opens = (day - 1) * MINUTES_PER_DAY + timeutil.to_minutes(night.open)
        length = (timeutil.to_minutes(night.close) - timeutil.to_minutes(night.open)) % (
            MINUTES_PER_DAY
        ) or MINUTES_PER_DAY
        closes = opens + length
        rng = rng_for(seed, "club", night.clubId, day)
        count = int(round(night.capacity * CLUB_ATTENDANCE_SCALE))
        open_hours = [(opens // 60 + h) % 24 for h in range(-1, 3)]
        weights = np.array(
            [
                m.persona.share
                * m.persona.storePrefs.get("club", 0.0)
                * float(m.active[open_hours].sum())
                for m in models
            ]
        )
        lead, latest = opens - CLUB_ARRIVAL_LEAD_MIN, max(opens, closes - 60)
        for n in range(count):
            persona = models[_pick(rng, weights)]
            entry_w = np.array(
                [persona.entry_kind.get(e.kind, 0.0) / kind_counts[e.kind] for e in entries]
            )
            entry = _pick(rng, entry_w)
            t_spawn = max(0, int((lead + (latest - lead) * rng.random() ** 1.6) // TICK * TICK))
            spill = bool(rng.random() < CLUB_SPILL_SHARE)
            # Early leavers stay at least an hour and are gone half an hour before close.
            earliest, last_early = t_spawn + 75, closes - 30
            leave_u = rng.random()
            if spill or earliest >= last_early:
                spill = True
                leave = closes + TICK * int(rng.integers(3))  # lights up, the room empties
            else:
                leave = ceil_tick(int(earliest + (last_early - earliest) * leave_u))
            drafts.append(
                _Draft(
                    order=(1, club, n),
                    t=t_spawn,
                    entry=entry,
                    persona=persona.index,
                    returning=bool(rng.random() < persona.returning_p),
                    stops=0,
                    club=ClubVisit(club, opens, leave, spill),
                )
            )
    return drafts


# --- choice ---------------------------------------------------------------------------------


def light_factor(
    sensitivity: float, effect: np.ndarray, is_open: np.ndarray, hour: int
) -> np.ndarray:
    """Lighting pull per store: only at night, only while open, scaled by sensitivity.

    effect: (n_stores,) LIGHT_EFFECT of each store's configured level for this hour.
    """
    if hour not in NIGHT_HOURS:
        return np.ones(len(effect))
    return np.where(is_open, 1.0 + sensitivity * effect, 1.0)


@dataclass(frozen=True)
class Choice:
    store: int | None  # chosen store, None = no store (move on / go home)
    wanted_shut: int | None  # top choice that was visibly shut, if any


def race(
    draws: np.ndarray, weights: np.ndarray, visible_closed: np.ndarray, outside: float
) -> Choice:
    """Exponential race over stores plus the outside option (the last draw).

    A store visibly shut (within VISIBLE_M) can win but is not entered: the agent wanted it,
    sees it is closed and takes the next best. Only the top choice counts as wanted-but-shut.
    """
    n = len(weights)
    scores = np.where(weights > 0, draws[:n] / np.where(weights > 0, weights, 1.0), np.inf)
    outside_score = draws[n] / outside
    wanted_shut = None
    while True:
        best = int(np.argmin(scores))
        if not scores[best] < outside_score:
            return Choice(None, wanted_shut)
        if not visible_closed[best]:
            return Choice(best, wanted_shut)
        if wanted_shut is None:
            wanted_shut = best
        scores[best] = np.inf
