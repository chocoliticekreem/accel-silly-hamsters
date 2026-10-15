"""POST /api/apply helpers: turn a run's suggestions into the store configs for the next run.

apply_suggestions is pure (no I/O). load_rules finds the hard rules (backend.agents.rules) so a
manual apply obeys the same rules as an agent proposal; if that module is missing the API
applies without them and logs a warning.
"""

from __future__ import annotations

import importlib
import re
from collections.abc import Iterable
from types import ModuleType
from typing import get_args

from backend.contract import LightingLevel, Suggestion
from backend.schemas import StoreConfig
from backend.timeutil import to_hhmm, to_minutes

RULES_MODULE = "backend.agents.rules"
LIGHTING_LEVELS = frozenset(get_args(LightingLevel))
_CLOCK = re.compile(r"\d{1,2}:[0-5]\d")

Configs = dict[str, StoreConfig]


def select_suggestions(
    suggestions: Iterable[Suggestion], store_ids: Iterable[str] | None
) -> list[Suggestion]:
    """The suggestions an apply covers: all of them when store_ids is None, else those stores'."""
    if store_ids is None:
        return list(suggestions)
    wanted = set(store_ids)
    return [s for s in suggestions if s.storeId in wanted]


def clock_time(value: str) -> str:
    """Normalise "H:MM" / "HH:MM" to "HH:MM" ("24:00" -> "00:00"); ValueError otherwise."""
    if not _CLOCK.fullmatch(value):
        raise ValueError(f"not a clock time: {value!r}")
    return to_hhmm(to_minutes(value))


def _lighting_hours(suggestion: Suggestion) -> list[int]:
    if not suggestion.hours:
        raise ValueError(f"lighting suggestion for {suggestion.storeId} lists no hours")
    bad = [h for h in suggestion.hours if not 0 <= h <= 23]
    if bad:
        raise ValueError(f"lighting hours out of range 0-23 for {suggestion.storeId}: {bad}")
    return suggestion.hours


def _lighting_level(value: str) -> str:
    if value not in LIGHTING_LEVELS:
        raise ValueError(f"not a lighting level: {value!r} (expected off, low or high)")
    return value


def apply_suggestions(base: Configs, suggestions: Iterable[Suggestion]) -> Configs:
    """New store configs with the suggestions applied in order; `base` is left untouched.

    open/close set that end of the opening window; lighting sets every listed hour to the `to`
    level. Raises ValueError for an unknown store or a malformed value. The hard rules (licence,
    30-minute steps, change caps) live in backend.agents.rules, not here.
    """
    configs = {store_id: config.model_copy(deep=True) for store_id, config in base.items()}
    for suggestion in suggestions:
        current = configs.get(suggestion.storeId)
        if current is None:
            raise ValueError(f"suggestion for unknown store {suggestion.storeId!r}")
        fields = current.model_dump()
        if suggestion.field == "lighting":
            for hour in _lighting_hours(suggestion):
                fields["lighting"][hour] = _lighting_level(suggestion.to)
        else:
            fields[suggestion.field] = clock_time(suggestion.to)
        configs[suggestion.storeId] = StoreConfig.model_validate(fields)
    return configs


def load_rules() -> ModuleType | None:
    """The backend.agents.rules module, or None when it does not exist.

    Any other import failure propagates: a rules module that exists but is broken must stop
    applies instead of letting changes through unchecked.
    """
    try:
        return importlib.import_module(RULES_MODULE)
    except ModuleNotFoundError as e:
        if e.name != RULES_MODULE:
            raise
        return None
