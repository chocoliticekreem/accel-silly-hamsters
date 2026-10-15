// Corner HUD: the clock, which run, and the run's 3 KPIs with deltas vs the previous run.
import { formatHHMM, dayOf } from "../sim/time";
import { useAnalyst, usePrevRun } from "../state/data";
import { useSim } from "../state/store";
import { Delta } from "./Delta";
import { change, fmtInt, fmtNum, WEEKDAYS } from "./format";

export function Clock() {
  const minute = useSim((s) => Math.floor(s.t));
  const day = dayOf(minute);
  return (
    <div className="clock">
      <span className="clock-day">
        Day <b>{day}</b>
        <small>{WEEKDAYS[(day - 1) % 7]}</small>
      </span>
      <span className="clock-sep">·</span>
      <span className="clock-time">{formatHHMM(minute)}</span>
    </div>
  );
}

export function Hud() {
  const run = useSim((s) => s.run);
  const { cur, prev, total } = usePrevRun(run);
  const best = useAnalyst().data?.bestRun;
  const k = cur?.kpis;
  const p = prev?.kpis;
  const tiles = [
    { key: "visits", label: "Visits", value: k && fmtInt(k.visits) },
    { key: "kwh", label: "kWh", value: k && fmtInt(k.kwh) },
    { key: "visitsPerKwh", label: "Visits / kWh", value: k && fmtNum(k.visitsPerKwh), main: true },
  ] as const;

  return (
    <section className="hud panel" aria-label="Run status">
      <Clock />
      <div className="hud-run">
        <span className="roundel" aria-hidden>
          <i />
        </span>
        <span>
          Run <b>{run}</b> / {total || "—"}
        </span>
        {best === run && <span className="tag tag-lamp">best</span>}
      </div>
      <div className="kpis">
        {tiles.map((t) => (
          <div key={t.key} className={`kpi ${"main" in t && t.main ? "kpi-main" : ""}`}>
            <span className="kpi-label">{t.label}</span>
            <span className="kpi-value">{t.value ?? "…"}</span>
            <Delta value={k && p ? change(p[t.key], k[t.key]) : null} metric={t.key} />
          </div>
        ))}
      </div>
      <div className="hud-foot">14-day totals · vs run {run > 1 ? run - 1 : "—"}</div>
    </section>
  );
}
