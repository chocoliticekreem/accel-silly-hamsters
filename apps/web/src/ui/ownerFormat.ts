// Labels and icons for owner decisions and street events (docs/OWNER_ACTIONS.md), shared by CityFeed,
// OwnerTimeline and WeekSchedule. Short labels only; the owner's own sentence is `reason`.
import { Ban, CalendarCheck, CalendarX, Car, Clock, CloudRain, Construction, DoorClosed, LightbulbOff, Moon, Music, PartyPopper, Sunset, type LucideIcon } from "lucide-react";
import type { OwnerAction, OwnerEvent, OwnerTriggerKind, StreetEvent, StreetEventKind } from "../api/contract";
import { formatHHMM } from "../sim/time";
import { dayAt, WEEKDAY_NAMES, weekdayIndex } from "../sim/storeState";

export const ACTION_ICON: Record<OwnerAction, LucideIcon> = {
  hours_changed: Clock,
  day_closed: CalendarX,
  day_reopened: CalendarCheck,
  shut_early: Sunset,
  open_late: Moon,
  temporary_closure: DoorClosed,
  lighting_changed: LightbulbOff,
  closed_permanently: Ban,
};

export const STREET_ICON: Record<StreetEventKind, LucideIcon> = {
  roadworks: Construction,
  heavy_traffic: Car,
  club_night: Music,
  event: PartyPopper,
  weather: CloudRain,
};

const TRIGGER: Record<OwnerTriggerKind, string> = {
  missed_demand: "people found it shut",
  empty_hours: "empty hours",
  dead_day: "quiet day",
  roadworks: "roadworks outside",
  heavy_traffic: "heavy traffic",
  club_night: "club night",
  event: "event nearby",
  weather: "bad weather",
  losses: "losing money",
  lights_waste: "lights on while shut",
};

export const triggerPhrase = (e: OwnerEvent) => (e.trigger ? TRIGGER[e.trigger.kind] : null);

/** "shut early at 15:00", "open till 03:00 tonight", "hours 23:00 → 00:00". */
export function actionLabel(e: OwnerEvent): string {
  const arrow = e.from && e.to ? `${e.from} → ${e.to}` : (e.to ?? "");
  switch (e.action) {
    case "shut_early":
      return e.to ? `shut early at ${e.to}` : "shut early";
    case "open_late":
      return e.to ? `open till ${e.to} tonight` : "open late tonight";
    case "hours_changed":
      return arrow ? `hours ${arrow}` : "hours changed";
    case "day_closed":
      return e.to ? `closed ${e.to}s` : "closed a day";
    case "day_reopened":
      return e.to ? `open ${e.to}s again` : "reopened a day";
    case "temporary_closure":
      return e.to ? `closed until ${e.to}` : "closed for now";
    case "lighting_changed":
      return e.to ? `window lights ${e.to} after close` : "lighting changed";
    case "closed_permanently":
      return "closed for good";
  }
}

/** "Day 3 · 15:00" */
export const momentLabel = (t: number) => `Day ${dayAt(t)} · ${formatHHMM(t)}`;
/** "Wed 15:00" */
export const weekdayTime = (t: number) => `${WEEKDAY_NAMES[weekdayIndex(dayAt(t))].slice(0, 3)} ${formatHHMM(t)}`;

export type FeedItem =
  | { key: string; kind: "owner"; t: number; event: OwnerEvent; storeName: string; text: string }
  | { key: string; kind: "street"; t: number; events: StreetEvent[]; text: string; live: boolean };

const STREET_TEXT: Record<StreetEventKind, string> = {
  roadworks: "Roadworks",
  heavy_traffic: "Heavy traffic",
  club_night: "Club night",
  event: "Event",
  weather: "Weather",
};

/** Street-event label minus its kind prefix: "Roadworks, Brick Ln" → "Brick Ln". */
function place(e: StreetEvent) {
  const i = e.label.indexOf(", ");
  return i >= 0 ? e.label.slice(i + 2) : e.label;
}

/**
 * The city feed at sim minute `t`: owner decisions and street events from the last `windowMin` minutes,
 * newest first. Street events of the same kind starting together are merged ("Heavy traffic · Old St, Shoreditch High St").
 */
export function feedItems(
  owner: readonly OwnerEvent[],
  street: readonly StreetEvent[],
  t: number,
  windowMin: number,
  storeName: (id: string) => string,
): FeedItem[] {
  const out: FeedItem[] = [];
  for (const e of owner) {
    if (e.t > t || e.t <= t - windowMin) continue;
    const why = triggerPhrase(e);
    out.push({ key: `o:${e.storeId}:${e.t}:${e.action}`, kind: "owner", t: e.t, event: e, storeName: storeName(e.storeId), text: `${storeName(e.storeId)} ${actionLabel(e)}${why ? ` · ${why}` : ""}` });
  }
  const groups = new Map<string, StreetEvent[]>();
  for (const e of street) {
    // recent starts, plus anything still going on (multi-day roadworks)
    if (e.fromT > t || (e.fromT <= t - windowMin && t >= e.toT)) continue;
    const k = `${e.kind}:${e.fromT}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const [k, events] of groups) {
    const places = [...new Set(events.map(place))].join(", ");
    out.push({ key: `s:${k}`, kind: "street", t: events[0].fromT, events, text: `${STREET_TEXT[events[0].kind]} · ${places}`, live: events.some((e) => t < e.toT) });
  }
  // newest first; at the same minute, owners reacting sit above the street event
  return out.sort((a, b) => b.t - a.t || (a.kind === b.kind ? 0 : a.kind === "owner" ? -1 : 1));
}
