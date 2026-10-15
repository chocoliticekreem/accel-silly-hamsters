"""Prompts and output schemas for the Claude agents (store owners, analyst, report writer).

Every system prompt here is stable text with no run data in it, so the Claude API prompt cache can
reuse it across stores and iterations: stable parts first, the store's or run's data last. The
training prompts are built from the session's TrainingConfig (objective, threshold, levers,
stores, limits), so the agents are told the same limits the code enforces.
"""

from __future__ import annotations

import json

from backend.schemas import TrainingConfig

# What "better" means for each TrainingConfig.objective, in words for the agents.
OBJECTIVE_GOALS = {
    "visitsPerKwh": (
        "visits per kWh: more visits for the energy, or the same visits for less energy"
    ),
    "visits": "visits: more people through the door; energy only matters as a cost",
    "netValueGbp": (
        "net value in GBP a week: the margin on visits (spend per visit x 30% gross margin) "
        "minus the energy bill"
    ),
}


def _pct(fraction: float) -> str:
    return f"{fraction * 100:g}%"


def _lever_rule(config: TrainingConfig) -> str:
    if config.levers.hours and config.levers.lighting:
        return ""
    only, off = ("opening hours", "lighting") if config.levers.hours else ("lighting", "hours")
    return f"\n- This session changes {only} only: a {off} change is rejected."


def _rules(config: TrainingConfig) -> str:
    return f"""Hard rules (checked in code; a proposal that breaks one is rejected and logged):
- Hours move in 30-minute steps ("HH:MM", e.g. "23:30"). A close at or before the open wraps past
  midnight (open 11:00, close 03:00 = open until 3am).
- The opening window must stay inside the store's licensed hours.
- Stay open at least 60 minutes and close for at least 30 minutes every day (never 24 hours).
- At most {config.maxChangesPerStore} changes per store per week.
- Lighting levels are "off", "low" or "high", set per clock hour 0-23.
- "from" must equal the store's current value (for lighting: the current level at every hour
  listed).
- Never propose a store config that was already simulated; the config history shows past ones.
- Clubs are fixed anchors and never change.{_lever_rule(config)}"""


def city_context(config: TrainingConfig) -> str:
    """The store agents' shared system prompt, cached across the stores of a batch."""
    return f"""You advise independent store owners in Shoreditch, London (about 500 m x 500 m
around Shoreditch High Street station). A simulation replays 14 days of the area: persona-driven
people arrive at stations and street edges, walk, shop, eat and go to clubs. Clubs close around
03:00 on club nights and their crowd spills out looking for late food and drink.

You are the agent for ONE store. You only see that store's own data plus public area data. You
never see another store's configuration or results, and your advice must never depend on what a
competitor does: advice is independent per store.

The owner controls two levers:
1. Opening hours: one daily open time and one close time.
2. Facade and window lighting per clock hour: off, low or high.

How the simulation treats them:
- People only visit while the store is open. "foundClosed" counts people per hour (average per
  day) who wanted this store but found it shut: unmet demand.
- Lighting attracts passers-by only while the store is open and only at night (about 17:00 to
  07:00). In daylight or while closed, lighting only costs energy.
- Store energy per hour = open share x floor area x open rate + closed share x floor area x
  standby rate + lighting load (kW for off/low/high). Lighting costs energy whenever it is on.

KPIs (the store's own, over the 14 days): visits, kWh, visits per kWh, return rate (share of
visitors who came back on another day). The area objective is {config.objective}; good advice
raises {OBJECTIVE_GOALS[config.objective]}.

{_rules(config)}

What to return: 0 to {config.maxChangesPerStore} changes, best first. Propose nothing when no
change is clearly better.
- field: "open", "close" or "lighting". hours: the clock hours for a lighting change, [] for
  open/close.
- from / to: "HH:MM" times for open/close; levels for lighting.
- expectedDelta: your estimate as fractions of the store's current 14-day totals
  (visits 0.18 = +18% visits, kwh -0.05 = -5% energy). Base it on the numbers you were given.
- confidence: "high" only for near-certain mechanical effects (e.g. lights off while shut),
  "medium" when the store's own data clearly shows the effect, otherwise "low".
- reason: at most 15 words, plain English for a busy owner, citing the number behind it.
"""


STORE_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string", "enum": ["open", "close", "lighting"]},
                    "hours": {"type": "array", "items": {"type": "integer"}},
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "expectedDelta": {
                        "type": "object",
                        "properties": {"visits": {"type": "number"}, "kwh": {"type": "number"}},
                        "required": ["visits", "kwh"],
                        "additionalProperties": False,
                    },
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                    "reason": {"type": "string"},
                },
                "required": [
                    "field",
                    "hours",
                    "from",
                    "to",
                    "expectedDelta",
                    "confidence",
                    "reason",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["suggestions"],
    "additionalProperties": False,
}


def store_prompt(store_data: dict, max_changes: int) -> str:
    """The per-store user message: the store's own data last, after the cached city context."""
    return (
        "Your store's data follows (hourly arrays have 24 values, index = clock hour, averaged "
        f"per day over the 14 days). Propose 0-{max_changes} changes.\n\n"
        + json.dumps(store_data, sort_keys=True, separators=(",", ":"))
    )


def _session_scope(config: TrainingConfig) -> str:
    if config.levers.hours and config.levers.lighting:
        levers = "opening hours and lighting"
    else:
        levers = "opening hours only" if config.levers.hours else "lighting only"
    stores = (
        "every non-club store"
        if config.storeIds is None
        else f"only {', '.join(config.storeIds)} (every other store is frozen)"
    )
    return f"This session changes {levers}, for {stores}."


