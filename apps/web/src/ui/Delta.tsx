// A +/− change chip, coloured good/bad by metric direction.
import { fmtPct, UP_IS_GOOD } from "./format";

export function Delta({ value, metric, size = "sm" }: { value: number | null | undefined; metric: string; size?: "sm" | "md" }) {
  if (value === null || value === undefined) return <span className={`delta delta-none delta-${size}`}>—</span>;
  const pct = Math.round(value * 100);
  const good = pct === 0 ? null : (pct > 0) === (UP_IS_GOOD[metric] ?? true);
  const cls = good === null ? "delta-flat" : good ? "delta-good" : "delta-bad";
  return (
    <span className={`delta ${cls} delta-${size}`}>
      {pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} {fmtPct(value)}
    </span>
  );
}
