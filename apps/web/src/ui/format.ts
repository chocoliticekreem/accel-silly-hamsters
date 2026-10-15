// Number and diff formatting for the overlay. Short labels only: no sentences anywhere in the UI.
import type { Suggestion } from "../api/contract";
import { rangeLabel } from "../sim/time";

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-GB");
export const fmtNum = (n: number, digits = 2) => n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** 0.18 → "+18%", -0.05 → "−5%". */
export function fmtPct(f: number) {
  const v = Math.round(f * 100);
  if (v === 0) return "±0%";
  return `${v > 0 ? "+" : "−"}${Math.abs(v)}%`;
}

/** Fractional change a → b, or null when there's nothing to compare. */
export function change(a: number | undefined, b: number | undefined): number | null {
  if (a === undefined || b === undefined || a === 0) return null;
  return (b - a) / a;
}

/** Whether an increase is good for this metric (kWh going down is good). */
export const UP_IS_GOOD: Record<string, boolean> = { visits: true, kwh: false, visitsPerKwh: true, returnRate: true };

/** "Close 23:00 → 03:00", "Light 01–03: off → low". */
export function suggestionLabel(s: Suggestion): { what: string; from: string; to: string } {
  if (s.field === "lighting") return { what: `Light ${rangeLabel(s.hours)}`, from: s.from, to: s.to };
  return { what: s.field === "open" ? "Open" : "Close", from: s.from, to: s.to };
}

export const TYPE_LABEL: Record<string, string> = {
  cafe: "Café",
  restaurant: "Restaurant",
  takeaway: "Takeaway",
  bar: "Bar",
  shop: "Shop",
  offlicence: "Off-licence",
  club: "Club",
};

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function duration(ms: number) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Why the analyst stopped, in two words (chip, History's stop line). */
export const STOP_LABELS = { threshold: "plateau", max_runs: "max runs", budget: "budget cap", error: "crashed, resumable" } as const;
