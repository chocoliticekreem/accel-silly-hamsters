// A shop's week (Mon–Sun × 24h) as it stands on the current sim day: the owner's schedule in effect, with
// cells that differ from the run's starting hours marked (opened / closed), and today's row showing today
// as it really is (shut early, open late, closed). Only this shop's data.
import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import { eventsByStore, weekGrid } from "../sim/storeState";
import { dayOf, hourOf } from "../sim/time";
import { useOwnerEvents, useRunStores } from "../state/data";
import { useSim } from "../state/store";

export interface WeekScheduleProps {
  storeId: string;
  /** Run to show; defaults to the run on screen. */
  run?: number;
  /** Day (1–14) whose week to show; defaults to the current sim day. */
  day?: number;
  className?: string;
}

const AXIS = [0, 6, 12, 18, 24];

export function WeekSchedule({ storeId, run: runProp, day: dayProp, className = "" }: WeekScheduleProps) {
  const simRun = useSim((s) => s.run);
  const run = runProp ?? simRun;
  // the grid only changes when an owner decides something: minute resolution is plenty
  const t = useSim((s) => Math.floor(s.t));
  const result = useRunStores(run).data?.[storeId];
  const owner = useOwnerEvents(run).data;
  const day = dayProp ?? dayOf(t);
  const at = dayProp ? Math.min(t, dayProp * 1440 - 1) : t;
  const mine = useMemo(() => eventsByStore(owner ?? []).get(storeId) ?? [], [owner, storeId]);
  const known = useMemo(() => mine.filter((e) => e.t <= at), [mine, at]);
  const rows = useMemo(() => (result ? weekGrid(result, known, day) : null), [result, known, day]);
  if (!result || !rows) return null;

  const changes = rows.reduce((n, r) => n + r.changed.filter(Boolean).length, 0);
  const since = [...(result.schedule ?? [])].reverse().find((e) => e.fromDay <= day && e.fromDay > 1)?.fromDay;
  const nowHour = Math.floor(hourOf(t));
  const showCursor = !dayProp || dayProp === dayOf(t);

  return (
    <section className={`week-schedule ${className}`} aria-label="Opening hours this week">
      <h3 className="section-title">
        <span className="week-title">
          <CalendarDays size={13} aria-hidden /> Week
        </span>
        <span className="muted">{since ? `changed day ${since}` : changes ? "today differs" : `day ${day}`}</span>
      </h3>
      <div className="week-grid" role="table">
        {rows.map((r) => (
          <div key={r.weekday} className={`week-row ${r.today ? "today" : ""}`} role="row">
            <span className="week-day" role="rowheader">
              {r.label}
            </span>
            <div className="week-cells">
              {r.open.map((on, h) => (
                <i
                  key={h}
                  role="cell"
                  className={`wcell ${on ? "on" : ""} ${r.changed[h] ?? ""} ${r.today && showCursor && h === nowHour ? "now" : ""}`}
                  title={`${r.label} ${String(h).padStart(2, "0")}:00 · ${on ? "open" : "closed"}${r.changed[h] === "added" ? " · newly open" : r.changed[h] === "removed" ? " · newly closed" : ""}`}
                />
              ))}
            </div>
            <span className="week-hours mono">{r.hours ? `${r.hours.open}–${r.hours.close}` : "closed"}</span>
          </div>
        ))}
        <div className="week-row week-axis" aria-hidden>
          <span className="week-day" />
          <div className="week-axis-labels">
            {AXIS.map((h) => (
              <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
                {String(h % 24).padStart(2, "0")}
              </span>
            ))}
          </div>
          <span className="week-hours" />
        </div>
      </div>
      <div className="strip-legend">
        <span>
          <i className="sw sw-open" /> open
        </span>
        <span>
          <i className="sw sw-added" /> newly open
        </span>
        <span>
          <i className="sw sw-removed" /> newly closed
        </span>
      </div>
    </section>
  );
}
