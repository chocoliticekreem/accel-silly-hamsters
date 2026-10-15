"""Store-owner agents: one per store, each advising only its own store.

Data firewall: a store agent's whole input is a StoreBrief built from this store's own files (its
KPIs, hourly visits, StoreStats, config history across runs and its owner's approve/reject
decisions) plus public area data (area footfall, energy benchmarks and prices). It never sees
another store's config or results, so advice stays independent per store.

Two ways to propose, 0-2 changes per store:
  online   settings.STORE_AGENT_MODEL through Message Batches: all stores in one batch, structured
           outputs, the shared city context as the first (cached) system block, the store's data
           last. A store whose request fails falls back to the heuristic (logged).
  offline  a deterministic heuristic, used when llm.available() is False.
TrainingConfig.storeAgents picks one ("auto" = online when Claude credentials exist).

A training session's TrainingConfig scopes the proposals: only participating stores (storeIds)
propose, only with enabled levers, at most maxChangesPerStore each, ranked by its objective.
Every proposal passes agents.rules before it reaches runs/{run}/suggestions.json.
"""

from __future__ import annotations

import json
import os
import re
import statistics
import time
from dataclasses import asdict, dataclass

from pydantic import ValidationError

from backend import cache, llm, settings, store
from backend.agents import prompts, rundata
from backend.agents.changes import (
    affected_hours,
    change_signature,
    contiguous_groups,
    make_suggestion,
    shift_time,
    window_length,
)
from backend.agents.objective import expected_gain, fraction, per_store, value_per_visit
from backend.agents.rules import check_changes, hours_violation, licensed_window, log_rejections
from backend.agents.wording import LEVEL_RANK, NIGHT_HOURS, clamp_words, hours_range
from backend.contract import MapData, MapStore, StoreKpis, StoreType, Suggestion
from backend.schemas import Decision, EnergyFile, StoreConfig, StoreStats, TrainingConfig
from backend.timeutil import open_hours_fraction

AGENT = "store_owner"

# Heuristic priors. They shape estimates only; the sim replay measures the real effect.
FOUND_CLOSED_CAPTURE = 0.7  # share of found-closed demand that turns into visits once open
NIGHT_LIGHT_UPLIFT_PER_STEP = 0.15  # night visits gained (or lost) per lighting level step
MAX_EXTENSION_HOURS = 4
MAX_TRIM_HOURS = 3
MIN_WINDOW_AFTER_TRIM = 4 * 60  # minutes; never trim a store below four hours a day
DEAD_HOUR_SHARE = 0.15  # an open hour is dead below 15% of an average open hour's visits...
MIN_DEAD_VISITS = 0.5  # ...or below half a visit a day
MIN_DEMAND_PER_DAY = 1.0  # found-closed demand worth opening for, per day...
MIN_DEMAND_SHARE = 0.03  # ...or 3% of the store's daily visits, whichever is larger
QUIET_FOOTFALL_SHARE = 0.5  # a night hour is quiet below half the store's mean open-hour footfall
MIN_GAIN = 0.001  # ignore changes estimated under +0.1% on the objective
# A one-shop session also tests ideas estimated slightly negative: the estimate is rough and the
# 14 simulated days decide; the patience rule stops it once nothing beats the best run.
EXPLORE_MIN_GAIN = -0.25
DEFAULT_FLOOR_AREA_M2 = 80.0  # only when neither map.json nor the building footprint has one
HISTORY_RUNS = 8
REASON_WORDS = 15
MAX_EXPECTED_DELTA = 3.0  # +300%: anything larger from a model is noise, not an estimate

BATCH_MAX_TOKENS = 8000
BATCH_POLL_SECONDS: float = 30
BATCH_TIMEOUT_SECONDS = float(os.getenv("BATCH_TIMEOUT_SECONDS", str(2 * 3600)))


