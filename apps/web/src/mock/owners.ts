// Mock shop owners who adapt day by day inside a run (docs/OWNER_ACTIONS.md, the inner learning loop).
// Each owner reads only its own shop's day (visits and people who found it shut, by hour) plus the public
// street events, and acts: shut early for roadworks, stay open late on club nights once they've seen the
// crowd, shift hours, close a dead weekday, turn the window lights off, or (rarely) close for good.
// Hard rules: never outside the licence, never another shop's data. Deterministic: no randomness at all.
//
// Opening and lighting go through sim/storeState.ts, the same helpers the 3D world uses, so the
// customers in the mock find exactly what the UI shows.
import type { CityMap, LightLevel, OwnerEvent, OwnerTriggerKind, ScheduleEntry, StoreType, StreetEvent, WeekHours } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";
import { GBP_PER_KWH, GROSS_MARGIN, SPEND_GBP } from "../sim/economics";
import { daySpan, fromSpan, latestLightingChange, lightLevelAt, minutesLeft, openInSpans, scheduledWeek, toSpan, WEEKDAY_NAMES, weekdayIndex, type Span } from "../sim/storeState";
import { formatHHMM } from "../sim/time";
import { LICENCE, type RunConfig } from "./configs";
import { storeStreets } from "./streetEvents";

// ---------- energy model (kWh per m² per hour) ----------

export const OPEN_KWH: Record<StoreType, number> = { cafe: 0.004, restaurant: 0.005, takeaway: 0.0045, bar: 0.004, shop: 0.0025, offlicence: 0.003, club: 0.006 };
export const LIGHT_KWH: Record<LightLevel, number> = { off: 0, low: 0.001, high: 0.003 };

/** One shop's day, by clock hour: visits that started then and people who walked over and found it shut. */
export interface DayStats {
  visits: number[];
  missed: number[];
}

interface Shop {
  id: string;
  name: string;
  type: StoreType;
  area: number;
  streetId: string;
  licence: Span;
  /** Within a short walk of a club door: sees the club crowd. */
  nearClub: boolean;
  src: { open: string; close: string; lighting: LightLevel[]; schedule: ScheduleEntry[]; closedFromDay: number | null };
  events: OwnerEvent[];
  /** day → span cache (cleared whenever this owner decides something). */
  spans: (Span | null | undefined)[];
  history: DayStats[];
  lastHoursChange: number;
  extended: number;
  shortened: number;
  openedEarlier: boolean;
  closedDays: Set<number>;
}

