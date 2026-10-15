// City feed rows for public-safety incidents (docs/INCIDENTS.md): "Day 6 · 03:35 · Police and ambulance called ·
// serious assault outside The Vault", plus the licence review that follows. Newest first, calm wording, places only.
// Click a row → jump to just before it and play at 1× so the response is watchable.
import { Ambulance, Car, CarFront, Gavel, ShieldAlert, Siren, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import type { Incident, IncidentKind } from "../api/incidents";
import { useIncidents } from "../api/incidents";
import { callLabel, closureStartDay } from "../sim/incidents";
import { useMap } from "../state/data";
import { useSim } from "../state/store";
import { momentLabel } from "./ownerFormat";
import "./safety.css";

const ICON: Record<IncidentKind, LucideIcon> = {
  fight: Siren,
  assault: Ambulance,
  theft: ShieldAlert,
  antisocial: ShieldAlert,
  chase: Car,
  collision: CarFront,
};

interface Row {
  key: string;
  t: number;
  /** Where the jump goes. */
  jumpT: number;
  text: string;
  Icon: LucideIcon;
  live: boolean;
  licence: boolean;
}

/** Licence reviews are announced the next morning at 10:00. */
const reviewT = (i: Incident) => (closureStartDay(i) - 1) * 1440 + 10 * 60;

export function incidentRows(incidents: readonly Incident[], t: number, windowMin: number, storeName: (id: string) => string): Row[] {
  const out: Row[] = [];
  for (const i of incidents) {
    if (i.t <= t && i.t > t - windowMin)
      out.push({ key: i.id, t: i.t, jumpT: i.t - (i.insideMin ?? 0) - 2, text: callLabel(i), Icon: ICON[i.kind], live: t < i.t + i.response.durationMin, licence: false });
    const n = i.effects.closedDays ?? 0;
    const rt = reviewT(i);
    if (i.effects.closedStoreId && n > 0 && rt <= t && rt > t - windowMin)
      out.push({
        key: `${i.id}:licence`,
        t: rt,
        jumpT: rt,
        text: `Licence review · ${storeName(i.effects.closedStoreId)} closed ${n} night${n === 1 ? "" : "s"}`,
        Icon: Gavel,
        live: false,
        licence: true,
      });
  }
  return out.sort((a, b) => b.t - a.t);
}

export function IncidentFeed({ run, t, windowMin = 24 * 60, limit = 3 }: { run: number; t: number; windowMin?: number; limit?: number }) {
  const incidents = useIncidents(run).data;
  const map = useMap().data;
  const names = useMemo(() => new Map((map?.stores ?? []).map((s) => [s.id, s.name])), [map]);
  const rows = useMemo(() => incidentRows(incidents ?? [], t, windowMin, (id) => names.get(id) ?? id).slice(0, limit), [incidents, t, windowMin, names, limit]);
  if (!rows.length) return null;
  const jump = (r: Row) => {
    const s = useSim.getState();
    s.setT(r.jumpT);
    if (!r.licence) {
      s.setSpeed(1);
      s.setPlaying(true);
    }
  };
  return (
    <ol className="city-feed-list city-feed-incidents" aria-label="Police and safety">
      {rows.map((r) => (
        <li key={r.key}>
          <button className={`feed-item feed-incident ${r.licence ? "feed-incident-licence" : ""}`} onClick={() => jump(r)} title={r.licence ? "Licensing decision (synthetic)" : "Synthetic incident · places, never people"}>
            <span className="feed-icon">
              <r.Icon size={13} aria-hidden />
            </span>
            <span className="feed-when mono">{momentLabel(r.t)}</span>
            <span className="feed-text">
              {r.text}
              {r.live ? " · on scene" : ""}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
