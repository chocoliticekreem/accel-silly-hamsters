// Persona colours and map symbols, hidden behind one click. Each line names its unit: the coloured figures and the
// columns count sim citizens; the grey background crowd is people on the street (the backend's people-per-agent scale).
import { useState } from "react";
import { useHealth, useMap } from "../state/data";
import { CROWD_TONES } from "../world/modules/Footfall";
import { PERSONA_COLORS } from "../world/palette";
import { fmtInt } from "./format";
import { Icon } from "./icons";

export function Legend() {
  const [open, setOpen] = useState(false);
  const sources = useMap().data?.sources ?? [];
  const scale = useHealth().data?.peoplePerAgent;
  return (
    <div className={`legend ${open ? "open" : ""}`}>
      <button className="chip" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Legend">
        <Icon name="info" size={14} /> <span className="chip-label">Legend</span>
      </button>
      {open && (
        <div className="legend-body panel">
          <span className="legend-item">sim citizens · shirt = persona</span>
          {Object.entries(PERSONA_COLORS).map(([p, c]) => (
            <span key={p} className="legend-item">
              <i style={{ background: c }} /> {p}
            </span>
          ))}
          {scale ? (
            <span className="legend-item">
              <i style={{ background: CROWD_TONES[1], flexShrink: 0 }} /> background crowd ≈ people on the street · {fmtInt(scale)} per sim citizen
            </span>
          ) : null}
          <span className="legend-item">
            <i className="lg-column" /> sim citizens inside
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
