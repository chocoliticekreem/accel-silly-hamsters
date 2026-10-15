"""Clock helpers shared by the sim, the agents and the hard rules.

Opening hours are daily windows "HH:MM"–"HH:MM" in 30-minute steps. A close at or before the
open wraps past midnight (open 07:00, close 03:00 = open 07:00–24:00 and 00:00–03:00).
open == close means open 24 hours.

Day 1 is a Monday, so days 5–6 and 12–13 are Friday–Saturday.
"""

from __future__ import annotations

from backend.contract import MINUTES_PER_DAY

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def to_minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    value = int(hours) * 60 + int(minutes)
    if not 0 <= value <= MINUTES_PER_DAY:
        raise ValueError(f"time out of range: {hhmm!r}")
    return value % MINUTES_PER_DAY


def to_hhmm(minutes: int) -> str:
    minutes %= MINUTES_PER_DAY
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def is_half_hour_step(hhmm: str) -> bool:
    return to_minutes(hhmm) % 30 == 0


def is_open(open_hhmm: str, close_hhmm: str, minute_of_day: int) -> bool:
    start, end, m = to_minutes(open_hhmm), to_minutes(close_hhmm), minute_of_day % MINUTES_PER_DAY
    if start == end:
        return True
    if start < end:
        return start <= m < end
    return m >= start or m < end


def open_minutes(open_hhmm: str, close_hhmm: str) -> set[int]:
    """Minutes of the day (0..1439) during which the window is open."""
    return {m for m in range(MINUTES_PER_DAY) if is_open(open_hhmm, close_hhmm, m)}


def open_hours_fraction(open_hhmm: str, close_hhmm: str) -> list[float]:
    """Fraction of each clock hour (0..23) that the window is open."""
    return [
        sum(is_open(open_hhmm, close_hhmm, h * 60 + m) for m in range(60)) / 60 for h in range(24)
    ]


def window_within(inner: tuple[str, str], outer: tuple[str, str]) -> bool:
    return open_minutes(*inner) <= open_minutes(*outer)


def day_of(t: int) -> int:
    """1-based day for sim minute t."""
    return t // MINUTES_PER_DAY + 1


def weekday_of_day(day: int) -> str:
    return WEEKDAYS[(day - 1) % 7]


def is_weekend_day(day: int) -> bool:
    return weekday_of_day(day) in ("sat", "sun")
