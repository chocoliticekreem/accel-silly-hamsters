"""Command line entry point.

python -m backend.cli pipeline all [--refresh]   build data/processed (with fallbacks)
python -m backend.cli pipeline map               one step: map|personas|energy|demand|calibration
python -m backend.cli run --seed 42              one 14-day run of the baseline -> runs/{n}
python -m backend.cli train --max-runs 10        analyst loop, resumable, uses caches
python -m backend.cli train --fresh              new session, no cached LLM outputs or runs
python -m backend.cli calibrate                  sim vs calibration targets -> chart PNG
python -m backend.cli reports --run N            (re)write owner reports for run N
uvicorn backend.api.main:app --reload            serve the API
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from backend import cache, settings


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


def cmd_train(args: argparse.Namespace) -> None:
    from backend.agents import training

    state = training.train(max_runs=args.max_runs, fresh=args.fresh, seed=args.seed)
    _print(state.model_dump(mode="json"))


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
    reports = report.write_reports(args.run, baseline)
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

    pt = sub.add_parser("train", help="analyst training loop")
    pt.add_argument("--max-runs", type=int, default=settings.MAX_RUNS)
    pt.add_argument("--seed", type=int, default=settings.DEFAULT_SEED)
    pt.add_argument(
        "--fresh",
        action="store_true",
        help="new session: no cached LLM responses or runs from earlier sessions",
    )
    pt.set_defaults(func=cmd_train)

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
