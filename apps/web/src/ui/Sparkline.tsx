// A tiny inline line chart (no axes): a trend at a glance. Marks the point `at` (e.g. today) when given.
export function Sparkline({ values, width = 120, height = 28, at, className }: { values: number[]; width?: number; height?: number; at?: number; className?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - lo) / span) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const zero = lo < 0 && hi > 0 ? y(0) : null;
  const k = at != null ? Math.max(0, Math.min(values.length - 1, at)) : null;
  return (
    <svg className={`spark ${className ?? ""}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {zero != null && <line x1={0} x2={width} y1={zero} y2={zero} className="spark-zero" />}
      <path d={d} className="spark-line" />
      {k != null && <circle cx={x(k)} cy={y(values[k])} r={2.6} className="spark-dot" />}
    </svg>
  );
}
