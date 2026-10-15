// A shop's state at any sim minute once owners adapt day by day (docs/OWNER_ACTIONS.md).
// Pure: the 3D world, the UI and the mock sim all read opening and lighting through these helpers,
// so what you see in 3D is exactly what the simulated customers found.
//
// Rules, in order:
// - `closedFromDay` (or a closed_permanently event, from the next day): shut and dark for good.
// - temporary_closure: whole days shut. `from` / `to` are weekday names ("Thursday", "Thu") or "Day N";
//   `from` defaults to the day after the decision, `to` is the day the shop reopens (exclusive).
// - `schedule`: the weekly hours in effect on that day (latest entry with fromDay <= day). Day 1 = Monday.
//   Absent = `open`/`close` every day (the pre-adaptation behaviour).
// - today-only actions on that day: shut_early (close earlier, `to` = new close) and open_late (`to` = new close).
// - Hours past midnight belong to the day they started: at 01:00 on Day 5 the shop is open if Day 4's hours run past 01:00.
// - Lighting: the run's 24h lighting, except off when closed for good or shut all day, and a lighting_changed
//   event changes closed-hour lighting from `from` (any level when absent) to `to`.
import type { HoursWindow, LightLevel, OwnerEvent, StoreRunResult, WeekHours } from "../api/contract";
import { MINUTES_PER_DAY } from "../api/contract";
import { formatHHMM, parseHHMM } from "./time";

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The hours fields a store result carries (schedule and closedFromDay are optional). */
export type HoursSource = Pick<StoreRunResult, "open" | "close"> & Partial<Pick<StoreRunResult, "schedule" | "closedFromDay">>;

/** 0 = Monday … 6 = Sunday. Day 1 is a Monday; day 0 (the night before the run) is a Sunday. */
export function weekdayIndex(day: number): number {
  return (((day - 1) % 7) + 7) % 7;
}

