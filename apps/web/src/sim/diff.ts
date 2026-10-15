// Config diffs: what changed in one store's hours and lighting between two runs, as suggestion-shaped changes.
import type { LightLevel, Suggestion } from "../api/contract";

/** A suggestion before its expected delta is known (Omit that keeps the field union intact). */
export type Change = Suggestion extends infer S ? (S extends Suggestion ? Omit<S, "expectedDelta"> : never) : never;

/** The fields a diff reads; both mock configs and StoreRunResult have them. */
export interface HoursAndLighting {
  open: string;
  close: string;
  lighting: LightLevel[];
}

/** Groups consecutive hours whose lighting changed the same way into one suggestion. */
function lightingDiff(storeId: string, a: LightLevel[], b: LightLevel[]): Omit<Extract<Suggestion, { field: "lighting" }>, "expectedDelta">[] {
  const out: Omit<Extract<Suggestion, { field: "lighting" }>, "expectedDelta">[] = [];
  // walk the day starting at 05:00 so overnight ranges (23–03) stay together
  const order = Array.from({ length: 24 }, (_, i) => (i + 5) % 24);
  let cur: (typeof out)[number] | null = null;
  for (const h of order) {
    if (a[h] === b[h]) {
      cur = null;
      continue;
    }
    if (cur && cur.from === a[h] && cur.to === b[h] && cur.hours[cur.hours.length - 1] === (h + 23) % 24) cur.hours.push(h);
    else {
      cur = { storeId, field: "lighting", hours: [h], from: a[h], to: b[h] };
      out.push(cur);
    }
  }
  return out;
}

export function diffStore(storeId: string, a: HoursAndLighting, b: HoursAndLighting): Change[] {
  const out: Change[] = [];
  if (a.open !== b.open) out.push({ storeId, field: "open", from: a.open, to: b.open });
  if (a.close !== b.close) out.push({ storeId, field: "close", from: a.close, to: b.close });
  out.push(...lightingDiff(storeId, a.lighting, b.lighting));
  return out;
}

