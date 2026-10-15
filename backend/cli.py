"""Command line entry point.

python -m backend.cli pipeline all [--refresh]   build data/processed (with fallbacks)
python -m backend.cli pipeline map               one step: map|personas|energy|demand|calibration
python -m backend.cli run --seed 42              one 14-day run of the baseline -> runs/{n}
python -m backend.cli train --max-runs 10        analyst loop, resumable, uses caches
python -m backend.cli train --fresh              new session, no cached LLM outputs or runs
python -m backend.cli train --objective netValueGbp --levers hours --stores s1,s13
                                                 flags override runs/training_config.json
python -m backend.cli train-config show          the saved training config (defaults if none)
python -m backend.cli train-config set threshold=0.01 levers=hours storeIds=s1,s13
                                                 validate and save runs/training_config.json
python -m backend.cli calibrate                  sim vs calibration targets -> chart PNG
python -m backend.cli reports --run N            (re)write owner reports for run N
python -m backend.cli chaos-demo                 a short session under injected faults (fake
                                                 Claude, temp runs dir) + recovery summary
uvicorn backend.api.main:app --reload            serve the API
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, get_args

from pydantic import ValidationError

from backend import cache, settings
from backend.schemas import AnalystBackendName, StoreAgentsMode, TrainingConfig, TrainingObjective

# `train` flag (argparse dest) -> TrainingConfig field it overrides.
TRAIN_FLAGS = {
    "objective": "objective",
    "threshold": "threshold",
    "patience": "patience",
    "max_runs": "maxRuns",
    "stores_per_iteration": "maxStoresPerIteration",
    "changes_per_store": "maxChangesPerStore",
    "levers": "levers",
    "stores": "storeIds",
    "budget_usd": "sessionBudgetUsd",
    "backend": "analystBackend",
    "store_agents": "storeAgents",
    "seed": "seed",
}
LEVERS = ("hours", "lighting")


def _print(obj: object) -> None:
    print(json.dumps(obj, indent=2, default=str))


def cmd_pipeline(args: argparse.Namespace) -> None:
    from backend.pipeline import run_all

    report = run_all.run(refresh=args.refresh, only=args.step, calibrate=not args.no_calibrate)
    _print({"fallbacks": report["fallbacks"], "steps": [s["step"] for s in report["steps"]]})


def cmd_run(args: argparse.Namespace) -> None:
    from backend.sim import runner

    run = runner.execute_run(runner.baseline_configs(), args.seed, use_cache=not args.no_cache)
    summary = json.loads((settings.RUNS_DIR / str(run) / "summary.json").read_text())
    _print(
        {
            "run": run,
            "kpis": summary["kpis"],
            "peakKw": summary["peakKw"],
            "durationSec": summary["durationSec"],
            "cacheHitRates": cache.hit_rates(),
        }
    )


def parse_levers(text: str) -> dict[str, bool]:
    """'hours,lighting' -> both levers on; 'hours' -> hours only."""
    names = {name.strip() for name in text.split(",") if name.strip()}
    unknown = sorted(names - set(LEVERS))
    if unknown:
        raise argparse.ArgumentTypeError(
            f"unknown lever {', '.join(unknown)}: use {','.join(LEVERS)}"
        )
    return {lever: lever in names for lever in LEVERS}


def parse_store_ids(text: str) -> list[str] | None:
    """'s1,s13' -> those stores take part; 'all' -> every non-club store (null)."""
    if text.strip().lower() in ("all", "null", ""):
        return None
    return [sid.strip() for sid in text.split(",") if sid.strip()]


def _validation_message(error: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(part) for part in e['loc']) or 'config'}: {e['msg']}"
        for e in error.errors()
    )


def _config_with(base: TrainingConfig, overrides: dict[str, Any]) -> TrainingConfig:
    """`base` with `overrides` (TrainingConfig field -> value) applied; exits when invalid."""
    try:
        config = TrainingConfig.model_validate({**base.model_dump(), **overrides})
    except ValidationError as e:
        sys.exit(f"invalid training config: {_validation_message(e)}")
    return config


def _check_store_ids(config: TrainingConfig) -> None:
    from backend import store

    if config.storeIds is None:
        return
    try:
        config.check_store_ids(store.load_map())
    except FileNotFoundError:
        sys.exit("data/processed/map.json is missing: run `python -m backend.cli pipeline` first")
    except ValueError as e:
        sys.exit(f"invalid training config: {e}")


def train_config_from_args(args: argparse.Namespace) -> TrainingConfig:
    """The saved training config with the `train` flags that were given applied on top (a flag
    left out is absent from `args`: argument_default=SUPPRESS)."""
    from backend import store

    overrides = {
        field: getattr(args, dest) for dest, field in TRAIN_FLAGS.items() if hasattr(args, dest)
    }
    config = _config_with(store.load_training_config(), overrides)
    _check_store_ids(config)
    return config


def cmd_train(args: argparse.Namespace) -> None:
    from backend.agents import training

    try:
        state = training.train(train_config_from_args(args), fresh=args.fresh)
    except training.SessionBusy as e:
        sys.exit(str(e))
    _print(state.model_dump(mode="json"))


def _assignments(items: list[str]) -> dict[str, Any]:
    """['threshold=0.01', 'levers=hours'] -> TrainingConfig fields; exits on a bad item."""
    fields = list(TrainingConfig.model_fields)
    out: dict[str, Any] = {}
    for item in items:
        key, sep, value = item.partition("=")
        if not sep or key not in fields:
            sys.exit(f"expected key=value with key one of {', '.join(fields)}; got {item!r}")
        if key == "levers":
            try:
                out[key] = parse_levers(value)
            except argparse.ArgumentTypeError as e:
                sys.exit(f"invalid training config: levers: {e}")
        elif key == "storeIds":
            out[key] = parse_store_ids(value)
        else:
            out[key] = value
    return out


def cmd_train_config(args: argparse.Namespace) -> None:
    from backend import store

    if args.action == "show":
        _print(store.load_training_config().model_dump(mode="json"))
        return
    if not args.assignments:
        sys.exit("nothing to set: pass key=value pairs, e.g. threshold=0.01 levers=hours")
    config = _config_with(store.load_training_config(), _assignments(args.assignments))
    _check_store_ids(config)
    store.save_training_config(config)
    _print(config.model_dump(mode="json"))


def cmd_calibrate(args: argparse.Namespace) -> None:
    from backend.sim import calibrate

    _print(calibrate.run(seed=args.seed))


def cmd_reports(args: argparse.Namespace) -> None:
    from backend import store
    from backend.agents import report

    state = store.load_analyst_state()
    baseline = (
        args.baseline if args.baseline is not None else (state.baselineRun if state else None)
    )
    if baseline is None:
        sys.exit("no baseline run: pass --baseline or run `train` first")
    objective = state.config.objective if state and state.config else None  # the session's
    reports = report.write_reports(args.run, baseline, objective=objective)
    _print(
        [
            {"storeId": r.storeId, "changes": len(r.changes), "confidence": r.confidence}
            for r in reports
        ]
    )


# Faults for the live demo: every layer fails often enough to watch it recover.
DEMO_CHAOS = (
    "llm_429:0.3,llm_529:0.1,llm_timeout:0.1,llm_conn:0.05,bad_json:0.2,refusal:0.05,"
    "batch_stuck:0.5,batch_partial:0.2,sim_crash:0.15,sim_nan:0.1"
)


def chaos_demo(
    *,
    runs_dir: Path | None,
    spec: str,
    seed: int,
    max_runs: int,
    wait_scale: float = 0.02,
) -> dict:
    """A short training session through the agents' online code paths (the fake Claude client:
    no key, no spend) with CHAOS faults on, in a new runs/ directory (never the real one). Prints
    the faults injected, the recoveries and the recovery timeline; returns the summary. Backoff
    waits are compressed by wait_scale. Everything it switches on is switched back off."""
    from backend import chaos, llm, store
    from backend.agents import store_owner, training

    target = (runs_dir or Path(tempfile.mkdtemp(prefix="chaos-demo-"))).resolve()
    if target == (settings.ROOT / "runs").resolve() or (target.exists() and any(target.iterdir())):
        sys.exit(f"refusing to run the chaos demo in {target}: use a new or empty directory")
    saved = (settings.RUNS_DIR, settings.LLM_CACHE_DIR, settings.FAKE_LLM, llm._client, llm._sleep)
    saved_batch = (store_owner.BATCH_TIMEOUT_SECONDS, store_owner.BATCH_POLL_SECONDS)
    settings.RUNS_DIR, settings.LLM_CACHE_DIR = target, target / "llm_cache"
    settings.FAKE_LLM, llm._client = True, None
    llm._sleep = lambda seconds: time.sleep(seconds * wait_scale)
    store_owner.BATCH_TIMEOUT_SECONDS, store_owner.BATCH_POLL_SECONDS = 3 * wait_scale, 0.0
    injected = chaos.configure(spec, seed)
    started = time.perf_counter()
    try:
        config = TrainingConfig(analystBackend="messages", storeAgents="batch", maxRuns=max_runs)
        state = training.train(config, fresh=True)
        events = _recovery_timeline(target)
        spent = llm.spent_usd(session=state.sessionId)
        runs = store.load_index()
    finally:
        chaos.configure("")
        settings.RUNS_DIR, settings.LLM_CACHE_DIR, settings.FAKE_LLM, llm._client, llm._sleep = (
            saved
        )
        store_owner.BATCH_TIMEOUT_SECONDS, store_owner.BATCH_POLL_SECONDS = saved_batch
    summary = {
        "runsDir": str(target),
        "seconds": round(time.perf_counter() - started, 1),
        "stoppedReason": state.stoppedReason,
        "bestRun": state.bestRun,
        "bestObjective": state.bestObjective,
        "runs": state.runsThisSession,
        "quarantinedRuns": state.quarantinedRuns,
        "failedRuns": [r.run for r in runs if r.status == "failed"],
        "faultsInjected": dict(sorted(injected.injected.items())),
        "recoveries": {k: v for k, v in state.recoveries.items() if v},
        "simulatedSpendUsd": round(spent, 4),
    }
    _print_demo(summary, events)
    return summary


def _recovery_timeline(runs_dir: Path) -> list[dict]:
    from backend import llm

    kinds = set(llm.RECOVERY_COUNTS)
    events = []
    for path in [runs_dir / "llm_log.jsonl", *sorted(runs_dir.glob("*/llm_log.jsonl"))]:
        for line in path.read_text().splitlines() if path.exists() else []:
            event = json.loads(line)
            if event.get("type") in kinds:
                events.append(event)
    return sorted(events, key=lambda e: e["at"])


def _print_demo(summary: dict, events: list[dict]) -> None:
    print(f"\nChaos demo: {summary['seconds']}s, runs in {summary['runsDir']}")
    print(
        f"Session: stopped ({summary['stoppedReason']}), best run {summary['bestRun']} "
        f"(objective {summary['bestObjective']}), runs {summary['runs']}, "
        f"quarantined {summary['quarantinedRuns']}"
    )
    print("\nFaults injected:")
    for fault, n in summary["faultsInjected"].items():
        print(f"  {fault:<15} {n:>4}")
    print("\nRecoveries:")
    for kind, n in summary["recoveries"].items():
        print(f"  {kind:<15} {n:>4}")
    print("\nTimeline (last 20):")
    for e in events[-20:]:
        wait = f" wait {e['wait']}s" if e.get("wait") else ""
        attempt = f" attempt {e['attempt']}" if e.get("attempt") else ""
        print(
            f"  {e['at'][11:19]} {e.get('step') or '-':<8} {e['agent']:<12} {e['type']:<14} "
            f"{e.get('kind', ''):<16}{attempt}{wait} -> {e.get('outcome', '')}"
        )
    print(
        f"\nSimulated Claude spend (fake client, nothing billed): ${summary['simulatedSpendUsd']}"
    )


def cmd_chaos_demo(args: argparse.Namespace) -> None:
    chaos_demo(
        runs_dir=args.runs_dir,
        spec=args.chaos,
        seed=args.seed,
        max_runs=args.max_runs,
        wait_scale=args.wait_scale,
    )


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m backend.cli")
    sub = p.add_subparsers(dest="command", required=True)

    pp = sub.add_parser("pipeline", help="build data/processed")
    pp.add_argument(
        "step",
        nargs="?",
        default="all",
        choices=["all", "map", "personas", "energy", "demand", "calibration"],
    )
    pp.add_argument("--refresh", action="store_true", help="re-scrape instead of data/raw")
    pp.add_argument("--no-calibrate", action="store_true", help="skip the calibration chart")
    pp.set_defaults(func=cmd_pipeline)

    pr = sub.add_parser("run", help="one 14-day baseline run")
    pr.add_argument("--seed", type=int, default=settings.DEFAULT_SEED)
    pr.add_argument("--no-cache", action="store_true", help="simulate even if cached")
    pr.set_defaults(func=cmd_run)

    pt = sub.add_parser(
        "train",
        help="analyst training loop",
        description="Flags override the saved config (train-config) for this session only.",
        argument_default=argparse.SUPPRESS,
    )
    pt.add_argument("--objective", choices=get_args(TrainingObjective))
    pt.add_argument("--threshold", type=float, help="stop when the gain stays below this (0-1)")
    pt.add_argument("--patience", type=int, help="... for this many runs in a row")
    pt.add_argument("--max-runs", type=int, help="runs per session, the baseline included")
    pt.add_argument("--stores-per-iteration", type=int, help="stores changed per experiment")
    pt.add_argument("--changes-per-store", type=int, help="changes per store per week (1-2)")
    pt.add_argument("--levers", type=parse_levers, help="hours,lighting | hours | lighting")
    pt.add_argument(
        "--stores", type=parse_store_ids, help="participating stores, e.g. s1,s13 (or all)"
    )
    pt.add_argument("--budget-usd", type=float, help="this session's Claude spend cap (USD)")
    pt.add_argument("--backend", choices=get_args(AnalystBackendName), help="analyst backend")
    pt.add_argument("--store-agents", choices=get_args(StoreAgentsMode))
    pt.add_argument("--seed", type=int)
    pt.add_argument(
        "--fresh",
        action="store_true",
        default=False,
        help="new session: no cached LLM responses or runs from earlier sessions",
    )
    pt.set_defaults(func=cmd_train)

    ptc = sub.add_parser("train-config", help="show or set the saved training config")
    ptc.add_argument("action", choices=["show", "set"])
    ptc.add_argument("assignments", nargs="*", metavar="key=value", help="for set")
    ptc.set_defaults(func=cmd_train_config)

    pc = sub.add_parser("calibrate", help="sim vs calibration targets")
    pc.add_argument("--seed", type=int, default=settings.DEFAULT_SEED)
    pc.set_defaults(func=cmd_calibrate)

    prp = sub.add_parser("reports", help="write owner reports for a run")
    prp.add_argument("--run", type=int, required=True)
    prp.add_argument("--baseline", type=int, default=None)
    prp.set_defaults(func=cmd_reports)

    pcd = sub.add_parser(
        "chaos-demo",
        help="a short training session under injected faults, with a recovery summary",
        description="Online agents against a fake Claude client (no key, no spend) in a new "
        "runs directory; the real runs/ is never touched.",
    )
    pcd.add_argument("--chaos", default=DEMO_CHAOS, help="CHAOS spec (backend/chaos.py)")
    pcd.add_argument("--seed", type=int, default=7, help="chaos seed")
    pcd.add_argument("--max-runs", type=int, default=4)
    pcd.add_argument("--runs-dir", type=Path, default=None, help="default: a new temp dir")
    pcd.add_argument("--wait-scale", type=float, default=0.02, help="backoff waits x this")
    pcd.set_defaults(func=cmd_chaos_demo)
    return p


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
