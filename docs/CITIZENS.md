# Citizens: data-grounded profiles, routines and activity chains (design v1)

Decided 2026-10-15. Citizens behave like real people across the whole 14-day run: a 65-year-old who visits a cafe every Tuesday, a student who comes once for a club night with pre-drinks first and a takeaway after, office workers' commutes and lunches. Builds on the self-learning city (docs/OWNER_ACTIONS.md, docs/PEOPLE_ECONOMY.md): citizen life stories are served through `GET /api/runs/{run}/people/{personId}`.

## Design summary

Design for a data-grounded citizen model on the 1.5 km x 1.5 km Shoreditch map. This was read-only: nothing in /Users/sonionring/orca/accel-silly-hamsters was edited. The benchmarks were throwaway scripts fed to Python on stdin.

Core rule: who comes, on which days, at what times, and what they mean to do depends only on the seed and the data files. Store configs, and later the day-by-day owner changes in docs/OWNER_ACTIONS.md, only change what happens during a trip. The test for this: take two runs that differ only in store X. For any citizen, the two runs match until the first decision that involves X — a visit to X, walking up to X and finding it shut, or seeing X shut as their top choice.

Who is in the sim:
- A fixed cast of about 3,000–3,500 regulars (ids r{n}), built once per seed. Each has a profile: age band, occupation, home anchor or arrival entry, work anchor, budget, loyalty, lighting sensitivity, walking reach, and the existing persona archetype id (so frontend colours keep working). Each has a weekly routine: their own weekdays, personal habit times, and an attendance probability per weekday.
- One-off visitors each day (ids v{day}-{n}). They fill the measured demand.json entry x hour rates, minus the arrivals the cast already produces at each entry.
- Event-goers for new VenueEvent entries in demand.json (XOYO, Village Underground), added until the venue's capacity is reached.

How they behave: each citizen-day is 1–3 outings built from an activity chain.
- Office day: station → coffee on the way → office | lunch → office | Friday drink → dinner → station.
- Night out: supplies → pres → club → late food → station.
- Weekly cafe: home → cafe → shop → home.

Each outing is one DayAgent under the citizen's id, so the DayAgent shape does not change. The one difference: a path may now start or end at a home or office door. Store choice in each step is: person prefs x step type weights x distance or detour decay x lighting (at night, when open) x memory. It runs through the existing exponential race and visible-shut logic, so the hours and lighting levers, foundClosedByHour and footfall all keep their meaning.

Memory (cast only):
- Found shut, per store x 3-hour band.
- Satisfaction as a moving average; a visit cut short by closing time counts as a bad visit.
- A habit term: visit count x loyalty.
- "Noticed it open": walking past a store that is now open and lit undoes a found-shut memory. This matters because owners will change hours mid-run.

Diaries: a compact event log, written only by execute_run (runs/{run}/citizens.json and diaries/{k}.json). GET /api/runs/{run}/citizens/{id}/diary turns it into text with fixed templates. Featured citizens are picked from plans only, so the same people are featured in run 1 and the best run.

Performance (measured on this Apple M4 Pro): a prototype executor ran at 48 µs per citizen-day. Projected evaluate() time:

| Citizens/day | Warm | Cold |
|---|---|---|
| 3,000 | 3.2 s | 4.7 s |
| 4,000 | 4.3 s | 6.0 s |

"Warm" means the same process and seed, which is the training-loop case. The nominal target is therefore 3,000/day.

Prerequisites:
- Grid-bucket the street intersection step. The existing O(M²) debt in movement.py would cost about 2.5 s per world build at 1.5 km.
- Cache the World per process, and the cast and plans per seed.
- Cache keyframes and footfall hits per walking leg.
- Write day files without pydantic, using integer coordinates.

Coordination: docs/OWNER_ACTIONS.md (decided today) and origin/backend/owner-actions also rewrite the schedule and the day loop. Agree the per-day Schedule and the before/after-day hook interface first.

## Data structures

All new pydantic models use schemas.Model / contract.Model (extra="forbid"). Every new field has a default, so existing files still validate. Internal sim structures are frozen slotted dataclasses (config-independent) or plain dataclasses (run state).

## 1. personas.json additions (backend/schemas.py)
```python
AgeBand = Literal["18-24", "25-34", "35-49", "50-64", "65+"]
Occupation = Literal["office", "remote", "student", "retired", "shift", "resident", "visitor"]
Budget = Literal["low", "mid", "high"]
Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]          # timeutil.WEEKDAYS

class Window(Model):
    start: str        # "HH:MM" on the 5-min grid; end <= start wraps past midnight (timeutil rule)
    end: str

class RelativeTime(Model):
    to: Literal["outing.start", "event.open", "event.close"]
    min: int          # minutes, may be negative
    max: int
    skew: float = 1.0 # value = min + (max - min) * u**skew; 1.6 = today's club-arrival skew

class StepTemplate(Model):
    purpose: str                               # diary label: coffee, lunch, pres, late-food, groceries
    kind: Literal["store", "anchor", "event"]
    types: dict[StoreType, float] = {}         # store steps; "club" rejected
    anchor: Literal["home", "work", "event"] | None = None
    p: float = 1.0                             # inclusion probability
    pByWeekday: dict[Weekday, float] = {}      # e.g. after-work drink {"thu": .3, "fri": .55}
    window: Window | None = None               # a store step is only attempted if it can start inside
    at: RelativeTime | None = None             # event arrival; anchor "back by"; first-step lead time
    until: Window | RelativeTime | None = None # anchor/event: when the stay ends (outing boundary)
    dwell: tuple[int, int] | None = None       # minutes; default Persona.dwellMinutes[type]
    reachM: float = 150.0                      # distance-decay length (today DECAY_M; late steps 80)
    detour: bool = False                       # decay on detour to the next fixed place
    late: bool = False                         # post-club rules: spill-only, lighting floor 0.8
    outside: float = 0.15                      # "no store, move on" weight (OUTSIDE_WEIGHT)
    onShut: Literal["retry", "substitute", "skip", "abort"] = "retry"
    substitute: dict[StoreType, float] = {}    # types after a shut store when onShut == "substitute"
    maxRetries: int = 2                        # walk-ups to shut stores per step (MAX_RETRIES)

class ChainTemplate(Model):
    id: str
    label: str
    start: Literal["home", "entry", "work"]
    steps: list[StepTemplate]                  # in order; an anchor step with `until` splits outings
    end: Literal["home", "origin", "station", "work"] = "origin"
    evidence: list[Source] = []

class RoutineSlot(Model):
    chain: str
    weekdays: list[Weekday]
    daysPerWeek: tuple[int, int] | None = None # pick k of `weekdays` once per citizen (a fixed habit)
    p: float                                   # attendance per occurrence
    pByWeekday: dict[Weekday, float] = {}      # hybrid office days
    start: Window                              # personal habit start drawn once inside it
    jitterMinutes: int = 15                    # daily sd around the habit start
    priority: int = 0                          # wins when two attended slots start < 240 min apart

class ProfileTemplate(Model):
    id: str
    label: str
    persona: str                               # Persona.id: colour family, storePrefs, dwell, lighting base
    kind: Literal["cast", "event"]             # cast = persistent regular; event = one-off crowd profile
    occupation: Occupation
    ageBands: dict[AgeBand, float]
    home: dict[Literal["area", "outside"], float]
    work: Literal["office", "outside", "none"] = "none"
    entryKinds: dict[EntryKind, float] = {}    # default Persona.entryKinds
    budget: dict[Budget, float] = {"mid": 1.0}
    loyalty: tuple[float, float] = (0.3, 0.6)
    lightingJitter: float = 0.15
    reachScale: tuple[float, float] = (0.8, 1.2)
    routine: list[RoutineSlot] = []            # cast profiles
    chains: dict[str, float] = {}              # event profiles: chain mix
    evidence: list[Source] = []

class PersonasFile(ProcessedFile):
    personas: list[Persona]                    # unchanged; ids stay the frontend colour keys
    profiles: list[ProfileTemplate] = []
    chains: list[ChainTemplate] = []
    visitorChains: dict[str, dict[str, float]] = {}   # Persona.id -> chain mix for residual one-offs
    budgetPrefs: dict[Budget, dict[StoreType, float]] = {}
    # model_validator: references resolve, windows parse, p in 0..1, dwell 1..480,
    # one profile's same-weekday slots start >= 240 min apart
```

## 2. demand.json additions (backend/schemas.py)
```python
class CastGroup(Model):
    profile: str      # ProfileTemplate.id, kind "cast"
    size: int         # persistent citizens, in sim agents
    basis: str        # e.g. "NUMBAT AM-peak exits x office share / mean attendance x scale"

class VenueEvent(Model):
    id: str
    venueId: str      # MapStore.id of a club (fixed anchor)
    name: str | None = None
    weekdays: list[Weekday] = []
    days: list[int] = []          # explicit sim days 1..14 (dated listings) instead of weekdays
    open: str
    close: str
    capacity: int     # sim agents at peak, already scaled (like ClubNight.capacity)
    crowd: dict[str, float]       # event ProfileTemplate.id -> share of one-off attendees
    spillShare: float = 0.7       # CLUB_SPILL_SHARE
    measured: bool = False
    source: Source | None = None

class DemandFile(ProcessedFile):  # existing fields unchanged; returningPoolSize = sum of cast sizes
    population: list[CastGroup] = []
    events: list[VenueEvent] = []                 # empty -> one weekly event per ClubNight (fallback)
    entryPointsByWeekday: dict[str, dict[Weekday, Hourly]] = {}  # NUMBAT day types; else weekday/weekend
```

## 3. Sim internals
```python
# backend/sim/rng.py
def mix64(x: int) -> int                      # splitmix64 finaliser
@dataclass(frozen=True, slots=True)
class Keyed:                                  # counter-based, stateless, random access
    base: int                                 # mix64 chain of (seed, crc32(tag), *keys)
    def u(self, k: int) -> float              # [0, 1)
    def normal(self, k: int) -> float         # Box-Muller on u(2k), u(2k + 1)
    def pick(self, k: int, cum: Sequence[float]) -> int
def trip_block(seed: int, key: int, day: int, rows: int, width: int) -> np.ndarray
    # Generator(PCG64(mix64(...))).standard_exponential((rows, width)); width = max(n_stores + 1, n_entries)

# backend/sim/population.py
@dataclass(frozen=True, slots=True)
class PersonalSlot:
    chain: int
    weekdays: frozenset[int]                  # 0 = Mon; the citizen's own days
    p: tuple[float, ...]                      # attendance per weekday (7)
    start: int                                # habit minute of day
    habits: tuple[int, ...]                   # habit minute per `until` window (lunch 12:40, leave 17:50)
    jitter: int
    priority: int

@dataclass(frozen=True, slots=True)
class Citizen:
    index: int                                # MemoryBank row
    id: str                                   # f"r{index + 1}" (contract id format unchanged)
    profile: int
    persona: int                              # World.models index
    age_band: str; occupation: str; budget: str
    home: int | None                          # home anchor place; None = lives outside
    work: int | None                          # office anchor place, or an edge-entry place (work="outside")
    entry: int                                # entry index toward home for people living outside
    venue: int | None                         # favourite club store index
    loyalty: float; sensitivity: float; reach: float; dwell_scale: float
    prefs: np.ndarray                         # (n_stores,) storePrefs x budgetPrefs x exp(0.2 N); 0 for clubs
    slots: tuple[PersonalSlot, ...]

# backend/sim/plans.py
STORE, ANCHOR, EVENT = 0, 1, 2
@dataclass(frozen=True, slots=True)
class PlannedStep:
    purpose: int
    kind: int
    types_w: np.ndarray | None                # (n_stores,) resolved type weights
    substitute_w: np.ndarray | None
    window: tuple[int, int] | None            # absolute minutes
    deadline: int | None                      # must be at the next fixed place by then
    place: int | None                         # anchor/event place
    until: int | None                         # stay end, absolute minute on the tick grid
    p: float; gate_u: float                   # gate decided at execution: gate_u < p
    dwell_u: float
    row: int                                  # draw-block row of attempt 0 (attempt a -> row + a)
    reach: float; detour: bool; late: bool; outside: float; on_shut: int; max_retries: int

@dataclass(frozen=True, slots=True)
class PlannedOuting:
    start: int                                # planned absolute minute
    origin: int                               # place index (entry or anchor door)
    steps: tuple[PlannedStep, ...]
    end: int                                  # place index, or EXIT = -1 (exit race at the end)
    exit_row: int
    latest_start: int
    required: bool                            # the outing that takes them home/out always runs

@dataclass(frozen=True, slots=True)
class CitizenDay:
    key: int                                  # cast index, or a one-off key with bit 63 set
    citizen: int                              # cast index, -1 for one-offs
    agent_id: str                             # "r12" | "v3-417"
    persona: int; profile: int; returning: bool; day: int; chain: int
    event: int                                # VenueEvent index or -1
    spill: bool                               # still inside the club at close
    outings: tuple[PlannedOuting, ...]
    rows: int                                 # store steps x (max_retries + 1) + exit rows

# backend/sim/citizens.py
@dataclass
class MemoryBank:                             # cast only; one-offs keep trip-local exclusion only
    closed: np.ndarray        # (n_cast, n_stores, N_BANDS) int8, capped at CLOSED_MEMORY_CAP
    satisfaction: np.ndarray  # (n_cast, n_stores) float32
    visits: np.ndarray        # (n_cast, n_stores) uint16
    habit: np.ndarray         # (n_cast, n_stores) float32 = 1 - exp(-visits / HABIT_SCALE)
    def factor(self, i: int, minute: int, loyalty: float) -> np.ndarray
        # (1 + SATISFACTION_BOOST*sat) * (1 + HABIT_BOOST*loyalty*habit) * CLOSED_PENALTY**closed[:, band]
    def found_shut(self, i: int, store: int, minute: int) -> None
    def visited(self, i: int, store: int, minute: int, outcome: float) -> None
    def noticed_open(self, i: int, store: int, minute: int) -> None

# backend/sim/engine.py
@dataclass(frozen=True, slots=True)
class Leg:                    # World.leg(a, b), lazily cached
    frames: tuple[Keyframe, ...]              # relative; frames[0][0] == 0
    minutes: int
    hits: tuple[tuple[int, int, float], ...]  # (door, relative minute of closest approach, metres), <= 60 m

@dataclass
class Schedule:               # per tick and per day, so owner actions can change it from day d + 1
    open_ticks: np.ndarray    # (n_stores, SIM_TICKS) bool (unchanged)
    light_effect: np.ndarray  # (n_stores, DAYS + 1, 24)  (was (n_stores, 24))
    lit: np.ndarray           # (n_stores, DAYS, 24) (unchanged)
    open_fraction: np.ndarray # (n_stores, DAYS, 24) (unchanged)

@dataclass
class Trip:                   # one outing = one DayAgent; name kept so kpis/tests change little
    day: int; agent_id: str; persona: str; returning: bool
    path: list[Keyframe]; visits: list[tuple[int, int, int]]
    citizen: int; outing: int
```
SimOutput keeps every existing field with the same meaning. skipped_busy becomes skipped_outings, and SimOutput gains diary: DiaryLog | None.
DiaryLog = dict[agent_id, list[(day, chain, list[(t, kind, a, b, c)])]]. The kind codes and their fields:
- ARRIVE (a=place)
- VISIT (a=store, b=tOut, c=purpose)
- SHUT_WALKED / SHUT_SEEN (a=store, c=purpose)
- SKIP (b=reason: 0 no store, 1 all shut, 2 deadline, 3 window, 4 ran late; c=purpose)
- ENTER (a=place)
- LEAVE (a=place)
- NOTICED (a=store)

