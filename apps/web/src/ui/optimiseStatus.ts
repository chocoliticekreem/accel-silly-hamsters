// Words for the store page's "Optimise for me" progress strip: what the session is doing now, whether it has
// finished, and the result line from the refreshed overview.
import type { AgentSession, StoreOverview } from "../api/contract";

const STEP_WORDS: Record<string, string> = {
  start: "starting",
  baseline: "baseline",
  proposed: "proposing changes",
  chosen: "picking a change",
  ran: "re-running the 14 days",
  scored: "scoring",
};

export function progressLabel(s: Pick<AgentSession, "currentRun" | "step"> | null | undefined): string {
  const parts = ["Optimising your shop"];
  if (s?.currentRun != null) parts.push(`run ${s.currentRun}`);
  if (s?.step) parts.push(`step ${STEP_WORDS[s.step] ?? s.step}`);
  return parts.join(" · ");
}

/**
 * Finished once the session reports stopped — after it was seen running, or after a couple of polls (a fast
 * backend can finish between two polls; a slow one may not have flipped to running on the first).
 */
export function sessionFinished(s: Pick<AgentSession, "state"> | null | undefined, sawRunning: boolean, polls: number): boolean {
  if (s?.state === "running") return false;
  return sawRunning || polls >= 2;
}

/** "Done: best run 6, £93/week better", from the shop's best history row (else the overview's own numbers). */
export function doneLabel(o: StoreOverview | null | undefined): string {
  if (!o) return "Done: open the report for the new runs";
  const best = o.history.find((h) => h.best);
  const run = best?.run ?? o.bestRun ?? o.run;
  const gbp = Math.round(best?.profitChangePerWeekGbp ?? o.numbers.profitChangePerWeekGbp);
  if (gbp > 0) return `Done: best run ${run}, £${gbp}/week better`;
  return `Done: best run ${run}, nothing beat your original settings`;
}
