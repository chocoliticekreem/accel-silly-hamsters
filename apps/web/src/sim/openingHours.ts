// A small parser for OSM `opening_hours` (the common subset: "Mo-Fr 07:00-17:00; Sa,Su 10:00-16:00", "24/7",
// "Mo-Su 12:00-15:00,18:00-23:30", "Fr-Sa 18:00-02:00", "Su off"). Public-holiday, month and week rules are ignored.
// Returns null for anything it can't read, so callers fall back to typical hours.
// Weekdays are 0 = Monday … 6 = Sunday (sim/storeState weekdayIndex); minutes from midnight, end may pass 1440.

export type WeekHours = [number, number][][];

const DAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];

function dayList(spec: string): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const p = part.trim().toLowerCase();
    const m = /^([a-z]{2})(?:\s*-\s*([a-z]{2}))?(?:\[[^\]]*\])?$/.exec(p);
    if (!m) return null;
    const a = DAYS.indexOf(m[1]);
    const b = m[2] ? DAYS.indexOf(m[2]) : a;
    if (a < 0 || b < 0) return null;
    for (let d = a; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === b) break;
    }
  }
  return [...out];
}

function timeList(spec: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$/.exec(part.trim());
    if (!m) return null;
    const a = +m[1] * 60 + +m[2];
    let b = +m[3] * 60 + +m[4];
    if (b <= a) b += 1440; // past midnight
    out.push([a, b]);
  }
  return out;
}

export function parseOpeningHours(src: string): WeekHours | null {
  const s = src.trim();
  if (!s) return null;
  if (/^24\/7$/.test(s)) return Array.from({ length: 7 }, () => [[0, 1440]]);
  const week: WeekHours = Array.from({ length: 7 }, () => []);
  let any = false;
  for (const raw of s.split(/;|\|\|/)) {
    const rule = raw.trim().replace(/\s+/g, " ");
    if (!rule) continue;
    if (/^(ph|sh)\b/i.test(rule)) continue; // holidays: not modelled
    // "Mo-Fr 09:00-17:00", "Mo-Fr off", or bare "09:00-17:00" (every day)
    const m = /^((?:[A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?(?:\[[^\]]*\])?\s*,\s*)*[A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?(?:\[[^\]]*\])?)?\s*(.*)$/.exec(rule);
    if (!m) return null;
    const days = m[1] ? dayList(m[1].replace(/,\s*ph\b/i, "")) : [0, 1, 2, 3, 4, 5, 6];
    const rest = m[2].trim().toLowerCase();
    if (!days) return null;
    if (rest === "off" || rest === "closed") {
      for (const d of days) week[d] = [];
      any = true;
      continue;
    }
    const times = timeList(rest);
    if (!times) return null;
    // a later rule for the same day replaces the earlier one (OSM semantics)
    for (const d of days) week[d] = times.slice();
    any = true;
  }
  return any ? week : null;
}

/** Open at minute `m` of weekday `wd`? Includes yesterday's hours that run past midnight. */
export function openAt(week: WeekHours, wd: number, m: number): boolean {
  if (week[wd].some(([a, b]) => m >= a && m < b)) return true;
  const prev = week[(wd + 6) % 7];
  return prev.some(([, b]) => b > 1440 && m < b - 1440);
}

const hhmm = (m: number) => {
  const v = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};

/** "closes 17:00" / "opens 09:00" / "opens Mon 09:00" from weekday wd at minute m (null if never open). */
export function nextChange(week: WeekHours, wd: number, m: number): string | null {
  const open = openAt(week, wd, m);
  // walk forward in 15-minute steps over the next week
  for (let k = 15; k <= 7 * 1440; k += 15) {
    const t = m + k;
    const d = (wd + Math.floor(t / 1440)) % 7;
    if (openAt(week, d, t % 1440) !== open) {
      const at = hhmm(Math.floor(t / 15) * 15);
      const shift = Math.floor(t / 1440);
      // a late close just after midnight reads as a time, not "tomorrow"
      const when = shift === 0 || (shift === 1 && open && t % 1440 < 360) ? "" : shift === 1 ? "tomorrow " : `${WEEKDAY_LABEL[d]} `;
      return `${open ? "closes" : "opens"} ${when}${at}`;
    }
  }
  return null;
}

export const WEEKDAY_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Readable week: consecutive days with the same hours grouped, e.g. ["Mon–Fri", "07:00–17:00"], ["Sun", "closed"]. */
export function weekRows(week: WeekHours): [string, string][] {
  const label = (d: [number, number][]) => (d.length ? d.map(([a, b]) => (b - a >= 1440 ? "24 hours" : `${hhmm(a)}–${hhmm(b)}`)).join(", ") : "closed");
  const rows: [string, string][] = [];
  let start = 0;
  for (let d = 1; d <= 7; d++) {
    if (d < 7 && label(week[d]) === label(week[start])) continue;
    rows.push([start === d - 1 ? WEEKDAY_LABEL[start] : `${WEEKDAY_LABEL[start]}–${WEEKDAY_LABEL[d - 1]}`, label(week[start])]);
    start = d;
  }
  return rows;
}

/** Open hours in a week. */
export function weeklyOpenHours(week: WeekHours): number {
  return week.reduce((s, d) => s + d.reduce((a, [x, y]) => a + (y - x) / 60, 0), 0);
}
