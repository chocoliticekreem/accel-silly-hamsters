"""A trainer process for tests/test_chaos.py: one session on the fake sim (tests/
test_agents_fakesim.py) with the fake Claude client, in the runs/ under argv[1].

Run with FAKE_LLM=1 and optionally CHAOS (e.g. kill_after_step:3: the process SIGKILLs itself
right after its 3rd checkpoint). A run without CHAOS resumes whatever a killed one left. Prints
"checkpoints=N" when the session ends.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]

import pytest  # noqa: E402
from test_agents_fakesim import setup_world  # noqa: E402

from backend import llm  # noqa: E402
from backend.agents import store_owner, training  # noqa: E402
from backend.schemas import TrainingConfig  # noqa: E402

CONFIG = TrainingConfig(analystBackend="messages", storeAgents="batch", maxRuns=6)


def main() -> None:
    patch = pytest.MonkeyPatch()
    setup_world(Path(sys.argv[1]), patch)
    patch.setattr(llm, "_sleep", lambda seconds: None)
    patch.setattr(store_owner, "BATCH_POLL_SECONDS", 0)
    checkpoints = {"n": 0}
    heartbeat = training._heartbeat

    def counted(state):
        checkpoints["n"] += 1
        heartbeat(state)

    patch.setattr(training, "_heartbeat", counted)
    training.train(CONFIG)
    print(f"checkpoints={checkpoints['n']}")


if __name__ == "__main__":
    main()
