// "Busy times" on the store card (Popular-Times style, from the simulation): visits by hour for the average day
// or one weekday, shaded where the shop is shut, the current sim hour marked, a live read of today vs usual,
// kWh by hour as a line, and the shop's hours today.
import { useMemo, useState } from "react";
import { WEEKDAYS } from "./format";
import { captionOf, hourlyCounts, kwhByHour, LIVE_TEXT, liveLevel, summarize } from "../sim/busyTimes";
import { closedFromDayOf, eventsByStore, storeStateAt, weekdayIndex, weekGrid } from "../sim/storeState";
import { dayOf, minuteOfDay, openByHour } from "../sim/time";
import { useDayArrivals, useWeekdayHours } from "../state/busyData";
import { useInsights, useMap, useOwnerEvents, useRunStores } from "../state/data";
import { useSim } from "../state/store";
import "./busy.css";

const AXIS = [0, 6, 12, 18, 24];

export function BusyTimes({ storeId }: { storeId: string }) {
  const run = useSim((s) => s.run);
  // five-minute resolution is plenty for the live read and the cursor
  const t = useSim((s) => Math.floor(s.t / 5) * 5);
  const day = dayOf(t);
  const todayW = weekdayIndex(day);
  const [pick, setPick] = useState<number | "avg">(todayW);
  const map = useMap().data;
  const cfg = useRunStores(run).data?.[storeId];
  const owner = useOwnerEvents(run).data;
  const insights = useInsights(cfg ? storeId : null, run).data;
  const today = useDayArrivals(run, cfg ? day : null).data?.get(storeId);
  const usualWd = useWeekdayHours(run, cfg ? todayW : null);
  const pickedWd = useWeekdayHours(run, cfg && pick !== "avg" ? pick : null);

  const store = map?.stores.find((s) => s.id === storeId);
  const known = useMemo(() => (eventsByStore(owner ?? []).get(storeId) ?? []).filter((e) => e.t <= t), [owner, storeId, t]);
  const grid = useMemo(() => (cfg ? weekGrid(cfg, known, day) : null), [cfg, known, day]);
  if (!store) return null;

  // no visit data for this business: its hours only
  if (!cfg) {
    const h = store.defaultHours;
    return (
      <section className="busy" aria-label="Busy times">
        <h3 className="section-title">
          Opening hours
        </h3>
        {h ? (
          <>
            <div className="busy-band">
              {openByHour(h.open, h.close).map((o, i) => (
                <i key={i} className={o ? "on" : ""} />
              ))}
            </div>
            <div className="busy-hours">
              Usual hours <b className="mono">{h.open}–{h.close}</b>
            </div>
          </>
        ) : (
          <div className="empty">Hours not listed</div>
        )}
      </section>
    );
  }

  const w = pick === "avg" ? todayW : pick;
  const row = grid![w];
  const open = row.open;
  const loadingWd = pick !== "avg" && !pickedWd.data && !pickedWd.error;
  const visits = pick === "avg" || !pickedWd.data ? cfg.visitsByHour : (pickedWd.data.get(storeId) ?? new Array<number>(24).fill(0));
  const area = store.floorArea ?? (() => {
    const b = map!.buildings.find((x) => x.id === store.buildingId);
    return b ? b.w * b.d : 0;
  })();
  const kwh = pick === "avg" && insights?.hourly.kwh.length === 24 ? insights.hourly.kwh : kwhByHour(store.type, area, open, cfg.lighting);

  const nowH = Math.floor(minuteOfDay(t) / 60);
  const showNow = pick === "avg" || pick === todayW;
  const state = storeStateAt(cfg, known, t);
  const usual = usualWd.data?.get(storeId) ?? cfg.visitsByHour;
  const live = today ? liveLevel(today, usual, t, state.open) : null;
  const todaySoFar = today ? hourlyCounts(today, t) : null;

  const peak = Math.max(1, ...visits, ...(showNow && todaySoFar ? [todaySoFar[nowH]] : []));
  const kmax = Math.max(0.001, ...kwh);
  const s = summarize(visits, open);
  const gone = closedFromDayOf(cfg, known);
  const todayRow = grid![todayW];
  const pts = kwh.map((k, h) => `${((h + 0.5) / 24) * 240},${40 - (k / kmax) * 36}`).join(" ");

  return (
    <section className="busy" aria-label="Busy times">
      <h3 className="section-title">
        Busy times <span className="muted">{pick === "avg" ? "avg of 14 days" : loadingWd ? "loading…" : `${WEEKDAYS[pick]} · 2 days`}</span>
      </h3>
      <div className="busy-days" role="tablist" aria-label="Day">
        <button role="tab" aria-selected={pick === "avg"} className={pick === "avg" ? "on" : ""} onClick={() => setPick("avg")}>
          Avg
        </button>
        {WEEKDAYS.map((d, i) => (
          <button key={d} role="tab" aria-selected={pick === i} className={`${pick === i ? "on" : ""} ${i === todayW ? "today" : ""}`} onClick={() => setPick(i)} title={i === todayW ? "today" : undefined}>
            {d}
          </button>
        ))}
      </div>

      {live && (
        <div className={`busy-live live-${live.level}`}>
          <i className="busy-dot" />
          <b>Live:</b> {LIVE_TEXT[live.level]}
          {live.level !== "closed" && (
            <span className="busy-live-n mono muted">
              {live.now} arrived in the last hour · {live.usual.toFixed(1)} usual
            </span>
          )}
        </div>
      )}

      <div className={`busy-chart ${loadingWd ? "loading" : ""}`}>
        <div className="busy-bars">
          {visits.map((v, h) => (
            <span
              key={h}
              className={`bb ${open[h] ? "open" : "shut"} ${showNow && h === nowH ? "now" : ""}`}
              title={`${String(h).padStart(2, "0")}:00 · ${v.toFixed(1)} visits${open[h] ? "" : " · closed"} · ${kwh[h].toFixed(2)} kWh${showNow && h === nowH && todaySoFar ? ` · today ${todaySoFar[h]}` : ""}`}
            >
              <i style={{ height: `${(v / peak) * 100}%` }} />
              {showNow && h === nowH && todaySoFar && <b className="bb-live" style={{ height: `${(todaySoFar[h] / peak) * 100}%` }} />}
            </span>
          ))}
        </div>
        <svg className="busy-kwh" viewBox="0 0 240 42" preserveAspectRatio="none" aria-hidden>
          <polyline points={pts} />
        </svg>
        {showNow && <div className="busy-cursor" style={{ left: `${((minuteOfDay(t) / 60) / 24) * 100}%` }} />}
      </div>
      <div className="strip-axis">
        {AXIS.map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {String(h % 24).padStart(2, "0")}
          </span>
        ))}
      </div>

      <div className="busy-caption">{captionOf(s)}</div>
      <div className="busy-hours">
        {gone != null && day >= gone ? (
          <>Closed for good since day {gone}</>
        ) : (
          <>
            Today ({WEEKDAYS[todayW]}) <b className="mono">{todayRow.hours ? `${todayRow.hours.open}–${todayRow.hours.close}` : "closed"}</b>
            {w !== todayW && (
              <>
                {" "}
                · {WEEKDAYS[w]} <b className="mono">{row.hours ? `${row.hours.open}–${row.hours.close}` : "closed"}</b>
              </>
            )}
            {gone != null && <> · closes for good day {gone}</>}
          </>
        )}
      </div>
      <div className="strip-legend">
        <span>
          <i className="sw busy-sw-open" /> visits/h
        </span>
        <span>
          <i className="sw busy-sw-shut" /> closed
        </span>
        <span>
          <i className="sw busy-sw-kwh" /> kWh/h {kmax >= 0.01 ? <span className="mono">(max {kmax.toFixed(1)})</span> : null}
        </span>
        {showNow && todaySoFar && (
          <span>
            <i className="sw busy-sw-live" /> today
          </span>
        )}
      </div>
    </section>
  );
}
