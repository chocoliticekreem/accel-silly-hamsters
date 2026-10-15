"""Hard rules every proposed change must pass before it is simulated, whatever proposed it.

Store agents, the analyst and the API's manual apply all call validate_changes. The rules live
here in code, not in prompts (docs/BUILD_NOTES.md, "Agents"):

  - open/close moves land on the 30-minute grid
  - the resulting window sits inside the store's licensed hours (MapStore.licensedHours, else a
    default cap for the store type)
  - the store stays open at least 60 minutes and closes for at least 30 (so never 24 hours)
  - at most settings.MAX_CHANGES_PER_STORE_PER_WEEK changes per store per iteration
  - lighting levels are off | low | high, hours are 0-23, and `from` matches the current config
  - clubs are fixed anchors and never change
  - never a store config that was already simulated (cache.store_config_tried)

Rejected changes come back with a reason; callers log them with log_rejections.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from backend import cache, llm, settings
from backend.agents.changes import normalize_time, window_length
from backend.contract import MINUTES_PER_DAY, MapData, MapStore, Suggestion, dump
from backend.schemas import StoreConfig
from backend.timeutil import to_minutes, window_within

LEVELS = ("off", "low", "high")
STEP_MINUTES = 30
MIN_OPEN_MINUTES = 60
MIN_CLOSED_MINUTES = 30

# Licence caps when map.json carries no licensedHours for a store (late-night licensing norms).
DEFAULT_LICENSED_HOURS: dict[str, tuple[str, str]] = {
    "cafe": ("06:00", "23:00"),
    "restaurant": ("07:00", "00:30"),
    "takeaway": ("06:00", "04:00"),
    "bar": ("10:00", "02:00"),
    "shop": ("06:00", "23:00"),
    "offlicence": ("06:00", "23:00"),
}


@dataclass(frozen=True)
class Rejection:
    suggestion: Suggestion
    reason: str

    def to_log(self) -> dict:
        return {"suggestion": dump(self.suggestion), "reason": self.reason}


@dataclass
class RuleResult:
    configs: dict[str, StoreConfig]  # every store in `base`, accepted changes applied
    accepted: list[Suggestion]
    rejections: list[Rejection]


def licensed_window(store: MapStore) -> tuple[str, str]:
    """The store's licensed opening window, or the default cap for its type."""
    if store.licensedHours is not None:
        return store.licensedHours.open, store.licensedHours.close
    return DEFAULT_LICENSED_HOURS[store.type]


def hours_violation(open_hhmm: str, close_hhmm: str, licence: tuple[str, str]) -> str | None:
    """Why a daily window breaks the hours rules, or None when it is allowed."""
    length = window_length(open_hhmm, close_hhmm)
    if length < MIN_OPEN_MINUTES:
        return f"open {length} min, must be open at least {MIN_OPEN_MINUTES} min"
    closed = MINUTES_PER_DAY - length
    if closed < MIN_CLOSED_MINUTES:
        return f"closed {closed} min, must close for at least {MIN_CLOSED_MINUTES} min"
    if not window_within((open_hhmm, close_hhmm), licence):
        return f"{open_hhmm}-{close_hhmm} is outside the licensed hours {licence[0]}-{licence[1]}"
    return None


def apply_suggestion(config: StoreConfig, suggestion: Suggestion) -> StoreConfig:
    """A copy of `config` with one change applied. No rule checks: see validate_changes."""
    data = config.model_dump(mode="json")
    if suggestion.field == "lighting":
        lighting = list(data["lighting"])
        for hour in suggestion.hours or []:
            lighting[hour] = suggestion.to
        data["lighting"] = lighting
    else:
        data[suggestion.field] = normalize_time(suggestion.to)
    return StoreConfig.model_validate(data)


def _lighting_violation(suggestion: Suggestion, config: StoreConfig) -> str | None:
    hours = suggestion.hours
    if not hours:
        return "a lighting change needs at least one hour"
    if any(not 0 <= h <= 23 for h in hours) or len(set(hours)) != len(hours):
        return f"lighting hours must be distinct values 0-23, got {hours}"
    if suggestion.from_ not in LEVELS or suggestion.to not in LEVELS:
        return f"lighting levels are {'|'.join(LEVELS)}, got {suggestion.from_}->{suggestion.to}"
    if suggestion.from_ == suggestion.to:
        return "no change: from and to are the same level"
    stale = [h for h in hours if config.lighting[h] != suggestion.from_]
    if stale:
        return f"stale: hour {stale[0]} is {config.lighting[stale[0]]}, not {suggestion.from_}"
    return None


