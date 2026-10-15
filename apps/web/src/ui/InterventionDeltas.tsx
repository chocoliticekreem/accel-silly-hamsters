// The what-if delta strip under compare mode: the area's numbers, fork vs baseline, over the same 14 days.
import { useRuns } from "../state/data";
import { useOwners } from "../state/economy";
import { Delta } from "./Delta";
import "./economy.css";
import { change, fmtInt, fmtNum } from "./format";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function InterventionDeltas({ base, other }: { base: number; other: number }) {
  const runs = useRuns().data;
  const a = runs?.find((r) => r.run === base)?.kpis;
  const b = runs?.find((r) => r.run === other)?.kpis;
  const oa = useOwners(base).data;
  const ob = useOwners(other).data;
  const takings = (o: typeof oa) => (o?.length ? sum(o.map((x) => x.totals.takingsGbp)) : undefined);
  const energy = (o: typeof oa) => (o?.length ? sum(o.map((x) => x.totals.energyGbp)) : undefined);
  const struggling = (o: typeof oa) => (o?.length ? o.filter((x) => x.status !== "trading").length : undefined);
  const tiles: { label: string; value?: string | null; d: number | null; metric: string }[] = [
    { label: "Shop visits", value: b && fmtInt(b.visits), d: change(a?.visits, b?.visits), metric: "visits" },
    { label: "kWh", value: b && fmtInt(b.kwh), d: change(a?.kwh, b?.kwh), metric: "kwh" },
    { label: "Visits / kWh", value: b && fmtNum(b.visitsPerKwh), d: change(a?.visitsPerKwh, b?.visitsPerKwh), metric: "visitsPerKwh" },
  ];
  if (ob?.length) {
    tiles.push(
      { label: "Takings", value: `£${fmtInt(takings(ob)!)}`, d: change(takings(oa), takings(ob)), metric: "visits" },
      // energy bill up is bad: reuse the kWh direction
      { label: "Energy bill", value: `£${fmtInt(energy(ob)!)}`, d: change(energy(oa), energy(ob)), metric: "kwh" },
    );
  }
  const sa = struggling(oa);
  const sb = struggling(ob);
  return (
    <div className="delta-strip panel" aria-label="What-if deltas">
      {tiles.map((t) => (
        <div key={t.label} className="ds-tile">
          <span className="kpi-label">{t.label}</span>
          <b>{t.value ?? "…"}</b>
          <Delta value={t.d} metric={t.metric} />
        </div>
      ))}
      {sb !== undefined && (
        <div className="ds-tile">
          <span className="kpi-label">Owners struggling</span>
          <b>{sb}</b>
          <span className={`delta delta-sm ${sa === undefined || sa === sb ? "delta-flat" : sb > sa ? "delta-bad" : "delta-good"}`}>
            {sa === undefined ? "—" : sb === sa ? "same" : `${sb > sa ? "+" : "−"}${Math.abs(sb - sa)}`}
          </span>
        </div>
      )}
      <span className="ds-note">same seed · 14-day totals vs run {base}</span>
    </div>
  );
}