## 4. Run files (runs/{run}/, written by execute_run only)
```python
class CitizensFile(Model):          # citizens.json
    run: int
    featured: list[dict]            # [{"id", "story"}], chosen from plans
    counts: dict[str, int]          # {"cast", "oneOff", "<profile id>": n}
    codes: dict[str, list]          # purposes, chains, profiles, places [{kind, name}]
```
Diaries go in diaries/{crc32(id) % 32}.json, written compact like days/:
`{id: {"p": [profile, ageBand, occupation, budget, home place, work place, entry, loyalty, sensitivity, slots], "d": [[day, chain, [[t, kind, a, b, c], ...]], ...]}}`

## 5. API contract (backend/contract.py, additive)
```python
class CitizenProfile(Model):
    id: str; persona: str; profile: str; label: str
    occupation: Occupation; ageBand: AgeBand; budget: Budget
    home: str                                  # street of the home anchor, or "outside the area"
    arrivesVia: str | None = Optional()        # entry or station name
    work: str | None = Optional()              # street of the work anchor
    loyalty: float; lightingSensitivity: float
    routine: list[str]                         # "Tue ~10:30 weekly cafe"
    returning: bool

class CitizenCard(Model):
    id: str; persona: str; label: str; story: str; headline: str
    daysPresent: int; visits: int; foundShut: int

class CitizenIndex(Model):
    run: int; featured: list[CitizenCard]; counts: dict[str, int]
    note: str = "Synthetic citizens built from anonymous aggregate data; not real people."

class DiaryEntry(Model):
    t: int
    kind: Literal["arrive", "visit", "found_shut", "seen_shut", "skip", "enter", "leave", "noticed_open"]
    storeId: str | None = Optional(); storeName: str | None = Optional()
    purpose: str | None = Optional(); tOut: int | None = Optional()
    place: str | None = Optional(); note: str | None = Optional()

class DiaryDay(Model):
    day: int; weekday: str; summary: str; entries: list[DiaryEntry]

class CitizenDiary(Model):
    run: int; citizen: CitizenProfile; days: list[DiaryDay]
    memory: list[str]                          # "regular at [cafe] (5 visits)", "avoids [shop] Tue mornings"
    note: str = "Simulated, not a real person."
```
DayAgent and DayData are unchanged.

## 6. Offline fallback set (backend/pipeline/personas.py, fallback=True)
These numbers are judgement unless a source is cited.

**Cast profiles** (persona id in brackets; each already has a frontend colour family):
- **office-commuter** (office-worker). Ages 25-34 .45, 35-49 .40, 50-64 .15. Lives outside; works in an office. Arrives by station .8 / street .2. Budget low .1, mid .6, high .3. Loyalty .4-.7.
  - office-day Mon-Fri, p: mon .45, tue .75, wed .80, thu .70, fri .35. This is an ONS hybrid-working prior, to be calibrated against the NUMBAT MON/TWT/FRI AM peaks.
  - Start 07:45-09:30; lunch habit 12:00-13:30; leave habit 16:45-18:30.
- **office-local** (office-worker). Lives in the area; same office-day slot; brunch Sat/Sun p .3.
- **through-commuter** (morning-commuter). Works outside the box: work is an edge entry toward the City. commute-am Mon-Fri p .6, 07:15-09:00; commute-pm p .55, 17:00-19:00.
- **resident** (local-resident). Ages 18-24 .10, 25-34 .35, 35-49 .35, 50-64 .20.
  - errand 3-5 of 7 days, p .8, 17:00-20:30
  - brunch Sat/Sun, p .35, 10:30-12:30
  - local-pub Thu-Sat, p .25, 19:00-21:00 (priority 1)
- **retired-local** (local-resident). Age 65+. Area .75 / outside .25 (outside means by bus, via a street entry). Loyalty .75-.95; reach .6-.9.
  - weekly-cafe, 1 of Mon-Fri, p .9, 09:30-11:30 (priority 1)
  - groceries, 2-3 of Mon-Sat, p .85, 09:00-12:00
- **remote-local** (remote-worker). cafe-work 2-4 of Mon-Fri, p .85, 09:00-10:30; errand 2-3 of 7, p .7.
- **student-local** (student-creative). Age 18-24 .9; budget low .8; loyalty .2-.5.
  - studio-day 3-5 of Mon-Fri, p .7, 11:00-13:00
  - night-out Thu-Sat, p .3 (priority 1)
- **shift-worker** (late-shift-worker). Area .3 / outside .7; works outside. late-shift-home 4-5 of 7, p .9, 22:30-01:30.
- **nightlife-regular** (night-owl). Lives outside. night-out Fri/Sat p .45, Thu p .15.
- **after-work-regular** (after-work-drinker). Lives and works outside. after-work 2 of Tue-Fri, p .7, 17:30-19:00.

**Event profiles:** event-student (night-owl; student, 18-24, budget low) and event-goer (night-owl; office, 18-34). Both use {night-out: 1}.

**visitorChains** (residual one-offs, by persona):
- tourist → tourist-day
- weekend-shopper → market-day
- evening-diner → dinner-out
- after-work-drinker → after-work-oneoff
- night-owl → bar-hop
- all others → pass-through (0-1 quick stop, then walk through)

**budgetPrefs:**
- low: restaurant .5, takeaway 1.3, offlicence 1.3, bar .8, cafe .9, shop .9
- mid: all 1
- high: restaurant 1.4, takeaway .8, offlicence .8, bar 1.1, cafe 1.1, shop 1.2

**Chains (19).** The three from the brief:
- **office-day.** Each `|` is an outing boundary at the office door.
  1. coffee: cafe, p .6, detour, 07:00-10:30, 3-8 min → work (until lunch habit)
  2. | lunch: {takeaway .4, cafe .3, restaurant .3}, p .75, reach 300, 11:45-14:30 → work (at outing.start +45..75, until leave habit)
  3. | after-work: bar, p .12 (thu .3, fri .55), reach 350, 45-150 min, 16:30-21:00 → dinner: restaurant, p .15, 18:30-21:30 → origin
- **night-out:**
  1. supplies: {offlicence .6, shop .4}, p .35, 3-10 min, at event.open -150..-90
  2. pres: bar, p .55, 40-90 min, deadline = club arrival
  3. club (event step): at event.open -30..+150, skew 1.6; until close if spill, else early leave
  4. late-food: {takeaway .7, offlicence .15, bar .15}, late, p .75 if spill, reach 80, close..close+60, maxRetries 1
  5. end: a station on Fri/Sat nights, else origin
- **weekly-cafe:** cafe (30-60 min, reach 300) → groceries ({shop .7, offlicence .3}, p .5) → home

The other 16: commute-am, commute-pm, errand, brunch, local-pub, groceries, cafe-work, studio-day, late-shift-home, after-work, after-work-oneoff, bar-hop, tourist-day (windowed coffee/lunch/shop/evening-drink steps, reach 400), market-day, dinner-out (restaurant, reach 600), pass-through.

## Per-day algorithm

## 0. Invariant (checked before any code)
Plans depend only on (seed, map, personas, demand). A plan covers: who comes, which days, start times, chain, optional-step gates, the dwell and exit uniforms, entries, anchors, event attendance and one-off counts. Configs and owner actions only change execution.

What this means for testing: for any citizen, two runs that differ only in store X are identical up to the first decision that involves X — visited, walked up to shut, or seen shut as the top choice. Before that point every race gives the same scores to all other stores, so it has the same winner.

Three things would break it. Each is ruled out:
- A random draw used in a config-dependent order. Ruled out: draws use fixed counters, and race rows are indexed by (step, attempt).
- Plans reading memory or the schedule. Ruled out by signature: day_plans takes no configs.
- Citizens interacting with each other. They never do: no queues, no capacity limits.

## 1. World build (config-independent; memoised per process on the four processed files' mtime_ns and size)
1. **Places** = stores + entries + home anchors + work anchors.
   - Anchors: in each 150 m grid cell, the door (movement.door_point) of the largest residential building, and separately of the largest office building.
   - Anchor weight = sum of w x d x h for that building kind in the cell.
   - At most 64 home and 48 work anchors, so about 80 + 45 + 110 = 235 places at 1.5 km.
2. **Walk graph** with grid-bucketed segment intersection, then Routes all-pairs (one Dijkstra per place) and sight (places x stores).
3. **Pull matrices** exp(-dist / r), cached per effective reach r = step reach x citizen reach scale (quantised to 0.1).
4. **Templates resolved:**
   - Type weights become (n_stores,) vectors, with clubs at 0.
   - Windows are converted to minutes; a purposes table is built.
   - Persona references resolve to PersonaModel.
   - Events are resolved per day to (event, club index, doors, close).
5. **leg(a, b) cache:** frames = walk(corners(a, b), 0), and hits = passes_near(frame segments, doors, FOOTFALL_RADIUS_M) with the closest-approach distance. walk() gives the same result shifted by t for any integer start minute t, up to float rounding at exact .5 boundaries. PR 1's byte-identity test checks this on the fixture.
6. **population_scale:** expected citizens/day (cast sizes x mean attendance + residual demand + event capacity), clamped into ARRIVALS_PER_DAY = (2000, 4000). It applies to cast sizes (largest-remainder rounding) and residual rates, the role arrival_scale plays today.

## 2. Cast (once per seed, cached on World, config-independent)
For each CastGroup in file order and n = 0..size-1, draw from k = Keyed(seed, "cast", group, n):
- age band, budget, and home in the area or outside
- home anchor (in proportion to anchor weight), or an entry for people living outside (in proportion to entryKinds / count of that kind, as entry_weights does)
- work anchor (in proportion to office weight), or a work entry
- loyalty ~ U(lo, hi)
- sensitivity = clamp(persona.lightingSensitivity ± lightingJitter)
- reach scale, and dwell scale exp(0.15 N)
- prefs = storePrefs[type] x budgetPrefs[budget][type] x exp(0.2 N_type)
- favourite venue, in proportion to event capacity

For each routine slot:
- own weekdays: all candidates, or k = daysPerWeek drawn, then weighted sampling without replacement
- habit start: uniform in the window, on the 5-min grid
- a habit minute for every `until` window

Ids are r1..rN in this order.

## 3. Plans for day d (weekday w; config-independent; computed in day order and cached per seed)
**a) Cast**, in citizen order, using fixed counters: 64 per slot, 4 per step.
- Slot j attends if Keyed(seed, "plan", i, d).u(64j) < p[w].
- Keep attended slots by priority. Drop one that starts less than 240 min from a kept slot.
- Rest rule: drop slots starting before 10:00 if the citizen had a night out on d-1. This means a 04:30 finish never overlaps the next day.

Expanding a slot's chain:
- Outing 1 starts at habit + round(jitter x normal), on the tick grid and clamped to the slot window.
- An anchor step with `until` ends the outing at that door. The next outing starts at that `until` time (habit + jitter).
- An anchor `at` relative to outing.start sets the deadline for the store steps before it ("back at work 45-75 min after leaving").
- Every step gets gate_u and dwell_u. Each store step gets max_retries + 1 block rows; each outing ending at an exit gets one exit row.
- Start and end places:
  - home → the home door, or citizen.entry if they live outside
  - work → the work door, or the work entry
  - entry → citizen.entry
  - origin → exit race with ORIGIN_EXIT_BONUS on the arrival entry
  - station → station entries only

Then count the cast's realised entry arrivals C[e, h].

**b) Residual one-offs.** For each entry e and hour h, n ~ Poisson(max(0, D[e, w, h] x scale - C[e, h])), drawn from rng_for(seed, "visitors", d, e.id, h). D is entryPointsByWeekday when present, else the weekday/weekend arrays. Each visitor gets:
- persona, in proportion to share x active[h] x weekendMultiplier x entryKind (today's weights)
- chain, in proportion to visitorChains[persona]
- spawn time h:00 plus a 5-min slot
- gates and dwells from Keyed(seed, "visitor", d, e, h, n)

**c) Events.** For each VenueEvent active on d whose venue is in the map:
- N = round(capacity x CLUB_ATTENDANCE_SCALE).
- Regulars = cast night-out plans tonight that resolve to this venue: their favourite venue; else picked in proportion to capacity among tonight's events; else they do bar-hop.
- One-offs = max(0, N - regulars). Each draws from Keyed(seed, "event", e, d, n):
  - crowd profile, which sets age band, occupation and budget
  - entry, in proportion to the profile's entryKinds
  - club arrival t_c = doors - 30 + (max(doors, close - 60) - doors + 30) x u^1.6
  - spill = u < spillShare
  - leave = close + 5 x {0, 1, 2} if spill, else an early leave in [t_c + 75, close - 30] (today's rules)
  - outing start = the first step's `at` (event.open -150..-90), or t_c minus walking time when no pre-steps are gated in
- Clubs are open exactly on their events' ticks (union per day). With no events, each ClubNight becomes one weekly event (fallback, labelled).

**d) Ids and order.** Sort the day's one-offs by (start, key) and number them v{d}-{n}, as today. Citizen-days run in order of (first planned start, key). Any fixed order works, because citizens never interact.

