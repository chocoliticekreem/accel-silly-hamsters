// The data contract shared with the backend. Mirrors docs/FRONTEND_PROMPT.md exactly.
// Change a shape here only together with the backend (and update the doc).
//
// Coordinates: metres, origin at Shoreditch High St station, x = east, z = north, y = up.
// Time: t = sim minutes since Day 1 00:00. 14 days = 20160.

export const MINUTES_PER_DAY = 1440;
export const DAYS_PER_RUN = 14;
export const RUN_MINUTES = MINUTES_PER_DAY * DAYS_PER_RUN; // 20160

// ---------- GET /api/map ----------

export type BuildingKind = "store" | "club" | "office" | "residential" | "station";
export type StoreType = "cafe" | "restaurant" | "takeaway" | "bar" | "shop" | "offlicence" | "club";

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Street {
  id: string;
  name: string;
  /** Polyline of [x, z] points. */
  points: [number, number][];
  width: number;
}

export interface Building {
  id: string;
  kind: BuildingKind;
  /** Set for kind "store" and "club". */
  storeId?: string;
  /** Centre of the footprint. */
  x: number;
  z: number;
  /** Size along x (w), z (d) and height (h). */
  w: number;
  d: number;
  h: number;
}

export interface Store {
  id: string;
  name: string;
  type: StoreType;
  buildingId: string;
}

export interface EntryPoint {
  id: string;
  kind: "street" | "station";
  name?: string;
  x: number;
  z: number;
}

export interface CityMap {
  bounds: Bounds;
  streets: Street[];
  buildings: Building[];
  stores: Store[];
  entryPoints: EntryPoint[];
}

// ---------- GET /api/runs ----------

export interface RunKpis {
  visits: number;
  kwh: number;
  visitsPerKwh: number;
  returnRate: number;
}

export interface RunSummary {
  run: number;
  seed: number;
  status: "queued" | "running" | "done";
  kpis: RunKpis;
  /** One-line analyst lab notebook entry. */
  notebook: string;
  createdAt: string;
  costPerStoreWeekGbp?: number;
}

// ---------- GET /api/runs/{run}/stores ----------

export type LightLevel = "off" | "low" | "high";

export interface StoreKpis {
  visits: number;
  kwh: number;
  returnRate: number;
}

export interface StoreRunResult {
  /** "HH:MM". close <= open means the store closes after midnight. */
  open: string;
  close: string;
  /** 24 values, index = hour of day. */
  lighting: LightLevel[];
  kpis: StoreKpis;
  /** 24 values, averaged over the 14 days. */
  visitsByHour: number[];
}

export type RunStores = Record<string, StoreRunResult>;

// ---------- GET /api/runs/{run}/days/{day} ----------

/** [t, x, z] */
export type PathKey = [number, number, number];

export interface StoreVisit {
  storeId: string;
  tIn: number;
  tOut: number;
}

export interface AgentDay {
  id: string;
  persona: string;
  returning: boolean;
  path: PathKey[];
  visits: StoreVisit[];
}

export interface DayData {
  day: number;
  agents: AgentDay[];
}

// ---------- GET /api/runs/{run}/suggestions ----------

export interface ExpectedDelta {
  /** Fractions, e.g. 0.18 = +18%. */
  visits: number;
  kwh: number;
}

export type Suggestion =
  | { storeId: string; field: "open" | "close"; from: string; to: string; expectedDelta: ExpectedDelta }
  | { storeId: string; field: "lighting"; hours: number[]; from: LightLevel; to: LightLevel; expectedDelta: ExpectedDelta };

// ---------- POST /api/apply ----------

export type ApplyRequest = { run: number; scope: "store"; storeIds: string[] } | { run: number; scope: "all" };
export interface ApplyResponse {
  queuedRun: number;
}

// ---------- GET /api/analyst ----------

export interface AnalystStatus {
  state: "running" | "stopped";
  startedAt: string;
  iterations: number;
  bestRun: number;
  stoppedReason: "threshold" | "max_runs" | null;
}

// ---------- GET /api/stores/{storeId}/report?run={run} ----------

export interface OwnerReport {
  storeId: string;
  changes: Suggestion[];
  impact: { visits: number; kwh: number; gbpPerWeek: number };
  confidence: "low" | "medium" | "high";
  evidence: { label: string; url: string }[];
  pdfUrl: string;
}

// ---------- POST /api/decision ----------

export interface DecisionRequest {
  storeId: string;
  suggestionIndex: number;
  decision: "approve" | "reject";
  reason?: string;
}
export interface DecisionResponse {
  ok: boolean;
}

// ---------- The client interface (mock and http both implement it) ----------

export interface Api {
  map(): Promise<CityMap>;
  runs(): Promise<RunSummary[]>;
  runStores(run: number): Promise<RunStores>;
  day(run: number, day: number): Promise<DayData>;
  suggestions(run: number): Promise<Suggestion[]>;
  apply(req: ApplyRequest): Promise<ApplyResponse>;
  analyst(): Promise<AnalystStatus>;
  report(storeId: string, run: number): Promise<OwnerReport>;
  decision(req: DecisionRequest): Promise<DecisionResponse>;
}
