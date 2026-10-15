// App shell: the 3D city fills the screen; everything else is a thin overlay on top.
import { USING_MOCK } from "./api/client";
import { useClock, useHotkeys } from "./state/clock";
import { useEffect } from "react";
import { useAnalyst, useHealth, useMap, useRuns, useRunStores } from "./state/data";
import { RUN_FROM_URL, useSim } from "./state/store";
import { AreaPanel } from "./ui/AreaPanel";
import { BusyPanel } from "./ui/BusyPanel";
import { CityFeedMount } from "./ui/CityFeedMount";
import { AgentsPanel } from "./ui/AgentsPanel";
import { Bot, ChartColumn, PanelsTopLeft } from "lucide-react";
import { AnalystChip } from "./ui/AnalystChip";
import { CompareView } from "./ui/CompareView";
import { DemoBar, DemoChip } from "./ui/DemoBar";
import { GoToBar } from "./ui/GoToBar";
import { HistoryPanel } from "./ui/HistoryPanel";
import { Clock, Hud } from "./ui/Hud";
import { Icon } from "./ui/icons";
import { Legend } from "./ui/Legend";
import { PlaybackBar } from "./ui/PlaybackBar";
import { OwnerReport } from "./ui/OwnerReport";
import { StoreCard } from "./ui/StoreCard";
import { Toast } from "./ui/Toast";
import { Headline } from "./ui/Headline";
import { LayersMenu } from "./ui/LayersMenu";
import { Dropdown, DropdownItem } from "./ui/Dropdown";
import { InterveneMenu } from "./ui/InterveneMenu";
import { PersonCard } from "./ui/PersonCard";
import World from "./world/World";

const VIEW_LABEL: Record<string, string> = { history: "History", agents: "Agents", area: "Area energy", busy: "Busy times", compare: "Before vs after" };

/** Keeps --goto-h = the Go-to bar's height, so the top-right tools sit just below it however it wraps. */
function useGotoHeight(ready: boolean) {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".goto-bar");
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--goto-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
}

export default function App() {
  useClock();
  useHotkeys();
  const { data: map, error } = useMap();
  useGotoHeight(!!map);
  const run = useSim((s) => s.run);
  const stores = useRunStores(run).data;
  const panel = useSim((s) => s.panel);
  const compare = useSim((s) => s.compare);
  const { openPanel, setCompare } = useSim.getState();
  const runs = useRuns().data;
  const analyst = useAnalyst().data;
  const health = useHealth().data;

  // Start on a run that exists: the analyst's best, else the latest finished one (the real backend may only have run 0).
  useEffect(() => {
    if (RUN_FROM_URL || !runs?.length) return;
    const s = useSim.getState();
    if (runs.some((r) => r.run === s.run && r.status === "done")) return;
    const done = runs.filter((r) => r.status === "done");
    const pick = analyst?.bestRun ?? done.at(-1)?.run ?? runs.at(-1)!.run;
    s.setRun(pick);
  }, [runs, analyst]);
  const dataTag = USING_MOCK ? "mock data" : health && (health.mapSource !== "processed" || health.realRuns === 0) ? "sample data" : null;

  if (error) return <div className="splash">Map unavailable · {error.message}</div>;
  if (!map) return <div className="splash">Shoreditch · loading</div>;

  return (
    <main className="app">
      <div className="stage">{compare ? <CompareView /> : <World map={map} run={run} stores={stores} />}</div>

      <div className="overlay">
        <GoToBar />
        <div className="top-left">
          {compare ? (
            <section className="hud panel" aria-label="Shared clock">
              <Clock />
              <div className="hud-foot">one clock · both runs</div>
            </section>
          ) : (
            <Hud />
          )}
          <Headline />
          <PersonCard />
        </div>
        <div className="top-right">
          <AnalystChip onClick={() => openPanel(panel === "agents" ? null : "agents")} />
          <div className="tool-row">
            <DemoChip />
            <InterveneMenu />
            <Dropdown label={VIEW_LABEL[compare ? "compare" : panel ?? ""] ?? "View"} icon={<PanelsTopLeft size={14} />} active={!!panel || compare}>
              {(close) => (
                <>
                  <div className="dd-title">Open</div>
                  <DropdownItem on={panel === "history"} icon={<Icon name="chart" size={14} />} onClick={() => (openPanel(panel === "history" ? null : "history"), close())}>History</DropdownItem>
                  <DropdownItem on={panel === "agents"} icon={<Bot size={14} />} onClick={() => (openPanel(panel === "agents" ? null : "agents"), close())}>Agents</DropdownItem>
                  <DropdownItem on={panel === "area"} icon={<Icon name="bolt" size={14} />} onClick={() => (openPanel(panel === "area" ? null : "area"), close())}>Area energy</DropdownItem>
                  <DropdownItem on={panel === "busy"} icon={<ChartColumn size={14} />} onClick={() => (openPanel(panel === "busy" ? null : "busy"), close())}>Busy times</DropdownItem>
                  <DropdownItem on={compare} icon={<Icon name="split" size={14} />} onClick={() => (setCompare(!compare), close())}>Before vs after</DropdownItem>
                </>
              )}
            </Dropdown>
            {!compare && <LayersMenu />}
            {dataTag && <span className="chip chip-mock" title={health ? `map: ${health.mapSource} · real runs: ${health.realRuns}` : undefined}>{dataTag}</span>}
          </div>
        </div>
        {panel === "history" && <HistoryPanel />}
        {panel === "area" && <AreaPanel />}
        {panel === "busy" && !compare && <BusyPanel />}
        {panel === "agents" && <AgentsPanel />}
        {!compare && <StoreCard />}
        {panel === "report" && <OwnerReport />}
        <CityFeedMount />
        <div className="bottom">
          <Legend />
          <PlaybackBar />
        </div>
        <DemoBar />
        <Toast />
      </div>
    </main>
  );
}