## 4. Execution (config-dependent; day-major, so owner hooks fit between days)
For day in 1..14:
1. before_day hook.
2. For each CitizenDay:
   - block = trip_block(seed, key, day, rows, W), only when rows > 0.
   - For each outing:
     - t = max(planned start, ceil_tick(busy_until + 1)).
     - If an optional outing cannot start by latest_start (planned + 120 min): count it in skipped_outings, log diary SKIP (ran late), and move on.
     - Otherwise: spawn a keyframe at the origin; run the steps; walk to the end place, or run the exit race on block[exit_row] with today's leave() weights (entry kind x exp(-d / EXIT_DECAY_M) x ORIGIN_EXIT_BONUS; the origin gets 0 when standing on it).
     - busy_until = the last keyframe.
3. Day tallies: footfall keys made unique per (citizen, door, absolute hour), area hours, found-closed by day.
4. after_day hook.

**Store step:**
1. Gate: skip silently unless gate_u < p. Late steps also need spill. If now is outside the step window, log SKIP (window).
2. Deadline feasibility: candidate s needs walk(loc→s) + dwell_min + walk(s→next fixed place) <= deadline - t, with walking minutes estimated as dist / 78 m/min x 1.1 + 2. If no store is feasible, log SKIP (deadline).
3. For attempt a = 0..max_retries:
   - weights = prefs x types_w (substitute_w after a shut store when onShut = substitute) x decay x light_factor x memory.factor (cast only) x feasibility.
   - light_factor uses the citizen's sensitivity (max(sensitivity, 0.8) for late steps), light_effect[:, day, hour], is_open and hour.
   - Stores excluded (weight 0): clubs, stores already tried this outing, stores seen shut this outing.
   - decay = pull[r][loc], or exp(-(d(loc,s) + d(s,next) - d(loc,next)) / r) when the step uses detour.
   - visible_closed = ~is_open & sight[loc] <= VISIBLE_M.
   - choice = citizens.race(block[row + a], weights, visible_closed, outside), which is the existing race.

   Outcomes:
   - **choice.wanted_shut:** record_closed(walked=False): found_closed[s, hour] += 1, a ClosedEvent, memory.found_shut, diary SHUT_SEEN. These are today's semantics exactly.
   - **No store chosen:** SKIP (no store).
   - **Walk there** using the leg cache; t_in = ceil_tick(t).
   - **Shut at t_in:** record_closed(walked=True) with memory and diary SHUT_WALKED; t += 1 (reads the sign); exclude s. Then apply onShut: retry or substitute → next attempt; skip → end the step; abort → go straight to the outing's end. When attempts run out: SKIP (all shut).
   - **Open:**
     - dwell = ceil_tick(max(5, lo + (hi - lo) x dwell_u x dwell_scale)).
     - planned_out = min(t_in + dwell, deadline - leg(s, next).minutes).
     - t_out = min(planned_out, schedule.open_until(s, t_in)).
     - If planned_out - t_in < 5, don't enter: SKIP (deadline).
     - Otherwise visit. Outcome is 0.4 if t_out < planned_out (cut short by closing), else 1.0. Then memory.visited and diary VISIT.

**Anchor step:** walk to the door. The outing, and its DayAgent path, ends there. The citizen is inside and invisible until the next outing.

**Event step:** walk to the club; t_in = max(ceil_tick(t), doors); t_out = max(leave, t_in + 5); visit with the club's storeId (today's club_night).

**Every walking leg:**
- Append the shifted frames, with a "wait" keyframe first if the citizen was standing.
- Add one footfall key per hit.
- For cast members: a hit within VISIBLE_M at minute m triggers memory.noticed_open (closed -= 1) and diary NOTICED when all of these hold: closed[i, s, band(m)] > 0, s is open at m, and it is 07:00-17:00 or the lit level is not off.

