// Area view ("zoom out"): the whole high street, anonymised totals only (no store ids, per the data firewall).
// This run vs the baseline: kWh, CO₂ and £ energy over the 14 days, the evening peak, and the demand curve.
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAnalyst, useRuns, useSummary } from "../state/data";
import { useSim } from "../state/store";
import { LAMP } from "../world/palette";
import { Delta } from "./Delta";
import { change, fmtInt } from "./format";
import { Icon } from "./icons";

// SVG attributes take literal colours; these mirror --context, --muted and --grid in styles.css.
const BASE = "rgba(240,234,221,0.5)";
const TICK = "#bfb6a6";
const GRID = "rgba(240,234,221,0.08)";

export function AreaPanel() {
  const run = useSim((s) => s.run);
  const analyst = useAnalyst().data;
  const runs = useRuns().data;
  const baseRun = analyst?.baselineRun ?? runs?.find((r) => r.status === "done")?.run ?? run;
  const cur = useSummary(run).data;
  const base = useSummary(baseRun === run ? null : baseRun).data ?? (baseRun === run ? cur : undefined);
  const close = () => useSim.getState().openPanel(null);

  const data = cur?.demandByHourKw.map((kw, h) => ({ h, kw, base: base?.demandByHourKw[h] }));
  const sameRun = baseRun === run;
  const tiles = cur && [
    { key: "kwh", label: "kWh", value: fmtInt(cur.kpis.kwh), d: change(base?.kpis.kwh, cur.kpis.kwh) },
    { key: "kwh", label: "CO₂ kg", value: fmtInt(cur.co2Kg), d: change(base?.co2Kg, cur.co2Kg) },
    { key: "kwh", label: "£ energy", value: `£${fmtInt(cur.energyCostGbp)}`, d: change(base?.energyCostGbp, cur.energyCostGbp) },
    { key: "kwh", label: `Peak kW · ${String(cur.peakHour).padStart(2, "0")}:00`, value: cur.peakKw.toFixed(1), d: change(base?.peakKw, cur.peakKw) },
  ];

  return (
    <aside className="history area panel" aria-label="Area view">
      <header className="card-head">
        <div>
          <h2>High street</h2>
          <div className="card-sub">area totals · 14 days · no store data</div>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      {cur === null && <div className="empty">No area summary for run {run}</div>}
      {cur === undefined && <div className="empty">…</div>}
      {cur && tiles && (
        <>
          <div className="mini-kpis area-kpis">
            {tiles.map((t) => (
              <div key={t.label} className="mini-kpi">
                <span className="kpi-label">{t.label}</span>
                <span className="kpi-value">{t.value}</span>
                {!sameRun && <Delta value={t.d} metric={t.key} />}
              </div>
            ))}
          </div>
          <div className="foot-note">{sameRun ? `run ${run} is the baseline` : `run ${run} vs baseline run ${baseRun}`}</div>

          <h3 className="section-title">
            Demand by hour <span className="muted">kW</span>
          </h3>
          <div className="chart">
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -22 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="h" tick={{ fill: TICK, fontSize: 12 }} axisLine={false} tickLine={false} ticks={[0, 6, 12, 18, 23]} tickFormatter={(h: number) => String(h).padStart(2, "0")} />
                <YAxis tick={{ fill: TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "var(--panel-solid)", border: "1px solid var(--line-strong)", borderRadius: 4, fontFamily: "var(--font)", fontSize: 13 }}
                  labelFormatter={(h) => `${String(h).padStart(2, "0")}:00`}
                  formatter={(v, name) => [`${Number(v).toFixed(1)} kW`, name === "kw" ? `run ${run}` : `baseline ${baseRun}`]}
                />
                {!sameRun && <Line type="monotone" dataKey="base" stroke={BASE} strokeDasharray="4 3" dot={false} strokeWidth={1.5} isAnimationActive={false} />}
                <Area type="monotone" dataKey="kw" stroke={LAMP} fill={LAMP} fillOpacity={0.16} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="calib-legend">
            <span>
              <i className="sw sw-sim" /> run {run}
            </span>
            {!sameRun && (
              <span>
                <i className="sw sw-target" /> baseline {baseRun}
              </span>
            )}
            <span className="muted">
              {fmtInt(cur.agents.total)} people · {Math.round((cur.agents.returning / Math.max(1, cur.agents.total)) * 100)}% regulars
            </span>
          </div>
        </>
      )}
    </aside>
  );
}
