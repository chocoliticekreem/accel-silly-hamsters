// Suggestions as diffs: "Close 23:00 → 03:00   ▲ +18% visits  ▲ +5% kWh". Used by the store card and the report.
import type { ReactNode } from "react";
import type { Suggestion } from "../api/contract";
import { Delta } from "./Delta";
import { suggestionLabel } from "./format";

export function SuggestionRow({ s, actions }: { s: Suggestion; actions?: ReactNode }) {
  const l = suggestionLabel(s);
  return (
    <li className="sugg">
      <div className="sugg-diff">
        <span className="sugg-what">{l.what}</span>
        <span className="sugg-from">{l.from}</span>
        <span className="sugg-arrow">→</span>
        <span className="sugg-to">{l.to}</span>
        {s.confidence && <Pips level={s.confidence} />}
      </div>
      <div className="sugg-deltas">
        <Delta value={s.expectedDelta.visits} metric="visits" />
        <span className="unit">visits</span>
        <Delta value={s.expectedDelta.kwh} metric="kwh" />
        <span className="unit">kWh</span>
      </div>
      {s.reason && (
        <div className="sugg-reason" title={s.reason}>
          {s.reason}
        </div>
      )}
      {actions && <div className="sugg-actions">{actions}</div>}
    </li>
  );
}

const PIPS = { low: 1, medium: 2, high: 3 } as const;

/** Three-pip confidence meter (same look as the report's badge). */
export function Pips({ level }: { level: keyof typeof PIPS }) {
  return (
    <span className="pips" title={`${level} confidence`} aria-label={`${level} confidence`}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= PIPS[level] ? "on" : ""} />
      ))}
    </span>
  );
}

export function SuggestionList({ items, empty = "No changes · at best config" }: { items: Suggestion[]; empty?: string }) {
  if (!items.length) return <div className="empty">{empty}</div>;
  return (
    <ul className="sugg-list">
      {items.map((s, i) => (
        <SuggestionRow key={i} s={s} />
      ))}
    </ul>
  );
}
