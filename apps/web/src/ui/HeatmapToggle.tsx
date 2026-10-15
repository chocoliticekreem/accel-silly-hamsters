// Ground heatmap switch: off / footfall / missed demand / wealth (world/modules/Heatmap.tsx draws it).
import { Layers } from "lucide-react";
import { useEconomy, type HeatmapLayer } from "../state/economy";
import "./economy.css";

const LAYERS: { id: HeatmapLayer; label: string; hint: string }[] = [
  { id: null, label: "Off", hint: "No heatmap" },
  { id: "footfall", label: "Footfall", hint: "Time people spent on foot here today" },
  { id: "missed", label: "Missed", hint: "People who walked to a shop today and found it shut" },
  { id: "wealth", label: "Wealth", hint: "Shop owners' money at the end of today, around their homes" },
];

const SCALE: Record<Exclude<HeatmapLayer, null>, string> = {
  footfall: "quiet → busy",
  missed: "few → many found it shut",
  wealth: "in debt → well off",
};

export function HeatmapToggle() {
  const layer = useEconomy((s) => s.heatmap);
  const set = useEconomy((s) => s.setHeatmap);
  return (
    <div className="heat-toggle panel" role="group" aria-label="Heatmap">
      <span className="heat-title">
        <Layers size={13} /> Heatmap
      </span>
      <div className="heat-seg">
        {LAYERS.map((l) => (
          <button key={l.label} className={layer === l.id ? "on" : ""} aria-pressed={layer === l.id} title={l.hint} onClick={() => set(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      {layer && (
        <div className={`heat-scale heat-${layer}`}>
          <i aria-hidden />
          <span>{SCALE[layer]}</span>
        </div>
      )}
    </div>
  );
}
