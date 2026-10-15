"""Every cache layer in one place (docs/BACKEND_PROMPT.md, "Caching").

Layers and where they live:
  llm       full LLM responses for deterministic, non-training calls   data/cache/llm/{key}.json
  scrape    raw scraped data / API responses                           data/raw/{source}/{key}.json
  pipeline  processed outputs, rebuilt only when inputs change         data/processed/.hashes.json
  run       finished sim runs, keyed by configs + seed + sim version   runs/cache.json
            + the processed files the run was simulated on
  prompt    Claude API prompt caching: always on, handled in llm.py (it never changes outputs)

Policy:
  fresh=True    (train --fresh) never read the llm or run cache. Runs produced earlier in the
                same session are still reused (the "don't retry a tried config" rule).
  refresh=True  (pipeline --refresh) re-scrape instead of reading data/raw.
  OFF           set NO_CACHE=1 to bypass every read (writes still happen).
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from backend import settings
from backend.schemas import CacheStats, StoreConfig
from backend.store import read_json, write_json

_lock = threading.RLock()


@dataclass
class CachePolicy:
    fresh: bool = False
    refresh: bool = False
    session_runs: set[int] = field(default_factory=set)
    disabled: bool = os.getenv("NO_CACHE", "") == "1"


policy = CachePolicy()
_hits: Counter[str] = Counter()
_misses: Counter[str] = Counter()


def set_policy(*, fresh: bool | None = None, refresh: bool | None = None) -> None:
    if fresh is not None:
        policy.fresh = fresh
        policy.session_runs.clear()
    if refresh is not None:
        policy.refresh = refresh


def _record(layer: str, hit: bool) -> None:
    (_hits if hit else _misses)[layer] += 1


def stats() -> CacheStats:
    return CacheStats(hits=dict(_hits), misses=dict(_misses))


def hit_rates() -> dict[str, float]:
    layers = set(_hits) | set(_misses)
    return {k: _hits[k] / max(1, _hits[k] + _misses[k]) for k in sorted(layers)}


def stable_hash(obj: Any) -> str:
    """sha256 of canonical JSON (sorted keys) so equal inputs always hash equal."""
    if hasattr(obj, "model_dump"):
        obj = obj.model_dump(mode="json", by_alias=True)
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


# --- llm response cache ---------------------------------------------------------------------


def llm_key(model: str, request: dict) -> str:
    return stable_hash({"model": model, "request": request})


def llm_get(key: str) -> dict | None:
    if policy.disabled or policy.fresh:
        _record("llm", False)
        return None
    value = read_json(settings.LLM_CACHE_DIR / f"{key}.json")
    _record("llm", value is not None)
    return value


def llm_put(key: str, value: dict) -> None:
    write_json(settings.LLM_CACHE_DIR / f"{key}.json", value)


# --- scrape cache ---------------------------------------------------------------------------


def scrape_key(url: str, params: dict | None = None) -> str:
    return stable_hash({"url": url, "params": params or {}})


def scrape_get(source: str, url: str, params: dict | None = None) -> Any | None:
    if policy.disabled or policy.refresh:
        _record("scrape", False)
        return None
    value = read_json(settings.RAW_DIR / source / f"{scrape_key(url, params)}.json")
    _record("scrape", value is not None)
    return None if value is None else value["body"]


def scrape_put(source: str, url: str, params: dict | None, body: Any, fetched_at: str) -> None:
    write_json(
        settings.RAW_DIR / source / f"{scrape_key(url, params)}.json",
        {"url": url, "params": params or {}, "fetchedAt": fetched_at, "body": body},
    )


# --- pipeline outputs -----------------------------------------------------------------------


def _hashes_path():
    return settings.PROCESSED_DIR / ".hashes.json"


def pipeline_up_to_date(step: str, inputs: Any) -> bool:
    if policy.disabled or policy.refresh:
        _record("pipeline", False)
        return False
    current = read_json(_hashes_path(), {}).get(step)
    output = settings.PROCESSED_DIR / f"{step}.json"
    hit = current == stable_hash(inputs) and output.exists()
    _record("pipeline", hit)
    return hit


def pipeline_mark(step: str, inputs: Any) -> None:
    with _lock:
        hashes = read_json(_hashes_path(), {})
        hashes[step] = stable_hash(inputs)
        write_json(_hashes_path(), hashes)


# --- run cache ------------------------------------------------------------------------------


def _run_cache_path():
    return settings.RUNS_DIR / "cache.json"


def _load_run_cache() -> dict:
    data = read_json(_run_cache_path(), {})
    data.setdefault("runs", {})
    data.setdefault("storeConfigs", {})
    return data


# The processed files a run is simulated from (sim.engine.load_world). A map rebuild renumbers the
# stores and a demand rebuild changes who arrives, so a run made on other data is never reused.
SIM_INPUTS = ("map.json", "personas.json", "demand.json", "energy.json")
_inputs_hashes: dict[tuple, str] = {}


def sim_inputs_hash() -> str:
    """Content hash of SIM_INPUTS, memoised on each file's (path, mtime_ns, size)."""
    paths = [settings.PROCESSED_DIR / name for name in SIM_INPUTS]
    stamp = tuple(
        (str(p), p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else (str(p), None, None)
        for p in paths
    )
    if stamp not in _inputs_hashes:
        digest = hashlib.sha256()
        for name, path in zip(SIM_INPUTS, paths, strict=True):
            digest.update(name.encode())
            digest.update(path.read_bytes() if path.exists() else b"")
        _inputs_hashes[stamp] = digest.hexdigest()[:16]
    return _inputs_hashes[stamp]


def run_key(stores: dict[str, StoreConfig], seed: int, *, allow_closure: bool = False) -> str:
    """Configs + seed + sim version + the processed inputs, plus the owner-adaptation switches
    when adaptation is on (so runs with and without adaptation never share a cache entry)."""
    configs = {sid: c.model_dump(mode="json") for sid, c in sorted(stores.items())}
    key: dict = {
        "stores": configs,
        "seed": seed,
        "simVersion": settings.SIM_VERSION,
        "data": sim_inputs_hash(),
    }
    if settings.OWNER_ADAPTATION:
        key["owners"] = 3  # owner-logic version: bump when owners decide differently
        if allow_closure:
            key["ownerClosures"] = True
    return stable_hash(key)


def store_config_hash(config: StoreConfig) -> str:
    """One store's config on the current processed data: after a map rebuild the same store id
    can be a different shop, so its tried configs start over."""
    return stable_hash({"config": config.model_dump(mode="json"), "data": sim_inputs_hash()})


def run_lookup(key: str) -> int | None:
    """Run id for a config hash, honouring --fresh (only this session's runs count)."""
    if policy.disabled:
        _record("run", False)
        return None
    run = _load_run_cache()["runs"].get(key)
    if run is not None and policy.fresh and run not in policy.session_runs:
        run = None
    if run is not None and not (settings.RUNS_DIR / str(run) / "summary.json").exists():
        run = None
    _record("run", run is not None)
    return run


def run_record(key: str, run: int, stores: dict[str, StoreConfig]) -> None:
    with _lock:
        data = _load_run_cache()
        data["runs"][key] = run
        for sid, config in stores.items():
            runs = (
                data["storeConfigs"].setdefault(sid, {}).setdefault(store_config_hash(config), [])
            )
            if run not in runs:
                runs.append(run)
        write_json(_run_cache_path(), data)
    policy.session_runs.add(run)


def store_config_tried(store_id: str, config: StoreConfig) -> bool:
    """True if this exact store config was already simulated (never re-propose it).

    Under --fresh only runs from the current session count.
    """
    runs = _load_run_cache()["storeConfigs"].get(store_id, {}).get(store_config_hash(config), [])
    if policy.fresh:
        runs = [r for r in runs if r in policy.session_runs]
    return bool(runs)