def _hours_change_violation(
    suggestion: Suggestion, config: StoreConfig, store: MapStore
) -> str | None:
    if suggestion.hours:
        return "hours apply to lighting changes only"
    try:
        to = normalize_time(suggestion.to)
        from_ = normalize_time(suggestion.from_)
    except ValueError as e:
        return str(e)
    if to_minutes(to) % STEP_MINUTES:
        return f"{to} is not on the {STEP_MINUTES}-minute grid"
    current = normalize_time(getattr(config, suggestion.field))
    if from_ != current:
        return f"stale: {suggestion.field} is {current}, not {from_}"
    if to == current:
        return f"no change: {suggestion.field} is already {to}"
    open_hhmm = to if suggestion.field == "open" else config.open
    close_hhmm = to if suggestion.field == "close" else config.close
    return hours_violation(open_hhmm, close_hhmm, licensed_window(store))


def _violation(
    suggestion: Suggestion,
    stores: dict[str, MapStore],
    configs: dict[str, StoreConfig],
    counts: Counter[str],
    check_tried: bool,
) -> str | None:
    store = stores.get(suggestion.storeId)
    if store is None:
        return f"unknown store {suggestion.storeId!r}"
    if store.type == "club":
        return "clubs are fixed anchors and never change"
    config = configs.get(suggestion.storeId)
    if config is None:
        return f"store {suggestion.storeId!r} has no config in this run"
    if counts[suggestion.storeId] >= settings.MAX_CHANGES_PER_STORE_PER_WEEK:
        return f"at most {settings.MAX_CHANGES_PER_STORE_PER_WEEK} changes per store per week"
    if suggestion.field == "lighting":
        reason = _lighting_violation(suggestion, config)
    else:
        reason = _hours_change_violation(suggestion, config, store)
    if reason:
        return reason
    if check_tried and cache.store_config_tried(
        suggestion.storeId, apply_suggestion(config, suggestion)
    ):
        return "this store config was already simulated"
    return None


def check_changes(
    base: dict[str, StoreConfig],
    suggestions: list[Suggestion],
    map_data: MapData,
    *,
    check_tried: bool = True,
) -> RuleResult:
    """Apply `suggestions` in order on top of `base`, keeping only those that pass every rule.

    Each accepted change is checked against the config as changed so far, so the final config of
    every store is one that was never simulated (when check_tried is True).
    """
    stores = {s.id: s for s in map_data.stores}
    configs = {sid: config.model_copy(deep=True) for sid, config in base.items()}
    counts: Counter[str] = Counter()
    accepted: list[Suggestion] = []
    rejections: list[Rejection] = []
    for suggestion in suggestions:
        reason = _violation(suggestion, stores, configs, counts, check_tried)
        if reason:
            rejections.append(Rejection(suggestion, reason))
            continue
        configs[suggestion.storeId] = apply_suggestion(configs[suggestion.storeId], suggestion)
        counts[suggestion.storeId] += 1
        accepted.append(suggestion)
    return RuleResult(configs=configs, accepted=accepted, rejections=rejections)


def validate_changes(
    base: dict[str, StoreConfig],
    suggestions: list[Suggestion],
    map_data: MapData,
    *,
    check_tried: bool = True,
) -> tuple[dict[str, StoreConfig], list[Rejection]]:
    """New configs for every store in `base` with the allowed changes applied, plus rejections."""
    result = check_changes(base, suggestions, map_data, check_tried=check_tried)
    return result.configs, result.rejections


def log_rejections(run: int | None, rejections: list[Rejection], *, agent: str) -> None:
    """Write each rejection to the run's audit log (runs/{run}/llm_log.jsonl)."""
    for rejection in rejections:
        llm.log_event(run, {"agent": agent, "type": "rule_rejection", **rejection.to_log()})