@dataclass
class StoreBrief:
    """Everything one store agent may see: its own data plus public area data, nothing else."""

    run: int
    store_id: str
    name: str
    type: StoreType
    floor_area: float
    licence: tuple[str, str]
    config: StoreConfig
    kpis: StoreKpis
    visits_by_hour: list[float]
    stats: StoreStats
    history: list[dict]
    decisions: list[Decision]
    area_footfall_by_hour: list[float]
    open_kwh_per_m2: float
    standby_kwh_per_m2: float
    lighting_kw: dict[str, float]
    price_gbp_per_kwh: list[float]
    objective: str  # what the heuristic ranks its ideas by (TrainingConfig.objective)

    @property
    def daily_visits(self) -> float:
        return sum(self.visits_by_hour)

    @property
    def daily_kwh(self) -> float:
        return sum(self.stats.kwhByHour)

    def prompt_data(self) -> dict:
        """The JSON the LLM store agent receives (rounded so the prompt stays small)."""

        def r(values: list[float]) -> list[float]:
            return [round(v, 2) for v in values]

        stats = self.stats
        return {
            "store": {
                "id": self.store_id,
                "name": self.name,
                "type": self.type,
                "floorAreaM2": round(self.floor_area, 1),
                "licensedHours": {"open": self.licence[0], "close": self.licence[1]},
            },
            "currentConfig": self.config.model_dump(mode="json"),
            "kpis14Days": self.kpis.model_dump(mode="json"),
            "perHour": {
                "visits": r(self.visits_by_hour),
                "visitsWeekday": r(stats.visitsByHourWeekday),
                "visitsWeekend": r(stats.visitsByHourWeekend),
                "footfallNearby": r(stats.footfallNearbyByHour),
                "foundClosed": r(stats.foundClosedByHour),
                "kwh": r(stats.kwhByHour),
            },
            "visitors": {
                "unique": stats.uniqueVisitors,
                "repeat": stats.repeatVisitors,
                "byPersona": stats.visitsByPersona,
            },
            "energyCostGbp14Days": round(stats.energyCostGbp, 2),
            "configHistory": self.history,
            "ownerDecisions": [
                {"decision": d.decision, "suggestion": d.suggestion, "reason": d.reason}
                for d in self.decisions
            ],
            "publicArea": {
                "footfallByHour": r(self.area_footfall_by_hour),
                "openKwhPerM2PerHour": self.open_kwh_per_m2,
                "standbyKwhPerM2PerHour": self.standby_kwh_per_m2,
                "lightingKw": self.lighting_kw,
                "priceGbpPerKwh": r(self.price_gbp_per_kwh),
            },
        }


def _floor_area(ms: MapStore, map_data: MapData) -> float:
    if ms.floorArea:
        return ms.floorArea
    building = next((b for b in map_data.buildings if b.id == ms.buildingId), None)
    return building.w * building.d if building else DEFAULT_FLOOR_AREA_M2


def build_brief(
    files: rundata.RunFiles,
    ms: MapStore,
    map_data: MapData,
    energy: EnergyFile,
    decisions: list[Decision],
    history: list[dict],
    *,
    objective: str | None = None,
) -> StoreBrief:
    """The brief for store `ms`, taking only that store's slice of the run files.

    `objective` defaults to settings.OBJECTIVE.
    """
    result = files.stores[ms.id]
    return StoreBrief(
        run=files.run,
        store_id=ms.id,
        name=ms.name,
        type=ms.type,
        floor_area=_floor_area(ms, map_data),
        licence=licensed_window(ms),
        config=files.config.stores[ms.id],
        kpis=result.kpis,
        visits_by_hour=list(result.visitsByHour),
        stats=files.stats[ms.id],
        history=history,
        decisions=[d for d in decisions if d.storeId == ms.id],
        area_footfall_by_hour=list(files.summary.footfallByHour),
        open_kwh_per_m2=energy.kwhPerM2PerOpenHour[ms.type],
        standby_kwh_per_m2=energy.standbyKwhPerM2PerHour[ms.type],
        lighting_kw={str(level): kw for level, kw in energy.lightingKw.items()},
        price_gbp_per_kwh=list(energy.priceGbpPerKwh),
        objective=objective or settings.OBJECTIVE,
    )


def store_histories(current_run: int, store_ids: list[str]) -> dict[str, list[dict]]:
    """Each store's own config and KPIs in other runs (last HISTORY_RUNS), sliced per store."""
    runs = sorted(r.run for r in store.real_runs() if r.run != current_run and r.status == "done")
    histories: dict[str, list[dict]] = {sid: [] for sid in store_ids}
    for run in runs[-HISTORY_RUNS:]:
        try:
            config, results = rundata.load_config(run), rundata.load_stores(run)
        except (FileNotFoundError, ValidationError):
            continue
        for sid in store_ids:
            if sid in config.stores and sid in results:
                kpis = results[sid].kpis
                histories[sid].append(
                    {
                        "run": run,
                        **config.stores[sid].model_dump(mode="json"),
                        "visits": kpis.visits,
                        "kwh": round(kpis.kwh, 1),
                        "returnRate": round(kpis.returnRate, 3),
                    }
                )
    return histories


# --- offline heuristic ----------------------------------------------------------------------


@dataclass
class Candidate:
    """One to two changes that belong together, with their estimated daily effect."""

    kind: str
    changes: list[Suggestion]
    d_visits: float  # visits per day
    d_kwh: float  # kWh per day
    gain: float  # estimated objective gain for this store


