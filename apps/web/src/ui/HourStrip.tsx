// 24h strip for one store: visits per hour (bars), open hours (lamp band), lighting level per hour (cells),
// and a cursor at the current sim hour. Optional ghost row shows a comparison config (e.g. last run).
import type { HoursWindow, StoreRunResult } from "../api/contract";
import { openByHour } from "../sim/time";

const LEVEL = { off: 0, low: 0.5, high: 1 } as const;

export function HourStrip({ cfg, hour, prev, licence }: { cfg: StoreRunResult; hour: number; prev?: StoreRunResult; licence?: HoursWindow }) {
  const open = openByHour(cfg.open, cfg.close);
  const licensed = licence && openByHour(licence.open, licence.close);
  const prevOpen = prev && openByHour(prev.open, prev.close);
  const peak = Math.max(1, ...cfg.visitsByHour, ...(prev?.visitsByHour ?? []));
  return (
    <div className="strip" aria-label="24 hour strip">
      <div className="strip-row strip-bars">
        {cfg.visitsByHour.map((v, h) => (
          <span key={h} className="bar-cell">
            {prev && <i className="bar ghost" style={{ height: `${(prev.visitsByHour[h] / peak) * 100}%` }} />}
            <i className="bar" style={{ height: `${(v / peak) * 100}%` }} />
          </span>
        ))}
      </div>
      {licensed && (
        <div className="strip-row strip-licence" title={`licence ${licence.open}–${licence.close}`}>
          {licensed.map((ok, h) => (
            <span key={h} className={`cell ${ok ? "on" : ""}`} />
          ))}
        </div>
      )}
      <div className="strip-row strip-open">
        {open.map((o, h) => (
          <span key={h} className={`cell ${o ? "on" : ""} ${prevOpen && prevOpen[h] !== o ? "changed" : ""}`} />
        ))}
      </div>
      <div className="strip-row strip-light">
        {cfg.lighting.map((l, h) => (
          <span key={h} className={`cell light-${l} ${prev && prev.lighting[h] !== l ? "changed" : ""}`} style={{ ["--lv" as string]: LEVEL[l] }} />
        ))}
      </div>
      <div className="strip-axis">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {String(h % 24).padStart(2, "0")}
          </span>
        ))}
      </div>
      <div className="strip-cursor" style={{ left: `${(hour / 24) * 100}%` }} />
      <div className="strip-legend">
        <span>
          <i className="sw sw-bar" /> visits/h
        </span>
        <span>
          <i className="sw sw-open" /> open
        </span>
        <span>
          <i className="sw sw-light" /> light
        </span>
        {licensed && (
          <span>
            <i className="sw sw-licence" /> licence
          </span>
        )}
        {prev && (
          <span>
            <i className="sw sw-changed" /> changed
          </span>
        )}
      </div>
    </div>
  );
}
