// App shell: the 3D city fills the screen; everything else is a thin overlay on top.
import { useClock, useHotkeys } from "./state/clock";
import { useEffect, useRef } from "react";
import { useAnalyst, useMap, useRuns, useRunStores } from "./state/data";
import { RUN_FROM_URL, useSim } from "./state/store";
import { AreaPanel } from "./ui/AreaPanel";
import { CityFeedMount } from "./ui/CityFeedMount";
import { AgentsPanel } from "./ui/AgentsPanel";
import { Bot, PanelsTopLeft } from "lucide-react";
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
import { BusinessCard } from "./ui/BusinessCard";
import { BusinessesChip } from "./ui/BusinessesChip";
import { Toast } from "./ui/Toast";
import { Headline } from "./ui/Headline";
import { LayersMenu } from "./ui/LayersMenu";
import { Dropdown, DropdownItem } from "./ui/Dropdown";
import { InterveneMenu } from "./ui/InterveneMenu";
import { PersonCard } from "./ui/PersonCard";
import World from "./world/World";

const VIEW_LABEL: Record<string, string> = { history: "History", agents: "Agents", area: "Area energy", compare: "Before vs after" };

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
  const analystRes = useAnalyst();
  const analyst = analystRes.data;
  const analystSettled = analyst !== undefined || !!analystRes.error;

  // Open on the analyst's best run (else the latest finished one), once, unless the URL picked a run. A deployed API
  // may only carry the day files of its latest runs, so staying on run 1 could show an empty street.
  const snapped = useRef(false);
  useEffect(() => {
    if (RUN_FROM_URL || !runs?.length || snapped.current || !analystSettled) return;
    snapped.current = true;
    const s = useSim.getState();
    const done = runs.filter((r) => r.status === "done");
    const pick = analyst?.bestRun ?? done.at(-1)?.run ?? runs.at(-1)!.run;
    if (pick !== s.run) s.setRun(pick);
  }, [runs, analyst, analystSettled]);

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
                  <DropdownItem on={compare} icon={<Icon name="split" size={14} />} onClick={() => (setCompare(!compare), close())}>Before vs after</DropdownItem>
                </>
              )}
            </Dropdown>
            {!compare && <LayersMenu />}
            {!compare && <BusinessesChip />}
          </div>
        </div>
        {panel === "history" && <HistoryPanel />}
        {panel === "area" && <AreaPanel />}
        {panel === "agents" && <AgentsPanel />}
        {!compare && <StoreCard />}
        {!compare && <BusinessCard />}
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
