// "What I changed this fortnight": one shop's own decisions this run, oldest first, each with the owner's
// one-line reason and what triggered it. Decisions after the current sim time are shown as upcoming.
// Click a row to jump to that moment. Only this shop's events (store-scoped data).
import { NotebookPen } from "lucide-react";
import { useMemo } from "react";
import { useOwnerEvents } from "../state/data";
import { useSim } from "../state/store";
import { ACTION_ICON, actionLabel, momentLabel, weekdayTime } from "./ownerFormat";

export interface OwnerTimelineProps {
  storeId: string;
  /** Run to show; defaults to the run on screen. */
  run?: number;
  /** Heading; defaults to the owner-voice title. */
  title?: string;
  className?: string;
}

export function OwnerTimeline({ storeId, run: runProp, title = "What I changed this fortnight", className = "" }: OwnerTimelineProps) {
  const simRun = useSim((s) => s.run);
  const run = runProp ?? simRun;
  const t = useSim((s) => Math.floor(s.t / 5) * 5);
  const owner = useOwnerEvents(run).data;
  const mine = useMemo(() => (owner ?? []).filter((e) => e.storeId === storeId).sort((a, b) => a.t - b.t), [owner, storeId]);
  if (!owner) return null;

  return (
    <section className={`owner-timeline ${className}`} aria-label={title}>
      <h3 className="section-title">
        <span className="week-title">
          <NotebookPen size={13} aria-hidden /> {title}
        </span>
        <span className="muted">
          {mine.length} change{mine.length === 1 ? "" : "s"}
        </span>
      </h3>
      {mine.length ? (
        <ol className="timeline">
          {mine.map((e) => {
            const Icon = ACTION_ICON[e.action];
            const upcoming = e.t > t;
            return (
              <li key={`${e.t}:${e.action}`} className={`tl-item tl-${e.action} ${upcoming ? "upcoming" : ""}`}>
                <button className="tl-row" onClick={() => useSim.getState().setT(e.t)} title={`Jump to ${momentLabel(e.t)}`}>
                  <span className="tl-icon">
                    <Icon size={13} aria-hidden />
                  </span>
                  <span className="tl-body">
                    <span className="tl-when mono">
                      {weekdayTime(e.t)}
                    </span>
                    <span className="tl-what">{actionLabel(e)}</span>
                    <q className="tl-reason">{e.reason}</q>
                    {e.trigger?.label && <span className="tl-trigger">{e.trigger.label}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="empty">No changes this fortnight</div>
      )}
    </section>
  );
}
