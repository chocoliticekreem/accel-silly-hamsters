"""A stand-in for the Anthropic client: the agents' LLM code paths, offline and free.

FAKE_LLM=1 makes llm.available() true and llm.client() return FakeClient, so a training session
runs the online paths end to end (Message Batches for the store agents, the Messages tool loop
for the analyst, cited report wording) without a key or a cent. It answers like a sensible
model would: a store agent proposes what the heuristic would for that store (rebuilt from the
store's own prompt data, so the data firewall holds), the analyst commits the proposals with the
highest expected area gain, and report wording is one plain sentence. Usage is reported as
fixed token counts, so the cost ledger and the budget logic see realistic numbers.

The chaos faults that need a model's answer come in here (backend/chaos.py): bad_json, refusal
and empty corrupt an answer; batch_stuck keeps a batch "in_progress"; batch_partial errors or
expires one result. Transport faults (429, 529, timeouts...) are raised by
llm.call_with_retries before any client is called, so they hit the real client the same way.
"""

from __future__ import annotations

import itertools
import json
from types import SimpleNamespace
from typing import Any

from backend import chaos, settings, store
from backend.agents import store_owner
from backend.agents.store_owner import StoreBrief
from backend.contract import StoreKpis
from backend.schemas import StoreConfig, StoreStats, TrainingConfig

USAGE = {"input_tokens": 1800, "output_tokens": 350, "cache_read_input_tokens": 4000}


def _usage() -> SimpleNamespace:
    return SimpleNamespace(**USAGE, cache_creation_input_tokens=0, server_tool_use=None)


def _message(text: str, stop_reason: str = "end_turn") -> SimpleNamespace:
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text, citations=None)],
        stop_reason=stop_reason,
        usage=_usage(),
        _request_id="req_fake",
    )


