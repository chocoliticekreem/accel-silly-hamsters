// Calibration: the sim's average day vs Google Popular Times for a few anchor venues (spec: the credibility chart).
// Both curves on the Popular Times scale (busiest hour = 100). Placeholder targets are labelled, never passed off as proof.
import type { CalibrationVenue } from "../api/contract";
import { blendedTarget, meanGap, toPeak100 } from "../sim/calibration";
import { useCalibration, useMap, useRunStores } from "../state/data";
import { useSim } from "../state/store";

const W = 150;
const H = 38;

function path(ys: number[]) {
  return ys.map((y, h) => `${h ? "L" : "M"}${((h + 0.5) / 24) * W},${H - (y / 100) * (H - 2) - 1}`).join(" ");
}

function Row({ v, sim, name }: { v: CalibrationVenue; sim: number[] | undefined; name: string }) {
  const target = blendedTarget(v);
  const simCurve = sim && toPeak100(sim);
  const gap = simCurve && meanGap(simCurve, target);
  return (
    <li>
      <button className="calib-row" onClick={() => useSim.getState().selectStore(v.storeId)}>
        <div className="calib-name">
          <b>{name}</b>
          <span className="muted">{v.name}</span>
          {!v.measured && <span className="tag tag-warn">placeholder</span>}
        </div>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`${name}: sim vs target by hour`}>
          <path d={`${path(target)} L${W},${H} L0,${H} Z`} className="calib-target-area" />
          <path d={path(target)} className="calib-target" />
          {simCurve && <path d={path(simCurve)} className="calib-sim" />}
        </svg>
        <span className="calib-gap mono">{gap === undefined ? "…" : `±${Math.round(gap)}`}</span>
      </button>
    </li>
  );
}

export function CalibrationPanel() {
  const calib = useCalibration().data;
  const run = useSim((s) => s.run);
  const stores = useRunStores(run).data;
  const map = useMap().data;
  if (!calib) return <div className="empty">No calibration data yet</div>;
  const placeholders = calib.venues.filter((v) => !v.measured).length;
  const name = (id: string) => map?.stores.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="calib">
      <div className="calib-legend">
        <span>
          <i className="sw sw-sim" /> sim, run {run}
        </span>
        <span>
          <i className="sw sw-target" /> Popular Times
        </span>
        <span className="muted">gap = mean pts / 100</span>
      </div>
      {placeholders > 0 && (
        <div className="calib-warn">
          {placeholders} of {calib.venues.length} targets are placeholders · not proof
        </div>
      )}
      <ul className="calib-list">
        {calib.venues.map((v) => (
          <Row key={v.storeId} v={v} sim={stores?.[v.storeId]?.visitsByHour} name={name(v.storeId)} />
        ))}
      </ul>
    </div>
  );
}