def _reason(text: str) -> str:
    return clamp_words(text, REASON_WORDS)


def _candidate(
    brief: StoreBrief, kind: str, changes: list[Suggestion], d_visits: float, d_kwh: float
) -> Candidate:
    gain = expected_gain(
        brief.daily_visits,
        brief.daily_kwh,
        d_visits,
        d_kwh,
        brief.objective,
        gbp_per_visit=value_per_visit(brief.type),
        price=statistics.fmean(brief.price_gbp_per_kwh),
    )
    return Candidate(kind, changes, d_visits, d_kwh, gain)


def _lights_off_when_closed(brief: StoreBrief) -> list[Candidate]:
    fracs = open_hours_fraction(brief.config.open, brief.config.close)
    by_level: dict[str, list[int]] = {}
    for hour in range(24):
        current = brief.config.lighting[hour]
        if fracs[hour] == 0 and current != "off":
            by_level.setdefault(current, []).append(hour)
    out = []
    for level, hours in by_level.items():
        for group in contiguous_groups(hours):
            d_kwh = -brief.lighting_kw[level] * len(group)
            change = make_suggestion(
                brief.store_id,
                "lighting",
                level,
                "off",
                hours=group,
                visits=0.0,
                kwh=fraction(d_kwh, brief.daily_kwh),
                confidence="high",
                reason=_reason(
                    f"Lights burn {hours_range(group)} while shut; "
                    f"off saves {-d_kwh:.1f} kWh a day."
                ),
            )
            out.append(_candidate(brief, "lights_off_closed", [change], 0.0, d_kwh))
    return out


def _new_window(config: StoreConfig, side: str, new_time: str) -> tuple[str, str]:
    return (config.open, new_time) if side == "close" else (new_time, config.close)


def _extensions(brief: StoreBrief, side: str) -> list[Candidate]:
    """Open longer into hours where people found the store shut (e.g. club spill-out)."""
    config, stats = brief.config, brief.stats
    current = getattr(config, side)
    before = open_hours_fraction(config.open, config.close)
    open_hours = [h for h in range(24) if before[h] > 0]
    mean_footfall = statistics.fmean([stats.footfallNearbyByHour[h] for h in open_hours] or [0.0])
    min_demand = max(MIN_DEMAND_PER_DAY, MIN_DEMAND_SHARE * brief.daily_visits)
    out: list[Candidate] = []
    for hours_added in range(1, MAX_EXTENSION_HOURS + 1):
        step = 60 * hours_added
        new_time = shift_time(current, step if side == "close" else -step)
        window = _new_window(config, side, new_time)
        if hours_violation(*window, brief.licence):
            break
        after = open_hours_fraction(*window)
        added = [max(0.0, after[h] - before[h]) for h in range(24)]
        demand = sum(stats.foundClosedByHour[h] * added[h] for h in range(24))
        if demand < min_demand:
            continue
        d_visits = FOUND_CLOSED_CAPTURE * demand
        d_kwh = sum(added) * brief.floor_area * (brief.open_kwh_per_m2 - brief.standby_kwh_per_m2)
        new_hours = [h for h in range(24) if added[h] > 0]
        change = make_suggestion(
            brief.store_id,
            side,
            current,
            new_time,
            visits=fraction(d_visits, brief.daily_visits),
            kwh=fraction(d_kwh, brief.daily_kwh),
            confidence="medium" if demand >= 5 else "low",
            reason=_reason(f"{demand:.0f} people a day found you shut {hours_range(new_hours)}."),
        )
        out.append(_candidate(brief, f"extend_{side}", [change], d_visits, d_kwh))
        dark = [h for h in new_hours if h in NIGHT_HOURS and config.lighting[h] == "off"]
        for group in contiguous_groups(dark):
            busy = statistics.fmean([stats.footfallNearbyByHour[h] for h in group]) >= mean_footfall
            level = "high" if busy and mean_footfall > 0 else "low"
            lit_visits = sum(
                FOUND_CLOSED_CAPTURE * stats.foundClosedByHour[h] * added[h] for h in group
            )
            d_visits_light = lit_visits * NIGHT_LIGHT_UPLIFT_PER_STEP * LEVEL_RANK[level]
            d_kwh_light = (brief.lighting_kw[level] - brief.lighting_kw["off"]) * len(group)
            light = make_suggestion(
                brief.store_id,
                "lighting",
                "off",
                level,
                hours=group,
                visits=fraction(d_visits_light, brief.daily_visits),
                kwh=fraction(d_kwh_light, brief.daily_kwh),
                confidence="low",
                reason="A lit frontage shows you are open; dark shops look shut.",
            )
            out.append(
                _candidate(
                    brief,
                    f"extend_{side}_lit",
                    [change, light],
                    d_visits + d_visits_light,
                    d_kwh + d_kwh_light,
                )
            )
    return out


