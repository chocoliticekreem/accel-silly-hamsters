// App shell: the 3D city fills the screen; everything else is a thin overlay on top.
import { USING_MOCK } from "./api/client";
import { useClock, useHotkeys } from "./state/clock";
import { useMap, useRunStores } from "./state/data";
import { useSim } from "./state/store";
import { AnalystChip } from "./ui/AnalystChip";
import { CompareView } from "./ui/CompareView";
import { HistoryPanel } from "./ui/HistoryPanel";
import { Hud } from "./ui/Hud";
import { Icon } from "./ui/icons";
import { Legend } from "./ui/Legend";
import { OwnerReport } from "./ui/OwnerReport";
import { PlaybackBar } from "./ui/PlaybackBar";
import { StoreCard } from "./ui/StoreCard";
import { Toast } from "./ui/Toast";
import World from "./world/World";

export default function App() {
  useClock();
  useHotkeys();
  const { data: map, error } = useMap();
  const run = useSim((s) => s.run);
  const stores = useRunStores(run).data;
  const panel = useSim((s) => s.panel);
  const compare = useSim((s) => s.compare);
  const { openPanel, setCompare } = useSim.getState();

  if (error) return <div className="splash">Map unavailable · {error.message}</div>;
  if (!map) return <div className="splash">Shoreditch · loading</div>;

  return (
    <main className="app">
      <div className="stage">{compare ? <CompareView /> : <World map={map} run={run} stores={stores} />}</div>

      <div className="overlay">
        <div className="top-left">{!compare && <Hud />}</div>
        <div className="top-right">
          <AnalystChip onClick={() => openPanel(panel === "history" ? null : "history")} />
          <div className="tool-row">
            <button className={`chip ${panel === "history" ? "on" : ""}`} onClick={() => openPanel(panel === "history" ? null : "history")}>
              <Icon name="chart" size={14} /> History
            </button>
            <button className={`chip ${compare ? "on" : ""}`} onClick={() => setCompare(!compare)}>
              <Icon name="split" size={14} /> {compare ? "Exit compare" : "Run 1 vs best"}
            </button>
            {USING_MOCK && <span className="chip chip-mock">mock data</span>}
          </div>
        </div>
        {panel === "history" && <HistoryPanel />}
        {!compare && <StoreCard />}
        {panel === "report" && <OwnerReport />}
        <div className="bottom">
          <Legend />
          <PlaybackBar />
        </div>
        <Toast />
      </div>
    </main>
  );
}
