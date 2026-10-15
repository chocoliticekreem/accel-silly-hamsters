"""Build every processed file in dependency order, then flag fallbacks and calibrate.

map -> personas, energy (independent) -> demand, calibration (need the map's entry/store ids).
Every step has hand-written defaults, so this never blocks on a source; the report written to
data/processed/pipeline_report.json says which steps fell back and why.
"""

from __future__ import annotations

import importlib
import logging
from typing import Any

from backend import cache, settings
from backend.store import now_iso, write_json

log = logging.getLogger(__name__)

STEPS: list[tuple[str, str, str]] = [
    # (step name, module, processed file)
    ("map", "backend.pipeline.osm_map", "map.json"),
    ("personas", "backend.pipeline.personas", "personas.json"),
    ("energy", "backend.pipeline.energy", "energy.json"),
    ("demand", "backend.pipeline.demand", "demand.json"),
    ("calibration", "backend.pipeline.calibration_data", "calibration.json"),
]


def _describe(name: str, filename: str, model: Any) -> dict:
    sources = getattr(model, "sources", []) or []
    fallback = getattr(model, "fallback", None)
    if fallback is None:  # map.json is a contract model without a fallback flag
        fallback = any("fallback" in s.label.lower() for s in sources)
    return {
        "step": name,
        "file": filename,
        "fallback": bool(fallback),
        "sources": [s.model_dump(mode="json") for s in sources],
        "notes": list(getattr(model, "notes", []) or []),
    }


def run(*, refresh: bool = False, only: str | None = None, calibrate: bool = True) -> dict:
    cache.set_policy(refresh=refresh)
    steps = []
    for name, module_name, filename in STEPS:
        if only not in (None, "all", name):
            continue
        module = importlib.import_module(module_name)
        model = module.build(refresh=refresh)
        steps.append(_describe(name, filename, model))
        log.info("pipeline %s: %s", name, "FALLBACK" if steps[-1]["fallback"] else "ok")
    report: dict[str, Any] = {
        "at": now_iso(),
        "steps": steps,
        "fallbacks": [s["step"] for s in steps if s["fallback"]],
        "cacheHitRates": cache.hit_rates(),
    }
    if calibrate and only in (None, "all"):
        from backend.sim import calibrate as calibration

        report["calibration"] = calibration.run()
    write_json(settings.PROCESSED_DIR / "pipeline_report.json", report)
    return report
