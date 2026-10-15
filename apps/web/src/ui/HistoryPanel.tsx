// History: the main KPI (visits/kWh) across runs, a dashed line where training stopped, and the analyst's
// one-line lab notebook. Click a point or a notebook row → replay that run.
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useState } from "react";
import { useAnalyst, useCalibration, useRuns } from "../state/data";
import { useSim } from "../state/store";
import { LAMP } from "../world/palette";
import { CalibrationPanel } from "./CalibrationPanel";
import { fmtNum } from "./format";
import { Icon } from "./icons";

// SVG attributes take literal colours; these mirror --muted, --grid and --plate in styles.css.
const TICK = "#bfb6a6";
const GRID = "rgba(240,234,221,0.08)";
const PLATE = "#181613";

export function HistoryPanel() {
  const runs = useRuns().data ?? [];
  const analyst = useAnalyst().data;
  const current = useSim((s) => s.run);
  const replay = (run: number) => useSim.getState().replay(run, useSim.getState().t);
  const done = runs.flatMap((r) => (r.status === "done" && r.kpis ? [{ run: r.run, v: r.kpis.visitsPerKwh }] : []));
  const stopRun = analyst?.state === "stopped" && analyst.iterations > 0 ? (done.at(-1)?.run ?? null) : null;
  const data = done;
  const cost = runs.at(-1)?.costPerStoreWeekGbp;
  const hasCalibration = !!useCalibration().data;
  const [tab, setTab] = useState<"runs" | "calibration">("runs");

  return (
    <aside className="history panel" aria-label="Training history">
      <header className="card-head">
        <div>
          <h2>Training history</h2>
          <div className="card-sub">visits / kWh per run · same seed, same 14 days</div>
        </div>
        <button className="icon-btn" onClick={() => useSim.getState().openPanel(null)} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      {hasCalibration && (
        <div className="tabs" role="tablist">
          {(["runs", "calibration"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "runs" ? "Runs" : "Calibration"}
            </button>
          ))}
        </div>
      )}

      {tab === "calibration" && hasCalibration ? (
        <CalibrationPanel />
      ) : (
      <>
      <div className="chart">
        <ResponsiveContainer width="100%" height={170}>
          <LineChart data={data} margin={{ top: 22, right: 18, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="run" tick={{ fill: TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: TICK, fontSize: 12 }} axisLine={false} tickLine={false} domain={["dataMin - 0.05", "dataMax + 0.03"]} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip
              cursor={{ stroke: "rgba(240,234,221,0.2)" }}
              contentStyle={{ background: "var(--panel-solid)", border: "1px solid var(--line-strong)", borderRadius: 4, fontFamily: "var(--font)", fontSize: 13 }}
              labelFormatter={(l) => `Run ${l}`}
              formatter={(v) => [fmtNum(Number(v)), "visits/kWh"]}
            />
            {stopRun && (
              <ReferenceLine x={stopRun} stroke={TICK} strokeDasharray="4 4" label={{ value: "stopped · plateau", position: "insideBottomRight", fill: TICK, fontSize: 12 }} />
            )}
            <Line
              type="monotone"
              dataKey="v"
              stroke={LAMP}
              strokeWidth={2.2}
              isAnimationActive={false}
              dot={(p: { cx?: number; cy?: number; payload?: { run: number } }) => (
                <circle
                  key={p.payload?.run}
                  cx={p.cx}
                  cy={p.cy}
                  r={p.payload?.run === current ? 6 : 4}
                  fill={p.payload?.run === current ? LAMP : PLATE}
                  stroke={LAMP}
                  strokeWidth={2}
                  style={{ cursor: "pointer" }}
                  onClick={() => p.payload && replay(p.payload.run)}
                />
              )}
              activeDot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <ol className="notebook">
        {runs.map((r) => (
          <li key={r.run} className={r.run === current ? "on" : ""}>
            <button onClick={() => replay(r.run)}>
              <span className="nb-run">{r.run}</span>
              <span className="nb-text">{r.notebook}</span>
              {analyst?.bestRun === r.run && <span className="tag tag-lamp">best</span>}
              <Icon name="replay" size={13} className="nb-icon" />
            </button>
          </li>
        ))}
      </ol>
      {cost !== undefined && <div className="foot-note">£{cost.toFixed(2)} / store-week · agent spend</div>}
      </>
      )}
    </aside>
  );
}
