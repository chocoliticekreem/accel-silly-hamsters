// History: the main KPI (visits/kWh) across runs, a dashed line where training stopped, and the analyst's
// one-line lab notebook. Click a point or a notebook row → replay that run.
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAnalyst, useRuns } from "../state/data";
import { useSim } from "../state/store";
import { fmtNum } from "./format";
import { Icon } from "./icons";

const LAMP = "#ffc857";

export function HistoryPanel() {
  const runs = useRuns().data ?? [];
  const analyst = useAnalyst().data;
  const current = useSim((s) => s.run);
  const replay = (run: number) => useSim.getState().replay(run, useSim.getState().t);
  const done = runs.flatMap((r) => (r.status === "done" && r.kpis ? [{ run: r.run, v: r.kpis.visitsPerKwh }] : []));
  const stopRun = analyst?.state === "stopped" && analyst.iterations > 0 ? (done.at(-1)?.run ?? null) : null;
  const data = done;
  const cost = runs.at(-1)?.costPerStoreWeekGbp;

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

      <div className="chart">
        <ResponsiveContainer width="100%" height={170}>
          <LineChart data={data} margin={{ top: 22, right: 18, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="run" tick={{ fill: "#8b97ad", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#8b97ad", fontSize: 11 }} axisLine={false} tickLine={false} domain={["dataMin - 0.05", "dataMax + 0.03"]} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip
              cursor={{ stroke: "rgba(255,255,255,0.15)" }}
              contentStyle={{ background: "#141b2b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontFamily: "IBM Plex Mono", fontSize: 12 }}
              labelFormatter={(l) => `Run ${l}`}
              formatter={(v) => [fmtNum(Number(v)), "visits/kWh"]}
            />
            {stopRun && (
              <ReferenceLine x={stopRun} stroke="#8b97ad" strokeDasharray="4 4" label={{ value: "stopped · plateau", position: "insideBottomRight", fill: "#8b97ad", fontSize: 10 }} />
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
                  fill={p.payload?.run === current ? LAMP : "#141b2b"}
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
    </aside>
  );
}