/** Day (1-based, not clamped) of a sim minute: the mock's after-midnight trips on Day 14 reach Day 15. */
export const dayAt = (t: number) => Math.floor(t / MINUTES_PER_DAY) + 1;
const minuteAt = (t: number) => ((Math.floor(t) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

/** The weekly hours in effect on `day`. */
export function scheduledWeek(r: HoursSource, day: number): WeekHours {
  const entries = r.schedule ?? [];
  if (!entries.length) return Array.from({ length: 7 }, () => ({ open: r.open, close: r.close }));
  let pick = entries[0];
  for (const e of entries) if (e.fromDay <= day && e.fromDay >= pick.fromDay) pick = e;
  return pick.week;
}

export function scheduledHours(r: HoursSource, day: number): HoursWindow | null {
  return scheduledWeek(r, day)[weekdayIndex(day)] ?? null;
}

/** A day's opening as minutes from that day's 00:00: [o, c) with c in (o, o + 1440]; past 1440 = after midnight. */
export interface Span {
  o: number;
  c: number;
}

export function toSpan(h: HoursWindow | null | undefined): Span | null {
  if (!h) return null;
  const o = parseHHMM(h.open);
  let c = parseHHMM(h.close);
  if (c <= o) c += MINUTES_PER_DAY; // equal = 24 hours
  return { o, c };
}

export function fromSpan(s: Span | null): HoursWindow | null {
  return s ? { open: formatHHMM(s.o), close: formatHHMM(s.c) } : null;
}

/** Open at `minute` (0..1439) of a day, given that day's span and the previous day's (for the after-midnight tail)? */
export function openInSpans(today: Span | null, yesterday: Span | null, minute: number): boolean {
  if (today && minute >= today.o && minute < today.c) return true;
  return !!yesterday && minute + MINUTES_PER_DAY < yesterday.c && minute + MINUTES_PER_DAY >= yesterday.o;
}

/** Minutes until a span that covers `minute` closes (0 when shut). */
export function minutesLeft(today: Span | null, yesterday: Span | null, minute: number): number {
  if (today && minute >= today.o && minute < today.c) return today.c - minute;
  if (yesterday && minute + MINUTES_PER_DAY >= yesterday.o && minute + MINUTES_PER_DAY < yesterday.c) return yesterday.c - minute - MINUTES_PER_DAY;
  return 0;
}

/** "Thursday" / "thu" / "Day 5" / "5" → a day number. Weekdays resolve to the first match on/after `base` (after, when `strict`). */
export function resolveDayRef(ref: string, base: number, strict: boolean): number | null {
  const s = ref.trim().toLowerCase();
  const num = /^(?:day\s*)?(\d+)$/.exec(s);
  if (num) return Number(num[1]);
  const w = WEEKDAY_NAMES.findIndex((n) => s.length >= 3 && n.toLowerCase().startsWith(s.slice(0, 3)));
  if (w < 0) return null;
  for (let d = strict ? base + 1 : base; d < base + 8; d++) if (weekdayIndex(d) === w) return d;
  return null;
}

/** [first closed day, reopening day) of a temporary_closure. */
export function closureDays(e: OwnerEvent): [number, number] {
  const start = (e.from && resolveDayRef(e.from, e.day, false)) || e.day + 1;
  const end = (e.to && resolveDayRef(e.to, start, true)) || start + 1;
  return [start, Math.max(start + 1, end)];
}

/** First day the shop is closed for good, or null. */
export function closedFromDayOf(r: HoursSource, events: readonly OwnerEvent[]): number | null {
  if (r.closedFromDay != null) return r.closedFromDay;
  const e = events.find((x) => x.action === "closed_permanently");
  return e ? e.day + 1 : null;
}

/**
 * The span a shop keeps on `day`, after closures and that day's today-only actions.
 * `events` = this shop's events (pass only those already decided, e.g. t <= now).
 */
export function daySpan(r: HoursSource, events: readonly OwnerEvent[], day: number): Span | null {
  const gone = closedFromDayOf(r, events);
  if (gone != null && day >= gone) return null;
  let span = toSpan(scheduledHours(r, day));
  for (const e of events) {
    if (!span) break;
    if (e.action === "temporary_closure") {
      const [a, b] = closureDays(e);
      if (day >= a && day < b) return null;
      continue;
    }
    if (e.day !== day || !e.to || (e.action !== "shut_early" && e.action !== "open_late")) continue;
    let to = parseHHMM(e.to);
    if (to <= span.o) to += MINUTES_PER_DAY;
    if (e.action === "shut_early") {
      const c = Math.min(span.c, to);
      span = c > span.o ? { o: span.o, c } : null;
    } else {
      span = { o: span.o, c: Math.max(span.c, Math.min(to, span.o + MINUTES_PER_DAY)) };
    }
  }
  return span;
}

export function dayHours(r: HoursSource, events: readonly OwnerEvent[], day: number): HoursWindow | null {
  return fromSpan(daySpan(r, events, day));
}

const LEVELS: readonly LightLevel[] = ["off", "low", "high"];

/** Lighting at an hour, given what the shop is doing (shared by the UI and the mock's energy model). */
export function lightLevelAt(
  base: LightLevel,
  o: { open: boolean; shutAllDay: boolean; closedForGood: boolean; lightingChange?: Pick<OwnerEvent, "from" | "to"> | null },
): LightLevel {
  if (o.closedForGood) return "off";
  if (o.open) return base;
  if (o.shutAllDay) return "off";
  const lc = o.lightingChange;
  if (lc && LEVELS.includes(lc.to as LightLevel) && (!lc.from || lc.from === base)) return lc.to as LightLevel;
  return base;
}

/** The latest lighting_changed event (events oldest first). */
export function latestLightingChange(events: readonly OwnerEvent[]): OwnerEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].action === "lighting_changed") return events[i];
  return null;
}

export interface StoreState {
  open: boolean;
  /** That day's hours after today-only actions; null = shut all day. */
  hours: HoursWindow | null;
  lighting: LightLevel;
  /** The owner's one-line reason for what the shop is doing now, if a decision is in effect. */
  reason?: string;
  /** The event behind `reason`. */
  event?: OwnerEvent;
  closedForGood: boolean;
  /** Shut for the whole day (closed weekday, temporary closure or closed for good). */
  shutAllDay: boolean;
  /** Set when today's hours differ from the schedule because of a today-only action. */
  todayAction?: "shut_early" | "open_late";
}

