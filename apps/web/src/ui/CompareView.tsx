// Compare mode: run 1 vs the best run, side by side on one clock and one shared camera.
import { useAnalyst, useMap, useRuns, useRunStores } from "../state/data";
import World from "../world/World";
import { Delta } from "./Delta";
import { change, fmtNum } from "./format";

export function CompareView() {
  const map = useMap().data;
  const best = useAnalyst().data?.bestRun ?? 1;
  const runs = useRuns().data;
  const left = useRunStores(1).data;
  const right = useRunStores(best).data;
  if (!map) return null;
  const k1 = runs?.find((r) => r.run === 1)?.kpis;
  const kb = runs?.find((r) => r.run === best)?.kpis;
  return (
    <div className="compare">
      <div className="compare-pane">
        <World map={map} run={1} stores={left} cameraGroup="compare" />
        <div className="compare-label panel">
          <b>Run 1</b> <span className="muted">owners today</span>
          {k1 && <span className="mono">{fmtNum(k1.visitsPerKwh)} v/kWh</span>}
        </div>
      </div>
      <div className="compare-pane">
        <World map={map} run={best} stores={right} cameraGroup="compare" />
        <div className="compare-label panel">
          <b>Run {best}</b> <span className="tag tag-lamp">best</span>
          {kb && <span className="mono">{fmtNum(kb.visitsPerKwh)} v/kWh</span>}
          <Delta value={change(k1?.visitsPerKwh, kb?.visitsPerKwh)} metric="visitsPerKwh" />
        </div>
      </div>
    </div>
  );
}
