// The inner learning loop: visits/kWh per sim day for the current run, dots sized by how many owners changed
// something that day, and the baseline run's days as a faint line underneath (the per-run curve is the outer loop).
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RunDay } from "../api/contract";
import { fmtNum } from "./format";
import { actionRadius, dayCaption, dayCurve, type DayPoint } from "./learningCurve";

const LAMP = "#ffc857";
const BASE = "rgba(127, 178, 255, 0.45)";

export function DaysChart({ run, days, baseRun, baseDays }: { run: number; days: RunDay[]; baseRun: number | null; baseDays?: RunDay[] | null }) {
  const data = dayCurve(days, baseDays);
  const hasBase = data.some((d) => d.base !== undefined);
  return (
    <>
      <div className="chart">
        <ResponsiveContainer width="100%" height={170}>
          <LineChart data={data} margin={{ top: 14, right: 18, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: "#8b97ad", fontSize: 11 }} axisLine={false} tickLine={false} ticks={[1, 4, 7, 8, 11, 14]} />
            <YAxis tick={{ fill: "#8b97ad", fontSize: 11 }} axisLine={false} tickLine={false} domain={["dataMin - 0.05", "dataMax + 0.05"]} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip
              cursor={{ stroke: "rgba(255,255,255,0.15)" }}
              contentStyle={{ background: "#141b2b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontFamily: "IBM Plex Mono", fontSize: 12 }}
              labelFormatter={(l, p) => {
                const a = (p?.[0]?.payload as DayPoint | undefined)?.actions ?? 0;
                return `Day ${l} · ${a} owner change${a === 1 ? "" : "s"}`;
              }}
              formatter={(v, name) => [fmtNum(Number(v)), name === "v" ? `run ${run}` : `baseline ${baseRun}`]}
            />
            {hasBase && <Line type="monotone" dataKey="base" stroke={BASE} strokeDasharray="4 3" strokeWidth={1.4} dot={false} activeDot={false} isAnimationActive={false} />}
            <Line
              type="monotone"
              dataKey="v"
              stroke={LAMP}
              strokeWidth={2}
              isAnimationActive={false}
              dot={(p: { cx?: number; cy?: number; payload?: DayPoint }) => (
                <circle
                  key={p.payload?.day}
                  cx={p.cx}
                  cy={p.cy}
                  r={actionRadius(p.payload?.actions ?? 0)}
                  fill={(p.payload?.actions ?? 0) > 0 ? "rgba(255,200,87,0.55)" : "#141b2b"}
                  stroke={LAMP}
                  strokeWidth={1.5}
                />
              )}
              activeDot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="calib-legend">
        <span>
          <i className="sw sw-sim" /> run {run}
        </span>
        {hasBase && (
          <span>
            <i className="sw sw-target" /> baseline {baseRun}
          </span>
        )}
        <span>
          <i className="sw-dot" /> dot size = owner changes that day
        </span>
      </div>
      <div className="foot-note">{dayCaption(data)}</div>
    </>
  );
}
