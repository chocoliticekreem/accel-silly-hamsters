// Persona colours and map symbols, hidden behind one click.
import { useState } from "react";
import { useMap } from "../state/data";
import { PERSONA_COLORS } from "../world/palette";
import { Icon } from "./icons";

export function Legend() {
  const [open, setOpen] = useState(false);
  const sources = useMap().data?.sources ?? [];
  return (
    <div className={`legend ${open ? "open" : ""}`}>
      <button className="chip" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Legend">
        <Icon name="info" size={14} /> <span className="chip-label">Legend</span>
      </button>
      {open && (
        <div className="legend-body panel">
          {Object.entries(PERSONA_COLORS).map(([p, c]) => (
            <span key={p} className="legend-item">
              <i style={{ background: c }} /> {p}
            </span>
          ))}
          <span className="legend-item">
            <i style={{ background: "#9aa3b2" }} /> background crowd · 1 agent ≈ 48 people
          </span>
          <span className="legend-item">
            <i className="lg-column" /> people inside
          </span>
          <span className="legend-item">
            <i className="lg-open" /> open
          </span>
          <span className="legend-item">
            <i className="lg-glow" /> lit window
          </span>
          {sources.length > 0 && (
            <div className="legend-sources">
              {sources.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                  {s.label}
                </a>
              ))}
            </div>
          )}
          <span className="legend-keys">space · ←/→ · 1 2 3 · esc</span>
        </div>
      )}
    </div>
  );
}