const dayStart = (day: number) => (day - 1) * MINUTES_PER_DAY;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const minuteOf = (t: number) => ((Math.floor(t) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
const dayOfT = (t: number) => Math.floor(t / MINUTES_PER_DAY) + 1;
const pct = (f: number) => `${Math.round(f * 100)}%`;

/** The shop's usual hours this week (the first open day). */
function usual(week: WeekHours): Span | null {
  for (const h of week) if (h) return toSpan(h);
  return null;
}

export class OwnerBook {
  readonly shops: Shop[];
  readonly byId: Map<string, Shop>;
  private permanentDone = false;

  constructor(
    map: CityMap,
    cfg: RunConfig,
    private readonly street: StreetEvent[],
    /** Which run of the session: nobody closes for good in run 1. */
    private readonly run: number,
  ) {
    const streets = storeStreets(map);
    const clubDoors = map.stores
      .filter((s) => s.type === "club")
      .map((s) => map.buildings.find((b) => b.id === s.buildingId)!)
      .filter(Boolean);
    this.shops = map.stores.map((s) => {
      const b = map.buildings.find((x) => x.id === s.buildingId)!;
      const c = cfg[s.id];
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        area: b.w * b.d,
        streetId: streets.get(s.id) ?? "",
        licence: toSpan(LICENCE[s.type])!,
        nearClub: s.type !== "club" && clubDoors.some((d) => Math.hypot(d.x - b.x, d.z - b.z) < 140),
        src: {
          open: c.open,
          close: c.close,
          lighting: [...c.lighting],
          schedule: [{ fromDay: 1, week: Array.from({ length: 7 }, () => ({ open: c.open, close: c.close })) }],
          closedFromDay: null,
        },
        events: [],
        spans: [],
        history: [],
        lastHoursChange: -99,
        extended: 0,
        shortened: 0,
        openedEarlier: false,
        closedDays: new Set(),
      };
    });
    this.byId = new Map(this.shops.map((s) => [s.id, s]));
  }

  // ---------- what customers find ----------

  span(shop: Shop, day: number): Span | null {
    let s = shop.spans[day + 1];
    if (s === undefined) {
      s = daySpan(shop.src, shop.events, day);
      shop.spans[day + 1] = s;
    }
    return s;
  }

  isOpen(shop: Shop, t: number): boolean {
    const day = dayOfT(t);
    return openInSpans(this.span(shop, day), this.span(shop, day - 1), minuteOf(t));
  }

  minutesToClose(shop: Shop, t: number): number {
    const day = dayOfT(t);
    return minutesLeft(this.span(shop, day), this.span(shop, day - 1), minuteOf(t)) || MINUTES_PER_DAY;
  }

  light(shop: Shop, t: number): LightLevel {
    const day = dayOfT(t);
    const lc = latestLightingChange(shop.events);
    return lightLevelAt(shop.src.lighting[Math.floor(minuteOf(t) / 60)], {
      open: this.isOpen(shop, t),
      shutAllDay: !this.span(shop, day),
      closedForGood: shop.src.closedFromDay != null && day >= shop.src.closedFromDay,
      lightingChange: lc && lc.t <= t ? lc : null,
    });
  }

  /** kWh this shop draws in each clock hour of `day` (half-hour resolution for opening). */
  kwhByHour(shop: Shop, day: number): number[] {
    const t0 = dayStart(day);
    return Array.from({ length: 24 }, (_, h) => {
      const t = t0 + h * 60;
      const openShare = (Number(this.isOpen(shop, t + 15)) + Number(this.isOpen(shop, t + 45))) / 2;
      return shop.area * (OPEN_KWH[shop.type] * openShare + LIGHT_KWH[this.light(shop, t + 30)]);
    });
  }

  // ---------- decisions ----------

  private decide(shop: Shop, e: Omit<OwnerEvent, "storeId">) {
    shop.events.push({ storeId: shop.id, ...e });
    shop.spans = [];
  }

  private setWeek(shop: Shop, fromDay: number, week: WeekHours) {
    const last = shop.src.schedule[shop.src.schedule.length - 1];
    if (last.fromDay === fromDay) last.week = week;
    else shop.src.schedule.push({ fromDay, week });
    shop.spans = [];
  }

  private withinLicence(shop: Shop, s: Span) {
    return s.o >= shop.licence.o && s.c <= shop.licence.c;
  }

  private roadworks(shop: Shop, day: number): StreetEvent | undefined {
    return this.street.find((e) => e.kind === "roadworks" && e.streetId === shop.streetId && e.fromT < dayStart(day + 1) && e.toT > dayStart(day) + 12 * 60);
  }

  private clubNight(day: number) {
    return this.street.some((e) => e.kind === "club_night" && e.day === day);
  }

  private active = (shop: Shop, day: number) => shop.type !== "club" && !(shop.src.closedFromDay != null && day >= shop.src.closedFromDay);

  /** Same-day calls, made before the day plays out (roadworks and club listings are public in advance). */
  morning(day: number) {
    for (const shop of this.shops) {
      if (!this.active(shop, day)) continue;
      const span = this.span(shop, day);
      if (!span) continue;
      const t0 = dayStart(day);

      const rw = this.roadworks(shop, day);
      if (rw) {
        const shutAt = Math.max(15 * 60, Math.ceil((span.o + 4 * 60) / 60) * 60);
        if (shutAt <= span.c - 60 && shutAt < MINUTES_PER_DAY) {
          const to = formatHHMM(shutAt);
          this.decide(shop, {
            day,
            t: t0 + shutAt,
            action: "shut_early",
            from: formatHHMM(span.c),
            to,
            reason: `Roadworks outside, nobody can get in, shutting at ${to}.`,
            trigger: { kind: "roadworks", value: rw.severity, label: `footfall −${pct(rw.severity)} vs usual` },
          });
        }
        continue;
      }

      // club night: only once this owner has seen the crowd find it shut after close
      if (shop.nearClub && (shop.type === "takeaway" || shop.type === "offlicence") && this.clubNight(day) && span.c < 27 * 60) {
        const closeH = Math.floor(span.c / 60) % 24;
        const hours: number[] = [];
        for (let h = closeH; h !== 4; h = (h + 1) % 24) hours.push(h);
        const missed = sum(shop.history.map((d) => sum(hours.map((h) => d.missed[h]))));
        const target = Math.min(27 * 60, shop.licence.c);
        if (missed >= 3 && target > span.c && this.withinLicence(shop, { o: span.o, c: target })) {
          const from = formatHHMM(span.c);
          const to = formatHHMM(target);
          this.decide(shop, {
            day,
            t: t0 + span.c - 15,
            action: "open_late",
            from,
            to,
            reason: `Club crowd outside, staying open till ${to} tonight.`,
            trigger: { kind: "club_night", value: missed, label: `${Math.round(missed)} found us shut after ${from} so far` },
          });
        }
      }
    }
  }

  /** End of the day: each owner reads its own day and decides what changes from tomorrow. */
  evening(day: number, stats: Map<string, DayStats>) {
    const t = dayStart(day) + 23 * 60 + 30;
    for (const shop of this.shops) {
      const today = stats.get(shop.id) ?? { visits: Array(24).fill(0), missed: Array(24).fill(0) };
      shop.history.push(today);
      if (!this.active(shop, day) || day >= DAYS_PER_RUN) continue;
      const ev = (action: OwnerEvent["action"], reason: string, kind: OwnerTriggerKind, value: number, label: string, from?: string, to?: string) =>
        this.decide(shop, { day, t, action, from: from ?? null, to: to ?? null, reason, trigger: { kind, value: Math.round(value * 100) / 100, label } });

      const visitsToday = sum(today.visits);
      const before = shop.history.slice(0, -1);
      const usualVisits = before.length ? sum(before.map((d) => sum(d.visits))) / before.length : 0;

      // 1. roadworks carrying on: small daytime shops close until the street reopens
      const rw = this.roadworks(shop, day);
      if (rw && (shop.type === "shop" || shop.type === "cafe") && rw.severity >= 0.55 && this.roadworks(shop, day + 1) && before.length >= 2 && visitsToday < 0.75 * usualVisits) {
        let end = day + 1;
        while (this.roadworks(shop, end)) end++;
        const until = WEEKDAY_NAMES[weekdayIndex(end)];
        ev(
          "temporary_closure",
          `Street closed for works, closed until ${until}.`,
          "roadworks",
          1 - visitsToday / usualVisits,
          `visits −${pct(1 - visitsToday / usualVisits)} vs usual`,
          WEEKDAY_NAMES[weekdayIndex(day + 1)],
          until,
        );
        continue;
      }

      const week = scheduledWeek(shop.src, day + 1).map((h) => (h ? { ...h } : null));
      const base = usual(week);
      const recent = shop.history.slice(-3);
      // days the shop really was open at hour h (shut-early days don't count as "nobody came")
      const wasOpen = (d: number, h: number) => this.isOpen(shop, dayStart(d) + h * 60 + 30);

      // 2. hours: missed demand after close / before open, or an empty last hour
      if (base && day - shop.lastHoursChange >= 3 && day >= 3) {
        const closeH = Math.floor(base.c / 60) % 24;
        const openH = Math.floor(base.o / 60);
        const missedAfter = sum(recent.map((d) => d.missed[closeH] + d.missed[(closeH + 1) % 24]));
        const missedBefore = openH > 0 ? sum(recent.map((d) => d.missed[openH - 1])) : 0;
        const lastH = Math.floor((base.c - 1) / 60) % 24;
        const lastDays = shop.history.map((_, i) => i + 1).slice(-4).filter((d) => wasOpen(d, lastH));
        const lastVisits = sum(lastDays.map((d) => shop.history[d - 1].visits[lastH]));
        const apply = (next: Span) => {
          for (let w = 0; w < 7; w++) if (week[w]) week[w] = fromSpan(next);
          this.setWeek(shop, day + 1, week);
          shop.lastHoursChange = day;
        };
        if (missedAfter >= 8 && shop.extended < 1 && !shop.shortened && this.withinLicence(shop, { o: base.o, c: base.c + 60 })) {
          const from = formatHHMM(base.c);
          const to = formatHHMM(base.c + 60);
          apply({ o: base.o, c: base.c + 60 });
          shop.extended++;
          ev("hours_changed", `People kept finding us shut after ${from}, staying open till ${to}.`, "missed_demand", missedAfter, `${Math.round(missedAfter)} found us shut after ${from} in ${recent.length} days`, from, to);
          continue;
        }
        if (missedBefore >= 8 && !shop.openedEarlier && this.withinLicence(shop, { o: base.o - 60, c: base.c })) {
          const from = formatHHMM(base.o);
          const to = formatHHMM(base.o - 60);
          apply({ o: base.o - 60, c: base.c });
          shop.openedEarlier = true;
          ev("hours_changed", `People were waiting before ${from}, opening at ${to}.`, "missed_demand", missedBefore, `${Math.round(missedBefore)} found us shut before ${from} in ${recent.length} days`, from, to);
          continue;
        }
        if (day >= 4 && lastDays.length >= 3 && lastVisits <= 1 && shop.extended === 0 && shop.shortened < 1 && base.c - base.o >= 8 * 60) {
          const from = formatHHMM(base.c);
          const to = formatHHMM(base.c - 60);
          apply({ o: base.o, c: base.c - 60 });
          shop.shortened++;
          ev("hours_changed", `Nobody comes in after ${to}, closing at ${to}.`, "empty_hours", lastVisits, `${lastVisits} visits after ${to} in ${lastDays.length} days`, from, to);
          continue;
        }
      }

      // 3. a dead weekday in week one: close it next week; reopen if people keep turning up
      const w = weekdayIndex(day);
      const name = WEEKDAY_NAMES[w];
      if (!this.span(shop, day) && shop.closedDays.has(w) && sum(today.missed) >= 3) {
        const prevHours = usual(week);
        if (prevHours) {
          week[w] = fromSpan(prevHours);
          this.setWeek(shop, day + 1, week);
          shop.closedDays.delete(w);
          ev("day_reopened", `Busy ${name}s again, opening.`, "dead_day", sum(today.missed), `${sum(today.missed)} found us shut on ${name}`, undefined, name);
          continue;
        }
      }
      const normalDay = !!this.span(shop, day) && !shop.events.some((e) => e.day === day && e.action === "shut_early");
      if (day <= 7 && normalDay && week[w] && before.length >= 3 && visitsToday <= 0.35 * usualVisits && usualVisits >= 8 && shop.closedDays.size === 0) {
        week[w] = null;
        this.setWeek(shop, day + 1, week);
        shop.closedDays.add(w);
        ev("day_closed", `${name}s are dead, closing ${name}s.`, "dead_day", visitsToday, `${visitsToday} visit${visitsToday === 1 ? "" : "s"} on ${name}`, undefined, name);
        continue;
      }

      // 4. window lights burning all night while shut: the bill says turn them off
      if (day >= 2 && !latestLightingChange(shop.events)) {
        const t0 = dayStart(day);
        const litShut = Array.from({ length: 24 }, (_, h) => h).filter((h) => !this.isOpen(shop, t0 + h * 60 + 30) && this.light(shop, t0 + h * 60 + 30) === "high");
        if (litShut.length >= 6) {
          const kwh = litShut.length * shop.area * LIGHT_KWH.high;
          ev("lighting_changed", "Window lights off after close.", "lights_waste", kwh, `${Math.round(kwh * 10) / 10} kWh a night lighting a shut shop`, "high", "off");
          continue;
        }
      }
    }

    // 5. rarely, a shop that can't cover its costs closes for good (never in run 1)
    if (this.run >= 2 && day === 10 && !this.permanentDone) {
      this.permanentDone = true;
      let worst: { shop: Shop; perDay: number } | null = null;
      // takings margin minus energy and a fixed £25/day for rent and staff, per day over days [from, to]
      const profit = (shop: Shop, from: number, to: number) => {
        let p = 0;
        for (let d = from; d <= to; d++) p += sum(shop.history[d - 1].visits) * SPEND_GBP[shop.type] * GROSS_MARGIN - sum(this.kwhByHour(shop, d)) * GBP_PER_KWH - 25;
        return p / (to - from + 1);
      };
      for (const shop of this.shops) {
        if (!this.active(shop, day)) continue;
        // losing money in week one and still losing since
        const week1 = profit(shop, 1, 7);
        const since = profit(shop, 8, day);
        if (week1 < 0 && since < 0 && (!worst || since < worst.perDay)) worst = { shop, perDay: since };
      }
      if (worst) {
        const { shop, perDay } = worst;
        shop.src.closedFromDay = day + 1;
        this.decide(shop, {
          day,
          t: dayStart(day) + 23 * 60 + 30,
          action: "closed_permanently",
          reason: "Not enough trade to cover costs, closing for good.",
          trigger: { kind: "losses", value: Math.round(-perDay * 100) / 100, label: `−£${(-perDay).toFixed(2)} a day after costs, two weeks running` },
        });
      }
    }
  }

  /** Every owner's decisions, oldest first. */
  allEvents(): OwnerEvent[] {
    return this.shops.flatMap((s) => s.events).sort((a, b) => a.t - b.t || a.storeId.localeCompare(b.storeId));
  }
}
