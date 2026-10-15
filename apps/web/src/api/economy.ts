// Owners are people, and the city has an economy (docs/PEOPLE_ECONOMY.md). Additive endpoints, kept apart from
// contract.ts: owners and their money, the ledger, life stories, interventions (forked runs) and daily headlines.
// Same switch as client.ts: VITE_API_URL unset = mock. Every endpoint is optional: a 404 reads as empty / null.
import type { AgentDay } from "./contract";
import { mockEconomyApi } from "../mock/economy";

/** A day-file trip that may belong to a shop owner (additive fields on AgentDay). */
export type PersonDay = AgentDay & { role?: "owner"; worksAt?: string; name?: string };

export interface Point {
  x: number;
  z: number;
}

export interface Balance {
  startGbp: number;
  endGbp: number;
  /** 14 values: the balance at the end of each day. */
  daily: number[];
}

export type OwnerStatus = "trading" | "cautious" | "bust";

// ---------- GET /api/runs/{run}/owners ----------

export interface OwnerPerson {
  personId: string;
  storeId: string;
  name: string;
  home: Point;
  commuteMinutes: number;
  business: Balance;
  personal: Balance;
  totals: { takingsGbp: number; energyGbp: number; rentGbp: number; stockGbp: number; wagesGbp: number; drawingsGbp: number; livingGbp?: number };
  status: OwnerStatus;
}

// ---------- GET /api/runs/{run}/ledger?storeId=&day=&limit= ----------

export type LedgerKind = "sale" | "energy" | "rent" | "stock" | "wages" | "drawings" | "living";

export interface LedgerEntry {
  t: number;
  day: number;
  storeId: string;
  kind: LedgerKind;
  /** Signed: + in, − out. */
  amountGbp: number;
  account: "business" | "personal";
}

export interface LedgerQuery {
  storeId?: string;
  day?: number;
  limit?: number;
}

// ---------- GET /api/runs/{run}/people/{personId} ----------

export interface PersonVisit {
  storeId: string;
  day: number;
  tIn: number;
  tOut: number;
  spentGbp: number;
}

export interface PersonStory {
  personId: string;
  role: "owner" | "citizen";
  name?: string;
  persona: string;
  home: Point | null;
  /** 3–5 plain sentences, built from the person's own trips, events and ledger. */
  story: string[];
  spentGbp?: number;
  /** Owners: business balance at the end of each day. */
  balance?: { daily: number[] };
  visits: PersonVisit[];
}

// ---------- POST /api/interventions ----------

export type InterventionKind = "station_closed" | "roadworks" | "energy_price" | "club_event" | "rain";

export type InterventionParams = Record<string, string | number | boolean | null>;

export interface InterventionRequest {
  kind: InterventionKind;
  params: InterventionParams;
  baseRun?: number;
}

export interface InterventionResponse {
  queuedRun: number;
}

/** What GET /api/runs items may add for a forked run. */
export interface RunIntervention {
  kind: InterventionKind;
  label: string;
  baseRun?: number;
  params?: InterventionParams;
}

// ---------- GET /api/runs/{run}/headlines ----------

export interface Headline {
  day: number;
  text: string;
}

// ---------- citizens (docs/CITIZENS.md §5): GET /api/runs/{run}/citizens, /citizens/{id}/diary ----------

export type AgeBand = "18-24" | "25-34" | "35-49" | "50-64" | "65+";
export type Occupation = "office" | "remote" | "student" | "retired" | "shift" | "resident" | "visitor";
export type Budget = "low" | "mid" | "high";

export interface CitizenProfile {
  id: string;
  persona: string;
  profile: string;
  label: string;
  occupation: Occupation;
  ageBand: AgeBand;
  budget: Budget;
  /** Street of the home anchor, or "outside the area". */
  home: string;
  /** Entry or station name. */
  arrivesVia?: string | null;
  /** Street of the work anchor. */
  work?: string | null;
  loyalty: number;
  lightingSensitivity: number;
  /** "Tue ~10:30 weekly cafe" */
  routine: string[];
  returning: boolean;
}

