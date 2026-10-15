"""The 14-day simulation as a pure function of (world data, store configs, seed).

simulate() builds the config-independent arrival plan (citizens.plan_arrivals), then walks every
arrival through its trip in time order: choose a store, walk there on the street graph, find it
open (visit and dwell) or shut (record foundClosed, remember it, choose again), and leave via a
station or a street edge. Club-goers walk to their club and stay until they leave (most at
close); the spill-out crowd then looks for late food or drink nearby before leaving.

The result is raw tallies plus the trips; kpis.py turns them into the contract and schema shapes
and runner.py persists them.

Conventions the API and frontend rely on:
- Spawn times, visit tIn and visit tOut sit on the 5-minute tick grid; corners, door arrivals and
  exits are integer minutes from walking at 1.3 m/s.
- A trip that runs past midnight is listed in both day files (same id, same path), so each day
  file plays back its own 24 hours. Tallies count every trip once.
- A store missing from `configs` is closed all day with its lights off (engine tests use this;
  runner.execute_run insists on a config for every store).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

import numpy as np

from backend import settings, timeutil
from backend.contract import (
    DAYS,
    MINUTES_PER_DAY,
    DayAgent,
    DayData,
    EntryPoint,
    MapData,
    MapStore,
    OwnerEvent,
    Visit,
)
from backend.schemas import ClubNight, DemandFile, EnergyFile, PersonasFile, StoreConfig
from backend.sim import citizens, movement, owners, street
from backend.sim.citizens import TICK, Arrival, PersonaModel, Regular
from backend.sim.energy import LEVELS, floor_area
from backend.sim.movement import Keyframe

TICKS_PER_DAY = MINUTES_PER_DAY // TICK
SIM_TICKS = (DAYS + 1) * TICKS_PER_DAY  # one spare day for trips that run past day 14
HOUR_SPAN = (DAYS + 2) * 24  # absolute hours a trip can touch, spare day and overrun included
MAX_RETRIES = 2  # walk-ups to shut stores per stop before the agent gives the stop up
FOOTFALL_RADIUS_M = 60.0


@dataclass
class World:
    """Everything config-independent: the data files plus derived geometry and personas."""

    map: MapData
    demand: DemandFile
    energy: EnergyFile
    stores: list[MapStore]
    entries: list[EntryPoint]
    models: list[PersonaModel]
    is_club: np.ndarray  # (n_stores,) bool
    floor_area: np.ndarray  # (n_stores,) m2
    doors: np.ndarray  # (n_stores, 2) door positions
    routes: movement.Routes  # places: stores 0..n-1, then entries
    sight: np.ndarray  # (places, n_stores) straight-line metres from each place to each door
    pull: np.ndarray  # (places, n_stores) distance decay for ordinary stops
    late_pull: np.ndarray  # (places, n_stores) distance decay for post-club food
    club_nights: dict[int, list[ClubNight]]  # store index -> its nights
    pool_size: int

    @property
    def n_stores(self) -> int:
        return len(self.stores)

    def entry_place(self, entry: int) -> int:
        return self.n_stores + entry

    @classmethod
    def build(
        cls, map_data: MapData, personas: PersonasFile, demand: DemandFile, energy: EnergyFile
    ) -> World:
        stores = list(map_data.stores)
        entries = list(map_data.entryPoints)
        if not stores or not entries:
            raise ValueError("map.json needs at least one store and one entry point")
        buildings = {b.id: b for b in map_data.buildings}
        missing = [s.id for s in stores if s.buildingId not in buildings]
        if missing:
            raise ValueError(f"stores without a building in map.json: {missing}")
        segs = movement.street_segments(map_data.streets)
        doors = [movement.door_point(buildings[s.buildingId], segs) for s in stores]
        places = doors + [(e.x, e.z) for e in entries]
        graph, nodes = movement.build_walk_graph(map_data.streets, places)
        routes = movement.Routes(graph, nodes)
        place_xy = np.asarray(places, dtype=float)
        door_xy = place_xy[: len(stores)]
        sight = np.hypot(*(place_xy[:, None, :] - door_xy[None, :, :]).transpose(2, 0, 1))
        index = {s.id: i for i, s in enumerate(stores)}
        nights: dict[int, list[ClubNight]] = {}
        for night in demand.clubNights:
            if night.clubId in index:
                nights.setdefault(index[night.clubId], []).append(night)
        scale = citizens.arrival_scale(demand, entries)
        return cls(
            map=map_data,
            demand=demand,
            energy=energy,
            stores=stores,
            entries=entries,
            models=citizens.persona_models(personas.personas, stores, demand),
            is_club=np.array([s.type == "club" for s in stores]),
            floor_area=np.array([floor_area(s, buildings.get(s.buildingId)) for s in stores]),
            doors=door_xy,
            routes=routes,
            sight=sight,
            pull=np.exp(-routes.dist[:, : len(stores)] / citizens.DECAY_M),
            late_pull=np.exp(-routes.dist[:, : len(stores)] / citizens.LATE_DECAY_M),
            club_nights=nights,
            pool_size=int(round(demand.returningPoolSize * scale)),
        )


def load_world() -> World:
    """The world from data/processed (map, personas, demand, energy)."""
    from backend import store

    return World.build(
        store.load_map(), store.load_personas(), store.load_demand(), store.load_energy()
    )


# --- store configs -> schedule ------------------------------------------------------------------


@dataclass
class Schedule:
    """Store configs resolved onto the tick grid."""

    open_ticks: np.ndarray  # (n_stores, SIM_TICKS) bool
    light_effect: np.ndarray  # (n_stores, 24) citizens.LIGHT_EFFECT of the configured level
    lit: np.ndarray  # (n_stores, DAYS, 24) LEVELS index actually switched on (energy)
    open_fraction: np.ndarray  # (n_stores, DAYS, 24) share of each hour the store is open

    def is_open(self, store: int, minute: int) -> bool:
        return bool(self.open_ticks[store, minute // TICK])

    def open_until(self, store: int, t_in: int) -> int:
        """First tick at or after t_in when the store is shut (visits end there at the latest)."""
        k = t_in // TICK
        row = self.open_ticks[store, k : k + TICKS_PER_DAY]
        shut = np.flatnonzero(~row)
        return (k + (int(shut[0]) if len(shut) else len(row))) * TICK


def build_schedule(world: World, configs: Mapping[str, StoreConfig]) -> Schedule:
    """Openness per tick and lighting per hour. Clubs follow demand.clubNights, not their
    config window; a store without a config is shut all day with its lights off."""
    n = world.n_stores
    open_ticks = np.zeros((n, SIM_TICKS), dtype=bool)
    levels = np.zeros((n, 24), dtype=np.int64)
    for i, store in enumerate(world.stores):
        config = configs.get(store.id)
        if config is not None:
            levels[i] = [LEVELS.index(level) for level in config.lighting]
        nights = world.club_nights.get(i)
        if store.type == "club" and nights:
            for day in range(1, DAYS + 2):
                for night in nights:
                    if timeutil.weekday_of_day(day) not in night.days:
                        continue
                    opens = (day - 1) * MINUTES_PER_DAY + timeutil.to_minutes(night.open)
                    length = (
                        timeutil.to_minutes(night.close) - timeutil.to_minutes(night.open)
                    ) % (MINUTES_PER_DAY) or MINUTES_PER_DAY
                    open_ticks[i, opens // TICK : min((opens + length) // TICK, SIM_TICKS)] = True
        elif config is not None:
            daily = [
                timeutil.is_open(config.open, config.close, k * TICK) for k in range(TICKS_PER_DAY)
            ]
            open_ticks[i] = np.tile(np.asarray(daily, dtype=bool), DAYS + 1)
    open_fraction = open_ticks[:, : DAYS * TICKS_PER_DAY].reshape(n, DAYS, 24, -1).mean(-1)
    lit = np.broadcast_to(levels[:, None, :], (n, DAYS, 24)).copy()
    lit[world.is_club] = np.where(open_fraction[world.is_club] > 0, lit[world.is_club], 0)
    effect = np.array([citizens.LIGHT_EFFECT[level] for level in LEVELS])[levels]
    return Schedule(open_ticks, effect, lit, open_fraction)


# --- outputs ------------------------------------------------------------------------------------


@dataclass
class Trip:
    day: int  # plan day
    agent_id: str
    persona: str
    returning: bool
    path: list[Keyframe]
    visits: list[tuple[int, int, int]]  # (store index, tIn, tOut)


@dataclass
class ClosedEvent:
    """An agent whose top choice was shut: walked up to it, or saw it dark within VISIBLE_M."""

    day: int
    store: int
    minute: int
    agent_id: str
    returning: bool
    walked: bool


@dataclass
class SimOutput:
    trips: list[Trip]
    closed_events: list[ClosedEvent]
    found_closed: np.ndarray  # (n_stores, 24) totals over the run
    footfall_near: np.ndarray  # (n_stores, 24) distinct passers-by within FOOTFALL_RADIUS_M
    area_footfall: np.ndarray  # (24,) distinct people present per clock hour, summed over days
    peak_present: int  # most agents in the area at one tick (inside stores included)
    peak_visible: int  # most agents walking or waiting outside at one tick
    skipped_busy: int  # planned regular trips dropped because the regular was still out
    schedule: Schedule
    # Self-learning city (settings.OWNER_ADAPTATION); empty when adaptation is off.
    owner_events: list[OwnerEvent] = field(default_factory=list)
    street_events: list[dict] = field(default_factory=list)  # contract StreetEvent dicts
    schedules: dict[str, list[dict]] = field(default_factory=dict)  # storeId -> ScheduleEntry
    closed_from: dict[str, int] = field(default_factory=dict)  # storeId -> day closed for good


# --- the simulation -----------------------------------------------------------------------------


@dataclass
class _Walker:
    """One trip in progress."""

    arrival: Arrival
    model: PersonaModel
    regular: Regular | None
    loc: int  # place index
    t: int  # current minute
    path: list[Keyframe] = field(default_factory=list)
    visits: list[tuple[int, int, int]] = field(default_factory=list)


class _Simulation:
    def __init__(
        self,
        world: World,
        schedule: Schedule,
        seed: int,
        *,
        street_factor: np.ndarray | None = None,
        owners: owners.Owners | None = None,
    ) -> None:
        self.world = world
        self.schedule = schedule
        self.seed = seed
        n = world.n_stores
        self.found_closed = np.zeros((n, 24))
        self.events: list[ClosedEvent] = []
        self.entry_weight_cache: dict[int, np.ndarray] = {}
        self.street_factor = street_factor  # (n, SIM_TICKS) choice-weight multiplier, or None
        self.owners = owners
        self.footfall = np.zeros((n, 24))  # summed day by day when owners are on

    def run(self, plan: list[list[Arrival]], pool: list[Regular]) -> tuple[list[Trip], int]:
        members = {m.id: m for m in pool}
        trips: list[Trip] = []
        skipped = 0
        for day, arrivals in enumerate(plan, start=1):
            team = self.owners
            if team is not None:
                team.start_day(day)
            first = len(trips)
            for arrival in arrivals:
                if team is not None:
                    team.before(arrival.t)
                regular = members.get(arrival.agent_id) if arrival.returning else None
                if regular is not None and regular.busy_until > arrival.t:
                    skipped += 1
                    continue
                trip = self.trip(arrival, regular)
                if regular is not None:
                    regular.busy_until = trip.path[-1][0]
                trips.append(trip)
            if team is not None:
                # Owners see the passers-by at their door today, then decide for tomorrow.
                footfall = _footfall_near(trips[first:], self.world.doors)
                self.footfall += footfall
                team.end_day(day, footfall)
        return trips, skipped

    def trip(self, arrival: Arrival, regular: Regular | None) -> Trip:
        world = self.world
        model = world.models[arrival.persona]
        rng = citizens.rng_for(self.seed, "trip", arrival.day, arrival.agent_id)
        # Fixed-size blocks first, so later choice draws stay aligned whatever happens.
        dwell_u = rng.random(arrival.stops + 1)
        exit_draws = rng.exponential(size=len(world.entries))
        food_u = rng.random()
        start = world.entry_place(arrival.entry)
        x, z = world.routes.graph.xy[world.routes.place_nodes[start]]
        walker = _Walker(arrival, model, regular, start, arrival.t)
        walker.path.append((arrival.t, round(float(x), 1), round(float(z), 1)))
        if arrival.club is not None:
            self.club_night(walker, rng, dwell_u, food_u)
        else:
            self.shop(walker, rng, arrival.stops, dwell_u, late=False)
        self.leave(walker, exit_draws)
        return Trip(
            day=arrival.day,
            agent_id=arrival.agent_id,
            persona=model.id,
            returning=arrival.returning,
            path=walker.path,
            visits=walker.visits,
        )

    def walk_to(self, walker: _Walker, place: int) -> None:
        corners = self.world.routes.corners(walker.loc, place)
        if walker.path[-1][0] < walker.t:
            _, x, z = walker.path[-1]
            walker.path.append((walker.t, x, z))
        frames = movement.walk(corners, walker.t)
        walker.path.extend(frames[1:])
        walker.t = frames[-1][0]
        walker.loc = place

    def shop(
        self,
        walker: _Walker,
        rng: np.random.Generator,
        stops: int,
        dwell_u: np.ndarray,
        *,
        late: bool,
    ) -> None:
        """Up to `stops` store visits; a walk-up to a shut store costs a retry, not a stop."""
        excluded = self.world.is_club.copy()
        done = retries = 0
        while done < stops:
            choice = self.decide(walker, rng, excluded, late=late)
            if choice is None:
                return
            excluded[choice] = True  # never the same store twice in one trip
            self.walk_to(walker, choice)
            t_in = citizens.ceil_tick(walker.t)
            if not self.schedule.is_open(choice, t_in):
                self.record_closed(walker, choice, walker.t, walked=True)
                walker.t += 1  # reads the sign, turns round
                retries += 1
                if retries > MAX_RETRIES:
                    return
                continue
            lo, hi = walker.model.dwell[choice]
            dwell = citizens.ceil_tick(
                max(TICK, int(lo + (hi - lo) * dwell_u[len(walker.visits) % len(dwell_u)]))
            )
            t_out = min(t_in + dwell, self.schedule.open_until(choice, t_in))
            walker.visits.append((choice, t_in, t_out))
            if self.owners is not None:
                self.owners.visit(choice, walker.arrival.day, t_in, t_out)
            walker.t = t_out
            if walker.regular is not None:
                walker.regular.memory.visited(choice, t_in)
            done += 1

    def decide(
        self, walker: _Walker, rng: np.random.Generator, excluded: np.ndarray, *, late: bool
    ) -> int | None:
        world, schedule = self.world, self.schedule
        draws = rng.exponential(size=world.n_stores + 1)
        minute = walker.t
        hour = (minute // 60) % 24
        is_open = schedule.open_ticks[:, minute // TICK]
        sensitivity = walker.model.persona.lightingSensitivity
        if late:
            sensitivity = max(sensitivity, citizens.LATE_LIGHT_SENSITIVITY)
            weights = walker.model.late_prefs * world.late_pull[walker.loc]
        else:
            weights = walker.model.prefs * world.pull[walker.loc]
        weights = weights * citizens.light_factor(
            sensitivity, schedule.light_effect[:, hour], is_open, hour
        )
        if walker.regular is not None:
            weights = weights * walker.regular.memory.factor(minute)
        if self.street_factor is not None:
            weights = weights * self.street_factor[:, min(minute // TICK, SIM_TICKS - 1)]
        weights[excluded] = 0.0
        visible_closed = ~is_open & (world.sight[walker.loc] <= citizens.VISIBLE_M)
        choice = citizens.race(draws, weights, visible_closed, citizens.OUTSIDE_WEIGHT)
        if choice.wanted_shut is not None:
            self.record_closed(walker, choice.wanted_shut, minute, walked=False)
        excluded |= visible_closed  # seen shut: not worth walking back to on this trip
        return choice.store

    def record_closed(self, walker: _Walker, store: int, minute: int, *, walked: bool) -> None:
        self.found_closed[store, (minute // 60) % 24] += 1
        arrival = walker.arrival
        if self.owners is not None:
            self.owners.found_closed(store, arrival.day, minute)
        self.events.append(
            ClosedEvent(arrival.day, store, minute, arrival.agent_id, arrival.returning, walked)
        )
        if walker.regular is not None:
            walker.regular.memory.found_closed(store, minute)

    def club_night(
        self, walker: _Walker, rng: np.random.Generator, dwell_u: np.ndarray, food_u: float
    ) -> None:
        club = walker.arrival.club
        assert club is not None
        self.walk_to(walker, club.store)
        t_in = max(citizens.ceil_tick(walker.t), club.opens)  # early birds queue at the door
        t_out = max(club.leave, t_in + TICK)
        walker.visits.append((club.store, t_in, t_out))
        walker.t = t_out
        if club.spill and food_u < citizens.SPILL_FOOD_PROB:
            self.shop(walker, rng, 1, dwell_u, late=True)

    def leave(self, walker: _Walker, exit_draws: np.ndarray) -> None:
        """Exit via a station or street edge: nearer is likelier, and so is the way they came."""
        world = self.world
        origin = walker.arrival.entry
        weights = self.entry_weights(walker.model) * np.exp(
            -world.routes.dist[walker.loc, world.n_stores :] / citizens.EXIT_DECAY_M
        )
        weights[origin] *= citizens.ORIGIN_EXIT_BONUS
        if walker.loc == world.entry_place(origin) and len(weights) > 1:
            weights[origin] = 0.0  # nothing happened: they walk through instead of vanishing
        with np.errstate(divide="ignore"):
            scores = np.where(weights > 0, exit_draws / np.where(weights > 0, weights, 1.0), np.inf)
        self.walk_to(walker, world.entry_place(int(np.argmin(scores))))

    def entry_weights(self, model: PersonaModel) -> np.ndarray:
        if model.index not in self.entry_weight_cache:
            entries = self.world.entries
            counts = {k: sum(e.kind == k for e in entries) for k in ("street", "station")}
            self.entry_weight_cache[model.index] = (
                np.array([model.entry_kind.get(e.kind, 0.0) / counts[e.kind] for e in entries])
                + 1e-9
            )
        return self.entry_weight_cache[model.index]


def simulate(
    world: World,
    configs: Mapping[str, StoreConfig],
    seed: int,
    *,
    allow_closure: bool = False,
    adapt: bool | None = None,
) -> SimOutput:
    """Run 14 days. Pure: same world + configs + seed (+ switches) gives the same output.

    adapt (default settings.OWNER_ADAPTATION): street events and owners adapting day by day
    (backend/sim/owners.py). Off gives exactly the pre-adaptation sim. allow_closure lets an
    owner close for good after a losing streak (never in a run whose parent is the baseline).
    """
    adapt = settings.OWNER_ADAPTATION if adapt is None else adapt
    schedule = build_schedule(world, configs)
    pool = citizens.build_pool(world.models, world.pool_size, world.n_stores)
    plan = citizens.plan_arrivals(
        seed, world.models, world.entries, world.stores, world.demand, pool, DAYS
    )
    if not adapt:
        sim = _Simulation(world, schedule, seed)
        trips, skipped = sim.run(plan, pool)
        footfall = _footfall_near(trips, world.doors)
        extras: dict = {}
    else:
        events = street.generate(world, seed)
        team = owners.Owners(world, schedule, configs, events, allow_closure=allow_closure)
        sim = _Simulation(
            world,
            schedule,
            seed,
            street_factor=street.store_factors(world, events, SIM_TICKS),
            owners=team,
        )
        trips, skipped = sim.run(plan, pool)
        team.finalize()
        footfall = sim.footfall
        extras = {
            "owner_events": team.events(),
            "street_events": [e.to_json() for e in events],
            "schedules": team.schedules(),
            "closed_from": team.closed_from(),
        }
    present, visible = _concurrency(trips)
    return SimOutput(
        trips=trips,
        closed_events=sim.events,
        found_closed=sim.found_closed,
        footfall_near=footfall,
        area_footfall=_area_footfall(trips),
        peak_present=present,
        peak_visible=visible,
        skipped_busy=skipped,
        schedule=schedule,
        **extras,
    )


# --- derived tallies ----------------------------------------------------------------------------


def _footfall_near(trips: list[Trip], doors: np.ndarray) -> np.ndarray:
    """Distinct agents per store per clock hour whose walk passes within FOOTFALL_RADIUS_M of
    the door. Uses the exact closest approach of each walking segment: sampling positions every
    5-minute tick would miss most walkers, who cross a 120 m circle in about 1.5 minutes."""
    totals = np.zeros((len(doors), 24))
    by_day: dict[int, list[int]] = {}
    for i, trip in enumerate(trips):
        by_day.setdefault(trip.day, []).append(i)
    for indices in by_day.values():
        rows, owners = [], []
        for i in indices:
            path = trips[i].path
            for (t0, x0, z0), (t1, x1, z1) in zip(path, path[1:], strict=False):
                if x0 != x1 or z0 != z1:  # standing at a door is not passing by
                    rows.append((t0, x0, z0, t1, x1, z1))
                    owners.append(i)
        seg_idx, door_idx, minute = movement.passes_near(
            np.asarray(rows, dtype=float).reshape(-1, 6), doors, FOOTFALL_RADIUS_M
        )
        if len(seg_idx) == 0:
            continue
        owner = np.asarray(owners)[seg_idx]
        abs_hour = minute // 60
        keys = np.unique((owner * len(doors) + door_idx) * HOUR_SPAN + abs_hour)
        hour_of_day = (keys % HOUR_SPAN) % 24
        store = (keys // HOUR_SPAN) % len(doors)
        np.add.at(totals, (store, hour_of_day), 1)
    return totals


def _area_footfall(trips: list[Trip]) -> np.ndarray:
    """Distinct agents present in the area during each clock hour, summed over all days."""
    totals = np.zeros(24)
    for trip in trips:
        first, last = trip.path[0][0] // 60, trip.path[-1][0] // 60
        hours = np.arange(first, last + 1) % 24
        np.add.at(totals, hours, 1)
    return totals


def _concurrency(trips: list[Trip]) -> tuple[int, int]:
    """Peak agents present at one tick, and peak visible (present and not inside a store)."""
    horizon = SIM_TICKS * TICK + MINUTES_PER_DAY
    present = np.zeros(horizon + 1, dtype=np.int64)
    inside = np.zeros(horizon + 1, dtype=np.int64)
    for trip in trips:
        present[trip.path[0][0]] += 1
        present[min(trip.path[-1][0] + 1, horizon)] -= 1
        for _, t_in, t_out in trip.visits:
            inside[t_in] += 1
            inside[min(t_out, horizon)] -= 1
    ticks = np.arange(0, horizon, TICK)
    p = np.cumsum(present)[ticks]
    return int(np.max(p, initial=0)), int(np.max(p - np.cumsum(inside)[ticks], initial=0))


def day_files(trips: list[Trip], stores: list[MapStore]) -> list[DayData]:
    """Contract DayData for days 1..14. A trip appears in the day it starts and, if it runs past
    midnight, also in the next day, so each file plays back its own 24 hours on its own."""
    agents: list[list[tuple[int, str, DayAgent]]] = [[] for _ in range(DAYS)]
    for trip in trips:
        agent = DayAgent(
            id=trip.agent_id,
            persona=trip.persona,
            returning=trip.returning,
            path=trip.path,
            visits=[Visit(storeId=stores[s].id, tIn=a, tOut=b) for s, a, b in trip.visits],
        )
        first = timeutil.day_of(trip.path[0][0])
        last = timeutil.day_of(trip.path[-1][0])
        for day in range(first, min(last, DAYS) + 1):
            agents[day - 1].append((trip.path[0][0], trip.agent_id, agent))
    return [
        DayData(day=d + 1, agents=[a for _, _, a in sorted(day, key=lambda x: (x[0], x[1]))])
        for d, day in enumerate(agents)
    ]
