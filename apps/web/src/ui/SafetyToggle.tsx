// Toolbar chip: the "Safety" layer (incident density on the ground, place-based, never people).
import { ShieldAlert } from "lucide-react";
import { useIncidents } from "../api/incidents";
import { useEconomy } from "../state/economy";
import { useSafety } from "../state/safety";
import { useSim } from "../state/store";
import "./safety.css";

export function SafetyToggle() {
  const run = useSim((s) => s.run);
  const on = useSafety((s) => s.heat);
  const n = useIncidents(run).data?.length ?? 0;
  if (!n) return null;
  return (
    <button
      className={`chip ${on ? "on" : ""}`}
      aria-pressed={on}
      onClick={() => {
        // one ground layer at a time: the Safety layer replaces the economy heatmap
        if (!on) useEconomy.getState().setHeatmap(null);
        useSafety.getState().setHeat(!on);
      }}
      title="Incident density so far this run."
    >
      <ShieldAlert size={14} /> Safety
    </button>
  );
}
