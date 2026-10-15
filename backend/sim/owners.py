"""The inner learning loop: every shop's owner adapts day by day inside a run.

See docs/OWNER_ACTIONS.md.

Rule-based, cheap and deterministic. Each owner reads only its own shop's day (visits and people
who found it shut, by plan day and clock hour; passers-by near the door; energy) plus the street
events on its own street and club nights next door, and may:

  hours_changed       stay open later after repeated missed demand after close, when the margin on
                      the expected extra visits beats the extra energy bill; trim a first/last hour
                      whose visits don't pay for its energy (from the next morning, every day)
  day_closed          weekly review at the end of week 1: close a weekday that was clearly dead
                      (< DEAD_DAY_SHARE of an average day's visits and its margin below its energy
                      bill), from that weekday in week 2
  day_reopened        reopen after a temporary closure, or a closed weekday people keep trying or
                      walk past in numbers (footfall at the shut door vs open days)
  shut_early          today only: roadworks / heavy traffic cut today's visits sharply
  open_late           tonight only: a club night next door whose crowd found the shop shut, if the
                      expected extra margin beats the extra energy bill
  temporary_closure   street closed for works: closed until it reopens
  lighting_changed    window lights off while shut and sign lights off in daylight: neither brings
                      anyone in (lit windows only draw people at night, while open)
  closed_permanently  losing money LOSS_DAYS days running (only when allow_closure: never in a run
                      whose parent is the baseline)

Money comes from backend/economics.py: margin per visit = spend x GROSS_MARGIN[type],
energy at energy.json's hourly price, lighting included, and wages for every open hour.

Every new window passes the hard rules (backend/agents/rules.py: licence, minimum open/closed).
A day's template is a daily window (open, close) plus closed weekdays; today-only actions are
per-day overrides. The schedule's open ticks are repainted from the windows after each change, so
Schedule.is_open / open_until see day-specific hours. Plan day d's window starts on day d and may
run past midnight; decisions at the end of plan day d apply from day d + 1.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from backend import economics, timeutil
from backend.agents import rules
from backend.agents.changes import window_length
from backend.contract import DAYS, MINUTES_PER_DAY, OwnerEvent, OwnerTrigger, StoreType
from backend.schemas import StoreConfig
from backend.sim import citizens, street
from backend.sim.energy import LEVELS
from backend.sim.energy import store_kwh as energy_kwh

if TYPE_CHECKING:
    from backend.sim.engine import Schedule, World

TICK = citizens.TICK
TPD = MINUTES_PER_DAY // TICK  # ticks per day

COOLDOWN_DAYS = 3  # days between two changes to a shop's weekly hours
WINDOW_DAYS = 3  # recent plan days an owner looks back over for hours changes
MIN_HISTORY_DAYS = 2
EXTEND_MIN_MISSED = 5.0  # people a day finding the shop shut in the 2 hours after close ...
EXTEND_VS_LAST_HOUR = 0.75  # ... and at least this share of the visits in the last open hour
EXTEND_CONVERSION = 0.5  # share of the people found us shut an owner expects to serve if open
MAX_EXTENDS = 2  # later closes per run
MIN_WINDOW_MIN = 240  # trims never leave a shop open less than this
MAX_TRIMS = 2  # per side per run
REVIEW_DAY = 7  # end of week 1: the owner reviews the week's weekdays
DEAD_DAY_SHARE = 0.10  # a weekday below this share of an average day's visits is dead ...
MIN_REVIEW_DAYS = 5  # ... judged against at least this many regular open days that week
REOPEN_MIN_FOUND = 10  # people finding a closed weekday shut that reopen it
REOPEN_FOOTFALL_SHARE = 0.8  # or passers-by at the shut door vs an open day's, in opening hours
SHUT_EARLY_AFTER_MIN = 120  # owner judges a disruption after this long
SHUT_EARLY_DROP = 0.45  # visits down this much vs usual -> shut early
SHUT_EARLY_MIN_USUAL = 3.0  # usual visits in those hours below this: too little to judge
SHUT_EARLY_COVER = 0.5  # the disruption must last through this share of the rest of the day
OPEN_LATE_RADIUS_M = 150.0  # club door within this distance of the shop's door
OPEN_LATE_MIN = 3  # people at the door around the last club close
OPEN_LATE_AFTER_MIN = 60  # stay open until club close + this
LOSS_DAYS = 7
NIGHT = np.array([h in citizens.NIGHT_HOURS for h in range(24)])  # lit windows only draw at night
NIGHT_LEVEL = np.where(NIGHT, 2, 1)  # high / low for hours newly opened with lights off
DAY_NAMES = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"]
WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

Window = tuple[str, str]


@dataclass
class Template:
    from_day: int
    open: str
    close: str
    closed: frozenset[int] = frozenset()  # weekday indices, 0 = Monday


@dataclass
class _Owner:
    index: int
    store_id: str
    store_type: StoreType
    licence: Window
    templates: list[Template]
    overrides: dict[int, Window | None] = field(default_factory=dict)
    override_kind: dict[int, str] = field(default_factory=dict)
    last_change: int = -99
    trims_open: int = 0
    trims_close: int = 0
    extends: int = 0
    lights_off_mask: np.ndarray = field(default_factory=lambda: np.zeros(24, dtype=bool))
    daylight_off_mask: np.ndarray = field(default_factory=lambda: np.zeros(24, dtype=bool))
    lights_off_from: int = 99  # from this day: lights off while shut (mask) and in daylight
    loss_streak: int = 0
    closed_from: int | None = None

    def template_for(self, day: int) -> Template:
        current = self.templates[0]
        for t in self.templates:
            if t.from_day <= day:
                current = t
        return current

    def window(self, day: int) -> Window | None:
        if self.closed_from is not None and day >= self.closed_from:
            return None
        if day in self.overrides:
            return self.overrides[day]
        t = self.template_for(day)
        return None if (day - 1) % 7 in t.closed else (t.open, t.close)

    def regular_day(self, day: int) -> bool:
        """Open on its weekly template that day, no today-only action."""
        return day not in self.override_kind and self.window(day) is not None

    def dark(self, day: int) -> bool:
        kind = self.override_kind.get(day)
        closed = self.closed_from is not None and day >= self.closed_from
        return closed or kind == "temporary_closure"

    def set_template(self, day: int, open_: str, close: str, closed: frozenset[int]) -> None:
        self.templates = [t for t in self.templates if t.from_day != day]
        self.templates.append(Template(day, open_, close, closed))
        self.templates.sort(key=lambda t: t.from_day)


def _abs(day: int, window: Window) -> tuple[int, int]:
    """Sim minutes the window of `day` opens and closes."""
    start = (day - 1) * MINUTES_PER_DAY + timeutil.to_minutes(window[0])
    return start, start + window_length(*window)


def _ceil(minute: int, step: int) -> int:
    return -(-minute // step) * step


def _shift(hhmm: str, minutes: int) -> str:
    return timeutil.to_hhmm(timeutil.to_minutes(hhmm) + minutes)


class Owners:
    """All owners of one run. The engine calls visit / found_closed while it simulates, start_day
    and before(t) to fire today-only checks in time order, end_day after each plan day, and
    finalize once at the end (energy arrays of the schedule)."""

    def __init__(
        self,
        world: World,
        schedule: Schedule,
        configs: Mapping[str, StoreConfig],
        events: list[street.StreetEvent],
        *,
        allow_closure: bool,
    ) -> None:
        self.world = world
        self.schedule = schedule
        self.allow_closure = allow_closure
        self.street_events = events
        n = world.n_stores
        self.base_open = (
            schedule.open_ticks[:, : DAYS * TPD].reshape(n, DAYS, 24, -1).mean(-1).copy()
        )
        self.levels = np.zeros((n, 24), dtype=np.int64)
        for i, s in enumerate(world.stores):
            if s.id in configs:
                self.levels[i] = [LEVELS.index(level) for level in configs[s.id].lighting]
        self.visits = np.zeros((n, DAYS + 2, 24))
        self.found = np.zeros((n, DAYS + 2, 24))
        self.footfall = np.zeros((n, DAYS + 2, 24))
        self.last_out = np.zeros(n, dtype=np.int64)
        self.on_street = street.store_streets(world)
        self.out: list[OwnerEvent] = []
        self.pending: list[tuple[int, int, street.StreetEvent]] = []
        self.owners: dict[int, _Owner] = {}
        for i, s in enumerate(world.stores):
            config = configs.get(s.id)
            if s.type == "club" or config is None:
                continue
            self.owners[i] = _Owner(
                index=i,
                store_id=s.id,
                store_type=s.type,
                licence=rules.licensed_window(s),
                templates=[Template(1, config.open, config.close)],
            )
        self.price = np.asarray(world.energy.priceGbpPerKwh)

    # --- tallies from the sim ------------------------------------------------------------------

    def visit(self, store: int, day: int, t_in: int, t_out: int) -> None:
        self.visits[store, day, (t_in // 60) % 24] += 1
        self.last_out[store] = max(self.last_out[store], t_out)

    def found_closed(self, store: int, day: int, minute: int) -> None:
        self.found[store, day, (minute // 60) % 24] += 1

    # --- today-only checks during the day ------------------------------------------------------

    def start_day(self, day: int) -> None:
        pending = []
        for e in self.street_events:
            if e.day != day or e.kind not in ("roadworks", "heavy_traffic"):
                continue
            for i, o in self.owners.items():
                if self.on_street[i] != e.street:
                    continue
                w = o.window(day)
                if w is None:
                    continue
                opens, closes = _abs(day, w)
                cp = _ceil(max(e.from_t, opens), 60) + SHUT_EARLY_AFTER_MIN
                if cp < e.to_t and cp + 60 <= closes:
                    pending.append((cp, i, e))
        self.pending = sorted(pending, key=lambda p: (p[0], p[1], p[2].kind))

    def before(self, t: int) -> None:
        while self.pending and self.pending[0][0] <= t:
            cp, i, e = self.pending.pop(0)
            self._shut_early(cp, self.owners[i], e)

    def _shut_early(self, cp: int, o: _Owner, e: street.StreetEvent) -> None:
        day = e.day
        if day in o.override_kind:
            return
        w = o.window(day)
        if w is None:
            return
        i = o.index
        day_start = (day - 1) * MINUTES_PER_DAY
        opens, closes = _abs(day, w)
        h0 = (_ceil(max(e.from_t, opens), 60) - day_start) // 60
        h1 = (cp - day_start) // 60
        if not 0 <= h0 < h1 <= 24:
            return
        today = self.visits[i, day, h0:h1].sum()
        weekend = timeutil.is_weekend_day(day)
        same = [p for p in range(1, day) if o.regular_day(p) and o.window(p) == w]
        history = [p for p in same if timeutil.is_weekend_day(p) == weekend]
        if len(history) < MIN_HISTORY_DAYS:
            history = same
        if len(history) < MIN_HISTORY_DAYS:
            return
        usual = float(np.mean([self.visits[i, p, h0:h1].sum() for p in history]))
        if usual < SHUT_EARLY_MIN_USUAL:
            return
        drop = 1.0 - today / usual
        if drop < SHUT_EARLY_DROP:
            return
        shut = _ceil(max(cp + 30, int(self.last_out[i])), 30)
        if shut > closes - 30 or shut - opens < rules.MIN_OPEN_MINUTES:
            return
        if min(e.to_t, closes) - shut < SHUT_EARLY_COVER * (closes - shut):
            return  # the disruption ends well before close: worth staying open for later trade
        new = (w[0], timeutil.to_hhmm(shut))
        if rules.hours_violation(*new, o.licence):
            return
        o.overrides[day] = new
        o.override_kind[day] = "shut_early"
        self._repaint(o, day)
        if e.kind == "roadworks":
            reason = f"Roadworks outside, nobody can get in, shutting at {new[1]}."
        else:
            reason = f"Traffic jammed outside, hardly anyone stopping, shutting at {new[1]}."
        self._emit(
            day, cp, o, "shut_early", w[1], new[1], reason,
            e.kind, round(drop, 2), f"visits −{round(drop * 100)}% vs usual",
        )  # fmt: skip

    # --- end of day decisions ------------------------------------------------------------------

    def end_day(self, day: int, footfall: np.ndarray) -> None:
        """Owners read their own day and decide what applies from day + 1."""
        self.pending = []
        self.footfall[:, day] = footfall
        nxt = day + 1
        if nxt > DAYS:
            return
        for i in sorted(self.owners):
            o = self.owners[i]
            if o.closed_from is not None:
                continue
            if self._losses(o, day, nxt):
                continue
            changed = self._weekday(o, day, nxt)
            changed = self._hours(o, day, nxt) or changed
            changed = self._temporary_closure(o, nxt) or changed
            changed = self._open_late(o, day, nxt) or changed
            self._lights(o, day, nxt)
            if changed:
                self._repaint(o, nxt)

    def _losses(self, o: _Owner, day: int, nxt: int) -> bool:
        if not self.allow_closure:
            return False
        if o.window(day) is None:
            return False
        i = o.index
        open_row = self._open_fraction(i, day)
        lit = self._lit(o, day, open_row[None])[0]
        kwh = energy_kwh(
            self.world.energy, o.store_type, float(self.world.floor_area[i]), open_row, lit
        )
        wages = float(open_row.sum()) * economics.staff_gbp_per_open_hour(o.store_type)
        margin = float(self.visits[i, day].sum()) * self._margin(o)
        profit = margin - float((kwh * self.price).sum()) - wages
        o.loss_streak = o.loss_streak + 1 if profit < 0 else 0
        if o.loss_streak < LOSS_DAYS:
            return False
        o.closed_from = nxt
        self._repaint(o, nxt)
        self._emit(
            nxt, (nxt - 1) * MINUTES_PER_DAY, o, "closed_permanently", None, None,
            "Not enough trade to cover costs, closing for good.",
            "losses", float(o.loss_streak), f"lost money {o.loss_streak} days running",
        )  # fmt: skip
        return True

    def _recent(self, o: _Owner, day: int, w: Window) -> list[int]:
        return [
            p
            for p in range(max(1, day - WINDOW_DAYS + 1), day + 1)
            if o.regular_day(p) and o.window(p) == w
        ]

    def _hours(self, o: _Owner, day: int, nxt: int) -> bool:
        if day - o.last_change < COOLDOWN_DAYS:
            return False
        t = o.template_for(nxt)
        w = (t.open, t.close)
        if window_length(*w) >= MINUTES_PER_DAY:
            return False
        days = self._recent(o, day, w)
        if len(days) < MIN_HISTORY_DAYS:
            return False
        i = o.index
        margin = self._margin(o)
        open_m, close_m = timeutil.to_minutes(t.open), timeutil.to_minutes(t.close)
        after = [(close_m // 60) % 24, (close_m // 60 + 1) % 24]
        missed = float(np.mean([self.found[i, p, after].sum() for p in days]))
        last_h = ((close_m - 60) % MINUTES_PER_DAY) // 60
        last = float(np.mean([self.visits[i, p, last_h] for p in days]))
        if (
            not o.trims_close
            and o.extends < MAX_EXTENDS
            and missed >= EXTEND_MIN_MISSED
            and missed >= EXTEND_VS_LAST_HOUR * last
        ):
            for step in (60, 30):
                new_close = _shift(t.close, step)
                if rules.hours_violation(t.open, new_close, o.licence) is None:
                    break
            else:
                step = 0
            # Expected extra visits: a share of those who found us shut in the first hour after
            # close; they must pay for the extra open time (lights included).
            first_after = float(np.mean([self.found[i, p, after[0]] for p in days]))
            gain = first_after * EXTEND_CONVERSION * step / 60 * margin
            cost = self._open_cost(o, close_m, step)
            if step and gain > cost:
                self._change(o, day, nxt, t, t.open, new_close)
                o.extends += 1
                self._lift_lights(o, close_m, step)
                self._emit(
                    nxt, (nxt - 1) * MINUTES_PER_DAY, o, "hours_changed", t.close, new_close,
                    f"People kept finding us shut after {t.close}, staying open till {new_close}.",
                    "missed_demand", round(missed, 1),
                    f"{missed:.0f} a day found us shut after {t.close}: "
                    f"+£{gain:.2f} margin vs £{cost:.2f} costs a day",
                )  # fmt: skip
                return True
        new_close = _shift(t.close, -60)
        cost = self._open_cost(o, close_m - 60, 60)
        if (
            o.trims_close < MAX_TRIMS
            and last * margin < cost
            and missed < 1
            and window_length(t.open, new_close) >= MIN_WINDOW_MIN
            and rules.hours_violation(t.open, new_close, o.licence) is None
        ):
            self._change(o, day, nxt, t, t.open, new_close)
            o.trims_close += 1
            self._emit(
                nxt, (nxt - 1) * MINUTES_PER_DAY, o, "hours_changed", t.close, new_close,
                f"After {new_close} takings don't cover staff and power, closing at {new_close}.",
                "empty_hours", round(last, 2),
                f"{last:.1f} visits a day after {new_close}: "
                f"£{last * margin:.2f} margin vs £{cost:.2f} power and staff",
            )  # fmt: skip
            return True
        first_h = open_m // 60
        first = float(np.mean([self.visits[i, p, first_h] for p in days]))
        early = float(np.mean([self.found[i, p, (first_h - 1) % 24] for p in days]))
        new_open = _shift(t.open, 60)
        cost = self._open_cost(o, open_m, 60)
        if (
            o.trims_open < MAX_TRIMS
            and first * margin < cost
            and early < 1
            and window_length(new_open, t.close) >= MIN_WINDOW_MIN
            and rules.hours_violation(new_open, t.close, o.licence) is None
        ):
            self._change(o, day, nxt, t, new_open, t.close)
            o.trims_open += 1
            self._emit(
                nxt, (nxt - 1) * MINUTES_PER_DAY, o, "hours_changed", t.open, new_open,
                f"Before {new_open} takings don't cover staff and power, opening at {new_open}.",
                "empty_hours", round(first, 2),
                f"{first:.1f} visits a day before {new_open}: "
                f"£{first * margin:.2f} margin vs £{cost:.2f} power and staff",
            )  # fmt: skip
            return True
        return False

    def _change(self, o: _Owner, day: int, nxt: int, t: Template, open_: str, close: str) -> None:
        o.set_template(nxt, open_, close, t.closed)
        o.last_change = day

    def _weekday(self, o: _Owner, day: int, nxt: int) -> bool:
        """Reopen a closed weekday people keep trying or walking past; at the end of week 1,
        close one clearly dead weekday from week 2."""
        weekday = (day - 1) % 7
        t = o.template_for(nxt)
        if weekday in t.closed:
            return o.window(day) is None and self._reopen(o, day, nxt, t, weekday)
        if day != REVIEW_DAY or t.closed:
            return False
        i = o.index
        week = [p for p in range(1, REVIEW_DAY + 1) if o.regular_day(p)]
        if len(week) < MIN_REVIEW_DAYS:
            return False
        usual = float(np.mean([self.visits[i, p].sum() for p in week]))
        margin = self._margin(o)
        dead = []
        for p in week:
            visits = float(self.visits[i, p].sum())
            w = o.window(p)
            assert w is not None
            cost = self._open_cost(o, timeutil.to_minutes(w[0]), window_length(*w))
            if visits < DEAD_DAY_SHARE * usual and visits * margin < cost:
                dead.append((visits, p))
        if not dead:
            return False
        visits, p = min(dead)
        weekday = (p - 1) % 7
        o.set_template(nxt, t.open, t.close, t.closed | {weekday})
        name = DAY_NAMES[weekday]
        self._emit(
            nxt, (nxt - 1) * MINUTES_PER_DAY, o, "day_closed", None, timeutil.WEEKDAYS[weekday],
            f"{name} are dead, closing {name}.",
            "dead_day", visits,
            f"{visits:.0f} visits last {WEEKDAY_NAMES[weekday]} vs {usual:.0f} on a usual day",
        )  # fmt: skip
        return True

    def _reopen(self, o: _Owner, day: int, nxt: int, t: Template, weekday: int) -> bool:
        i = o.index
        name = WEEKDAY_NAMES[weekday]
        found = float(self.found[i, day].sum())
        if found >= REOPEN_MIN_FOUND:
            reason = f"People keep trying the door on {DAY_NAMES[weekday]}, opening again."
            value, label = found, f"{found:.0f} found us shut on {name}"
        else:
            # Passers-by at the shut door in our usual hours vs an open day of the same kind.
            hours = np.asarray(timeutil.open_hours_fraction(t.open, t.close)) > 0
            weekend = timeutil.is_weekend_day(day)
            same = [p for p in range(1, day) if o.regular_day(p)]
            history = [p for p in same if timeutil.is_weekend_day(p) == weekend] or same
            if not history:
                return False
            usual = float(np.mean([self.footfall[i, p, hours].sum() for p in history]))
            passing = float(self.footfall[i, day, hours].sum())
            if usual <= 0 or passing < REOPEN_FOOTFALL_SHARE * usual:
                return False
            reason = f"Plenty walking past on {DAY_NAMES[weekday]}, opening again."
            value = round(passing / usual, 2)
            label = f"{passing:.0f} walked past on {name}, {value:.0%} of an open day"
        o.set_template(nxt, t.open, t.close, t.closed - {weekday})
        self._emit(
            nxt, (nxt - 1) * MINUTES_PER_DAY, o, "day_reopened", None,
            timeutil.WEEKDAYS[weekday], reason, "dead_day", value, label,
        )  # fmt: skip
        return True

    def _temporary_closure(self, o: _Owner, nxt: int) -> bool:
        if nxt in o.override_kind or o.window(nxt) is None:
            return False
        closed_days = []
        severity, label = 0.0, ""
        for d in range(nxt, DAYS + 1):
            works = [
                e
                for e in self.street_events
                if e.day == d
                and e.kind == "roadworks"
                and e.street == self.on_street[o.index]
                and e.severity >= street.CLOSED_SEVERITY
            ]
            w = o.window(d)
            if not works or w is None or d in o.override_kind:
                break
            opens, closes = _abs(d, w)
            overlap = max(0, min(closes, works[0].to_t) - max(opens, works[0].from_t))
            if overlap < 0.5 * (closes - opens):
                break
            closed_days.append(d)
            severity, label = works[0].severity, works[0].label
        if not closed_days:
            return False
        for d in closed_days:
            o.overrides[d] = None
            o.override_kind[d] = "temporary_closure"
        back = closed_days[-1] + 1
        until = WEEKDAY_NAMES[(back - 1) % 7]
        self._emit(
            nxt, (nxt - 1) * MINUTES_PER_DAY, o, "temporary_closure", None,
            timeutil.WEEKDAYS[(back - 1) % 7],
            f"Street closed for works, closed until {until}.",
            "roadworks", severity, label,
        )  # fmt: skip
        if back <= DAYS:
            self._emit(
                back, (back - 1) * MINUTES_PER_DAY, o, "day_reopened", None,
                timeutil.WEEKDAYS[(back - 1) % 7], "Works are done outside, open again.",
                "roadworks", severity, label,
            )  # fmt: skip
        return True

    def _open_late(self, o: _Owner, day: int, nxt: int) -> bool:
        if nxt in o.override_kind:
            return False
        w = o.window(nxt)
        if w is None:
            return False
        i = o.index
        weekday = timeutil.weekday_of_day(nxt)
        for j, nights in sorted(self.world.club_nights.items()):
            if self.world.sight[i, j] > OPEN_LATE_RADIUS_M:
                continue
            for night in nights:
                if weekday not in night.days:
                    continue
                last = next(
                    (p for p in range(day, 0, -1) if timeutil.weekday_of_day(p) in night.days),
                    None,
                )
                if last is None:
                    continue
                close_h = timeutil.to_minutes(night.close) // 60
                hours = [(close_h - 1) % 24, close_h]
                evidence = self.found[i, last, hours].sum()
                if o.override_kind.get(last) == "open_late":
                    evidence += self.visits[i, last, hours].sum()
                if evidence < OPEN_LATE_MIN:
                    continue
                club_close = _abs(nxt, (night.open, night.close))[1]
                opens, closes = _abs(nxt, w)
                if closes >= club_close + 30:
                    continue
                for target in range(club_close + OPEN_LATE_AFTER_MIN, club_close, -30):
                    new = (w[0], timeutil.to_hhmm(target))
                    if target - opens < MINUTES_PER_DAY and not rules.hours_violation(
                        *new, o.licence
                    ):
                        break
                else:
                    continue
                gain = evidence * EXTEND_CONVERSION * self._margin(o)
                if gain <= self._open_cost(o, closes % MINUTES_PER_DAY, target - closes):
                    continue  # the crowd would not pay the staff and power of staying open
                o.overrides[nxt] = new
                o.override_kind[nxt] = "open_late"
                self._lift_lights(o, timeutil.to_minutes(w[1]), target - closes)
                # Announced an hour before the usual close, on the evening itself.
                announce = max((nxt - 1) * MINUTES_PER_DAY, min(closes, nxt * MINUTES_PER_DAY) - 60)
                self._emit(
                    nxt, announce, o, "open_late", w[1], new[1],
                    f"Club crowd outside, staying open till {new[1]} tonight.",
                    "club_night", float(evidence),
                    f"{evidence:.0f} at the door after the last club night",
                )  # fmt: skip
                return True
        return False

    def _lights(self, o: _Owner, day: int, nxt: int) -> None:
        """Lights that bring nobody in go off: a lit window only draws people at night while the
        shop is open, so lights while shut and sign lights in daylight are pure cost."""
        if o.lights_off_from <= DAYS or not o.regular_day(day):
            return
        i = o.index
        open_row = self._open_fraction(i, day)
        lit = self.levels[i] > 0
        waste = lit & ((open_row == 0) | ~NIGHT)
        if not waste.any():
            return
        o.lights_off_mask = lit
        o.daylight_off_mask = ~NIGHT
        o.lights_off_from = nxt
        hours = np.flatnonzero(waste)
        kw = np.array(
            [self.world.energy.lightingKw.get(LEVELS[self.levels[i, h]], 0.0) for h in hours]
        )
        kwh = float(kw.sum())
        cost = float((kw * self.price[hours]).sum())
        level = LEVELS[int(self.levels[i, waste].max())]
        while_shut = waste & (open_row == 0)
        if (while_shut == waste).all():
            reason = "Window lights off while we're shut, they don't sell anything."
        elif not while_shut.any():
            reason = "Sign lights off in daylight, nobody comes in for them."
        else:
            reason = "Lights off in daylight and while we're shut, they bring nobody in."
        label = f"{kwh:.2f} kWh (£{cost:.2f}) a day on lights nobody shops by"
        self._emit(
            nxt, (nxt - 1) * MINUTES_PER_DAY, o, "lighting_changed", level, "off", reason,
            "lights_waste", round(kwh, 2), label,
        )  # fmt: skip

    # --- money -------------------------------------------------------------------------------

    def _margin(self, o: _Owner) -> float:
        """GBP the owner keeps per visit (backend/economics.py)."""
        return economics.margin_per_visit(o.store_type)

    def _open_cost(self, o: _Owner, minute: int, minutes: int) -> float:
        """Extra cost (GBP) of being open `minutes` from clock minute `minute` instead of shut:
        the staff on shift, the open-hours load over standby, and the lights it would burn open
        vs shut."""
        e = self.world.energy
        i = o.index
        rate = float(self.world.floor_area[i]) * (
            e.kwhPerM2PerOpenHour.get(o.store_type, 0.0)
            - e.standbyKwhPerM2PerHour.get(o.store_type, 0.0)
        )
        light_kw = [e.lightingKw.get(level, 0.0) for level in LEVELS]
        lights_off = o.lights_off_from <= DAYS
        total = 0.0
        for m in range(minute, minute + max(minutes, 0), 30):
            h = (m // 60) % 24
            hours = min(30, minute + minutes - m) / 60
            level = int(self.levels[i, h])
            on_open = level if level or self.base_open[i, 0, h] > 0 else int(NIGHT_LEVEL[h])
            on_shut = level
            if lights_off:
                on_open = 0 if o.daylight_off_mask[h] else on_open
                on_shut = 0 if o.lights_off_mask[h] else on_shut
            kwh = (rate + light_kw[on_open] - light_kw[on_shut]) * hours
            total += kwh * float(self.price[h])
        return total + max(minutes, 0) / 60 * economics.staff_gbp_per_open_hour(o.store_type)

    # --- schedule upkeep -----------------------------------------------------------------------

    def _lift_lights(self, o: _Owner, from_minute: int, minutes: int) -> None:
        """Hours the owner newly opens with lights configured off get lit (high at night):
        nobody trades in the dark."""
        i = o.index
        for m in range(from_minute, from_minute + max(minutes, 0), 60):
            h = (m // 60) % 24
            if self.levels[i, h] == 0:
                level = LEVELS[NIGHT_LEVEL[h]]
                self.schedule.light_effect[i, h] = citizens.LIGHT_EFFECT[level]

    def _repaint(self, o: _Owner, from_day: int) -> None:
        """Open ticks of store o from the start of from_day on, from its per-day windows."""
        row = self.schedule.open_ticks[o.index]
        lo = (from_day - 1) * TPD
        row[lo:] = False
        for day in range(max(from_day - 1, 0), DAYS + 2):
            w = o.window(day)
            if w is None:
                continue
            opens, closes = _abs(day, w)
            a, b = max(opens // TICK, lo), min(closes // TICK, len(row))
            if a < b:
                row[a:b] = True

    def _open_fraction(self, i: int, day: int) -> np.ndarray:
        ticks = self.schedule.open_ticks[i, (day - 1) * TPD : day * TPD]
        return ticks.reshape(24, -1).mean(-1)

    def _lit(self, o: _Owner, first_day: int, open_fraction: np.ndarray) -> np.ndarray:
        """LEVELS index lit per (day, hour) for days first_day.. (rows of open_fraction)."""
        i = o.index
        n_days = len(open_fraction)
        lit = np.broadcast_to(self.levels[i], (n_days, 24)).copy()
        base = self.base_open[i, first_day - 1 : first_day - 1 + n_days]
        opened = (open_fraction > 0) & (base == 0) & (lit == 0)
        lit = np.where(opened, NIGHT_LEVEL[None, :], lit)
        shut = open_fraction == 0
        for k in range(n_days):
            day = first_day + k
            if o.dark(day):
                lit[k, shut[k]] = 0
            elif day >= o.lights_off_from:
                lit[k, shut[k] & o.lights_off_mask] = 0
                lit[k, o.daylight_off_mask] = 0
        return lit

    def finalize(self) -> None:
        """Energy arrays of the schedule from the adapted hours and lighting."""
        s = self.schedule
        n = self.world.n_stores
        s.open_fraction = s.open_ticks[:, : DAYS * TPD].reshape(n, DAYS, 24, -1).mean(-1)
        for i, o in self.owners.items():
            s.lit[i] = self._lit(o, 1, s.open_fraction[i])

    # --- outputs -------------------------------------------------------------------------------

    def _emit(
        self,
        day: int,
        t: int,
        o: _Owner,
        action: str,
        from_: str | None,
        to: str | None,
        reason: str,
        kind: str,
        value: float,
        label: str,
    ) -> None:
        self.out.append(
            OwnerEvent.model_validate(
                {
                    "day": day,
                    "t": t,
                    "storeId": o.store_id,
                    "action": action,
                    "from": from_,
                    "to": to,
                    "reason": reason,
                    "trigger": OwnerTrigger.model_validate(
                        {"kind": kind, "value": float(value), "label": label}
                    ),
                }
            )
        )

    def events(self) -> list[OwnerEvent]:
        """Owner events, oldest first (a day_reopened after a permanent closure is dropped)."""
        closed = {o.store_id: o.closed_from for o in self.owners.values() if o.closed_from}
        kept = [
            e
            for e in self.out
            if not (e.action == "day_reopened" and e.day >= closed.get(e.storeId, DAYS + 1))
        ]
        return sorted(kept, key=lambda e: (e.t, e.storeId, e.action))

    def schedules(self) -> dict[str, list[dict]]:
        """Per store that changed its weekly hours: [{fromDay, week[7]}], oldest first."""
        out = {}
        for o in self.owners.values():
            if len(o.templates) < 2:
                continue
            out[o.store_id] = [
                {
                    "fromDay": t.from_day,
                    "week": [
                        None if k in t.closed else {"open": t.open, "close": t.close}
                        for k in range(7)
                    ],
                }
                for t in o.templates
            ]
        return out

    def closed_from(self) -> dict[str, int]:
        return {o.store_id: o.closed_from for o in self.owners.values() if o.closed_from}
