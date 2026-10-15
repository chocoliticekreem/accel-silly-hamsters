"""Short human-readable wording for changes: diff labels, notebook phrases, word limits.

The UI shows diffs, not paragraphs ("Close 23:00 → 03:00", "Light 01–03: off → low"); the lab
notebook gets one line of at most 12 words ("Opened Kebab Co till 03:00 → +18% night visits").
"""

from __future__ import annotations

from backend.agents.changes import contiguous_groups, window_length
from backend.contract import Suggestion
from backend.schemas import StoreConfig

LEVEL_RANK = {"off": 0, "low": 1, "high": 2}
# Lighting only attracts at night (docs/BUILD_NOTES.md): roughly 17:00-07:00.
NIGHT_HOURS = frozenset([*range(17, 24), *range(0, 7)])


def clamp_words(text: str, limit: int) -> str:
    words = text.split()
    return " ".join(words[:limit])


def hours_range(hours: list[int]) -> str:
    """[1, 2] -> '01–03' (end exclusive, as in the contract's 'Light 01–03').

    Hours that are not one consecutive run are listed instead: '01,05'.
    """
    groups = contiguous_groups(hours)
    if len(groups) == 1:
        group = groups[0]
        return f"{group[0]:02d}–{(group[-1] + 1) % 24:02d}"
    return ",".join(f"{h:02d}" for h in sorted(hours))


def change_label(suggestion: Suggestion) -> str:
    """Contract-style diff: 'Close 23:00 → 03:00' or 'Light 01–03: off → low'."""
    if suggestion.field == "lighting":
        return f"Light {hours_range(suggestion.hours or [])}: {suggestion.from_} → {suggestion.to}"
    return f"{suggestion.field.capitalize()} {suggestion.from_} → {suggestion.to}"


def lengthens(suggestion: Suggestion, config: StoreConfig) -> bool:
    """True when an open/close change makes the daily window longer."""
    if suggestion.field == "open":
        before = window_length(suggestion.from_, config.close)
        after = window_length(suggestion.to, config.close)
    else:
        before = window_length(config.open, suggestion.from_)
        after = window_length(config.open, suggestion.to)
    return after > before


def change_phrase(suggestion: Suggestion, name: str, config: StoreConfig) -> str:
    """Notebook verb phrase for a change, given the store's config before the change."""
    if suggestion.field == "lighting":
        span = hours_range(suggestion.hours or [])
        if suggestion.to == "off":
            return f"Lights off at {name} {span}"
        if LEVEL_RANK[suggestion.to] > LEVEL_RANK.get(suggestion.from_, 0):
            return f"Lit {name} {suggestion.to} {span}"
        return f"Dimmed {name} to {suggestion.to} {span}"
    if suggestion.field == "close":
        if lengthens(suggestion, config):
            return f"Opened {name} till {suggestion.to}"
        return f"Closed {name} at {suggestion.to}"
    if lengthens(suggestion, config):
        return f"Opened {name} from {suggestion.to}"
    return f"{name} opens at {suggestion.to}"


def signed_pct(fraction: float) -> str:
    return f"{fraction * 100:+.0f}%"
