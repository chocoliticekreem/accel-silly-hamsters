// City feed (area view): a live ticker of owner decisions and street events around the current sim time,
// newest first. "Day 3 · 15:00 · Kebab Co shut early at 15:00 · roadworks outside".
// Click an owner decision → select that shop and jump to the moment; click a street event → jump to its start.
import { Radio } from "lucide-react";
import { useMemo } from "react";
import { useMap, useOwnerEvents, useStreetEvents } from "../state/data";
import { useSim } from "../state/store";
import { ACTION_ICON, feedItems, feedRows, momentLabel, STREET_ICON, type FeedItem } from "./ownerFormat";

export interface CityFeedProps {
  /** Run to show; defaults to the run on screen. */
  run?: number;
  /** How far back to look, in sim hours (default 24). */
  windowHours?: number;
  /** Max rows (default 6). */
  limit?: number;
  className?: string;
}

export function CityFeed({ run: runProp, windowHours = 24, limit = 6, className = "" }: CityFeedProps) {
  const simRun = useSim((s) => s.run);
  const run = runProp ?? simRun;
  // re-render every 5 sim minutes, not every frame
  const t = useSim((s) => Math.floor(s.t / 5) * 5);
  const map = useMap().data;
  const owner = useOwnerEvents(run).data;
  const street = useStreetEvents(run).data;

  const names = useMemo(() => new Map((map?.stores ?? []).map((s) => [s.id, s.name])), [map]);
  const items = useMemo(
    () => feedItems(owner ?? [], street ?? [], t, windowHours * 60, (id) => names.get(id) ?? id),
    [owner, street, t, windowHours, names],
  );
  // nothing served (old backend): stay out of the way
  if (!owner?.length && !street?.length) return null;

  const live = items.filter((i): i is Extract<FeedItem, { kind: "street" }> => i.kind === "street" && i.live && i.events[0].kind !== "heavy_traffic");
  const traffic = items.some((i) => i.kind === "street" && i.live && i.events[0].kind === "heavy_traffic");
  // live street events sit in the "now" strip above; owners' decisions get the rows first
  const rows = feedRows(
    items.filter((i) => !(i.kind === "street" && i.live)),
    limit,
  );

  const jump = (item: FeedItem) => {
    const s = useSim.getState();
    if (item.kind === "owner") s.selectStore(item.event.storeId);
    s.setT(item.t);
  };

  return (
    <section className={`city-feed panel ${className}`} aria-label="City feed">
      <header className="city-feed-head">
        <Radio size={14} aria-hidden />
        <span>City feed</span>
        <span className="city-feed-window">last {windowHours}h</span>
      </header>
      {(live.length > 0 || traffic) && (
        <div className="city-feed-now">
          {live.map((i) => {
            const Icon = STREET_ICON[i.events[0].kind];
            return (
              <button key={i.key} className={`feed-now feed-now-${i.events[0].kind}`} onClick={() => jump(i)} title={i.events.map((e) => e.label).join(" · ")}>
                <Icon size={12} aria-hidden /> {i.text}
              </button>
            );
          })}
          {traffic && (
            <span className="feed-now feed-now-heavy_traffic">
              <STREET_ICON.heavy_traffic size={12} aria-hidden /> Rush hour
            </span>
          )}
        </div>
      )}
      {rows.length ? (
        <ol className="city-feed-list">
          {rows.map((i) => {
            const Icon = i.kind === "owner" ? ACTION_ICON[i.event.action] : STREET_ICON[i.events[0].kind];
            return (
              <li key={i.key}>
                <button
                  className={`feed-item feed-${i.kind === "owner" ? `action-${i.event.action}` : `street-${i.events[0].kind}`}`}
                  onClick={() => jump(i)}
                  title={i.kind === "owner" ? i.event.reason : i.events.map((e) => e.label).join(" · ")}
                >
                  <span className="feed-icon">
                    <Icon size={13} aria-hidden />
                  </span>
                  <span className="feed-when mono">{momentLabel(i.t)}</span>
                  <span className="feed-text">{i.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="city-feed-empty">Quiet on the street</div>
      )}
    </section>
  );
}
