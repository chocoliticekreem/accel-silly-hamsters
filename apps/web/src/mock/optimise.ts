// A short, scoped "Optimise for me" session for the mock: the session runs for a few seconds of wall time,
// stepping through the analyst loop over the runs that lead to the best one, then stops at the best run.
// Lets the store page's live progress strip be demonstrated without a backend.
import type { AgentSession } from "../api/contract";

export const OPTIMISE_MS = 7500;
const STEPS = ["proposed", "chosen", "ran", "scored"] as const;

/** Where the session is `elapsedMs` after it started. `best` = the best run it will land on (>= 2). */
export function optimiseProgress(elapsedMs: number, best: number, durationMs = OPTIMISE_MS): Pick<AgentSession, "state" | "currentRun" | "step" | "iterations" | "runsThisSession" | "stoppedReason" | "bestRun"> {
  const runs = Array.from({ length: Math.max(1, best - 1) }, (_, i) => i + 2).slice(-3); // up to 3 runs ending at best
  if (elapsedMs >= durationMs)
    return { state: "stopped", currentRun: best, step: "scored", iterations: runs.length, runsThisSession: runs, stoppedReason: "threshold", bestRun: best };
  const f = Math.max(0, elapsedMs) / durationMs;
  const i = Math.min(runs.length - 1, Math.floor(f * runs.length));
  const within = f * runs.length - i;
  const step = STEPS[Math.min(STEPS.length - 1, Math.floor(within * STEPS.length))];
  return {
    state: "running",
    currentRun: runs[i],
    step,
    iterations: i + (step === "scored" ? 1 : 0),
    runsThisSession: runs.slice(0, i + 1),
    stoppedReason: null,
    bestRun: i > 0 ? runs[i - 1] : null,
  };
}
