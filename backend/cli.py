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
uvicorn backend.api.main:app --reload            serve the API
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
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
    return p


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