def _trims(brief: StoreBrief, side: str) -> list[Candidate]:
    """Close earlier (or open later) through hours with almost no visits but full energy cost."""
    config = brief.config
    current = getattr(config, side)
    before = open_hours_fraction(config.open, config.close)
    open_hours_total = sum(before)
    if open_hours_total == 0:
        return []
    dead_rate = max(MIN_DEAD_VISITS, DEAD_HOUR_SHARE * brief.daily_visits / open_hours_total)
    out: list[Candidate] = []
    for hours_cut in range(1, MAX_TRIM_HOURS + 1):
        step = 60 * hours_cut
        new_time = shift_time(current, -step if side == "close" else step)
        window = _new_window(config, side, new_time)
        if window_length(*window) < MIN_WINDOW_AFTER_TRIM:
            break
        if hours_violation(*window, brief.licence):
            continue  # a store already outside its licence may come inside with a longer trim
        after = open_hours_fraction(*window)
        removed = [max(0.0, before[h] - after[h]) for h in range(24)]
        cut = [h for h in range(24) if removed[h] > 0]
        if any(brief.visits_by_hour[h] / before[h] > dead_rate for h in cut):
            break
        lost = sum(brief.visits_by_hour[h] * removed[h] / before[h] for h in cut)
        d_kwh = (
            -sum(removed) * brief.floor_area * (brief.open_kwh_per_m2 - brief.standby_kwh_per_m2)
        )
        change = make_suggestion(
            brief.store_id,
            side,
            current,
            new_time,
            visits=fraction(-lost, brief.daily_visits),
            kwh=fraction(d_kwh, brief.daily_kwh),
            confidence="medium",
            reason=_reason(
                f"Only {lost:.1f} visits a day {hours_range(cut)}; closing saves {-d_kwh:.1f} kWh."
            ),
        )
        out.append(_candidate(brief, f"trim_{side}", [change], -lost, d_kwh))
    return out


def _night_lighting(brief: StoreBrief) -> list[Candidate]:
    """Dim quiet open night hours; brighten busy ones."""
    config, stats = brief.config, brief.stats
    fracs = open_hours_fraction(config.open, config.close)
    open_hours = [h for h in range(24) if fracs[h] > 0]
    if not open_hours:
        return []
    mean_footfall = statistics.fmean(stats.footfallNearbyByHour[h] for h in open_hours)
    if mean_footfall <= 0:
        return []
    night = [h for h in open_hours if h in NIGHT_HOURS]
    out: list[Candidate] = []
    quiet = [
        h
        for h in night
        if config.lighting[h] == "high"
        and stats.footfallNearbyByHour[h] < QUIET_FOOTFALL_SHARE * mean_footfall
    ]
    for group in contiguous_groups(quiet):
        d_kwh = -(brief.lighting_kw["high"] - brief.lighting_kw["low"]) * len(group)
        d_visits = -sum(brief.visits_by_hour[h] for h in group) * NIGHT_LIGHT_UPLIFT_PER_STEP
        change = make_suggestion(
            brief.store_id,
            "lighting",
            "high",
            "low",
            hours=group,
            visits=fraction(d_visits, brief.daily_visits),
            kwh=fraction(d_kwh, brief.daily_kwh),
            confidence="low",
            reason=_reason(
                f"Few passers-by {hours_range(group)}; low light saves {-d_kwh:.1f} kWh a day."
            ),
        )
        out.append(_candidate(brief, "night_low", [change], d_visits, d_kwh))
    for level in ("off", "low"):
        busy = [
            h
            for h in night
            if config.lighting[h] == level and stats.footfallNearbyByHour[h] >= mean_footfall
        ]
        for group in contiguous_groups(busy):
            steps = LEVEL_RANK["high"] - LEVEL_RANK[level]
            d_kwh = (brief.lighting_kw["high"] - brief.lighting_kw[level]) * len(group)
            d_visits = (
                sum(brief.visits_by_hour[h] for h in group) * NIGHT_LIGHT_UPLIFT_PER_STEP * steps
            )
            change = make_suggestion(
                brief.store_id,
                "lighting",
                level,
                "high",
                hours=group,
                visits=fraction(d_visits, brief.daily_visits),
                kwh=fraction(d_kwh, brief.daily_kwh),
                confidence="low",
                reason=_reason(
                    f"Busy street {hours_range(group)}; a brighter frontage draws walk-ins."
                ),
            )
            out.append(_candidate(brief, "night_high", [change], d_visits, d_kwh))
    return out


