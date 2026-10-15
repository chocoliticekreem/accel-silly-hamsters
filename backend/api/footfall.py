"""The background crowd's data: the sim's street presence by day and hour, and the real-world scale
behind every sim agent (GET /api/runs/{run}/footfall, GET /api/health peoplePerAgent).

on_street_by_hour counts, minute by minute, the agents of a day file that are on the street:
between their first and last keyframe and not inside a store, the people the frontend draws (it
adds only a walk-in from beyond the map edge, outside these counts). Each clock hour is the mean
of its 60 minutes. run_footfall caches a run's 14 x 24 table in
runs/{run}/footfall.json and rebuilds it when a day file is newer or CACHE_VERSION changed; the
sample run is computed per request instead (its days are tiny and runs/0 is committed).

people_per_agent is how many real people one sim agent stands for: demand.json's scale (real
arrivals per sim arrival, derived in backend/pipeline/demand.py and stated in the file's notes)
divided by the factor the sim applies to bring arrivals into its daily band
(backend/sim/citizens.arrival_scale).
"""

from __future__ import annotations

import itertools
import logging
from pathlib import Path

from backend import contract, economics, store
from backend.api import common
from backend.contract import DAYS, MINUTES_PER_DAY, DayData, RunFootfall

log = logging.getLogger(__name__)

CACHE_FILE = "footfall.json"
# Bump whenever on_street_by_hour counts differently, so finished runs rebuild their cached table.
CACHE_VERSION = 1


def people_per_agent() -> float | None:
    """Real people per sim agent (economics.real_people_per_agent); None while the data cannot
    say. Never raises: GET /api/health serves it."""
    return economics.real_people_per_agent()


def on_street_by_hour(day: DayData) -> list[float]:
    """24 values: mean agents on the street during each clock hour of `day`."""
    start = (day.day - 1) * MINUTES_PER_DAY
    diff = [0] * (MINUTES_PER_DAY + 1)

    def add(t_from: int, t_to: int, delta: int) -> None:
        """`delta` on every minute in [t_from, t_to) that falls inside this day."""
        lo, hi = max(t_from - start, 0), min(t_to - start, MINUTES_PER_DAY)
        if lo < hi:
            diff[lo] += delta
            diff[hi] -= delta

    seen: set[tuple[str, int]] = set()
    for agent in day.agents:
        if not agent.path:
            continue
        # a trip's identity is id + start time, as the frontend merges them (sim/interp.mergeDays)
        key = (agent.id, agent.path[0][0])
        if key in seen:
            continue
        seen.add(key)
        add(agent.path[0][0], agent.path[-1][0] + 1, 1)
        for visit in agent.visits:
            add(visit.tIn, visit.tOut, -1)
    minutes = list(itertools.accumulate(diff[:MINUTES_PER_DAY]))
    return [round(sum(minutes[h * 60 : (h + 1) * 60]) / 60, 2) for h in range(24)]


def run_footfall(run: int) -> RunFootfall:
    """The run's street crowd by day and hour. 404 for an unknown run or a missing day file."""
    directory = common.run_path(run)
    days = [common.run_file(run, f"days/{d}.json") for d in range(1, DAYS + 1)]
    cache = directory / CACHE_FILE
    cacheable = run != common.SAMPLE_RUN
    if cacheable:
        cached = _read_cache(cache, run, newer_than=max(p.stat().st_mtime for p in days))
        if cached is not None:
            return cached
    result = RunFootfall(
        run=run, onStreetByDayHour=[on_street_by_hour(common.read_file(p, DayData)) for p in days]
    )
    if cacheable:
        try:
            store.write_json(cache, {"version": CACHE_VERSION, "footfall": contract.dump(result)})
        except OSError as e:  # a read-only runs dir still gets its answer, just uncached
            log.warning("footfall for run %s not cached: %s", run, e)
    return result


def _read_cache(path: Path, run: int, newer_than: float) -> RunFootfall | None:
    """The cached table, or None when it is missing, older than a day file, from another
    CACHE_VERSION or unreadable."""
    if not path.is_file() or path.stat().st_mtime < newer_than:
        return None
    try:
        data = store.read_json(path)
        if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
            return None
        cached = RunFootfall.model_validate(data.get("footfall"))
    except ValueError:  # corrupt JSON or an older shape: rebuild
        return None
    return cached if cached.run == run else None