def _corrupt(text: str) -> tuple[str, str]:
    """(text, stop_reason) after the answer-level chaos faults."""
    if chaos.fires("refusal"):
        return "", "refusal"
    if chaos.fires("empty"):
        return "", "end_turn"
    if chaos.fires("bad_json"):
        return text[: max(1, len(text) // 2)], "end_turn"
    return text, "end_turn"


# --- store agents --------------------------------------------------------------------------


def _store_data(params: dict) -> dict:
    content = params["messages"][0]["content"]
    return json.loads(content.split("\n\n", 1)[1])


def _brief(data: dict) -> StoreBrief:
    """The StoreBrief behind a store agent's prompt (everything it may see, nothing more)."""
    s, per_hour, visitors = data["store"], data["perHour"], data["visitors"]
    area = data["publicArea"]
    stats = StoreStats(
        visitsByHourWeekday=per_hour["visitsWeekday"],
        visitsByHourWeekend=per_hour["visitsWeekend"],
        footfallNearbyByHour=per_hour["footfallNearby"],
        foundClosedByHour=per_hour["foundClosed"],
        kwhByHour=per_hour["kwh"],
        uniqueVisitors=visitors["unique"],
        repeatVisitors=visitors["repeat"],
        visitsByPersona=visitors["byPersona"],
        energyCostGbp=data["energyCostGbp14Days"],
        co2Kg=0.0,
    )
    return StoreBrief(
        run=0,
        store_id=s["id"],
        name=s["name"],
        type=s["type"],
        floor_area=s["floorAreaM2"],
        licence=(s["licensedHours"]["open"], s["licensedHours"]["close"]),
        config=StoreConfig.model_validate(data["currentConfig"]),
        kpis=StoreKpis.model_validate(data["kpis14Days"]),
        visits_by_hour=per_hour["visits"],
        stats=stats,
        history=data["configHistory"],
        decisions=[],
        area_footfall_by_hour=area["footfallByHour"],
        open_kwh_per_m2=area["openKwhPerM2PerHour"],
        standby_kwh_per_m2=area["standbyKwhPerM2PerHour"],
        lighting_kw=area["lightingKw"],
        price_gbp_per_kwh=area["priceGbpPerKwh"],
        objective=settings.OBJECTIVE,
    )


def store_answer(params: dict) -> str:
    """What a sensible store agent says: the heuristic's proposals for its own store."""
    brief = _brief(_store_data(params))
    suggestions = store_owner.heuristic_proposals(brief, store.load_map(), TrainingConfig())
    return json.dumps(
        {
            "suggestions": [
                {
                    "field": s.field,
                    "hours": list(s.hours or []),
                    "from": s.from_,
                    "to": s.to,
                    "expectedDelta": {"visits": s.expectedDelta.visits, "kwh": s.expectedDelta.kwh},
                    "confidence": s.confidence or "medium",
                    "reason": s.reason or "Measured in the last run.",
                }
                for s in suggestions
            ]
        }
    )


class FakeBatches:
    def __init__(self) -> None:
        self.batches: dict[str, list[dict]] = {}
        self.stuck: set[str] = set()
        self._ids = itertools.count(1)

    def create(self, *, requests: list[dict]) -> SimpleNamespace:
        batch_id = f"msgbatch_fake_{next(self._ids)}"
        self.batches[batch_id] = list(requests)
        if chaos.fires("batch_stuck"):
            self.stuck.add(batch_id)
        return SimpleNamespace(id=batch_id, processing_status="in_progress")

    def retrieve(self, batch_id: str) -> SimpleNamespace:
        status = "in_progress" if batch_id in self.stuck else "ended"
        return SimpleNamespace(id=batch_id, processing_status=status)

    def cancel(self, batch_id: str) -> SimpleNamespace:
        return SimpleNamespace(id=batch_id, processing_status="canceling")

    def results(self, batch_id: str):
        for request in self.batches.get(batch_id, []):
            if chaos.fires("batch_partial"):
                kind = chaos.current().rng.choice(["errored", "expired"])
                yield SimpleNamespace(
                    custom_id=request["custom_id"], result=SimpleNamespace(type=kind)
                )
                continue
            text, stop = _corrupt(store_answer(request["params"]))
            yield SimpleNamespace(
                custom_id=request["custom_id"],
                result=SimpleNamespace(type="succeeded", message=_message(text, stop)),
            )


# --- analyst and report wording (Messages API) --------------------------------------------------


def _tool_use(tool_id: str, name: str, tool_input: dict) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=tool_id, name=name, input=tool_input)


def analyst_answer(kwargs: dict) -> SimpleNamespace:
    """The analyst's next turn: run_sim with the best untried window of proposals (by expected
    area gain); after a rejected run_sim, the next window; out of windows, plain text (the
    training loop nudges once, then the heuristic decides)."""
    messages = kwargs["messages"]
    brief = json.loads(messages[0]["content"].split("\n\n", 1)[1])
    attempt = sum(1 for m in messages if m["role"] == "assistant")
    ranked = sorted(
        (p for p in brief["proposals"] if p["expectedAreaGain"] > 0),
        key=lambda p: (-p["expectedAreaGain"], p["storeId"]),
    )
    windows = [ranked[i : i + 2] for i in range(len(ranked))]
    if attempt >= len(windows) or attempt >= 4:
        text = "STOP" if not ranked else "I need to think about this more."
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            stop_reason="end_turn",
            usage=_usage(),
        )
    changes = [
        {
            "storeId": c["storeId"],
            "field": c["field"],
            "hours": list(c.get("hours") or []),
            "from": c["from"],
            "to": c["to"],
        }
        for p in windows[attempt]
        for c in p["changes"]
    ]
    names = " and ".join(p["store"] for p in windows[attempt])
    hypothesis = f"{names} should lift {brief['objective']} as their agents estimate"
    return SimpleNamespace(
        content=[_tool_use(f"toolu_fake_{attempt}", "run_sim", {"changes": changes,
                                                                  "hypothesis": hypothesis})],
        stop_reason="tool_use",
        usage=_usage(),
    )  # fmt: skip


class FakeMessages:
    def create(self, **kwargs: Any) -> SimpleNamespace:
        if kwargs.get("tools"):
            return analyst_answer(kwargs)
        content = kwargs["messages"][0]["content"]
        if isinstance(content, list):  # report wording: documents + the facts
            return _message(
                "Simulated advice: test the change for a week. Simulated, not guaranteed."
            )
        if len(kwargs["messages"]) > 1:  # a repair re-ask: answer properly this time
            return _message(store_answer({**kwargs, "messages": kwargs["messages"][:1]}))
        text, stop = _corrupt(store_answer(kwargs))
        return _message(text, stop)


class FakeClient:
    def __init__(self) -> None:
        messages = FakeMessages()
        self.messages = SimpleNamespace(create=messages.create, batches=FakeBatches())
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._beta_create))
        self.files = SimpleNamespace(upload=self._upload)
        self._messages = messages
        self._files = itertools.count(1)

    def _beta_create(self, **kwargs: Any) -> SimpleNamespace:
        kwargs.pop("betas", None)
        kwargs.pop("fallbacks", None)
        return self._messages.create(**kwargs)

    def _upload(self, *, file) -> SimpleNamespace:
        return SimpleNamespace(id=f"file_fake_{next(self._files)}")