def _owner_rejected(brief: StoreBrief) -> set[tuple]:
    """Changes this store's owner already rejected: never propose them again."""
    rejected = set()
    for decision in brief.decisions:
        if decision.decision == "reject" and decision.suggestion:
            try:
                rejected.add(change_signature(Suggestion.model_validate(decision.suggestion)))
            except ValidationError:
                continue
    return rejected


def heuristic_proposals(
    brief: StoreBrief, map_data: MapData, config: TrainingConfig | None = None
) -> list[Suggestion]:
    """Deterministic 0-2 changes for one store, best estimated objective gain first.

    Candidates: lights off while shut; extend hours into found-closed demand (with a lit frontage
    for newly opened dark night hours); trim dead edge hours; dim quiet / brighten busy night hours.
    Only candidates on `config`'s enabled levers count, at most config.maxChangesPerStore. Each
    pick must pass the hard rules (including "never a tried config"), so a store whose best idea
    was already simulated moves on to its next one.
    """
    config = config or TrainingConfig()
    candidates = [
        candidate
        for candidate in (
            *_lights_off_when_closed(brief),
            *_extensions(brief, "close"),
            *_extensions(brief, "open"),
            *_trims(brief, "close"),
            *_trims(brief, "open"),
            *_night_lighting(brief),
        )
        if all(config.levers.allows(s.field) for s in candidate.changes)
    ]
    candidates.sort(key=lambda c: (-c.gain, c.kind, [change_signature(s) for s in c.changes]))
    rejected = _owner_rejected(brief)
    base = {brief.store_id: brief.config}
    limit = config.maxChangesPerStore
    floor = EXPLORE_MIN_GAIN if config.scope_store is not None else MIN_GAIN
    picked: list[Suggestion] = []
    touched: set[int] = set()
    for candidate in candidates:
        if candidate.gain < floor or len(picked) >= limit:
            break
        if len(picked) + len(candidate.changes) > limit:
            continue
        if any(change_signature(s) in rejected for s in candidate.changes):
            continue
        hours = {h for s in candidate.changes for h in affected_hours(s, brief.config)}
        if hours & touched:
            continue
        trial = check_changes(base, picked + candidate.changes, map_data, training=config)
        if len(trial.accepted) == len(picked) + len(candidate.changes):
            picked.extend(candidate.changes)
            touched |= hours
    return picked


# --- online: Message Batches ----------------------------------------------------------------


def _custom_id(index: int, store_id: str) -> str:
    return f"{index:03d}-{re.sub(r'[^A-Za-z0-9_-]', '_', store_id)}"[:64]


def _batch_params(brief: StoreBrief, system: list[dict], max_changes: int) -> dict:
    user = prompts.store_prompt(brief.prompt_data(), max_changes)
    return {
        "model": settings.STORE_AGENT_MODEL,
        "max_tokens": BATCH_MAX_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "output_config": {
            "format": llm.json_schema_format(prompts.STORE_SCHEMA),
            "effort": "medium",
        },
    }


def _clamp_delta(value: float) -> float:
    """Keep a model's estimate inside a plausible range before the analyst ranks on it."""
    return min(MAX_EXPECTED_DELTA, max(-1.0, value))


def parse_store_output(store_id: str, data: dict) -> tuple[list[Suggestion], list[str]]:
    """Turn one store agent's structured output into Suggestions for that store only."""
    suggestions: list[Suggestion] = []
    errors: list[str] = []
    for item in data.get("suggestions", [])[: settings.MAX_CHANGES_PER_STORE_PER_WEEK]:
        try:
            delta = item["expectedDelta"]
            suggestions.append(
                make_suggestion(
                    store_id,
                    item["field"],
                    item["from"],
                    item["to"],
                    hours=list(item["hours"]) if item["field"] == "lighting" else None,
                    visits=_clamp_delta(float(delta["visits"])),
                    kwh=_clamp_delta(float(delta["kwh"])),
                    confidence=item.get("confidence"),
                    reason=_reason(str(item.get("reason", ""))) or None,
                )
            )
        except (KeyError, TypeError, ValueError) as e:
            errors.append(f"{type(e).__name__}: {e}")
    return suggestions, errors


REPAIR_PROMPT = (
    "Your answer failed validation: {error}. Reply again with only the corrected JSON object "
    "for the same schema; keep the suggestions you meant, fix only what failed."
)
_ITEM_SCHEMA: dict = prompts.STORE_SCHEMA["properties"]["suggestions"]["items"]


