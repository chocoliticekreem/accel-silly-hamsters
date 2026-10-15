// Public-safety incidents (docs/INCIDENTS.md): an optional, additive contract with its own client.
// Place-based and anonymous: an incident is a time, a place and the response it drew. Never a person.
// GET /api/runs/{run}/incidents → Incident[] (404 → [], so older backends keep working).
// Mock mode generates the same list the mock sim uses (mock/incidents.ts), deterministic per seed.
import { API_URL, api } from "./client";
import { load, useResource } from "../state/data";
import { generateIncidents } from "../mock/incidents";
import { MOCK_SEED } from "../mock";

export type IncidentKind = "fight" | "assault" | "theft" | "antisocial" | "chase" | "collision";

export interface IncidentResponse {
  police: boolean;
  ambulance: boolean;
  /** How long the response stays on scene (sim minutes from `t`). */
  durationMin: number;
}

export interface IncidentEffects {
  /** A licence review closes this venue (a club) for the next `closedDays` nights. */
  closedStoreId?: string | null;
  closedDays?: number | null;
  /** 0..1 fewer people on `streetId` while the response is on scene. */
  footfallDrop?: number | null;
  /** Minutes the street is cordoned off from `t`. */
  streetClosedMin?: number | null;
}

export interface Incident {
  id: string;
  /** Day of `t` (1-based). An incident at 03:00 on day 6 belongs to Friday night's club session. */
  day: number;
  /** Sim minute the police were called. */
  t: number;
  kind: IncidentKind;
  /** 1 minor · 2 moderate · 3 serious. */
  severity: 1 | 2 | 3;
  /** Contract coords (x east, z north). */
  x: number;
  z: number;
  streetId?: string | null;
  nearStoreId?: string | null;
  /** Calm, factual, one line: "Fight outside Basement 45". */
  label: string;
  response: IncidentResponse;
  effects: IncidentEffects;
  /** Additive: the incident began inside the venue `nearStoreId` this many minutes before `t`, then moved to the door. */
  insideMin?: number | null;
  /** Additive, chases only: where the pursuit began (it ends at x, z). */
  from?: { x: number; z: number } | null;
}

const KEY = (run: number) => `incidents:${run}`;

/** GET /api/runs/{run}/incidents; [] when the backend doesn't serve it. Mock: generated from the mock map. */
export async function fetchIncidents(run: number): Promise<Incident[]> {
  if (!API_URL) return generateIncidents(await api.map(), MOCK_SEED);
  const res = await fetch(`${API_URL.replace(/\/$/, "")}/api/runs/${run}/incidents`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GET /api/runs/${run}/incidents → ${res.status}`);
  return (await res.json()) as Incident[];
}

export const loadIncidents = (run: number) => load(KEY(run), () => fetchIncidents(run).catch(() => [] as Incident[]));

/** Incidents for a run (cached; [] when not served). */
export const useIncidents = (run: number | null) => useResource<Incident[]>(run == null ? null : KEY(run), () => loadIncidents(run!));

export { isActive, licenceClosure, closureStartDay } from "../sim/incidents";