function inEffect(e: OwnerEvent, day: number, minute: number): boolean {
  switch (e.action) {
    case "shut_early":
    case "open_late":
      return e.day === day || (e.day === day - 1 && minute < 6 * 60);
    case "temporary_closure": {
      const [, b] = closureDays(e);
      return day >= e.day && day < b;
    }
    case "closed_permanently":
      return true;
    default:
      // hours, days and lighting decisions are news the day they're made and the day they start
      return day <= e.day + 1;
  }
}

/**
 * A shop's state at sim minute `t`.
 * `events` = this shop's owner events, oldest first (filter per shop with eventsByStore).
 * Events after `t` are not known yet and are ignored.
 */
export function storeStateAt(result: HoursSource & Partial<Pick<StoreRunResult, "lighting">>, events: readonly OwnerEvent[], t: number): StoreState {
  const known = events.filter((e) => e.t <= t);
  const day = dayAt(t);
  const minute = minuteAt(t);
  const gone = closedFromDayOf(result, known);
  const closedForGood = gone != null && day >= gone;
  const today = daySpan(result, known, day);
  const yesterday = daySpan(result, known, day - 1);
  const open = !closedForGood && openInSpans(today, yesterday, minute);
  const scheduled = toSpan(scheduledHours(result, day));
  const base = result.lighting?.[Math.floor(minute / 60)] ?? "off";
  const lighting = lightLevelAt(base, { open, shutAllDay: !today, closedForGood, lightingChange: latestLightingChange(known) });
  let todayAction: StoreState["todayAction"];
  if (today && scheduled && today.c !== scheduled.c) todayAction = today.c < scheduled.c ? "shut_early" : "open_late";
  let event: OwnerEvent | undefined;
  for (let i = known.length - 1; i >= 0; i--)
    if (inEffect(known[i], day, minute)) {
      event = known[i];
      break;
    }
  return { open, hours: fromSpan(today), lighting, reason: event?.reason, event, closedForGood, shutAllDay: !today, todayAction };
}

/** storeId → that shop's events, oldest first. */
export function eventsByStore(events: readonly OwnerEvent[]): Map<string, OwnerEvent[]> {
  const out = new Map<string, OwnerEvent[]>();
  for (const e of events) {
    const list = out.get(e.storeId);
    if (list) list.push(e);
    else out.set(e.storeId, [e]);
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

// ---------- week grid (Mon–Sun × 24h) ----------

export type CellChange = "added" | "removed" | null;

export interface WeekRow {
  weekday: number;
  label: string;
  /** 24 cells: open during (most of) each clock hour on that weekday, incl. the previous night's tail. */
  open: boolean[];
  /** vs the run's starting week. */
  changed: CellChange[];
  hours: HoursWindow | null;
  /** This row is the current day (today-only actions and closures applied). */
  today: boolean;
}

/** The week in effect on `day`, with cells that differ from the run's start marked; today's row shows today as it is. */
export function weekGrid(r: HoursSource, events: readonly OwnerEvent[], day: number): WeekRow[] {
  const week = scheduledWeek(r, day);
  const start = scheduledWeek(r, 1);
  const todayW = weekdayIndex(day);
  return Array.from({ length: 7 }, (_, w) => {
    const isToday = w === todayW;
    const span = isToday ? daySpan(r, events, day) : toSpan(week[w]);
    const prev = isToday ? daySpan(r, events, day - 1) : toSpan(week[(w + 6) % 7]);
    const s0 = toSpan(start[w]);
    const p0 = toSpan(start[(w + 6) % 7]);
    const open = Array.from({ length: 24 }, (_, h) => openInSpans(span, prev, h * 60 + 30));
    const changed = open.map((on, h): CellChange => {
      const was = openInSpans(s0, p0, h * 60 + 30);
      return on === was ? null : on ? "added" : "removed";
    });
    return { weekday: w, label: WEEKDAY_NAMES[w].slice(0, 3), open, changed, hours: fromSpan(span), today: isToday };
  });
}