def output_errors(data: object) -> list[str]:
    """Where a store agent's structured output breaks STORE_SCHEMA ([] when it is valid)."""
    if not isinstance(data, dict):
        return ["expected a JSON object"]
    items = data.get("suggestions")
    if not isinstance(items, list):
        return ["suggestions: expected an array"]
    errors = []
    required, props = set(_ITEM_SCHEMA["required"]), _ITEM_SCHEMA["properties"]
    for i, item in enumerate(items):
        where = f"suggestions[{i}]"
        if not isinstance(item, dict):
            errors.append(f"{where}: expected an object")
            continue
        if missing := sorted(required - set(item)):
            errors.append(f"{where}: missing {', '.join(missing)}")
        if extra := sorted(set(item) - set(props)):
            errors.append(f"{where}: unexpected {', '.join(extra)}")
        for key in ("field", "confidence"):
            if key in item and item[key] not in props[key]["enum"]:
                errors.append(f"{where}.{key}: {item[key]!r} is not one of {props[key]['enum']}")
        delta = item.get("expectedDelta")
        if "expectedDelta" in item and not (
            isinstance(delta, dict)
            and all(isinstance(delta.get(k), int | float) for k in ("visits", "kwh"))
        ):
            errors.append(f"{where}.expectedDelta: needs numbers visits and kwh")
    return errors


def validate_output(store_id: str, text: str) -> tuple[list[Suggestion], str | None]:
    """The store's suggestions from its raw answer, or the validation error to repair."""
    if not text.strip():
        return [], "empty response"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return [], f"invalid JSON: {e}"
    errors = output_errors(data)
    if not errors:
        suggestions, errors = parse_store_output(store_id, data)
        if not errors:
            return suggestions, None
    return [], "; ".join(errors)[:600]


def _text(message) -> str:
    return next((b.text for b in message.content if getattr(b, "type", "") == "text"), "")


@dataclass
class _Round:
    """One round of store agents in progress: what each store ended with."""

    run: int
    session: str | None
    params: dict[str, dict]  # store id -> request params
    proposals: dict[str, list[Suggestion]]
    heuristic: dict[str, str]  # store id -> why it falls back to the heuristic


def _recover(event: str, rnd: _Round, sid: str, **fields) -> None:
    llm.record_recovery(event, agent=AGENT, run=rnd.run, session=rnd.session, storeId=sid, **fields)


def _ask_one(rnd: _Round, params: dict, sid: str):
    """One store agent as a plain Messages call (batch fallback, repair): budget pre-flight, the
    retry policy, ledger and log. Raises LLMError when Claude stays unavailable."""
    llm.preflight(rnd.session, params)
    client = llm.client()
    message = llm.call_with_retries(
        lambda: client.messages.create(**params),
        agent=AGENT,
        run=rnd.run,
        session=rnd.session,
    )
    usage = llm.Usage.from_api(message.usage)
    llm.record_usage(AGENT, params["model"], usage, run=rnd.run, session=rnd.session)
    llm.log_event(
        rnd.run,
        {
            "agent": AGENT,
            "type": "response",
            "storeId": sid,
            "stopReason": message.stop_reason,
            "text": _text(message),
            "usage": asdict(usage),
        },
    )
    return message


def _accept(rnd: _Round, sid: str, message) -> None:
    """Take one store's answer: a refusal or truncation falls back to the heuristic; output that
    fails validation gets one repair re-ask with the error, then the shop is skipped this round
    (no proposals rather than a guess). Isolated per shop: nothing here touches another store."""
    if message.stop_reason in ("refusal", "max_tokens"):
        rnd.heuristic[sid] = f"stop_reason={message.stop_reason}"
        _recover(
            "fallback", rnd, sid, to="heuristic", kind=message.stop_reason, outcome="heuristic"
        )
        return
    text = _text(message)
    suggestions, error = validate_output(sid, text)
    if error is None:
        rnd.proposals[sid] = suggestions
        return
    _recover("repair", rnd, sid, kind="invalid_output", attempt=1, error=error, outcome="re-ask")
    params = rnd.params[sid]
    repair = {
        **params,
        "messages": [
            *params["messages"],
            {"role": "assistant", "content": text},
            {"role": "user", "content": REPAIR_PROMPT.format(error=error)},
        ],
    }
    try:
        repaired = _ask_one(rnd, repair, sid)
        suggestions, error = validate_output(sid, _text(repaired))
    except llm.BudgetExceeded:
        raise
    except llm.LLMError as e:
        error = f"repair call failed: {e}"
    if error is None:
        rnd.proposals[sid] = suggestions
        return
    rnd.proposals[sid] = []
    _recover("skip", rnd, sid, kind="invalid_output", error=error, outcome="no proposals")


def _batch_intent_path(run: int):
    return store.run_dir(run) / "store_batch.json"