export interface CitizenCard {
  id: string;
  persona: string;
  label: string;
  story: string;
  headline: string;
  daysPresent: number;
  visits: number;
  foundShut: number;
}

export interface CitizenIndex {
  run: number;
  featured: CitizenCard[];
  counts: Record<string, number>;
  note: string;
}

export type DiaryKind = "arrive" | "visit" | "found_shut" | "seen_shut" | "skip" | "enter" | "leave" | "noticed_open";

export interface DiaryEntry {
  t: number;
  kind: DiaryKind;
  storeId?: string | null;
  storeName?: string | null;
  purpose?: string | null;
  tOut?: number | null;
  place?: string | null;
  note?: string | null;
}

export interface DiaryDay {
  day: number;
  weekday: string;
  summary: string;
  entries: DiaryEntry[];
}

export interface CitizenDiary {
  run: number;
  citizen: CitizenProfile;
  days: DiaryDay[];
  /** "regular at [cafe] (5 visits)", "avoids [shop] Tue mornings" */
  memory: string[];
  note: string;
}

// ---------- the client ----------

export interface EconomyApi {
  /** [] when not served. */
  owners(run: number): Promise<OwnerPerson[]>;
  /** [] when not served. */
  ledger(run: number, q?: LedgerQuery): Promise<LedgerEntry[]>;
  /** null when not served or unknown. */
  person(run: number, personId: string): Promise<PersonStory | null>;
  /** Forks the run with one change applied; poll /api/runs for queuedRun. */
  intervene(req: InterventionRequest): Promise<InterventionResponse>;
  /** run → its intervention, for forked runs (read off GET /api/runs). */
  interventions(): Promise<Record<number, RunIntervention>>;
  /** [] when not served. */
  headlines(run: number): Promise<Headline[]>;
  /** Featured citizens (docs/CITIZENS.md); null when not served. */
  citizens(run: number): Promise<CitizenIndex | null>;
  /** A citizen's fortnight diary; null when not served or unknown. */
  diary(run: number, citizenId: string): Promise<CitizenDiary | null>;
}

export function httpEconomyApi(base: string): EconomyApi {
  const root = base.replace(/\/$/, "");
  async function getOptional<T>(path: string): Promise<T | null> {
    const res = await fetch(`${root}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }
  const qs = (q: LedgerQuery = {}) => {
    const p = new URLSearchParams();
    if (q.storeId) p.set("storeId", q.storeId);
    if (q.day != null) p.set("day", String(q.day));
    if (q.limit != null) p.set("limit", String(q.limit));
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  return {
    owners: async (run) => (await getOptional<OwnerPerson[]>(`/api/runs/${run}/owners`)) ?? [],
    ledger: async (run, q) => (await getOptional<LedgerEntry[]>(`/api/runs/${run}/ledger${qs(q)}`)) ?? [],
    person: (run, id) => getOptional<PersonStory>(`/api/runs/${run}/people/${encodeURIComponent(id)}`),
    intervene: async (req) => {
      const res = await fetch(`${root}/api/interventions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
      if (!res.ok) throw new Error(`POST /api/interventions → ${res.status}`);
      return res.json() as Promise<InterventionResponse>;
    },
    interventions: async () => {
      const runs = (await getOptional<{ run: number; intervention?: RunIntervention | null }[]>("/api/runs")) ?? [];
      return Object.fromEntries(runs.filter((r) => r.intervention).map((r) => [r.run, r.intervention!]));
    },
    headlines: async (run) => (await getOptional<Headline[]>(`/api/runs/${run}/headlines`)) ?? [],
    citizens: (run) => getOptional<CitizenIndex>(`/api/runs/${run}/citizens`),
    diary: (run, id) => getOptional<CitizenDiary>(`/api/runs/${run}/citizens/${encodeURIComponent(id)}/diary`),
  };
}

const ECON_URL: string | undefined = import.meta.env.VITE_API_URL || undefined;
export const economyApi: EconomyApi = ECON_URL ? httpEconomyApi(ECON_URL) : mockEconomyApi();