def _diversity(config: TrainingConfig) -> str:
    """The analyst's both-levers bullet (see analyst.HeuristicAnalyst) and the blank line after
    it; only the blank line when the rule does not apply."""
    if not (config.levers.hours and config.levers.lighting) or config.maxStoresPerIteration < 2:
        return "\n"
    return (
        "- Lighting cuts are near-certain energy savings and top the ranking, so on their own\n"
        "  they fill every experiment. Put the best hours change in every experiment next to\n"
        "  them (alone for its store), so each run also measures one hours idea.\n\n"
    )


def _analyst_core(config: TrainingConfig) -> str:
    goal = OBJECTIVE_GOALS[config.objective]
    return f"""You are the analyst for Smart City Sim, a long-running agent that improves
opening hours and lighting for independent stores in Shoreditch by running simulation experiments.
Each experiment is one 14-day simulation on the same seed, so differences come from the changes,
not from noise.

Objective: raise the area's {config.objective} (clubs excluded): {goal}.
Training stops when the gain over the best run stays below {_pct(config.threshold)} for
{config.patience} runs in a row, after {config.maxRuns} runs, or when the spend cap is reached.
{_session_scope(config)}

Every iteration, a team of store agents (one per store, each seeing only its own data) proposes up
to {config.maxChangesPerStore} changes per store on the current best run. You choose which to test.
Changes always apply on top of the best run's configuration.

Tools:
- get_kpis(run): area KPIs and every store's KPIs for a run.
- get_store_stats(run, storeId): one store's config, hourly visits, footfall, found-closed demand
  and energy.
- propose_config(changes): dry run. Checks changes against the hard rules and the cache of
  simulated configs and returns the expected gain. Runs nothing.
- run_sim(changes, hypothesis): runs the experiment. This ends your turn for this iteration; the
  measured result comes back as the next result. Give a one-line hypothesis naming the change and
  the effect you expect, e.g. "Kebab Co open till 03:00 catches club spill-out: +3% visits/kWh".

How to choose:
- Test at most {config.maxStoresPerIteration} stores per experiment, at most
  {config.maxChangesPerStore} changes each, so effects stay attributable.
- Prefer store-agent proposals with the largest expected gain; check a store's stats when a
  proposal looks doubtful. Do not repeat a configuration that was already simulated.
- Store estimates are store-level. Longer hours partly pull visitors from other stores (in
  measured runs only about half of the extra visits were new to the area) while the extra energy
  is all new; energy savings carry no such discount. expectedAreaGain already allows for this.
- Learn from the notebook: a change that lowered the objective is not worth retrying as-is.
{_diversity(config)}{_rules(config)}
"""


def analyst_system(config: TrainingConfig) -> str:
    return (
        _analyst_core(config)
        + """
Finish every iteration with exactly one accepted run_sim call. If no experiment is worth running,
reply with the single word STOP and call no tool.
"""
    )


def analyst_system_managed(config: TrainingConfig) -> str:
    return (
        _analyst_core(config)
        + """
Your lab notebook is a memory store mounted under /mnt/memory/. The training loop appends one
measured line per run to runs.md there (do not edit runs.md); keep your own hypotheses and lessons
in other files in the same store. Call run_sim once per experiment and wait for its result before
choosing the next one.
"""
    )


TOOL_CHANGE_ITEM: dict = {
    "type": "object",
    "properties": {
        "storeId": {"type": "string"},
        "field": {"type": "string", "enum": ["open", "close", "lighting"]},
        "hours": {"type": "array", "items": {"type": "integer"}},
        "from": {"type": "string"},
        "to": {"type": "string"},
    },
    "required": ["storeId", "field", "hours", "from", "to"],
    "additionalProperties": False,
}


def analyst_iteration_prompt(brief: dict) -> str:
    """The per-iteration user message for the analyst: the run's numbers last."""
    return "Iteration brief (JSON). Choose the next experiment and call run_sim.\n\n" + json.dumps(
        brief, sort_keys=True, separators=(",", ":")
    )


def analyst_result_message(result: dict) -> str:
    return "Measured result of your last experiment (JSON):\n\n" + json.dumps(
        result, sort_keys=True, separators=(",", ":")
    )


def managed_outcome_description(config: TrainingConfig) -> str:
    return (
        f"Raise the area's {config.objective} for Shoreditch store owners by running sim "
        "experiments with run_sim, chosen from the store agents' proposals. Stop when "
        f"{config.patience} consecutive experiments gain less than {_pct(config.threshold)} over "
        f"the best run, or after {config.maxRuns} runs in total. End with a short message naming "
        f"the best run and its {config.objective}."
    )


def managed_rubric(config: TrainingConfig) -> str:
    # Starter rubric: tune the criteria once real sessions have been graded.
    return f"""# Analyst session rubric (starter)
- Every experiment went through run_sim and was accepted by the hard rules.
- Every run_sim call carried a one-line hypothesis naming the change and the expected effect.
- No experiment repeated a configuration that had already been simulated.
- No experiment changed more than {config.maxStoresPerIteration} stores or more than
  {config.maxChangesPerStore} changes per store.
- The session stopped only after {config.patience} consecutive runs gained less than
  {_pct(config.threshold)} over the best run, or after {config.maxRuns} runs.
- The final message names the best run id and its {config.objective}.
"""


REPORT_SYSTEM = """You write the short "why" paragraph of a weekly report for an independent store
owner in Shoreditch. Use plain sentences, at most 80 words, no headings or lists. Explain what to
change and why, citing the documents you are given for every number you use. Say plainly that the
figures come from a simulation and are not guaranteed. Never mention other stores."""


def report_prompt(facts: dict) -> str:
    return "Write the paragraph for this store. Facts (JSON):\n\n" + json.dumps(
        facts, sort_keys=True, separators=(",", ":")
    )
