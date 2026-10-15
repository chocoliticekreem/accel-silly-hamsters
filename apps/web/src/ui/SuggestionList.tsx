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
      </div>
      <div className="sugg-deltas">
        <Delta value={s.expectedDelta.visits} metric="visits" />
        <span className="unit">visits</span>
        <Delta value={s.expectedDelta.kwh} metric="kwh" />
        <span className="unit">kWh</span>
      </div>
      {actions && <div className="sugg-actions">{actions}</div>}
    </li>
  );
}

export function SuggestionList({ items }: { items: Suggestion[] }) {
  if (!items.length) return <div className="empty">No changes · at best config</div>;
  return (
    <ul className="sugg-list">
      {items.map((s, i) => (
        <SuggestionRow key={i} s={s} />
      ))}
    </ul>
  );
}
