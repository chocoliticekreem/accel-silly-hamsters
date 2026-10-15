// Sim-time helpers. t = sim minutes since Day 1 00:00 (see api/contract.ts).
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";

const pad = (n: number) => String(n).padStart(2, "0");

export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes (any size) → "HH:MM" on a 24h clock. */
export function formatHHMM(minutes: number): string {
  const m = ((Math.floor(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** 1-based day, clamped to the run. */
export function dayOf(t: number): number {
  return Math.min(DAYS_PER_RUN, Math.max(1, Math.floor(t / MINUTES_PER_DAY) + 1));
}

export function minuteOfDay(t: number): number {
  return ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Fractional hour of day, 0..24. */
export function hourOf(t: number): number {
  return minuteOfDay(t) / 60;
}

export function clockLabel(t: number): string {
  return `Day ${dayOf(t)} · ${formatHHMM(t)}`;
}

/** Is a store with these hours open at this minute of the day? close <= open wraps past midnight. */
export function isOpenAt(open: string, close: string, minute: number): boolean {
  const o = parseHHMM(open);
  const c = parseHHMM(close);
  if (o === c) return true;
  return o < c ? minute >= o && minute < c : minute >= o || minute < c;
}

/** 24 booleans: is the store open during (most of) each hour. */
export function openByHour(open: string, close: string): boolean[] {
  return Array.from({ length: 24 }, (_, h) => isOpenAt(open, close, h * 60 + 30));
}

/** [1, 2] → "01–03" (hours are inclusive start slots). */
export function rangeLabel(hours: number[]): string {
  if (!hours.length) return "";
  const lo = Math.min(...hours);
  const hi = Math.max(...hours) + 1;
  return `${pad(lo)}–${pad(hi % 24)}`;
}
