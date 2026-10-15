"""Prompts and output schemas for the Claude agents (store owners, analyst, report writer).

Every system prompt here is stable text with no run data in it, so the Claude API prompt cache can
reuse it across stores and iterations: stable parts first, the store's or run's data last.
"""

from __future__ import annotations

import json

from backend import settings

_RULES = f"""Hard rules (checked in code; a proposal that breaks one is rejected and logged):
- Hours move in 30-minute steps ("HH:MM", e.g. "23:30"). A close at or before the open wraps past
  midnight (open 11:00, close 03:00 = open until 3am).
- The opening window must stay inside the store's licensed hours.
- Stay open at least 60 minutes and close for at least 30 minutes every day (never 24 hours).
- At most {settings.MAX_CHANGES_PER_STORE_PER_WEEK} changes per store per week.
- Lighting levels are "off", "low" or "high", set per clock hour 0-23.
- "from" must equal the store's current value (for lighting: the current level at every hour
  listed).
- Never propose a store config that was already simulated; the config history shows past ones.
- Clubs are fixed anchors and never change."""

CITY_CONTEXT = f"""You advise independent store owners in Shoreditch, London (about 500 m x 500 m
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
visitors who came back on another day). The area objective is {settings.OBJECTIVE}; good advice
raises visits per kWh: more visits for the energy, or the same visits for less energy.

{_RULES}

What to return: 0, 1 or 2 changes, best first. Propose nothing when no change is clearly better.
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


def store_prompt(store_data: dict) -> str:
    """The per-store user message: the store's own data last, after the cached city context."""
    return (
        "Your store's data follows (hourly arrays have 24 values, index = clock hour, averaged "
        "per day over the 14 days). Propose 0-2 changes.\n\n"
        + json.dumps(store_data, sort_keys=True, separators=(",", ":"))
    )


_ANALYST_CORE = f"""You are the analyst for Smart City Sim, a long-running agent that improves
opening hours and lighting for independent stores in Shoreditch by running simulation experiments.
Each experiment is one 14-day simulation on the same seed, so differences come from the changes,
not from noise.

Objective: raise the area's {settings.OBJECTIVE} (clubs excluded). Training stops when the gain
over the best run stays below {settings.THRESHOLD:.0%} for {settings.PATIENCE} runs in a row, at
the run limit, or when the spend cap is reached.

Every iteration, a team of store agents (one per store, each seeing only its own data) proposes up
to 2 changes per store on the current best run. You choose which to test. Changes always apply on
top of the best run's configuration.

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
- Test at most {settings.MAX_STORES_PER_ITERATION} stores per experiment, at most
  {settings.MAX_CHANGES_PER_STORE_PER_WEEK} changes each, so effects stay attributable.
- Prefer store-agent proposals with the largest expected gain; check a store's stats when a
  proposal looks doubtful. Do not repeat a configuration that was already simulated.
- Store estimates are store-level. Longer hours partly pull visitors from other stores (in
  measured runs only about half of the extra visits were new to the area) while the extra energy
  is all new; energy savings carry no such discount. expectedAreaGain already allows for this.
- Learn from the notebook: a change that lowered the objective is not worth retrying as-is.

{_RULES}
"""

ANALYST_SYSTEM = (
    _ANALYST_CORE
    + """
Finish every iteration with exactly one accepted run_sim call. If no experiment is worth running,
reply with the single word STOP and call no tool.
"""
)

ANALYST_SYSTEM_MANAGED = (
    _ANALYST_CORE
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


def managed_outcome_description(max_runs: int) -> str:
    return (
        f"Raise the area's {settings.OBJECTIVE} for Shoreditch store owners by running sim "
        "experiments with run_sim, chosen from the store agents' proposals. Stop when two "
        f"consecutive experiments gain less than {settings.THRESHOLD:.0%} over the best run, or "
        f"after {max_runs} runs in total. End with a short message naming the best run and its "
        f"{settings.OBJECTIVE}."
    )


def managed_rubric(max_runs: int) -> str:
    # Starter rubric: tune the criteria once real sessions have been graded.
    return f"""# Analyst session rubric (starter)
- Every experiment went through run_sim and was accepted by the hard rules.
- Every run_sim call carried a one-line hypothesis naming the change and the expected effect.
- No experiment repeated a configuration that had already been simulated.
- No experiment changed more than {settings.MAX_STORES_PER_ITERATION} stores or more than
  {settings.MAX_CHANGES_PER_STORE_PER_WEEK} changes per store.
- The session stopped only after two consecutive runs gained less than {settings.THRESHOLD:.0%}
  over the best run, or after {max_runs} runs.
- The final message names the best run id and its {settings.OBJECTIVE}.
"""


REPORT_SYSTEM = """You write the short "why" paragraph of a weekly report for an independent store
owner in Shoreditch. Use plain sentences, at most 80 words, no headings or lists. Explain what to
change and why, citing the documents you are given for every number you use. Say plainly that the
figures come from a simulation and are not guaranteed. Never mention other stores."""


def report_prompt(facts: dict) -> str:
    return "Write the paragraph for this store. Facts (JSON):\n\n" + json.dumps(
        facts, sort_keys=True, separators=(",", ":")
    )
