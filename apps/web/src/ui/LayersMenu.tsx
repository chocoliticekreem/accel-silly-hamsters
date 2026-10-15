// "Layers" dropdown: one ground layer at a time: none, footfall, missed demand, wealth (world/modules/Heatmap) or
// Safety (incident density, places never people). Replaces the Heatmap segmented row and the Safety chip.
import { Layers } from "lucide-react";
import { useIncidents } from "../api/incidents";
import { useEconomy, type HeatmapLayer } from "../state/economy";
import { useSafety } from "../state/safety";
import { useSim } from "../state/store";
import { Dropdown, DropdownItem } from "./Dropdown";
import "./economy.css";

type Layer = Exclude<HeatmapLayer, null> | "safety" | null;

const LAYERS: { id: Layer; label: string; hint: string; scale?: string }[] = [
  { id: null, label: "None", hint: "No ground layer" },
  { id: "footfall", label: "Footfall", hint: "Time people spent on foot here today", scale: "quiet → busy" },
  { id: "missed", label: "Missed demand", hint: "People who walked to a shop today and found it shut", scale: "few → many found it shut" },
  { id: "wealth", label: "Wealth", hint: "Shop owners' money at the end of today, around their homes", scale: "in debt → well off" },
  { id: "safety", label: "Safety", hint: "Incident density so far this run.", scale: "fewer → more incidents" },
];

export function LayersMenu() {
  const run = useSim((s) => s.run);
  const heat = useEconomy((s) => s.heatmap);
  const safety = useSafety((s) => s.heat);
  const incidents = useIncidents(run).data?.length ?? 0;
  const current: Layer = safety ? "safety" : heat;
  const pick = (id: Layer) => {
    useSafety.getState().setHeat(id === "safety");
    useEconomy.getState().setHeatmap(id === "safety" ? null : id);
  };
  const now = LAYERS.find((l) => l.id === current);
  return (
    <Dropdown label={current ? now?.label : "Layers"} icon={<Layers size={14} />} active={current !== null}>
      {(close) => (
        <>
          <div className="dd-title">Ground layer</div>
          {LAYERS.filter((l) => l.id !== "safety" || incidents > 0).map((l) => (
            <DropdownItem
              key={l.label}
              on={current === l.id}
              hint={l.hint}
              onClick={() => {
                pick(l.id);
                close();
              }}
            >
              {l.label}
            </DropdownItem>
          ))}
          {now?.scale && <div className={`dd-note heat-scale heat-${current === "safety" ? "missed" : current}`}>{now.scale}</div>}
        </>
      )}
    </Dropdown>
  );
}
