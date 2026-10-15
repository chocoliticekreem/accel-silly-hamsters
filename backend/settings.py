"""Paths, tunables and environment. One place so the team can find every knob."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# Vercel's filesystem is read-only outside /tmp: runs and caches live there, and the API seeds
# /tmp/runs from the bundled runs/ on a cold start (backend/api/main.py).
ON_VERCEL = os.getenv("VERCEL") == "1"

DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
CACHE_DIR = Path("/tmp/cache") if ON_VERCEL else DATA_DIR / "cache"
LLM_CACHE_DIR = CACHE_DIR / "llm"
BUNDLED_RUNS_DIR = ROOT / "runs"
RUNS_DIR = Path(os.getenv("RUNS_DIR", "/tmp/runs" if ON_VERCEL else BUNDLED_RUNS_DIR))
# Day files are the 3D replay (about 5 MB a day on the 209-shop map); Vercel's /tmp holds 500 MB.
WRITE_DAY_FILES = os.getenv("WRITE_DAY_FILES", "0" if ON_VERCEL else "1") == "1"
# A session must finish inside one Vercel invocation (maxDuration 300 s, about 20 s a run).
MAX_SESSION_RUNS = int(os.getenv("MAX_SESSION_RUNS", "12" if ON_VERCEL else "40"))

# Simulation
SIM_VERSION = "0.3.0"  # bump on any change that alters sim output; it is part of the run-cache key
DEFAULT_SEED = 42
TICK_MINUTES = 5
# Self-learning city (docs/OWNER_ACTIONS.md): street events, and every shop's owner adapting day by
# day inside a run. OWNER_ADAPTATION=0 gives exactly the pre-adaptation sim (same files, same keys).
OWNER_ADAPTATION = os.getenv("OWNER_ADAPTATION", "1") != "0"

# Training loop: defaults for schemas.TrainingConfig, which runs/training_config.json overrides
OBJECTIVE = os.getenv("OBJECTIVE", "visitsPerKwh")  # any key of contract.Kpis
THRESHOLD = float(os.getenv("THRESHOLD", "0.02"))  # stop when gain < 2% ...
PATIENCE = 2  # ... for this many consecutive runs
MAX_RUNS = int(os.getenv("MAX_RUNS", "10"))
MAX_STORES_PER_ITERATION = 4
MAX_CHANGES_PER_STORE_PER_WEEK = 2

# Claude models (docs/BACKEND_PROMPT.md, "Claude API architecture").
ANALYST_MODEL = "claude-opus-5-5"
STORE_AGENT_MODEL = "claude-sonnet-5-5"
REPORT_MODEL = "claude-sonnet-5-5"
PERSONA_MODEL = "claude-haiku-5-5"

# debt: fixed FX rate for cost reporting. ceiling: drifts with the market. upgrade: if £ figures
# go in front of a paying customer, read a daily rate.
GBP_PER_USD = 0.75

# Claude API spend caps in USD (team budget: $30). llm.check_budget runs before every request
# and batch; reaching a cap is a hard stop, and training checkpoints with stoppedReason "budget".
SPEND_CAP_USD = float(os.getenv("SPEND_CAP_USD", "30"))  # all agents, all sessions
SESSION_BUDGET_USD = float(os.getenv("SESSION_BUDGET_USD", "15"))  # one training session
ANALYST_BUDGET_GBP = SESSION_BUDGET_USD * GBP_PER_USD  # the session cap, for GBP-based callers

# Business-tariff electricity price used for £ impact when energy.json has no hourly price.
DEFAULT_PRICE_GBP_PER_KWH = 0.27

# Force the offline (no-LLM) agent backends even when credentials exist: OFFLINE=1
OFFLINE = os.getenv("OFFLINE", "") == "1"

# A read-only demo replays pre-computed runs: requests that start or reconfigure work (training
# start/stop and config writes, POST .../optimize, .../experiment) answer 403. On Vercel it is
# read-only unless ALLOW_WRITES=1.
READ_ONLY = os.getenv("READ_ONLY") == "1" or (ON_VERCEL and os.getenv("ALLOW_WRITES") != "1")

# Analyst backend: "auto" (messages when credentials exist, else heuristic), "heuristic",
# "messages" (Messages API tool-use loop) or "managed" (Managed Agents session).
ANALYST_BACKEND = os.getenv("ANALYST_BACKEND", "auto")

CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"
).split(",")
