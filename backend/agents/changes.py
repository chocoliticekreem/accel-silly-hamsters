"""Small helpers for store changes: building contract Suggestions, hours maths, config diffs.

A "change" is one contract Suggestion: a new open time, a new close time, or a new lighting level
for a set of clock hours. Every agent (store owner, analyst, report) builds and compares changes
through these helpers so they agree on the details.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from backend.contract import MINUTES_PER_DAY, Suggestion
from backend.schemas import StoreConfig
from backend.timeutil import open_hours_fraction, to_hhmm, to_minutes

_TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")


def make_suggestion(
    store_id: str,
    field: str,
    from_: str,
    to: str,
    *,
    visits: float,
    kwh: float,
    hours: list[int] | None = None,
    confidence: str | None = None,
    reason: str | None = None,
) -> Suggestion:
    """Build a validated contract Suggestion. `visits`/`kwh` are expected fractional deltas."""
    data: dict[str, object] = {
        "storeId": store_id,
        "field": field,
        "from": from_,
        "to": to,
        "expectedDelta": {"visits": round(visits, 4), "kwh": round(kwh, 4)},
    }
    if hours is not None:
        data["hours"] = hours
    if confidence is not None:
        data["confidence"] = confidence
    if reason is not None:
        data["reason"] = reason
    return Suggestion.model_validate(data)


def normalize_time(value: str) -> str:
    """'7:00' -> '07:00', '24:00' -> '00:00'. Raises ValueError for anything else."""
    if not _TIME_RE.match(value):
        raise ValueError(f"not an HH:MM time: {value!r}")
    hours, minutes = value.split(":")
    if int(minutes) >= 60:
        raise ValueError(f"not an HH:MM time: {value!r}")
    return to_hhmm(to_minutes(value))


def window_length(open_hhmm: str, close_hhmm: str) -> int:
    """Minutes the daily window is open (a close at or before the open wraps past midnight)."""
    length = (to_minutes(close_hhmm) - to_minutes(open_hhmm)) % MINUTES_PER_DAY
    return length or MINUTES_PER_DAY


def shift_time(hhmm: str, minutes: int) -> str:
    return to_hhmm(to_minutes(hhmm) + minutes)


def contiguous_groups(hours: Iterable[int]) -> list[list[int]]:
    """Group clock hours into runs of consecutive hours, joining a run across midnight.

    [0, 1, 5, 22, 23] -> [[22, 23, 0, 1], [5]]
    """
    ordered = sorted(set(hours))
    if not ordered:
        return []
    groups: list[list[int]] = [[ordered[0]]]
    for hour in ordered[1:]:
        if hour == groups[-1][-1] + 1:
            groups[-1].append(hour)
        else:
            groups.append([hour])
    if len(groups) > 1 and groups[0][0] == 0 and groups[-1][-1] == 23:
        groups[0] = groups.pop() + groups[0]
    return groups


def config_diff(before: StoreConfig, after: StoreConfig) -> list[dict]:
    """The changes that turn `before` into `after`: field, from, to and (lighting) hours.

    Lighting hours that move between the same two levels and sit next to each other become one
    change, so "18-24 low -> off" is a single item.
    """
    items: list[dict] = []
    for field in ("open", "close"):
        old, new = getattr(before, field), getattr(after, field)
        if old != new:
            items.append({"field": field, "from": old, "to": new, "hours": None})
    by_levels: dict[tuple[str, str], list[int]] = {}
    for hour, (old, new) in enumerate(zip(before.lighting, after.lighting, strict=True)):
        if old != new:
            by_levels.setdefault((old, new), []).append(hour)
    for (old, new), hours in by_levels.items():
        for group in contiguous_groups(hours):
            items.append({"field": "lighting", "from": old, "to": new, "hours": group})
    return items


def change_signature(suggestion: Suggestion) -> tuple[str, str, str, tuple[int, ...]]:
    """Identity of a change regardless of its estimates: store, field, target and hours."""
    return (
        suggestion.storeId,
        suggestion.field,
        suggestion.to,
        tuple(sorted(suggestion.hours or [])),
    )


def affected_hours(change: Suggestion, config: StoreConfig) -> list[int]:
    """Clock hours a change touches on `config`: the lighting hours, or the hours whose open
    share moves when open/close changes."""
    if change.field == "lighting":
        return sorted(set(change.hours or []))
    before = open_hours_fraction(config.open, config.close)
    window = (config.open, change.to) if change.field == "close" else (change.to, config.close)
    after = open_hours_fraction(*window)
    return [h for h in range(24) if before[h] != after[h]]
