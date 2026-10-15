// Store card extras from the nightlife + public-safety layer: the licence-review note on a club
// ("Licence review: closed 2 nights after a fight") and the "Look inside" button for the interior cutaway.
import { Eye, EyeOff, Gavel } from "lucide-react";
import { useIncidents } from "../api/incidents";
import { closureNights } from "../sim/incidents";
import { dayAt } from "../sim/storeState";
import { useSafety } from "../state/safety";
import { useSim } from "../state/store";
import { momentLabel } from "./ownerFormat";
import "./safety.css";

const WHY: Record<string, string> = { assault: "a serious assault outside", fight: "a fight outside" };

/** The latest licence review for this venue that has been announced by now, with the nights it covers. */
export function licenceNote(incidents: { t: number; day: number; kind: string; effects: { closedStoreId?: string | null; closedDays?: number | null } }[], storeId: string, t: number) {
  let hit: { text: string; detail: string; now: boolean } | null = null;
  for (const i of incidents) {
    if (i.effects.closedStoreId !== storeId || i.t > t) continue;
    const nights = closureNights(i as Parameters<typeof closureNights>[0]);
    if (!nights.length) continue;
    const day = dayAt(t);
    const n = nights.length;
    const now = nights.includes(day) || (nights.includes(day - 1) && t % 1440 < 6 * 60);
    hit = {
      text: `Licence review: closed ${n} night${n === 1 ? "" : "s"} after ${WHY[i.kind] ?? "an incident"}`,
      detail: `${now ? "Closed tonight" : day > nights[n - 1] ? "Reopened" : "Closes"} · nights of day ${nights[0]}${n > 1 ? `–${nights[n - 1]}` : ""} · incident ${momentLabel(i.t)}`,
      now,
    };
  }
  return hit;
}

export function SafetyCardExtras({ storeId }: { storeId: string }) {
  const run = useSim((s) => s.run);
  const t = useSim((s) => Math.floor(s.t / 10) * 10);
  const incidents = useIncidents(run).data;
  const inside = useSafety((s) => s.insideId === storeId);
  const note = incidents ? licenceNote(incidents, storeId, t) : null;
  return (
    <>
      {note && (
        <div className="licence-note" role="note">
          <Gavel size={14} aria-hidden />
          <span>
            {note.text}
            <span className="muted">{note.detail}</span>
          </span>
        </div>
      )}
      <button className={`btn btn-inside ${inside ? "on" : ""}`} onClick={() => useSafety.getState().setInside(inside ? null : storeId)}>
        {inside ? <EyeOff size={14} /> : <Eye size={14} />} {inside ? "Back outside" : "Look inside"}
      </button>
    </>
  );
}
