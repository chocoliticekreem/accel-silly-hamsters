// Persona colours and map symbols, hidden behind one click.
import { useState } from "react";
import { PERSONA_COLORS } from "../world/palette";
import { Icon } from "./icons";

export function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`legend ${open ? "open" : ""}`}>
      <button className="chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="info" size={14} /> Legend
      </button>
      {open && (
        <div className="legend-body panel">
          {Object.entries(PERSONA_COLORS).map(([p, c]) => (
            <span key={p} className="legend-item">
              <i style={{ background: c }} /> {p}
            </span>
          ))}
          <span className="legend-item">
            <i className="lg-column" /> people inside
          </span>
          <span className="legend-item">
            <i className="lg-open" /> open
          </span>
          <span className="legend-item">
            <i className="lg-glow" /> lit window
          </span>
          <span className="legend-keys">space · ←/→ · 1 2 3 · esc</span>
        </div>
      )}
    </div>
  );
}