## 5. Memory evolution (cast only; per run, never carried across runs)
- **Found shut** (walked or seen): closed[i, s, band] = min(3, n + 1), so the weight is x 0.2^n in that 3-hour band. The step's type weights never change, so next time another store of the same type wins ("found shut → try another of the same type next time"). Retries inside the step do the same immediately.
- **Visit:**
  - the closed band resets to 0 (today's rule)
  - satisfaction += 0.5 x (outcome - satisfaction)
  - visits += 1; habit = 1 - exp(-visits / 2); the weight gains x (1 + loyalty x habit)
  - Example: a retiree with loyalty 0.9, after 2 Tuesday visits, weights "her" cafe x1.78, times x1.75 from satisfaction. A student with loyalty 0.3 gets x1.26.
- **Noticed open:** decrements the band in which the store was seen open and lit. Owners who extend hours mid-run (OWNER_ACTIONS) win regulars back, and lighting gains a second, realistic effect. Ship it together with the owner day hooks: with constant hours it has no reader.
- Memory never changes attendance, start times, chains or entries. Lost customers show up as switching stores, not as staying home. This keeps "the same 14 days of arrivals".

## 6. Diary and featured citizens
- The diary is recorded only when simulate(..., diary=True), i.e. from execute_run. evaluate() skips it.
- **Featured citizens are picked from plans only** (config-independent). The same ids are featured in every run of a seed, so the frontend can follow one person in run 1 vs the best run. Story slots in order, first match by ascending key:
  - weekly-regular: a retired-local who attends its weekly-cafe slot in both weeks
  - office-routine: an office-commuter with >= 7 office days, including a Friday whose after-work gate passed
  - night-out, one per venue: a one-off event-goer on the first event night, with supplies and pres gated in and spill true
  - student, remote-worker, resident, late-shift
  - tourist: weekend, >= 3 planned stops
  - nightlife-regular, diner

  That gives about 10-12 cards. Their counters (visits, foundShut, daysPresent) come from the run.
- **Rendering** (API side, fixed templates, store and street names from map.json). Example: "Tue · 10:32 left home (Calvert Avenue) · 10:41 coffee at [cafe], 48 min, 2nd visit · 11:33 groceries: [shop] was shut, went to [shop] · 11:46 home".
- memory[] notes are derived from the history: "regular at X (n visits)", "avoids Y on Tue mornings (found shut 2x)", "noticed Z open late again".

## 7. Determinism keys
| Stream | Key | Used for | Config-dependent order? |
|---|---|---|---|
| Keyed "cast" | seed, group, n | traits, anchors, routine | no |
| Keyed "plan" | seed, citizen, day | attendance, jitter, gates, dwell u | no |
| rng_for "visitors" | seed, day, entry, hour | Poisson counts | no |
| Keyed "visitor" / "event" | seed, day, entry, hour, n / seed, event, day, n | persona, chain, times, spill | no |
| trip_block | seed, key, day | race rows (step, attempt), exit rows | rows fixed by plan shape |

Same seed + same configs → byte-identical files on the same machine. A new draw always takes a new counter.

## 8. Compatibility with OWNER_ACTIONS.md (decided 2026-10-15; origin/backend/owner-actions in progress)
- **Schedule per day:** light_effect becomes per day; open_ticks is already per tick. Owner changes apply from day + 1.
- **Information rule:** next-day changes use tallies up to day d. Today-only actions (shut_early, open_late) are decided at day start, from street events known in advance. This is required because a day's citizen-days run independently, not in global time order.
- **Street events the citizen model reads:**
  - weather → plan-level multipliers (config-independent)
  - club_night / gig → VenueEvent
  - roadworks / heavy traffic → execution modifiers: choice weight of stores on the street, and a leg time scale with legs cached per speed bucket
  - pedestrian closures would need per-day Routes (~0.4 s each); out of scope here
- With settings.OWNER_ADAPTATION = 0 the schedule is constant and everything above holds unchanged.

## Integration plan

Repo: /Users/sonionring/orca/accel-silly-hamsters. Ship as three PRs, one outcome each:
1. Performance prerequisites, with byte-identical output.
2. The citizen model end to end: schemas, offline templates, engine, run files, API, docs, tests, SIM_VERSION bump.
3. Haiku 5.5 template synthesis.

Before PR 2, agree the Schedule / day-hook interface with the owner-actions branch. Both rewrite backend/sim/engine.py, and that branch already adds settings.OWNER_ADAPTATION plus an autouse conftest that turns it off in tests.

## Reuse map (kept as is)
- citizens: race, light_factor, LIGHT_EFFECT, NIGHT_HOURS, VISIBLE_M, CLOSED_PENALTY, HOUR_BAND, PersonaModel, persona_models
- engine: record_closed semantics, the leave()/entry_weights exit logic, Schedule.open_until
- movement: walk, passes_near, Routes, door_point
- day_files conventions: midnight trips appear in both days; sort by start time and id
- kpis: build_results, run_kpis, city_metrics
- runner persistence order: summary.json last
- store.write_json atomic writes; api.common.read_run_file 404/500 handling

New code only where the map shows a gap: keyed RNG, cast, plans, memory bank, leg cache, diary.

## PR 1: prerequisites (no output change; SIM_VERSION stays 0.1.0)
- **backend/sim/movement.py:** _segment_cuts buckets segments on a 50 m grid (bbox + SNAP_M) and tests each pair once (i < j). This removes the O(M²) debt marker. The rest of build_walk_graph is unchanged.
- **backend/sim/engine.py:**
  - add a World.leg(a, b) cache (relative frames + footfall hits) and use it in walk_to
  - replace _footfall_near with per-trip hit keys + np.unique (same numbers)
  - memoise load_world() on (path, mtime_ns, size) of map, personas, demand and energy
  - build day_files as plain dicts and have runner write them; pydantic DayData validation moves to tests
- **Tests:** equality oracles (pairwise vs bucketed cuts; old passes_near footfall vs leg hits) and a byte-identity check against run files produced by main.

## PR 2: citizen model
- **backend/schemas.py** (shared seam, hand-written):
  - new literals and models: AgeBand, Occupation, Budget, Weekday, Window, RelativeTime, StepTemplate, ChainTemplate, RoutineSlot, ProfileTemplate, CastGroup, VenueEvent, CitizensFile
  - PersonasFile gains profiles, chains, visitorChains, budgetPrefs, plus a model_validator
  - DemandFile gains population, events, entryPointsByWeekday
- **backend/contract.py:** CitizenProfile, CitizenCard, CitizenIndex, DiaryEntry, DiaryDay, CitizenDiary.
- **backend/sim/rng.py** (new): mix64, Keyed, trip_block. rng_for stays, for the visitor Poisson cells.
- **backend/sim/population.py** (new): select_anchors(map), population_scale(world), build_cast(world, seed).
- **backend/sim/plans.py** (new): ChainModel resolution; day_plans(world, cast, seed) -> list[list[CitizenDay]], with no configs argument; plan_digest(plans) for tests; select_featured(world, cast, plans).
- **backend/sim/citizens.py:**
  - keep PersonaModel (plus budget-aware prefs), light_factor, race, band_of, ceil_tick and the constants
  - Memory becomes MemoryBank, with the habit term in factor and noticed_open
  - delete Regular, build_pool, _Availability, Arrival, ClubVisit, _Draft, plan_arrivals, _general_drafts, _club_drafts, arrival_scale
  - GENERAL_ARRIVALS_PER_DAY becomes ARRIVALS_PER_DAY = (2000, 4000)
  - new constants: HABIT_SCALE = 2, HABIT_BOOST = 1.0, CUT_SHORT_OUTCOME = 0.4, MIN_SLOT_GAP = 240, REST_AFTER_NIGHT_OUT = 600, MAX_LATE_START = 120
- **backend/sim/engine.py:**
  - World gains anchors, profiles, chains, purposes, events by day, a pull cache by reach, and cast/plan caches (at most 2 seeds)
  - build_schedule reads events (falling back to clubNights) and stores light_effect per day
  - _Simulation is rewritten as run_day / run_outing / store_step / decide / walk_to / leave / record_closed, each under 100 lines
  - simulate(world, configs, seed, *, diary=False) -> SimOutput
  - Trip gains citizen and outing; skipped_busy becomes skipped_outings
  - add `# debt:` markers: no citizen interaction (no queues or capacity); one race per decision (the batched upgrade, see performance)
- **backend/sim/kpis.py:** agents = distinct returning ids / distinct one-off ids. Every StoreStats field is unchanged.
- **backend/sim/diary.py** (new): kind codes; DiaryLog; write(directory, out, world, plans), which writes citizens.json and diaries/{k}.json; render_index() → CitizenIndex; render() → CitizenDiary (fixed text templates).
- **backend/sim/runner.py:** execute_run calls simulate(diary=True) and writes citizens.json and diaries/ before summary.json. evaluate keeps diary=False. _summary is unchanged.
- **backend/store.py:** write_json writes diaries/ compactly, as it does days/.
- **backend/settings.py:** SIM_VERSION = "0.2.0" (part of the run-cache key).
- **backend/api/routers/citizens.py** (new):
  - GET /api/runs/{run}/citizens → CitizenIndex
  - GET /api/runs/{run}/citizens/{citizen_id}/diary → CitizenDiary
  - citizen_id must match ^(r\d+|v\d+-\d+)$ before the shard lookup
  - 404 for an unknown run, a run without citizens.json (the run 0 sample, pre-0.2 runs) and an unknown id
  - also update backend/api/main.py (include the router) and the routers/__init__.py docstring
- **backend/pipeline/personas.py:** offline PROFILES, CHAINS, VISITOR_CHAINS and BUDGET_PREFS, with basis notes. offline_file and synthesised_file always include them; in this PR the LLM revises personas only. The notes say the templates are a hand-written fallback. The pipeline cache key already hashes the module source.
- **backend/pipeline/demand.py:**
  - population: office workers from AM-peak station exits (as returning_estimate does) ÷ mean office attendance. Residents, retired, students and remote workers from Census 2021 via Nomis (TS007A age, TS066 economic activity, TS058 works mainly from home) for the box's LSOAs when reachable; otherwise hand-written shares, labelled.
  - events: from clubNights plus hand-written weekly patterns for the map's clubs matched by name (XOYO, Village Underground), with measured=false.
  - entryPointsByWeekday from the five NUMBAT day types the builder already fetches.
  - keep returningPoolSize and returningShare (sum of the cast); MODEL_VERSION = 4.
- **backend/pipeline/osm_map.py** (map workstream; dependencies only):
  - keep office and residential buildings across the box (anchors)
  - force-include XOYO and Village Underground
  - stations inside the box become station entries; Liverpool Street sits about 610 m S and 480 m W of SHS, inside a ±750 m box, and Old Street about 850 m W, just outside
  - raise SIMPLIFY_TOLERANCE_M to cap route corners
- **tests/fixtures:**
  - map.json gains cafe s8, 2 office and 2 residential buildings
  - personas.json gains a template subset; demand.json gains population and one club event
  - new tests/fixtures/grid_world.py builds a synthetic 1.5 km world (80 stores, 45 entries, 3 stations, offices, homes) for the scale and performance tests
- **Existing tests that change:**
  - test_targets_agents_visits_concurrency_and_file_size: new targets
  - test_keyframes_follow_the_contract: paths may end at anchor doors
  - test_changing_one_store_does_not_reshuffle_arrivals: replaced by the plan-invariance and first-divergence tests
  - test_memory_factor_*: now tests MemoryBank
  - test_arrival_scale_*: now tests population_scale
- **Docs:**
  - docs/BUILD_NOTES.md: new simulation targets (2,000-4,000 citizens/day, nominal 3,000; outings 1.2-2.0 per citizen; peak visible ≲ 1,200; evaluate ≲ 5 s; day-file budget), a citizen-model section and the determinism keys
  - backend/CONTRACT_CHANGES.md and docs/FRONTEND_PROMPT.md: the new endpoints, plus behaviour notes: paths may start or end at a home or office door; an id can have several non-overlapping outings per day; id formats unchanged
  - docs/DELIVERABLES.md: update "About 800 synthetic citizens a day" and "about 2 seconds" once measured
- **Not touched:** backend/agents/*, backend/insights.py, economics, rules, and the reports (they consume runner and StoreStats, whose meaning is unchanged). Frontend colours need nothing: profiles reuse the 11 persona ids that PERSONA_ALIASES / PERSONA_COLORS already cover. A diary panel can come later.

## PR 3: Haiku 5.5 template synthesis
- **backend/pipeline/personas.py:**
  - TEMPLATE_SCHEMA (structured outputs) revises only the numbers in existing template ids: p, pByWeekday, windows, dwell, type weights, reach. Ids, store types and weekdays are enums; times are strings validated afterwards.
  - templates_from_llm clamps each value and falls back to the offline template where needed.
  - evidence comes via sourceIds; the response is cached as in synthesise().
  - same privacy rule: groups, never individuals.

## Local gate per PR (from BUILD_NOTES)
- .venv/bin/ruff format --check backend tests
- .venv/bin/ruff check backend tests
- .venv/bin/mypy backend
- .venv/bin/pytest -q
- npm test, only if apps/web changes

## Performance

## Basis
Measured in this session on the dev Mac: Apple M4 Pro, Python 3.12.15, numpy 2.5.4. scipy and numba are not installed, and BUILD_NOTES forbids new dependencies.

**Today, on the real 500 m map** (26 stores, 17 entries, 43 places, 184 graph nodes, 164 street segments):
- simulate: 1.17 s for 10,814 trips (772/day), about 108 µs per trip
- kpis: 0.03 s; day_files: 0.13 s; dump: 0.12 s
- Profile hot spots:
  - SeedSequence rng_for: 5.8 µs x 16.5k calls
  - 30.7k walk() calls and 21.8k decide calls
  - _footfall_near: 0.27 s. It checks every path segment against every door, so it grows about 9x with 3x trips and 3x stores.

**Primitives:**
| Operation | Cost |
|---|---|
| decide at 80 stores, distance decay | 8.2 µs |
| decide at 80 stores, detour decay | 9.8 µs |
| same decision batched over 3,000 rows | 0.79 µs per row |
| Generator(PCG64(int)) | 3.4 µs |
| PCG64 + 6 x 81 exponential block | 5.5 µs |
| keyed splitmix uniform | 0.25 µs (1.24 µs if 5 keys are mixed per draw, so mix the person-day base once) |
| cached leg → absolute keyframes | 0.21 µs |
| _segment_cuts | 2.23 µs per segment pair |

**Prototype** (throwaway script, not in the repo). 3,000 office-worker cast on the real map, 3 outings a day with coffee, lunch and an optional bar; keyed draws, per-day block, cached legs, memory factors. Result: 27,317 citizen-days / 81,951 outings in 1.32 s warm, i.e. 48 µs per citizen-day. The 1.68 M footfall keys went through np.unique in 0.13 s.

## Projection for the 1.5 km map
Assumed size: ~80 stores, ~45 entries and ~110 anchors (~235 places), ~2,000 nodes, ~1,500 segments. Seconds per run:

| Stage | 2,000/day | 3,000/day | 4,000/day | Cached |
|---|---|---|---|---|
| World build (bucketed cuts ~0.1, 235 Dijkstras ~0.35) | 0.5 | 0.5 | 0.5 | per process |
| Leg cache fill (~15-20k legs x ~25 µs) | 0.4 | 0.5 | 0.5 | per process |
| Cast (~15 µs per citizen) | 0.03 | 0.05 | 0.06 | per seed |
| Plans (~12 µs per citizen-day, incl. visitor Poisson cells) | 0.35 | 0.5 | 0.7 | per seed |
| Execution (60-75 µs per citizen-day*) | 1.9 | 2.8 | 3.8 | no |
| Tallies + kpis | 0.25 | 0.35 | 0.45 | no |
| **evaluate(), cold / warm** | **3.4 / 2.2** | **4.7 / 3.2** | **6.0 / 4.3** | |
| execute_run extra (day files, diaries ~0.4 s, citizens.json) | +0.6 | +0.8 | +1.0 | |

*The prototype's 48 µs plus deadlines, exit races over ~45 entries and plan objects. Day files are written as dicts + json, about 20 ms per day with integer coordinates.

"Warm" means the same process and seed. That covers every run of a training session (one seed), the API process after its first run, and the report's base/best pair. Each extra report seed (EXTRA_SEED_OFFSETS = (1, 2)) adds about 0.55 s for cast and plans.

**Verdict:** ~5 s holds at 3,000 citizens/day — evaluate cold is 4.7 s, and a training-session run including file writes is about 4.0 s. At 4,000/day it only holds warm. Nominal target: 3,000/day. The analyst loop is the warm case.

## What keeps it inside the budget
1. No SeedSequence per trip. Plans use keyed splitmix scalars; races use one PCG64 block per citizen-day, indexed by (store step, attempt).
2. walk() and closest-approach minutes give the same result shifted by t for any integer start t, so frames and footfall hits are computed once per (a, b) place pair. This replaces about 30k walk() calls and the all-segments x all-doors passes_near.
3. Grid-bucketed street intersection. Pairwise at ~1,500 segments costs about 2.5 s per world build.
4. World memoised per process; cast and plans cached per seed (at most 2 seeds, ~30-50 MB).
5. Day files without pydantic. Today building and dumping costs ~23 µs per trip, which would be ~1.4 s at 60k outings. Integer-metre keyframes measured 17% fewer bytes and a 2.2x faster dump.
6. Diaries only in execute_run.
7. Upgrade if a slower laptop, or 4,000/day cold, must hit 5 s: batch the races of one step round across citizens (measured 0.79 vs ~9 µs per decision; saves ~0.8 s at 4,000/day). Leave this marker in decide():

   `# debt: one race per citizen decision. ceiling: ~4,000 citizens/day in 5 s on an M4 Pro. upgrade: batch the races of one step round across citizens when a run must fit 5 s at higher volume or on slower hardware.`

## Day-file budget
- **Today:** 21.6 keyframes per trip, ~22 bytes per keyframe, ~610 bytes per agent entry, gzip 6.5x.
- **Synthetic benchmark** of 4,500 outings x 30 keyframes: 3.10 MB with 0.1 m coordinates, 2.56 MB with integer coordinates.
- **3,000 citizens/day** (~4,500-5,000 outings, ~22 keyframes after corner simplification): about 2.0-2.4 MB with integer coordinates, under the 2.5 MB cap.
- **4,000/day** needs one of two options. The first is GZipMiddleware (it compresses FileResponse streams too, roughly 6x on the wire) plus a higher raw cap, which needs frontend sign-off. The second is fewer citizens.
- **Peak walkers:** about 600-1,000 at weekday lunch, well under the frontend's CAPACITY = 4,000.
- **Disk:** about 35 MB of day files + 8 MB of diaries per run, vs about 6 MB today.

## Test plan

- Commands: .venv/bin/pytest -q tests/test_sim_movement.py tests/test_sim_engine.py tests/test_sim_plans.py tests/test_sim_citizens.py tests/test_sim_runner.py tests/test_api_citizens.py tests/test_personas.py tests/test_demand.py. The slow performance test runs with: SIM_PERF=1 .venv/bin/pytest -q -s -k performance. Fixture world: tests/fixtures, extended with cafe s8, 2 offices, 2 homes, templates, population and one club event.
- test_sim_movement.py::test_bucketed_cuts_match_pairwise. Run on the fixture streets and on data/processed/map.json (skip if absent). The bucketed _segment_cuts must give the same node set and an identical Routes.dist as the pairwise version, which the test keeps as an oracle.
- test_sim_engine.py::test_leg_cache_matches_walk_and_footfall. For 200 random (a, b, t), World.leg(a, b) shifted by t must equal movement.walk(corners, t). On a full run, footfall_near from leg hits must equal the old all-segments passes_near computation exactly.
- test_sim_runner.py::test_same_seed_same_configs_byte_identical. Extend it to citizens.json and every diaries/*.json. In PR 1, also compare against run files produced from main.
- test_sim_plans.py::test_cast_is_stable_and_sized. Two build_cast calls give equal results. Per-profile counts equal demand.population sizes x population_scale (largest-remainder rounding). Ids run r1..rN without gaps. Every home and work place is an anchor place.
- test_sim_plans.py::test_plans_never_see_configs. day_plans has no configs parameter. Simulate the baseline and a variant (s4 shut all day, s1 open 24 h, all lights off). The set of (agent_id, day, outing, planned start, origin, chain) must be identical, and every citizen-day's first outing must spawn at the identical (t, x, z).
- test_sim_plans.py::test_first_divergence_involves_the_changed_store. Compare the baseline with s7 closing at 17:00. Walk each citizen's outings in time order. The first outing whose path or visits differ must contain, in at least one of the two runs, a visit to s7 or a closed event at s7.
- test_sim_engine.py::test_contract_paths_and_outings. Checks: DayData validates; spawn, tIn and tOut sit on the 5-min grid; keyframe times strictly increase; speed is at most 2.5 m/s; every path starts and ends at an entry or an anchor door; one id's outings never overlap, within a day file or across day files; each visit's tOut is a keyframe time.
- test_sim_citizens.py::test_office_day_chain. Covers office-commuter outings on attended weekdays. Outing 1 starts 07:00-10:30 at the citizen's entry and ends at its own work door; a coffee visit, if any, is at a cafe and comes before arrival at work. The lunch outing starts and ends at the work door between 11:30 and 14:45, with a cafe, takeaway or restaurant visit. The evening outing leaves work at 16:30 or later and ends at an entry. The share of evening outings with a bar visit on Fridays is at least 2x the Mon-Wed share.
- test_sim_citizens.py::test_hybrid_attendance. Office-commuter attendance on Tue-Thu is at least 1.6x that of Mon and of Fri. No office-day outings on Sat/Sun.
- test_sim_citizens.py::test_retiree_weekly_cafe. Every weekly-cafe outing of a retired-local falls on that citizen's own weekday and starts within 45 min of its habit time. At least 80% of these retirees have a cafe visit in both weeks.
- test_sim_citizens.py::test_loyalty_forms_a_habit. Among retirees with two weekly-cafe visits, the share whose second cafe equals the first is at least 0.6. That share must be at least 0.2 above a control run with HABIT_BOOST = SATISFACTION_BOOST = 0 (monkeypatched).
- test_sim_citizens.py::test_found_shut_moves_regulars_within_type. s4 shuts 07:00-10:00. Cast members who found s4 shut on a morning pick s4 on later mornings at most 0.5x as often as those who never did. At least 80% of their later morning coffee visits are at the other cafe (s8), not at another store type.
- test_sim_citizens.py::test_retry_after_a_walk_up. When a coffee step walked up to a shut s4 and then visited a store, that store was a cafe in at least 70% of cases. No step ever makes more than maxRetries + 1 walk-ups. One-offs never carry memory across ids.
- test_sim_citizens.py::test_cut_short_lowers_satisfaction. MemoryBank unit check: a visit truncated by open_until gets outcome 0.4. Run check: when s5 closes 30 min early, regulars choose s5 less often on later days.
- test_sim_citizens.py::test_noticed_open_wins_regulars_back. Monkeypatch engine.build_schedule so s7 closes at 17:00 on days 1-7 and at 23:00 from day 8, the shape OWNER_ACTIONS will produce. Regulars who found s7 shut in week 1 must visit it on week-2 evenings at no less than 0.5x the rate of regulars who never did. With noticed_open disabled the ratio must be lower.
- test_sim_citizens.py::test_night_out_chain. Covers event-goers on event nights. Supplies and pres visits end before their club tIn. The club visit is at the event venue with tIn at or after doors. Late-food visits happen only for spill attendees, within 0-60 min after close. Each event-goer exits at an entry and its id appears in exactly one outing.
- test_sim_citizens.py::test_event_attendance_and_club_hours. Club visits per event night are within 10% of capacity x CLUB_ATTENDANCE_SCALE. There are zero club visits on non-event days. A club's open ticks equal the union of its events.
- test_sim_engine.py::test_club_spill_out_finds_the_takeaway_next_door_shut and test_takeaway_open_past_club_close_gains_visits. Today's tests, now driven by events. The hours lever must still turn 03:00 spill-out into visits, with at least 80% of the 03:00 trade on Fri-Sun mornings.
- test_sim_engine.py::test_night_lighting_raises_visits_of_an_open_store. Today's lighting test, unchanged: high vs off lighting from 17:00 to 24:00 must give at least 1.2x the night visits.
- test_sim_engine.py::test_found_closed_keeps_its_meaning. found_closed equals the (store, clock hour) histogram of closed_events. Every walked event happens at a tick when the store is shut. Every seen event's store is within VISIBLE_M of the citizen's place. StoreStats.foundClosedByHour equals found_closed / 14.
- test_sim_engine.py::test_footfall_counts_distinct_people. A cast citizen passing a door in two outings within one clock hour counts once. Standing at a door never counts. Per-store totals equal the oracle.
- test_sim_engine.py::test_kpis_recompute_from_per_store_results. Today's test, plus: summary agents equal distinct returning ids plus distinct one-off ids, and total equals their sum.
- test_sim_engine.py::test_targets_on_the_grid_world. Synthetic 1.5 km world. Mean citizens/day is in 2,000-4,000; outings per citizen 1.2-2.0; store visits/day at least 1.2x citizens; peak visible at most 1,200; the largest day file under 2.5 MB at 3,000/day.
- test_sim_runner.py::test_diary_agrees_with_day_files. For every featured citizen: diary visits equal that id's day-file visits (storeId, tIn, tOut); found_shut and seen_shut entries equal its closed_events; arrive and leave times equal the path ends; the listed days equal the days present.
- test_sim_runner.py::test_featured_are_stable_across_runs. Featured ids are identical for the baseline and a changed config on the same seed. The story slots present in the fixture are all covered. Every id resolves to a diary. evaluate() writes no citizens files.
- test_api_citizens.py. GET /api/runs/{run}/citizens returns 200 with featured cards. GET .../citizens/{id}/diary returns 200 for a featured cast id and for a one-off id (one day). Returns 404 for an unknown id, a malformed id, the run 0 sample and a run without citizens.json. No summary contains None, and the note is present.
- test_personas.py additions. The offline file validates with profiles, chains, visitorChains and budgetPrefs, and every reference resolves. Every persona id a profile uses is one of the 11 archetype ids the frontend aliases. LLM-shaped bad input (an unknown chain, 25:00, p 1.7, dwell 900) is clamped or falls back to the offline template.
- test_demand.py additions. Population sizes follow the documented derivation. With no listings, events fall back to one weekly event per ClubNight, noted as a fallback. entryPointsByWeekday has all 7 days when NUMBAT was measured.
- test_sim_engine.py::test_station_arrivals_follow_numbat. Uses real data; skipped when data/processed is missing. Compare sim station arrivals by hour, per day type, with the demand station shape: peak-normalised MAE at most 0.15 and the AM-peak share within 5 percentage points.
- test_sim_engine.py::test_performance_budget. Slow; opt-in with SIM_PERF=1. Grid world at 3,000 citizens/day: evaluate must take at most 6 s cold and 4 s warm on the dev Mac. Prints the stage breakdown: world, legs, cast, plans, execution, tallies.

## Risks

- Thin performance margin. evaluate() takes about 4.7 s cold at 3,000/day and about 6 s at 4,000/day. These figures come from an M4 Pro; an older laptop is 1.5-2x slower. Mitigations: a nominal 3,000/day, the caches, and the batched-decision upgrade (debt marker).
- Day files at 1.5 km stay at about 2-2.4 MB for 3,000/day only with integer coordinates and corner simplification. 4,000/day needs gzip on the wire and a higher cap, which is a frontend decision. Disk use per run grows from about 6 MB to about 45 MB.
- Event scale. At roughly 1:100 (2,000-4,000 agents for the 1.5 km box), XOYO's ~800 people become about 8 agents, so the spill-out demo moment looks thin. CLUB_ATTENDANCE_SCALE can exaggerate it but must be labelled as such. economics.gbp_per_week counts one agent visit as one real visit, so any scale change moves the £/week figures.
- Liverpool Street inside the box would dominate arrivals with City through-commuters. The demand builder must give it a partial 'enters the area' share, or the independent-shop customers get swamped.
- Grounding. Only station timing (NUMBAT) and, if reachable, the Census 2021 mixes are measured. Routines and chains (Friday drinks .55, pres .55, hybrid attendance) are judgement. Label the fallback in personas.json and in every diary ('Simulated, not a real person'). The Haiku pass may only revise numbers in existing templates, with citations and clamps.
- Memory weakens foundClosedByHour in week 2: regulars learn a store is shut and stop trying, more so with a larger cast. The store-owner heuristic (FOUND_CLOSED_CAPTURE x foundClosedByHour) then under-estimates missed demand. One-offs still dominate at night, and noticed_open partly offsets this.
- Plans ignore experience by design. A regular who keeps finding the cafe shut still comes on schedule and switches store. That keeps runs comparable ('the same 14 days of arrivals') but cannot show customers who stay home.
- Citizens never interact: no queues, no full cafes, and club capacity is a count, not a constraint. This is deliberate for determinism and speed; mark it with a debt: comment in engine.py.
- OWNER_ACTIONS coupling. Owner 'today' actions must be decidable from information known at day start, because a day's citizen-days run independently, not in global time order. Pedestrian street closures would need per-day routes (about 0.4 s each). origin/backend/owner-actions will touch engine.Schedule and the day loop: agree the interface first or expect conflicts in engine.py.
- The contract shape stays the same but its meaning changes: paths may start or end at building doors, and an id can have several outings per day. The current frontend copes (it spawns at path[0], and mergeDays keys trips by id@start). FRONTEND_PROMPT ('enters/leaves via entry points') and any consumer that assumes spawns only at entries must be updated.
- Anchor clustering (at most 64 homes and 48 workplaces) puts spawns on fewer doors than reality, so people visibly clump at office doors around 12:30.
- Without the bucketed street intersection, the 1.5 km world build adds about 2.5 s per run. It is a prerequisite, not an optimisation.
- Determinism. Files are byte-identical only on the same machine and numpy build, because float reductions can differ. Never iterate str-keyed sets (PYTHONHASHSEED). A new draw must take a new counter and never shift existing ones; the first-divergence test enforces this.
- The SIM_VERSION bump invalidates the run cache and makes old runs non-comparable. Old runs and the run 0 sample have no diaries, so they return 404. Start a fresh analyst session after the change.
- Privacy. Diaries narrate a synthetic person's movements across real, named shops. They carry no names, ids are run-local, and profiles come only from aggregate shares. Diaries expose the same as day files do, and must stay out of owner-scoped views beyond the owner's own stats.
- Persona ids. Profiles must reuse the 11 archetype ids, or the frontend renders those citizens in PERSONA_FALLBACK grey. A test guards this.
- Memory footprint. Cached plans take about 30-50 MB of Python objects per seed; cap the cache at 2 seeds. The API never needs plans, because it reads files.
- Real venues. XOYO and Village Underground nights are hand-written weekly patterns until listings are usable (RA, Dice and Eventbrite terms restrict scraping). Keep measured=false and never claim real line-ups.
- Scope. This is the largest change to the sim since v1, and the second concurrent change to engine.py. Split it into the byte-identical prerequisites PR, the citizen-model PR and the Haiku PR, each passing the full local gate.

## Evidence: parameters

| Parameter | Value | Derivation | Measured | Source |
| --- | --- | --- | --- | --- |
| box_definition | Centre 51.523375,-0.075246. Lat 51.51663-51.53012, lon -0.08607 to -0.06442. Area 2.25 km2. 16 LSOAs have their population-weighted centroid inside: E01004315, E01004307, E01035669, E01033708, E01004306, E01033706, E01001780, E01035668, E01004316, E01004313, E01004312, E01004309, E01004311, E01004308, E01035664, E01004310. 30 LSOAs and 11 wards intersect the box. | Box of +/-750 m around the station coordinate from the TfL API. LSOA/ward polygons intersected and clipped locally; the clipped areas sum to 2.25 km2. | yes | https://api.tfl.gov.uk/StopPoint/Search/Shoreditch%20High%20Street ; https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/LSOA_PopCentroids_EW_2021_V4/FeatureServer/0/query |
| ward_area_inside_box | km2 inside (share of ward): Spitalfields & Banglatown 0.639 (71%); Weavers 0.617 (92%); Hoxton East & Shoreditch 0.533 (53%); Bishopsgate (City) 0.212 (85%); Hoxton West 0.075 (12%); Bunhill (Islington) 0.062 (7%); Haggerston 0.033 (4%); Whitechapel 0.025; St Peter's 0.020; Broad Street 0.017; Coleman Street 0.017. Clerkenwell does not touch the box. | Dec 2022 ward polygons clipped to the box | yes | https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Wards_December_2022_Boundaries_UK_BFC/FeatureServer/0/query |
| resident_population_box | 29,651 usual residents (Census 2021). Area-weighted check across all 30 intersecting LSOAs: 29,466. 95.4% live in households, 4.6% (1,378) in communal establishments. | Sum of TS007A totals for the 16 centroid LSOAs. TS001 gives 29,642 for the same set (ONS cell perturbation). | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_2020_1.data.csv?date=latest&geography=E01004315,E01004307,E01035669,E01033708,E01004306,E01033706,E01001780,E01035668,E01004316,E01004313,E01004312,E01004309,E01004311,E01004308,E01035664,E01004310&c2021_age_19=0&measures=20100&select=geography_code,obs_value |
| resident_age_mix | All residents: 0-17 16.5% / 18-24 14.7% / 25-34 30.4% / 35-49 21.1% / 50-64 11.3% / 65-74 3.3% / 75+ 2.6%. Adults 18+ only (24,749): 18-24 17.7% / 25-34 36.5% / 35-49 25.3% / 50-64 13.5% / 65-74 4.0% / 75+ 3.1%. 5-year counts: 0-4 1319, 5-9 1291, 10-14 1391, 15-19 1501, 20-24 3771, 25-29 5057, 30-34 3971, 35-39 2668, 40-44 1983, 45-49 1614, 50-54 1375, 55-59 1046, 60-64 916, 65-69 591, 70-74 392, 75-79 307, 80-84 246, 85+ 212. | TS007A summed over the 16 LSOAs. The 15-19 band is split 60/40 into 15-17 and 18-19, assuming uniform ages. | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_2020_1.data.csv?date=latest&geography=E01004315,E01004307,E01035669,E01033708,E01004306,E01033706,E01001780,E01035668,E01004316,E01004313,E01004312,E01004309,E01004311,E01004308,E01035664,E01004310&measures=20100&select=geography_code,geography_name,c2021_age_19_name,obs_value |
| resident_economic_status_16plus | Base 25,373 residents aged 16+. Employed, excluding FT students: 59.0% (employee full-time 39.9%, employee part-time 8.6%, self-employed 10.4%). Unemployed 4.8%. Full-time students 14.8% (3,765: 4.0% economically active, 10.8% inactive). Retired 5.5% (1,403). Looking after home/family 6.9%. Long-term sick 4.5%. Other inactive 4.5%. Self-employed are 17.6% of employed residents (2,640); part-time employees are 14.7%. | TS066 summed over the 16 LSOAs | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_2083_1.data.csv?date=latest&geography=E01004315,E01004307,E01035669,E01033708,E01004306,E01033706,E01001780,E01035668,E01004316,E01004313,E01004312,E01004309,E01004311,E01004308,E01035664,E01004310&measures=20100&select=geography_code,geography_name,c2021_eastat_20_name,obs_value |
| resident_occupation_mix | Employed residents (15,671): managers 14.4% / professional 33.4% / associate professional/technical 20.2% / administrative 6.0% / skilled trades 4.3% / caring/leisure 4.9% / sales/customer service 6.1% / process/plant 3.9% / elementary 6.8% | TS063 summed over the 16 LSOAs | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_2080_1.data.csv?date=latest&geography=E01004315,E01004307,E01035669,E01033708,E01004306,E01033706,E01001780,E01035668,E01004316,E01004313,E01004312,E01004309,E01004311,E01004308,E01035664,E01004310&measures=20100&select=geography_code,c2021_occ_10_name,obs_value |
| ward_profiles_census2021 | residents / age 0-14 / age 20-34 / age 65+ / of 16+: employed (excl. FT students) / FT students / retired. Hoxton East & Shoreditch 11,773 / 12.8% / 42.0% / 6.1% / 64.0% / 12.4% / 5.5%. Haggerston 14,396 / 13.9% / 36.9% / 7.3% / 63.4% / 10.1% / 7.0%. Hoxton West 13,756 / 13.3% / 40.0% / 5.9% / 62.6% / 14.5% / 5.3%. Weavers 13,338 / 15.6% / 38.6% / 6.4% / 60.3% / 11.1% / 6.3%. Spitalfields & Banglatown 13,356 / 14.3% / 44.1% / 5.7% / 53.5% / 18.2% / 5.4%. Bunhill 11,146 / 13.0% / 38.4% / 8.8% / 56.1% / 18.7% / 8.8%. Clerkenwell 10,952 / 12.4% / 35.2% / 9.1% / 54.1% / 19.5% / 8.8%. | 283 OAs best-fitted to Dec 2022 wards (ONS OA21_WD22 lookup), with TS007A and TS066 summed by ward. City wards are not in the lookup (City OAs map to the borough), so Bishopsgate is omitted; it has very few residents. | yes | https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/OA21_WD22_LTLA22_UTLA22_RGN22_CTRY22_EW_LU_v2/FeatureServer/0/query + Nomis NM_2020_1 / NM_2083_1 by OA code |
| workplace_jobs_in_box | BRES jobs (employees plus working owners), area-weighted: 2015 115,041 / 2017 128,658 / 2019 138,792 / 2021 150,675 / 2022 164,863 (2011-LSOA basis) / 2023 182,266 / 2024 200,400 (2021-LSOA basis). 2024 counting only the 16 centroid LSOAs, i.e. excluding the City and Islington slivers: 128,625. Recommended central value for 2024: ~180k jobs (range 165k-200k). | BRES LSOA counts multiplied by each LSOA's area share inside the box. The City LSOA E01032739 (422k jobs, 14.6% of its area inside) contributes about 62k and is the main uncertainty. BRES 2015 (115k) is close to the 2011 Census workplace population (103k), which supports using it for people as well as jobs. | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_189_1.data.csv?geography=1946157247TYPE298,1946157248TYPE298,1946157251TYPE298,1946157257TYPE298&date=2015,2017,2019,2021,2022&industry=37748736&employment_status=4&measure=1&measures=20100 ; 2023-24 with 2021 LSOA GSS codes |
| workplace_population_2011_and_worker_age_mix | 2011 Census workplace population aged 16-74 in the box: 103,022 by workplace zone (City part 41,786; Hackney 29,017; Tower Hamlets 26,609; Islington 5,609). OA-based check: 100,071. Worker age mix: 16-24 10.3% / 25-34 40.3% / 35-49 37.4% / 50-64 11.2% / 65-74 0.8%. | WP1101EW by workplace zone, weighted by the share of each of the 160 zones inside the box | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_1320_1.data.csv (WZ codes, c_sex=0, c_age=0..59) |
| worker_industry_mix_2024 | Share of box jobs by SIC division: computer programming 14.3% / financial services 10.0% / auxiliary finance 8.7% / legal & accounting 8.1% / head offices/management consultancy 7.8% / employment agencies 7.2% (likely head-office reporting) / food & beverage service 4.7% (~9,400 jobs) / retail 3.9% (~7,700) / office support 3.0% / advertising 3.0% / social work 2.6% / architecture/engineering 2.0% / information services 2.0% / real estate 1.9% / education 1.7% / accommodation 0.8% (~1,600) | BRES 2024 division counts (industry=TYPE35), area-weighted | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_189_1.data.csv?geography=<30 LSOA21 codes>&date=latest&industry=TYPE35&employment_status=4&measure=1&measures=20100 |
| workers_per_resident | About 6.8 jobs per resident (BRES 2024: 200,400 vs 29,651 residents). About 6 at the central 180k. 3.5 using the 2011 Census workplace population. | Ratio of measured figures from different years | estimate | BRES NM_189_1 ; Census 2021 TS007A ; Census 2011 WP1101EW |
| office_day_of_week_index | Station exits on a typical 2024 day, relative to Tue-Thu. Liverpool Street LU: Mon 0.76, Fri 0.77, Sat 0.68, Sun 0.44 (Tue-Thu = 111,635). Old Street: Mon 0.75, Fri 0.87, Sat 0.78, Sun 0.43 (Tue-Thu = 28,890). For office workers use Mon 0.76, Tue-Thu 1.00, Fri 0.77. The weekend office factor is not measured; station weekend flows are mostly leisure. | TfL AC2024 typical-day exits | yes | https://crowding.data.tfl.gov.uk/Annual%20Station%20Counts/2024/AC2024_AnnualisedEntryExit_Public.xlsx |
| office_presence_level | Pret 'London: City Worker' stores: 2024 mean index 76.8 (first 4 weeks of 2020 = 100); Sep-Oct 2024 between 63 and 70. London workers (Sep 2022-Jan 2023): 40% hybrid, 31% travel-only, about 29% home-only. GB Oct 2024: 28% hybrid; 19% of 16-29s vs 29% of 30+ (Apr-Jun 2024). Derived share of box jobs physically present: Tue-Thu about 0.56 (plausible range 0.55-0.75), Mon/Fri about 0.43. | Presence = 0.31 travel-only + 0.40 hybrid x 0.5 days in office = 0.51 average weekday. Rescaled with weekday weights (0.76, 1, 1, 1, 0.77) to get Tue-Thu 0.56 and Mon/Fri 0.43. The Pret index suggests a higher upper bound of about 0.75. | estimate | https://www.ons.gov.uk/file?uri=/economy/economicoutputandproductivity/output/datasets/transactionsatpretamanger/2024/transactionsatpretamangerdataset311024.xlsx ; https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/articles/characteristicsofhomeworkersgreatbritain/september2022tojanuary2023 |
| work_location_share_by_age | Share of work minutes spent away from home, UK, March 2024: 18-24 0.89 / 25-34 0.68 / 35-44 0.70 / 45-54 0.77 / 55-64 0.72 | OTUS Table 7: working away from home / (away + from home), averaged over diary days | yes | https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/personalandhouseholdfinances/incomeandwealth/datasets/timeuseintheuk/march2024/timeuseintheukmarch24.xlsx |
| arrivals_by_hour_shoreditch_high_st | Station exits, % of the day by hour starting. Tue-Thu (11,734): 06 1.9/07 7.6/08 18.6/09 17.2/10 8.1/11 4.4/12 4.1/13 3.9/14 3.5/15 3.5/16 4.3/17 6.0/18 6.8/19 4.3/20 2.2/21 1.4/22 1.1/23 0.7/00 0.2. Fri (11,299): 07 4.4/08 9.0/09 10.0/10 6.5/11 5.0/12 4.9/13 4.7/14 4.5/15 4.7/16 5.6/17 7.2/18 8.5/19 7.7/20 5.1/21 3.5/22 3.0/23 2.3/00 1.1/01 0.3/02 0.2. Sat (12,676): 08 2.1/09 4.1/10 5.8/11 7.3/12 8.8/13 8.9/14 8.1/15 8.0/16 7.6/17 7.2/18 7.2/19 7.0/20 5.3/21 3.7/22 3.2/23 2.5/00 1.2/01 0.3. Sun (7,547): 09 4.5/10 8.0/11 10.8/12 12.9/13 12.1/14 9.4/15 8.4/16 7.5/17 6.4/18 5.6/19 4.4/20 2.8/21 1.6/22 1.2/23 0.6. | NUMBAT 2024 Station_Exits, quarter-hours summed to hours. NUMBAT is modelled and annualised. | yes | https://crowding.data.tfl.gov.uk/NUMBAT/NUMBAT%202024/NBT24TWT_outputs.xlsx (also FRI/SAT/SUN) |
| departures_by_hour_shoreditch_high_st | Station entries, % of the day by hour. Tue-Thu (10,584): 15 4.9/16 7.9/17 16.0/18 17.0/19 10.2/20 7.0/21 6.6/22 6.0/23 4.1/00 0.7. Fri (10,053): 16 8.3/17 11.0/18 11.1/19 8.4/20 6.4/21 6.6/22 7.4/23 7.0/00 2.6/01 1.1/02 0.8/03 0.4/04 0.1. Sat (10,704): 12 4.4/13 5.4/14 6.2/15 8.0/16 9.1/17 9.1/18 9.0/19 7.2/20 5.7/21 5.7/22 7.3/23 7.3/00 3.5/01 1.6/02 1.1/03 0.5/04 0.2. Departures from 22:00 to 05:00: Tue-Thu 1,154 / Fri 1,950 / Sat 2,291 / Sun 448 people/day. After midnight: Fri 503, Sat 739 (Night Overground). | NUMBAT 2024 Station_Entries; NUMBAT 'Late' band = 22:00-05:00 | yes | https://crowding.data.tfl.gov.uk/NUMBAT/NUMBAT%202024/NBT24SAT_outputs.xlsx |
| office_arrivals_by_hour_liverpool_st | Liverpool Street LU exits, Tue-Thu (133,216): 06 3.5/07 8.0/08 14.1/09 11.6/10 5.8/11 4.2/12 4.1/13 3.9/14 4.0/15 4.6/16 6.2/17 8.5/18 7.4/19 4.0/20 2.7/21 2.5/22 2.5/23 1.5. Old Street Tue-Thu exits peak 08-10 (34.2% of the day). | NUMBAT 2024, City-fringe office proxy | yes | https://crowding.data.tfl.gov.uk/NUMBAT/NUMBAT%202024/NBT24TWT_outputs.xlsx |
| share_out_of_home_by_hour_national | % of adults outside the home, March 2023. Weekday: 07 18.5/08 35.4/09 43.4/10 47.4/11 51.1/12 52.8/13 50.8/14 49.6/15 46.6/16 41.3/17 34.4/18 26.9/19 22.7/20 15.6/21 10.5/22 6.9/23 3.6/00 1.9/01 1.5. Weekend: 08 13.1/09 22.7/10 31.9/11 36.9/12 39.3/13 41.5/14 40.1/15 36.9/16 31.2/17 25.7/18 21.5/19 21.4/20 17.0/21 10.8/22 7.4/23 4.0/00 2.4/01 1.8. Weekday cooking peaks at 17:00 (12.7%) and 18:00 (11.4%), so evening grocery runs fall just before. | 10-minute OTUS shares averaged to hours. England and Wales, all adults; no age or work-status split is published. | yes | https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/personalandhouseholdfinances/incomeandwealth/adhocs/1496timeuseinenglandandwalesbyweekdayandweekenddaymarch2023/timeusedataweekdaysandweekendsmarch2023.xlsx |
| late_night_street_footfall_profile | Pedestrians per 15 min at Shoreditch High St / Great Eastern St, mean of 4 Fridays, Jul-Oct 2016: 21:00 646 / 22:00 619 / 23:00 826 (max 1,165) / 00:00 695 / 01:00 426 / 02:00 344 / 03:00 246. Relative to 21:00: 1.00, 0.96, 1.28, 1.08, 0.66, 0.53, 0.38. Old Street north pavement: Sat 16 Jul 409/491/890/688/223/383/212; Thu 10 Nov 574/636/624/613/252/241/189. | Appendix 2 counts. Peak is 23:00-00:15; dispersal runs 01:00-03:30. | yes | https://consultation.hackney.gov.uk/licensing-and-regulatory-services/licensing-policy-consultation/supporting_documents/Evening%20and%20Nighttime%20Economy%20Behaviour%20Study.pdf |
| nightlife_day_of_week_multipliers | Local, Shoreditch High St departures 22:00-05:00, relative to Tue-Thu: Tue-Thu 1.00 / Fri 1.69 / Sat 1.99 / Sun 0.39. London-wide night visitors (BT 2023) 21-24h, relative to Wed: Sun 0.89 / Mon 0.89 / Tue 0.93 / Wed 1.00 / Thu 1.20 / Fri 1.59 / Sat 1.83. At 00-03h: Thu 1.11, Fri 1.57, Sat 1.83. Hackney visitors, Sun-Wed vs Thu-Sat nights: 0.58 for 18-24h, 0.73 for 00-06h. | NUMBAT late entries. GLA Figure 42 (chart read, about +/-0.05M) and Figure 44 (exact table). | yes | NUMBAT 2024 ; https://data.london.gov.uk/download/london-at-night--research-and-analysis/5311efaa-47c8-4664-a188-09e8763ae678/London-at-Night-Update-2024%2520%2528FOR%2520PDF%2529.pdf |
| daytime_leisure_weekend_multiplier | Shoreditch High St arrivals 10:00-16:00: Sat 5,932 = 1.84x Tue-Thu (3,227); Sun 4,649 = 1.44x. Total exits: Mon 0.75 / Fri 0.98 / Sat 1.11 / Sun 0.66 of Tue-Thu (11,281). This is the only local station where Saturday exceeds midweek. | NUMBAT midday shares multiplied by day totals; AC2024 typical days | yes | NUMBAT 2024 ; AC2024 |
| night_visitors_present_in_box_area | BT Mobility 2023, average Thu-Sat night, 18:00-24:00 visitors: Shoreditch town centre about 30k, Brick Lane about 11k, Liverpool Street about 15k. 00:00-06:00: Shoreditch about 5.4k. Density per 350 m hex, 18-24h: Liverpool St about 13.7k, Shoreditch about 6.9k. 00-06h: Shoreditch about 1.26k, Liverpool St about 1.24k. Borough totals, Thu-Sat 18-24h: Hackney 123,385; Tower Hamlets 186,088; City 96,712. Relative to Saturday 12-15h footfall: Hackney 0.76 (Thu-Sat evening), 0.44 (Sun-Wed evening), 0.23 / 0.17 (00-06h). | Town-centre values read from Figures 46-49, roughly +/-1-2k. Borough values are exact from Figures 44-45. BT 'visitors' means people who neither live nor work in the area. | yes | https://data.london.gov.uk/download/london-at-night--research-and-analysis/5311efaa-47c8-4664-a188-09e8763ae678/London-at-Night-Update-2024%2520%2528FOR%2520PDF%2529.pdf |
| london_night_activity_frequency | Share of Londoners going out 18:00-06:00, in the order few times/week / once/week / once/month / less than monthly / never. Pub or bar: 18 / 24 / 18 / 22 / 17%. Socialise elsewhere: 15 / 31 / 21 / 21 / 13%. Cultural: 7 / 14 / 26 / 35 / 17%. Everyday errands and shopping: 38 / 32 / 11 / 10 / 9%. GB 2015 (YouGov): 14% go to a pub weekly, 16% monthly, 11% never. | Survey charts, N=2,000 London adults, March 2022 | yes | https://data.london.gov.uk/download/london-at-night--research-and-analysis/4bcae9c9-a524-4082-a380-db755e7808c6/London%2520at%2520night%2520survey.pdf |
| late_night_out_by_age | Travel between 23:00 and 05:00 at least weekly: 18-24 30% / 25-49 24% / 50-64 13% / 65+ 13%. Overall about 1 in 5 weekly, 1 in 3 monthly, 10% on 3 or more days a week. Purpose: 53% leisure, 22% visiting friends/family, 19% work. | TfL/GLA Late Night Travel Survey, YouGov Jan 2024, N=1,074 | yes | https://data.london.gov.uk/download/london-at-night--research-and-analysis/5311efaa-47c8-4664-a188-09e8763ae678/London-at-Night-Update-2024%2520%2528FOR%2520PDF%2529.pdf |
| night_out_rate_per_week_by_age | Pub/bar evenings per week (anywhere in London): all adults 0.75 / 18-24 about 1.1 / 25-49 about 0.9 / 50-64 about 0.5 / 65+ about 0.5. Share with a night past 23:00 at least weekly: 0.30 / 0.24 / 0.13 / 0.13. Visits to the box are a fraction of these, depending on home distance (see visit_frequency_distribution). | Frequency bins mapped to rates (few times/week = 2.5, weekly = 1, monthly = 0.23, less = 0.08), giving 0.75/week. Scaled by each age band's late-night weekly share divided by the 20.6% all-adult share. | estimate | GLA London at night survey 2022 + Late Night Travel Survey 2024 + Census 2021 London ages (NM_2020_1, geography=E12000007) |
| age_mix_of_late_night_visitor_pool | 18-24 16.5% / 25-49 60.4% / 50-64 13.6% / 65+ 9.5%. For the club/bar sub-pool, skew younger: the Liverpool nightlife sample (18-35) had mean age 24.3, 52% male and 29% students. | Weekly late-night shares by age multiplied by London adult population (Census 2021: 11.4 / 52.0 / 21.6 / 15.1%). The implied 20.6% weekly overall matches the survey's 'about 1 in 5'. | estimate | Late Night Travel Survey 2024 ; https://www.nomisweb.co.uk/api/v01/dataset/NM_2020_1.data.csv?date=latest&geography=E12000007&measures=20100 ; https://essl.leeds.ac.uk/download/downloads/id/570/anderson3.pdf |
| predrinks_prevalence_and_location | P(pre-drinks before a night out): 0.58 for general nightlife users aged 18-35 (Liverpool 2006: 57.6%); 0.83 for students (English student drinkers 2022: 82.8%). Where (students): own home 54%, friend's home 45%, outdoors 0%. Pre-drinks supply 26.5% of women's and 15.4% of men's alcohol for the night. 77.4% always drink on a night out. | Published survey percentages | yes | https://essl.leeds.ac.uk/download/downloads/id/570/anderson3.pdf ; Hughes 2008 PMID 17996008 ; https://www.ebi.ac.uk/europepmc/webservices/rest/PMC8929586/fullTextXML |
| chain_offlicence_or_supermarket_step | Recommended: P(buys alcohol at an off-licence or convenience store on the way / pre-drinks) 0.3-0.5. P(supermarket run before the night) 0.2-0.3. Off-licence dwell 2-8 min. Measured context: the Shoreditch Buffer has 8 convenience-store off-licences permitted to 01:00 or later, and on-street drinking of off-sales was observed. | The probabilities are assumptions. The off-licence count and behaviour are observed (Hackney 2016-17). | estimate | https://consultation.hackney.gov.uk/licensing-and-regulatory-services/licensing-policy-consultation/supporting_documents/Evening%20and%20Nighttime%20Economy%20Behaviour%20Study.pdf |
| chain_bar_to_club_to_takeaway | Recommended chain: pre-drinks (18:30-21:30) -> 1-3 bars (21:00-23:30) -> P(club) 0.3-0.5, entering 23:00-01:00 and leaving 02:00-04:00 -> P(late takeaway) 0.5 (range 0.35-0.65), 5-15 min -> home via Night Overground/Night Tube or bus. Measured anchors: 79.4% of patrons interviewed mid-night intended to drink more before going home; the Shoreditch Buffer has 29 premises open to 01:00 or later (5 nightclubs, 11 late bars, 10 late-night takeaways/refreshment, 1 pub, 1 hotel bar, 1 adult venue), plus 9 in the Tower Hamlets part and 5 in the Islington part; the study notes that fast food is the only food after 23:00 and that dispersal flows towards Liverpool Street. | Transition probabilities are assumptions; no open survey measures takeaway uptake after clubbing. Timing comes from the measured street counts and NUMBAT. | estimate | Bellis 2010 PMID 20406433 ; Hackney ENTE study 2017 ; NUMBAT 2024 |
| visit_frequency_distribution | Visitation law: visitor density rho(r,f) = mu/(r*f)^2. With T = 30 days and f from 1 to 30 days: P(f=1) 0.62, P(f=2-3) 0.22, P(f>=4, about weekly) 0.16, P(f>=8) 0.06. Weekly-or-more regulars account for 54% of visit-days; one-day visitors account for 25%. At a fixed frequency, visitors fall with distance as 1/r^2. | Discrete f^-2 distribution normalised over 1..30. The law is fitted to cell-level phone data from Boston, Portugal, Singapore, Dakar and Abidjan, not London or individual venues. | estimate | https://www.isi.it/wp-content/uploads/2024/01/the-universal-visitation-law-of-human-mobility_s41586-021-03480-9.pdf |
| routine_regularity | Each person keeps about 25 familiar locations at any time (stable over years). Individual mobility is 93% predictable. Use about 25 regular places per agent, drawn mostly near home and work, with preferential return. | Published findings | yes | Alessandretti 2018 PMID 31097800 ; Song 2010 PMID 20167789 (Europe PMC) |
| event_only_visitor_share | Proxy: 62% of a place's unique monthly visitors come on one day only. Recommended: 0.6-0.75 of attendees at a club event night (e.g. XOYO) have no other visit to the box in the 14 days; 0.8 for ticketed one-off events. | The law-derived P(f=1) is used as a floor. The uplift for clubs is an assumption; ticketing data is proprietary. | estimate | Schlapfer 2021 ; GLA BT 2023 |
| returning_pool_composition | Unique people present on 2 or more days in 14: non-resident workers about 67% (about 175k), residents about 12% (29.7k), regular leisure visitors about 21% (about 55k). One-off evening stream: about 80k unique per 14 days, plus an unmeasured daytime tourist stream. Age mix within each group comes from resident_age_mix, workplace_population_2011_and_worker_age_mix and age_mix_of_late_night_visitor_pool. | Workers: 180k jobs minus a small local overlap; all attend at least twice in 14 days at London hybrid rates. Visitors: Shoreditch town centre 30k x 3 Thu-Sat nights + 17.5k x 4 Sun-Wed nights = 160k visitor-evenings/week, about 686k/month. Divided by 2.48 visit-days per unique visitor (f^-2 mean) gives about 277k unique per month; 38% visit on 2 or more days and 62% once, scaled to 14 days. | estimate | BRES ; Census 2021 ; GLA BT 2023 ; Schlapfer 2021 |
| visit_frequency_per_week_by_profile | Office worker: 3.6 office days/week if they attend at all (all-worker average 2.55), Mon/Fri weight 0.76. Lunch out 2-3 times/week at 12:00-14:00 (assumption). After-work drink about 0.9 evenings/week. Resident: about 1.3 evening errand trips/week (70% at least weekly), 17:00-21:00. Remote/freelance resident (17.6% of employed residents self-employed): cafe session 1-2 times/week, 60-180 min (assumption). Student 18-24: about 1.1 evenings out/week, 30% past 23:00 weekly. Professional 25-49: about 0.9 evenings out/week, 24% late. 50+: about 0.5/week, daytime-weighted. 65+ resident: 1-2 fixed daytime cafe visits/week, 10:00-14:00 (assumption). | Measured rates (GLA surveys, ONS hybrid shares, Census) combined with assumptions where marked | estimate | GLA London at night survey 2022 ; Late Night Travel Survey 2024 ; ONS homeworkers Sep 2022-Jan 2023 ; Census TS066 |
| tourism_volumes_and_repeat | International: 20.9M visits to London in 2024 (spend £17.3bn); top markets US 3.75M, France 2.04M, Germany 1.57M, Spain 1.43M. About 5.5 nights per visit, i.e. about 316k international visitors in London on an average night. Domestic: 210M tourism day visits in 2023 (£11.4bn, about £54/visit, about 575k/day); 189M day visits and 15.1M overnight trips in 2024. Repeat share among holiday visitors to Britain: US 58%, Germany 62%, Netherlands 76%; 66-68% of holiday visitors visit London. | Published figures. Nights per visit = GLA 2030 projection ratio 139.0M nights / 25.2M visitors. | yes | https://data.london.gov.uk/download/2j81l/sg4/Tourism-in-London-Recent-Trends.pdf ; https://www.visitbritain.org/media/3110/download ; https://www.visitbritain.org/media/618/download |
| tourist_share_and_dwell_shoreditch | Recommended: tourists are 25-40% of weekend daytime leisure visitors and 10-20% of night visitors. Dwell in the box 2-4 h with 2-4 stops. P(revisits within 14 days) 0.1-0.2, given multi-night stays. Sunday peak 11:00-14:00. Measured anchors: a tourism day visit is at least 3 h including travel (GBDVS definition); Hackney observers report young foreign visitors in the night crowd; Truman Markets reportedly draw about 25,000 Sunday shoppers, mostly visitors (search snippet only; source blocked). | Assumptions. There is no open Shoreditch visitor-origin or dwell measure; the GLA High Streets Data Service split is restricted. | estimate | https://www.visitbritain.org/media/3108/download ; Hackney ENTE study ; NUMBAT Sun profile |
| students_population | Full-time students aged 16+ living in the box: 3,765 (14.8% of 16+). In nearby boroughs: Hackney 21,273 / Tower Hamlets 34,292 / Islington 21,340 / City 843 (77,748 total). London: 702,947 (9.9% of 16+). These include 16-17s in full-time education, and Census 2021 was during COVID. Provider headcounts, HESA 2024/25 via Wikipedia (unverified): UCL 51,315 / KCL 40,870 / City (UKPRN 10001478) 27,230 / UEL 26,755 / QMUL 24,640 (low against earlier years; check) / UAL 22,950 / LSBU 15,760 / London Met 13,665 / LSE 12,950. Students were 29% of nightlife users in the Liverpool intercept survey. | Census TS066 categories 1006 + 16. HESA site blocked, so Wikipedia's HESA templates were used as a fallback. | yes | https://www.nomisweb.co.uk/api/v01/dataset/NM_2083_1.data.csv?date=latest&geography=E09000012,E09000030,E09000019,E09000001,E12000007&c2021_eastat_20=0,1006,16&measures=20100 ; Wikipedia expandtemplates |
| older_residents_daytime | Residents aged 65+: 1,748 (5.9%); retired: 1,403. National free time (entertainment, socialising) at 65-74: 317.6 min/day vs 156.8 at 25-34 (March 2024). Only 13% of 65+ travel after 23:00 weekly. Out-of-home share peaks 11:00-14:00 on weekdays (51-53% of all adults). Recommended: a 65+ regular gets 1-2 fixed-weekday daytime cafe visits; P(same weekday each week) 0.5-0.7 (assumption). | Census and OTUS are measured; the fixed-weekday habit share is assumed (no open data) | estimate | Census TS007A/TS066 ; ONS Time use March 2024 Table 7 ; ONS ad hoc 1496 |

## Evidence: sources

| Source | Access | What it gives | URL |
| --- | --- | --- | --- |
| TfL Unified API: StopPoint search | open, no key needed at low volume. GET https://api.tfl.gov.uk/StopPoint/Search/Shoreditch%20High%20Street | Box centre: Shoreditch High Street station (910GSHRDHST) at 51.523375, -0.075246 | https://api.tfl.gov.uk/StopPoint/Search/Shoreditch%20High%20Street |
| ONS Open Geography Portal (ArcGIS REST) | open. Called <service>/FeatureServer/0/query with geometry=-0.08607,51.51663,-0.06442,51.53012, geometryType=esriGeometryEnvelope, inSR=4326. Services used: LSOA_PopCentroids_EW_2021_V4, Lower_layer_Super_Output_Areas_December_2021_Boundaries_EW_BFC_V10, Middle_layer_..._2021_..._BFC_V7, Wards_December_2022_Boundaries_UK_BFC, Wards_December_2024_Boundaries_UK_BFC, Workplace_Zones_Dec_2011_FCB_in_England_and_Wales_2022, Output_Areas_Dec_2011_Boundaries_EW_BFC_2022, Lower_layer_Super_Output_Areas_Dec_2011_Boundaries_Full_Clipped_BFC_EW_V3_2022, OA21_WD22_LTLA22_UTLA22_RGN22_CTRY22_EW_LU_v2 | Which LSOAs, wards, 2011 workplace zones and 2011 OAs fall inside the box, and what fraction of each (area clipping done locally; the clipped areas sum to exactly 2.25 km2). Also the OA-to-2022-ward lookup. | https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services |
| Nomis API: Census 2021 TS007A age by 5-year band (NM_2020_1) | open, no key. GSS codes work directly in geography=. Nomis has no 2022-ward geography for this table, so ward figures were built by summing 283 OAs (geography=<OA codes>). | Residents by age band for the 16 LSOAs whose population-weighted centroid is inside the box (29,651), plus the 7 named wards. London region: geography=E12000007. | https://www.nomisweb.co.uk/api/v01/dataset/NM_2020_1.data.csv?date=latest&geography=E01004315,E01004307,E01035669,E01033708,E01004306,E01033706,E01001780,E01035668,E01004316,E01004313,E01004312,E01004309,E01004311,E01004308,E01035664,E01004310&measures=20100&select=geography_code,geography_name,c2021_age_19_name,obs_value |
| Nomis API: Census 2021 TS066 economic activity (NM_2083_1) | open, no key. Borough and London student counts: geography=E09000012,E09000030,E09000019,E09000001,E12000007&c2021_eastat_20=0,1006,16 | Employed, self-employed, unemployed, full-time students, retired and inactive shares for residents aged 16+. Also full-time student counts for Hackney, Tower Hamlets, Islington, City and London. | https://www.nomisweb.co.uk/api/v01/dataset/NM_2083_1.data.csv?date=latest&geography=E01004315,E01004307,E01035669,E01033708,E01004306,E01033706,E01001780,E01035668,E01004316,E01004313,E01004312,E01004309,E01004311,E01004308,E01035664,E01004310&measures=20100&select=geography_code,geography_name,c2021_eastat_20_name,obs_value |
| Nomis API: Census 2021 TS001 (NM_2021_1), TS068 (NM_2085_1), TS063 (NM_2080_1) | open, no key. Same URL pattern with NM_2021_1/c2021_restype_3 and NM_2085_1/c2021_student_3 | Household vs communal-establishment residents, schoolchildren and students, and occupation (SOC major group) of employed residents | https://www.nomisweb.co.uk/api/v01/dataset/NM_2080_1.data.csv?date=latest&geography=E01004315,E01004307,E01035669,E01033708,E01004306,E01033706,E01001780,E01035668,E01004316,E01004313,E01004312,E01004309,E01004311,E01004308,E01035664,E01004310&measures=20100&select=geography_code,c2021_occ_10_name,obs_value |
| Nomis API: BRES open access (NM_189_1) | open, no key. 2021 LSOAs (GSS codes) only have data for 2023-2024. 2015-2022 needs 2011 LSOAs requested by parent borough as <LA id>TYPE298. Divisions: industry=TYPE35. Wards: GSS ward codes (May 2025 wards). | Jobs (employees plus working owners) located in the box, 2015-2024, area-weighted; mix by SIC division; ward and City totals for a sanity check | https://www.nomisweb.co.uk/api/v01/dataset/NM_189_1.data.csv?geography=1946157247TYPE298,1946157248TYPE298,1946157251TYPE298,1946157257TYPE298&date=2015,2017,2019,2021,2022&industry=37748736&employment_status=4&measure=1&measures=20100&select=date_name,geography_code,obs_value |
| Nomis API: Census 2011 workplace population WP1101EW (NM_1320_1) and WP101EW (NM_1300_1) | open, no key. WP1101EW is published at workplace-zone (TYPE262) and MSOA level only. WP101EW is published at OA level but not at workplace-zone level. | 2011 workplace population in the box: 103,022 by workplace zone, 100,071 by OA; age mix of workers | https://www.nomisweb.co.uk/api/v01/dataset/NM_1320_1.data.csv?geography=<160 E33 workplace-zone codes>&c_sex=0&c_age=0,1,...,59&measures=20100&select=geography_code,c_age,obs_value |
| TfL Annual Station Counts 2024 | open (S3 bucket, 106 KB xlsx) | Typical-day entries and exits by station for Mon, Tue-Thu, Fri, Sat and Sun: Shoreditch High Street, Old Street, Liverpool Street LU/NR, Aldgate East, Hoxton | https://crowding.data.tfl.gov.uk/Annual%20Station%20Counts/2024/AC2024_AnnualisedEntryExit_Public.xlsx |
| TfL NUMBAT 2024 (modelled 15-minute station flows) | open (S3). Also NBT24FRI, NBT24SAT and NBT24SUN _outputs.xlsx, about 12 MB each. Sheets Station_Entries and Station_Exits. | Hour-of-day and 15-minute arrivals (exits) and departures (entries) by day type at the local stations, including Friday and Saturday Night Overground hours | https://crowding.data.tfl.gov.uk/NUMBAT/NUMBAT%202024/NBT24TWT_outputs.xlsx |
| ONS Online Time Use Survey ad hoc 1496: activity by time of day, March 2023 | open (46 KB xlsx) | Percentage of adults aged 18+ who are outside the home, cooking, or asleep, in 10-minute slots, average weekday and weekend day, England and Wales. This is the only open hour-of-day time-use split found; it has no age breakdown. | https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/personalandhouseholdfinances/incomeandwealth/adhocs/1496timeuseinenglandandwalesbyweekdayandweekenddaymarch2023/timeusedataweekdaysandweekendsmarch2023.xlsx |
| ONS Time use in the UK, March 2024 dataset | open | Table 7: minutes per day by activity and age group (working away from home vs working from home; entertainment, socialising and free time) | https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/personalandhouseholdfinances/incomeandwealth/datasets/timeuseintheuk/march2024/timeuseintheukmarch24.xlsx |
| ONS hybrid and home working articles | open (read through WebFetch). Also https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/articles/whoarethehybridworkers/2024-11-11 | London: 40% hybrid and 31% travel-only (Sep 2022-Jan 2023). GB: 28% hybrid (Oct 2024); 19% of 16-29s and 29% of 30+ (Apr-Jun 2024). | https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/articles/characteristicsofhomeworkersgreatbritain/september2022tojanuary2023 |
| ONS Transactions at Pret A Manger | open. Discontinued after 31 Oct 2024. | Weekly till-transaction index (first 4 weeks of 2020 = 100) for London City Worker, Stations, West End and Suburban stores; a measure of office-lunch footfall | https://www.ons.gov.uk/file?uri=/economy/economicoutputandproductivity/output/datasets/transactionsatpretamanger/2024/transactionsatpretamangerdataset311024.xlsx |
| GLA: London at night, a survey of Londoners and night time workers (Jan 2023; fieldwork 8-9 Mar 2022, N=2,000) | open PDF | How often Londoners go out between 6pm and 6am to a pub or bar, to socialise elsewhere, for cultural activities, and for everyday errands. All ages combined. | https://data.london.gov.uk/download/london-at-night--research-and-analysis/4bcae9c9-a524-4082-a380-db755e7808c6/London%2520at%2520night%2520survey.pdf |
| GLA Economics: London at Night Update 2024 | open PDF. Figures 42-49 are images; values were read from the charts, approximately. | BT Mobility 2023 night-time visitor counts by borough (exact table) and by town centre (Shoreditch, Brick Lane, Liverpool Street; chart reads), visitors by night of week, borough night vs Saturday-afternoon ratios, and the TfL/GLA Late Night Travel Survey (YouGov, Jan 2024, N=1,074) by age | https://data.london.gov.uk/download/london-at-night--research-and-analysis/5311efaa-47c8-4664-a188-09e8763ae678/London-at-Night-Update-2024%2520%2528FOR%2520PDF%2529.pdf |
| GLA Economics: Tourism in London, Recent Trends (Feb 2026) | open PDF | 20.9M international visits to London in 2024 (IPS), split by market; 189M domestic day visits and 15.1M domestic overnight trips in 2024; 2030 projection of 25.2M visitors and 139.0M nights | https://data.london.gov.uk/download/2j81l/sg4/Tourism-in-London-Recent-Trends.pdf |
| VisitBritain: Great Britain Day Visits Survey, Q4 2023 and 2023 overall; GBDVS 2023 Background Quality Report | open PDF. Background Quality Report: https://www.visitbritain.org/media/3108/download | 210M tourism day visits to London in 2023, £11.4bn spend. A tourism day visit is defined as lasting at least 3 hours including travel. | https://www.visitbritain.org/media/3110/download |
| VisitBritain: Discover England Fund research summary (Great West Way) | open PDF | Share of holiday visitors to Britain who are repeat visitors (IPS 2015): US 58%, Germany 62%, Netherlands 76%. London visited by 68% of first-timers and 66% of repeat visitors. | https://www.visitbritain.org/media/618/download |
| LB Hackney: Evening and Night-time Economy Behaviour Study, Summary Report (Hadfield, 2017) | open PDF | 15-minute pedestrian counts from 21:00 to 03:15 at Shoreditch High St / Great Eastern St and on Old Street (2016); audit of premises open to 01:00 or later and of late off-licences; observed behaviour (off-sales pre-drinking, late takeaways, dispersal towards Liverpool Street Night Tube) | https://consultation.hackney.gov.uk/licensing-and-regulatory-services/licensing-policy-consultation/supporting_documents/Evening%20and%20Nighttime%20Economy%20Behaviour%20Study.pdf |
| Hughes, Anderson, Morleo, Bellis (2008) Addiction 103:60-65, plus the LJMU results slides | open. Abstract via Europe PMC REST: https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22Alcohol%2C+nightlife+and+violence%22&format=json&resultType=core (PMID 17996008) | Liverpool nightlife users aged 18-35 (N=380, 2006): 57.6% pre-drink; share of the night's alcohol drunk before going out; 83.9% go out weekly; 29% students; mean age 24.3 | https://essl.leeds.ac.uk/download/downloads/id/570/anderson3.pdf |
| Santos, Sanchez, Hughes, Gee, Quigg (2022) PLoS One, pre-drinking among English university students | open access full text through Europe PMC | 82.8% of English student drinkers pre-drink: 54.1% at their own home, 45.3% at a friend's, 0% outdoors; 44.7% to save money | https://www.ebi.ac.uk/europepmc/webservices/rest/PMC8929586/fullTextXML |
| Bellis et al. (2010) Subst Abuse Treat Prev Policy 5:5, blood alcohol levels in UK nightlife | open (Europe PMC REST, PMID 20406433) | Nightlife patrons interviewed mid-night (n=214, 3 cities): 79.4% intended to drink more before going home | https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22Cross-sectional+measures+and+modelled+estimates+of+blood+alcohol+levels+in+UK+nightlife%22&format=json&resultType=core |
| Schlapfer et al. (2021) Nature 593:522, The universal visitation law of human mobility | open PDF; abstract also via Europe PMC (PMID 34040209) | Visitor density rho(r,f) = mu/(r*f)^2, where f is the number of distinct days a person visited a 0.5-1 km cell (minimum stay 1 h) within an observation period T. This gives the visit-frequency distribution of regulars vs one-off visitors. | https://www.isi.it/wp-content/uploads/2024/01/the-universal-visitation-law-of-human-mobility_s41586-021-03480-9.pdf |
| Alessandretti et al. (2018) Nat Hum Behav; Song et al. (2010) Science | open (Europe PMC REST; PMIDs 31097800 and 20167789) | About 25 familiar locations per person at any time; 93% potential predictability of individual mobility | https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22Evidence+for+a+conserved+quantity+in+human+mobility%22&format=json&resultType=core |
| Wikipedia API expandtemplates (HESA student population templates) | open. Rate-limited (HTTP 429 after rapid calls). Used only as a fallback because HESA itself is blocked. | HESA 2024/25 headcounts by provider, as held in Wikipedia templates | https://en.wikipedia.org/w/api.php?action=expandtemplates&prop=wikitext&format=json&text={{HESA student population/INSTID=10007775}} |
| YouGov: Three in 10 adults say they don't drink (2015) | open (read through WebFetch; age split not in the article) | GB adults: 14% go to a pub or bar weekly, 16% monthly, 1% daily, 11% never | https://yougov.com/en-gb/articles/12114-three-10-adults-say-they-dont-drink |
| HESA open data (Table 1, sb271 figures) | BLOCKED: Cloudflare JS challenge for curl; WebFetch gets 403. The CSVs linked from data.gov.uk (e.g. https://www.hesa.ac.uk/data-and-analysis/sb271/figure-7.csv) are blocked the same way. Skipped. | Would give official enrolments by provider | https://www.hesa.ac.uk/data-and-analysis/students/table-1 |
| LB Tower Hamlets democracy documents (markets / Brick Lane) | BLOCKED: Azure WAF JS challenge (curl) and 403 (WebFetch). Skipped; only a search-engine snippet is available. | Would give Truman/Brick Lane Sunday market visitor figures | https://democracy.towerhamlets.gov.uk/mgConvert2PDF.aspx?ID=177605 |
| FSA Food and You 2 (eating out and takeaways by age) | GONE: HTTP 410; the print/pdf endpoint returns 404 after the site migration. Skipped. | Would give the share of each age group eating out or ordering takeaway in the last 4 weeks | https://www.food.gov.uk/research/fy2-wave-8-chapter-4-eating-out-and-takeaways |

## Gaps (labelled as estimates in the model)

- HESA open data (CC BY) is behind a Cloudflare JS challenge: curl gets an HTML challenge and WebFetch gets 403, including the CSV links listed on data.gov.uk. University headcounts come from Wikipedia's HESA templates (2024/25) and are unverified; QMUL's 24,640 looks low against earlier years.
- Tower Hamlets democracy documents are behind an Azure WAF challenge. The Brick Lane/Truman Markets figure of about 25,000 Sunday shoppers, mostly visitors, is from a search snippet only and is not verified.
- FSA Food and You 2 pages return 410/404 after the site migration, so eating-out and takeaway prevalence by age was not used. It only gives 'in the last 4 weeks' prevalence anyway, not weekly frequency.
- There is no open measured probability of a takeaway after a club night, a supermarket or off-licence run before one, or the bar-to-club transition rate. All chain transition probabilities are assumptions anchored on the Hackney 2016-17 observational study and on pre-drinking prevalence surveys.
- There is no open hour-of-day split of eating, shopping or socialising by age or work status. The only open time-of-day time-use table (ONS ad hoc 1496) gives 'outside the home' for all adults. Station flows (NUMBAT) are the local proxy, but they miss walking, cycling and bus arrivals, which are large in Shoreditch.
- There is no Shoreditch-specific tourist share, origin mix or dwell time. The GLA High Streets Data Service (BT resident/worker/visitor split by hour, Mastercard spend) is restricted to boroughs and partners. Town-centre visitor counts were read approximately (+/-1-2k) from chart images in the GLA 2024 report.
- Census 2021 workplace and workday population was not used. It was taken during the March 2021 lockdown and no 2021 workplace tables are on Nomis. Workers come from the 2011 Census (dated) and BRES (jobs, with head-office reporting artefacts: BRES puts 251k jobs in Bishopsgate ward alone, about 37% of the City's 676k). Area weighting of the City LSOA E01032739 dominates the uncertainty in the worker count.
- Nightlife frequency by age is indirect. The GLA pub/bar frequency question is published for all ages only; the age gradient comes from the 2024 late-night travel survey (23:00-05:00), whose trips include work (19%) and visiting friends/family (22%). The DCMS Participation Survey has no nightclub variable; live-music attendance by age is in a 4 MB ODS that was not parsed.
- The Liverpool 2006 nightlife sample is old, outside London, and intercepted in bars, so frequent users are oversampled (83.9% weekly).
- Weekly regularity at cafes and pubs: there is no open venue-level visit-frequency data for London. The universal visitation law comes from cell-level phone data in other cities and gives the shape, not a London calibration. No data exists on fixed-weekday habits such as 'every Tuesday'.
- Remote workers in cafes: no open data on the share of work-from-home days spent in cafes or co-working spaces. Only hybrid and home-only shares (ONS) and self-employment (Census) are available.
- Office lunch frequency: no open measure of how often workers buy lunch out. The Pret index gives the level of office footfall (discontinued Oct 2024, base Jan 2020) but not per-person frequency.
- The NUMBAT Monday profile was not downloaded (Tue-Thu are combined); Monday totals come from the TfL annual station counts. NUMBAT is a modelled, annualised dataset.
- The event-only share for XOYO-type events is not measured. Venue capacity and ticketing data were not sourced.
