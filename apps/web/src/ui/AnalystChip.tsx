// "Analyst running · 9h 12m · 10 experiments". Running: live clock since startedAt. Stopped: until the last run.
import { useEffect, useState } from "react";
import { useAnalyst, useRuns } from "../state/data";
import { duration, STOP_LABELS } from "./format";


export function AnalystChip({ onClick }: { onClick?: () => void }) {
  const a = useAnalyst().data;
  const runs = useRuns().data;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (a?.state !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [a?.state]);
  if (!a) return <div className="chip">Analyst …</div>;

  const start = a.startedAt ? Date.parse(a.startedAt) : NaN;
  const lastRun = runs?.length ? Date.parse(runs[runs.length - 1].createdAt) : start;
  const end = a.state === "running" ? now : lastRun;
  const reason = a.stoppedReason ? STOP_LABELS[a.stoppedReason] : null;

  return (
    <button className={`chip chip-analyst ${a.state}`} onClick={onClick} title="Open the agents view" aria-label="Analyst status: open the agents view">
      <span className="pulse" aria-hidden />
      <span>
        Analyst <b>{a.state}</b>
      </span>
      {reason && <span className="muted">· {reason}</span>}
      {Number.isFinite(end - start) && <span className="muted">· {duration(end - start)}</span>}
      <span className="muted">· {a.iterations} experiments</span>
    </button>
  );
}