def _submit_or_reattach(rnd: _Round, client, requests: list[dict]) -> str:
    """The batch for these requests: the one submitted before a crash or kill (its id was
    recorded right after submitting, so a resume re-attaches instead of paying twice), else a
    new one. Budget pre-flight covers the whole batch."""
    digest = cache.stable_hash(requests)
    intent = store.read_json(_batch_intent_path(rnd.run)) or {}
    if intent.get("digest") == digest and intent.get("session") == rnd.session:
        llm.log_event(
            rnd.run, {"agent": AGENT, "type": "batch_reattached", "batchId": intent["batchId"]}
        )
        return intent["batchId"]
    estimate = sum(llm.estimate_usd(r["params"], batch=True) for r in requests)
    llm.check_budget(rnd.session, estimate)
    batch = llm.call_with_retries(
        lambda: client.messages.batches.create(requests=requests),
        agent=AGENT,
        run=rnd.run,
        session=rnd.session,
        what="batches.create",
    )
    store.write_json(
        _batch_intent_path(rnd.run),
        {"batchId": batch.id, "session": rnd.session, "digest": digest, "at": store.now_iso()},
    )
    llm.log_event(
        rnd.run,
        {"agent": AGENT, "type": "batch_created", "batchId": batch.id, "requests": len(requests)},
    )
    return batch.id


def _wait_for_batch(rnd: _Round, client, batch_id: str) -> bool:
    """Poll until the batch ends (True) or BATCH_TIMEOUT_SECONDS pass (False: cancelled, and
    the stores without a result go per-request)."""
    deadline = time.monotonic() + BATCH_TIMEOUT_SECONDS
    while True:
        batch = llm.call_with_retries(
            lambda: client.messages.batches.retrieve(batch_id),
            agent=AGENT,
            run=rnd.run,
            session=rnd.session,
            what="batches.retrieve",
        )
        if batch.processing_status == "ended":
            return True
        if time.monotonic() >= deadline:
            try:
                client.messages.batches.cancel(batch_id)
            except Exception as e:  # best effort: the per-request fallback runs either way
                llm.log_event(
                    rnd.run, {"agent": AGENT, "type": "batch_cancel_error", "error": repr(e)}
                )
            llm.record_recovery(
                "batch_timeout",
                agent=AGENT,
                run=rnd.run,
                session=rnd.session,
                batchId=batch_id,
                kind="batch_stuck",
                wait=BATCH_TIMEOUT_SECONDS,
                outcome="per-request for the missing stores",
            )
            return False
        time.sleep(BATCH_POLL_SECONDS)


def _batch_results(rnd: _Round, client, requests: list[dict]) -> tuple[list, str]:
    """The batch's results and why a store without one is missing. Never raises LLMError: a
    batch that cannot be created, polled or read leaves every store to the per-request path."""
    try:
        batch_id = _submit_or_reattach(rnd, client, requests)
        if not _wait_for_batch(rnd, client, batch_id):
            return [], "batch_timeout"
        results = llm.call_with_retries(
            lambda: list(client.messages.batches.results(batch_id)),
            agent=AGENT,
            run=rnd.run,
            session=rnd.session,
            what="batches.results",
        )
        return results, "batch_ended_without_result"
    except llm.BudgetExceeded:
        raise
    except llm.LLMError as e:
        llm.log_event(rnd.run, {"agent": AGENT, "type": "batch_error", "error": str(e)})
        return [], "batch_error"


