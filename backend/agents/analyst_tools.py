"""The simulation exposed as tools for the LLM analyst (Messages API and Managed Agents backends).

  get_kpis(run)                  area KPIs and every store's KPIs for a run
  get_store_stats(run, storeId)  one store's config, hourly detail and licence
  propose_config(changes)        dry run: hard rules + tried-config cache + expected gain
  run_sim(changes, hypothesis)   commit the experiment; the training loop runs it

Both proposing tools go through agents.rules, so the model can never get a change past the hard
rules. run_sim does not simulate inside the tool call: it hands the accepted changes back to the
training loop, which owns execution, scoring, the notebook and checkpoints.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from backend import cache, settings
from backend.agents import prompts, rundata
from backend.agents.changes import change_signature, make_suggestion
from backend.agents.experiment import AnalystContext, Choice, expected_city_gain
from backend.agents.rules import RuleResult, check_changes, licensed_window, log_rejections
from backend.agents.wording import change_label, clamp_words
from backend.contract import Suggestion, dump

AGENT = "analyst"
HYPOTHESIS_WORDS = 25

_DESCRIPTIONS = {
    "get_kpis": (
        "Area KPIs and each store's visits, kWh and return rate for one finished run. Call it to "
        "compare runs or to see how big a store is before trusting its proposal."
    ),
    "get_store_stats": (
        "One store's config, licence, hourly visits, footfall nearby, found-closed demand and "
        "energy for a run. Call it when a proposal looks doubtful or you want your own idea."
    ),
    "propose_config": (
        "Dry run: check a set of changes against the hard rules and the cache of simulated "
        "configs, and get the expected area gain. Runs nothing. Use it before run_sim when unsure."
    ),
    "run_sim": (
        "Run the experiment: one 14-day simulation of the best run's config with these changes, "
        "same seed. Ends your turn for this iteration; the measured result comes back next. Call "
        "it exactly once per iteration with a one-line hypothesis."
    ),
}

_SCHEMAS: dict[str, dict] = {
    "get_kpis": {
        "type": "object",
        "properties": {"run": {"type": "integer"}},
        "required": ["run"],
        "additionalProperties": False,
    },
    "get_store_stats": {
        "type": "object",
        "properties": {"run": {"type": "integer"}, "storeId": {"type": "string"}},
        "required": ["run", "storeId"],
        "additionalProperties": False,
    },
    "propose_config": {
        "type": "object",
        "properties": {"changes": {"type": "array", "items": prompts.TOOL_CHANGE_ITEM}},
        "required": ["changes"],
        "additionalProperties": False,
    },
    "run_sim": {
        "type": "object",
        "properties": {
            "changes": {"type": "array", "items": prompts.TOOL_CHANGE_ITEM},
            "hypothesis": {"type": "string"},
        },
        "required": ["changes", "hypothesis"],
        "additionalProperties": False,
    },
}

# Messages API tool definitions (strict: schema-valid inputs guaranteed).
MESSAGES_TOOLS: list[dict] = [
    {"name": name, "description": _DESCRIPTIONS[name], "input_schema": schema, "strict": True}
    for name, schema in _SCHEMAS.items()
]

# Managed Agents custom tool definitions (type "custom", executed by this process).
MANAGED_TOOLS: list[dict] = [
    {"type": "custom", "name": name, "description": _DESCRIPTIONS[name], "input_schema": schema}
    for name, schema in _SCHEMAS.items()
]


@dataclass
class ToolResult:
    text: str
    is_error: bool = False
    committed: Choice | None = None  # set when run_sim accepted the experiment


def _json(data: object) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


class AnalystTools:
    """Tool handlers bound to one iteration's context."""

    def __init__(self, ctx: AnalystContext) -> None:
        self.ctx = ctx
        self._files: dict[int, rundata.RunFiles] = {}

    def _run_files(self, run: int) -> rundata.RunFiles:
        if run not in self._files:
            self._files[run] = rundata.RunFiles.load(run)
        return self._files[run]

    def dispatch(self, name: str, tool_input: dict) -> ToolResult:
        try:
            if name == "get_kpis":
                return self.get_kpis(int(tool_input["run"]))
            if name == "get_store_stats":
                return self.get_store_stats(int(tool_input["run"]), str(tool_input["storeId"]))
            if name == "propose_config":
                return self.propose_config(list(tool_input["changes"]))
            if name == "run_sim":
                return self.run_sim(list(tool_input["changes"]), str(tool_input["hypothesis"]))
        except (KeyError, TypeError, ValueError) as e:
            return ToolResult(f"invalid input for {name}: {e}", is_error=True)
        except FileNotFoundError as e:
            return ToolResult(f"no such run file: {e}", is_error=True)
        return ToolResult(f"unknown tool {name!r}", is_error=True)

    def get_kpis(self, run: int) -> ToolResult:
        files = self._run_files(run)
        names = rundata.store_names(self.ctx.map_data)
        stores = {
            ms.id: {
                "name": names[ms.id],
                "type": ms.type,
                **files.stores[ms.id].kpis.model_dump(mode="json"),
            }
            for ms in rundata.advised_stores(self.ctx.map_data)
            if ms.id in files.stores
        }
        summary = files.summary
        return ToolResult(
            _json(
                {
                    "run": run,
                    "objective": summary.objective,
                    "objectiveValue": summary.objectiveValue,
                    "kpis": summary.kpis.model_dump(mode="json"),
                    "peakKw": summary.peakKw,
                    "co2Kg": summary.co2Kg,
                    "stores": stores,
                }
            )
        )

    def get_store_stats(self, run: int, store_id: str) -> ToolResult:
        files = self._run_files(run)
        ms = next((s for s in self.ctx.map_data.stores if s.id == store_id), None)
        if ms is None or store_id not in files.stores:
            return ToolResult(f"unknown store {store_id!r} in run {run}", is_error=True)
        licence = None if ms.type == "club" else licensed_window(ms)
        return ToolResult(
            _json(
                {
                    "run": run,
                    "storeId": store_id,
                    "name": ms.name,
                    "type": ms.type,
                    "licensedHours": licence,
                    "config": files.config.stores[store_id].model_dump(mode="json"),
                    "kpis": files.stores[store_id].kpis.model_dump(mode="json"),
                    "visitsByHour": files.stores[store_id].visitsByHour,
                    "stats": files.stats[store_id].model_dump(mode="json")
                    if store_id in files.stats
                    else None,
                }
            )
        )

    def to_suggestions(self, changes: list[dict]) -> list[Suggestion]:
        """Tool changes as Suggestions, carrying a store agent's estimates when they match."""
        known = {change_signature(p): p for p in self.ctx.proposals}
        out = []
        for change in changes:
            hours = list(change.get("hours") or []) if change["field"] == "lighting" else None
            draft = make_suggestion(
                str(change["storeId"]),
                str(change["field"]),
                str(change["from"]),
                str(change["to"]),
                hours=hours,
                visits=0.0,
                kwh=0.0,
                confidence="low",
                reason="Analyst experiment",
            )
            out.append(known.get(change_signature(draft), draft))
        return out

    def _validate(self, changes: list[dict]) -> tuple[RuleResult, dict]:
        suggestions = self.to_suggestions(changes)
        result = check_changes(self.ctx.base_configs, suggestions, self.ctx.map_data)
        log_rejections(self.ctx.best_run, result.rejections, agent=AGENT)
        stores = {s.storeId for s in result.accepted}
        problems = [f"{change_label(r.suggestion)}: {r.reason}" for r in result.rejections]
        if not suggestions:
            problems.append("no changes given")
        if len(stores) > settings.MAX_STORES_PER_ITERATION:
            problems.append(
                f"{len(stores)} stores changed; at most {settings.MAX_STORES_PER_ITERATION} per "
                "experiment"
            )
        cached = None
        if result.accepted and not result.rejections:
            cached = cache.run_lookup(cache.run_key(result.configs, self.ctx.seed))
            if cached is not None:
                problems.append(f"this exact config was already simulated as run {cached}")
        report = {
            "accepted": [dump(s) for s in result.accepted],
            "rejected": [r.to_log() for r in result.rejections],
            "problems": problems,
            "expectedAreaGain": round(
                expected_city_gain(
                    result.accepted,
                    self._run_files(self.ctx.best_run),
                    self.ctx.objective,
                    self.ctx.map_data,
                ),
                5,
            ),
        }
        return result, report

    def propose_config(self, changes: list[dict]) -> ToolResult:
        _, report = self._validate(changes)
        report["ok"] = not report["problems"]
        return ToolResult(_json(report), is_error=False)

    def run_sim(self, changes: list[dict], hypothesis: str) -> ToolResult:
        result, report = self._validate(changes)
        if report["problems"]:
            report["ok"] = False
            return ToolResult(_json(report), is_error=True)
        choice = Choice(
            changes=result.accepted,
            hypothesis=clamp_words(hypothesis, HYPOTHESIS_WORDS) or "Analyst experiment",
            expected_gain=report["expectedAreaGain"],
        )
        return ToolResult(_json({"ok": True, "queued": True, **report}), committed=choice)