def _propose_with_batch(
    run: int, briefs: dict[str, StoreBrief], session: str | None, config: TrainingConfig
) -> tuple[dict[str, list[Suggestion]], dict[str, str]]:
    """All store agents in one Message Batch. Returns proposals and the stores that fall back to
    the heuristic (with why).

    Recovery, per store: a batch that cannot be created, times out ("in_progress" too long) or
    whose results expired, and every result that errored, expired or was cancelled, is asked again
    as a plain request; one that still fails gets the heuristic. Bad output gets one repair
    (_accept). Once the circuit breaker opens every remaining store gets the heuristic at once.
    """
    client = llm.client()
    system = llm.system_blocks(prompts.city_context(config))
    ids: dict[str, str] = {}
    requests = []
    rnd = _Round(run=run, session=session, params={}, proposals={}, heuristic={})
    for index, (sid, brief) in enumerate(briefs.items()):
        custom_id = _custom_id(index, sid)
        ids[custom_id] = sid
        params = _batch_params(brief, system, config.maxChangesPerStore)
        rnd.params[sid] = params
        requests.append({"custom_id": custom_id, "params": params})
        llm.log_event(
            run,
            {
                "agent": AGENT,
                "type": "batch_request",
                "storeId": sid,
                "customId": custom_id,
                "params": params,
            },
        )
    results, why_missing = _batch_results(rnd, client, requests)
    answered: dict[str, object] = {}
    missing: dict[str, str] = {}  # store id -> why it has no batch answer
    for result in results:
        found = ids.get(result.custom_id)
        if found is None:
            continue
        sid = found
        outcome = result.result
        if outcome.type != "succeeded":
            missing[sid] = f"batch_{outcome.type}"
            continue
        message = outcome.message
        usage = llm.Usage.from_api(message.usage)
        llm.record_usage(
            AGENT, settings.STORE_AGENT_MODEL, usage, run=run, batch=True, session=session
        )
        llm.log_event(
            run,
            {
                "agent": AGENT,
                "type": "batch_response",
                "storeId": sid,
                "stopReason": message.stop_reason,
                "text": _text(message),
                "usage": asdict(usage),
            },
        )
        answered[sid] = message
    for sid in briefs:
        if sid not in answered:
            missing.setdefault(sid, why_missing)
    for sid in briefs:
        if sid not in missing:
            continue
        why = missing[sid]
        if llm.breaker_open():
            rnd.heuristic[sid] = f"{why}; circuit open"
            _recover("fallback", rnd, sid, to="heuristic", kind="circuit_open", outcome="heuristic")
            continue
        _recover("fallback", rnd, sid, to="request", kind=why, outcome="asking per request")
        try:
            answered[sid] = _ask_one(rnd, rnd.params[sid], sid)
        except llm.BudgetExceeded:
            raise
        except llm.LLMError as e:
            rnd.heuristic[sid] = f"{why}; request failed: {e}"
            kind = "circuit_open" if isinstance(e, llm.CircuitOpen) else "llm_unavailable"
            _recover("fallback", rnd, sid, to="heuristic", kind=kind, outcome="heuristic")
    for sid in briefs:
        if sid in answered:
            _accept(rnd, sid, answered[sid])
    return rnd.proposals, rnd.heuristic


# --- entry point ----------------------------------------------------------------------------


def _mode(requested: str, run: int) -> str:
    """The mode for TrainingConfig.storeAgents: "batch" (needs credentials) or "heuristic"."""
    if requested == "heuristic":
        return "heuristic"
    if llm.available():
        return "batch"
    if requested == "batch":
        llm.log_event(
            run, {"agent": AGENT, "type": "fallback", "requested": "batch", "reason": "offline"}
        )
    return "heuristic"


def propose_all(
    run: int, *, session: str | None = None, config: TrainingConfig | None = None
) -> list[Suggestion]:
    """Every participating non-club store's agent proposes 0-2 changes on `run`.

    `config` (default: TrainingConfig() from settings) sets the participating stores, levers,
    change cap, objective and store-agent mode. Writes runs/{run}/suggestions.json (rule-checked)
    and returns the participating stores' proposals, in map order. With storeIds (e.g. a one-shop
    session) their suggestions replace theirs in suggestions.json and every other store's are
    kept.
    """
    config = config or TrainingConfig()
    map_data = store.load_map()
    files = rundata.RunFiles.load(run)
    energy = store.load_energy()
    decisions = store.load_decisions()
    advised = [
        ms
        for ms in rundata.advised_stores(map_data)
        if ms.id in files.config.stores
        and ms.id in files.stores
        and ms.id in files.stats
        and config.takes_part(ms.id)
    ]
    histories = store_histories(run, [ms.id for ms in advised])
    briefs = {
        ms.id: build_brief(
            files,
            ms,
            map_data,
            energy,
            decisions,
            histories[ms.id],
            objective=per_store(config.objective),
        )
        for ms in advised
    }
    mode = _mode(config.storeAgents, run)
    if mode == "batch":
        proposals, fallbacks = _propose_with_batch(run, briefs, session, config)
    else:
        proposals, fallbacks = {}, {sid: "offline" for sid in briefs}
    for sid in fallbacks:
        proposals[sid] = heuristic_proposals(briefs[sid], map_data, config)

    final: list[Suggestion] = []
    for ms in advised:
        result = check_changes(
            {ms.id: files.config.stores[ms.id]},
            proposals.get(ms.id, []),
            map_data,
            training=config,
        )
        log_rejections(run, result.rejections, agent=AGENT)
        final.extend(result.accepted)
    if config.storeIds is None:
        rundata.save_suggestions(run, final)
    else:
        kept = [s for s in rundata.load_suggestions(run) if not config.takes_part(s.storeId)]
        rundata.save_suggestions(run, kept + final)
    llm.log_event(
        run,
        {
            "agent": AGENT,
            "type": "proposals",
            "mode": mode,
            "stores": len(briefs),
            "suggestions": len(final),
            "heuristicStores": sorted(fallbacks),
        },
    )
    return final
