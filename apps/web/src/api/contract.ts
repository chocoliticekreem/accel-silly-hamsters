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

export interface HoursWindow {
  open: string;
  close: string;
}

/** A cited source (map data, report evidence). */
export interface Source {
  label: string;
  url: string;
  fetchedAt?: string | null;
}

export interface Store {
  id: string;
  name: string;
  type: StoreType;
  buildingId: string;
  // Additive (backend/contract.py): optional, the UI works without them.
  /** Hours the premises licence allows; suggestions never go outside these. */
  licensedHours?: HoursWindow | null;
  /** The owner's current hours (what run 1 uses). */
  defaultHours?: HoursWindow | null;
  /** m², from the EPC register / OSM footprint. */
  floorArea?: number | null;
  osmId?: string | null;
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
  /** Additive: citations for where the map came from. */
  sources?: Source[];
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
  status: "queued" | "running" | "done" | "failed";
  /** null until the run is done. */
  kpis: RunKpis | null;
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

export type Confidence = "low" | "medium" | "high";

/** Additive fields every suggestion may carry: honest confidence and a one-line reason. */
interface SuggestionExtras {
  confidence?: Confidence | null;
  reason?: string | null;
}

export type Suggestion =
  | ({ storeId: string; field: "open" | "close"; from: string; to: string; expectedDelta: ExpectedDelta } & SuggestionExtras)
  | ({ storeId: string; field: "lighting"; hours: number[]; from: LightLevel; to: LightLevel; expectedDelta: ExpectedDelta } & SuggestionExtras);

// ---------- POST /api/apply ----------

export type ApplyRequest = { run: number; scope: "store"; storeIds: string[] } | { run: number; scope: "all" };
export interface ApplyResponse {
  queuedRun: number;
}

// ---------- GET /api/analyst ----------

export interface AnalystStatus {
  state: "running" | "stopped";
  /** null before the first training session. */
  startedAt: string | null;
  iterations: number;
  bestRun: number | null;
  /** budget = spend cap reached (hard stop); error = the session crashed and can resume. */
  stoppedReason: "threshold" | "max_runs" | "budget" | "error" | null;
  /** The session's untouched starting run (compare mode's left side). */
  baselineRun?: number | null;
}

// ---------- GET /api/stores/{storeId}/report?run={run} ----------

export interface OwnerReport {
  storeId: string;
  changes: Suggestion[];
  impact: { visits: number; kwh: number; gbpPerWeek: number };
  confidence: Confidence;
  evidence: Source[];
  /** null when the PDF isn't rendered yet. */
  pdfUrl: string | null;
  /** Additive: the honesty note shown with every report. */
  note?: string;
}

// ---------- POST /api/decision ----------

export interface DecisionRequest {
  /** The run whose report the owner saw (sent as ?run=). */
  run?: number;
  storeId: string;
  suggestionIndex: number;
  decision: "approve" | "reject";
  reason?: string;
}
export interface DecisionResponse {
  ok: boolean;
}

// ---------- GET /api/calibration (additive, optional) ----------
// Sim busyness vs Google Popular Times for a few anchor venues: the credibility chart.
// Mirrors data/processed/calibration.json. A backend without it answers 404; the UI then hides the tab.

export interface CalibrationVenue {
  name: string;
  storeId: string;
  type: StoreType;
  /** 24 values, 0–100 = share of the venue's busiest hour of the week (Popular Times scale). */
  weekday: number[];
  weekend: number[];
  /** false = a placeholder shape for the venue type, not data for this venue. Never use it as proof. */
  measured: boolean;
  source: Source | null;
}

export interface Calibration {
  venues: CalibrationVenue[];
  /** true when every target fell back to placeholders. */
  fallback?: boolean;
  notes?: string[];
  sources?: Source[];
}

// ---------- GET /api/runs/{run}/summary (additive) ----------
// Area totals for the city view (anonymised: no store ids). Totals cover the 14-day run.

export interface RunAreaSummary {
  run: number;
  seed: number;
  kpis: RunKpis;
  objective: string;
  objectiveValue: number;
  peakKw: number;
  peakHour: number;
  co2Kg: number;
  energyCostGbp: number;
  /** 24 values: the area's power demand by hour, averaged over the 14 days. */
  demandByHourKw: number[];
  /** 24 values: people in the area by hour. */
  footfallByHour: number[];
  agents: { returning: number; oneOff: number; total: number };
  durationSec: number;
}

// ---------- GET /api/health (additive) ----------

export interface Health {
  ok: boolean;
  simVersion: string;
  /** "sample" = hand-made demo map; "processed" = the real pipeline output. */
  mapSource: "processed" | "sample" | "missing";
  realRuns: number;
}

// ---------- GET /api/stores/{storeId}/insights?run={run} (additive) ----------
// One shop's analytics panel ("PostHog for shop energy"). Store-scoped: no other shop's id, name or numbers;
// benchmarks are anonymous percentiles over >= 3 peers. kpis/funnel/energy = 14-day totals; hourly and
// weekdayVsWeekend = per-day averages by clock hour; insight metrics and impact.gbpPerWeek = per week.

export type InsightKind = "missed_demand" | "wasted_energy" | "dead_hours" | "lighting_opportunity" | "benchmark";
export type Severity = "high" | "medium" | "low";

export interface StoreInsights {
  storeId: string;
  run: number;
  name: string;
  type: StoreType;
  days: number;
  kpis: { visits: number; kwh: number; visitsPerKwh: number; returnRate: number; energyCostGbp: number; co2Kg: number };
  funnel: { passersBy: number; visits: number; uniqueVisitors: number; returningVisitors: number; captureRate: number; returnRate: number };
  hourly: {
    visits: number[];
    footfall: number[];
    /** People who walked to the store and found it shut. */
    missedDemand: number[];
    kwh: number[];
    lighting: LightLevel[];
    /** 0..1 share of the hour the store is open. */
    openFraction: number[];
  };
  weekdayVsWeekend: { weekday: number[]; weekend: number[] };
  personas: { persona: string; visits: number; share: number }[];
  energy: { kwh: number; kwhWhileClosed: number; kwhLightingWhileClosed: number; kwhLowTrafficOpen: number; costGbp: number; co2Kg: number; visitsPerKwh: number };
  /** null when fewer than 3 anonymous peers exist. */
  benchmarks: {
    peers: number;
    peerType: StoreType | "all";
    areaMedianVisitsPerKwh: number;
    /** 0..1 share of peers below this store. */
    visitsPerKwhPercentile: number;
    areaMedianCaptureRate: number;
    captureRatePercentile: number;
  } | null;
  /** Ranked by £/week then severity; at most 5. */
  insights: {
    id: string;
    kind: InsightKind;
    severity: Severity;
    title: string;
    detail: string;
    metric: { label: string; value: number; unit: string };
    impact: { visits: number; kwh: number; gbpPerWeek: number };
    confidence: Confidence;
    suggestion: Suggestion | null;
    evidence: Source[];
  }[];
  note?: string;
}

// ---------- GET /api/stores/{storeId}/overview?run= (docs/STORE_PAGE.md) ----------
// One call renders the owner's store page. Plain English; only this shop's numbers.

export type OverviewStatus = "not_started" | "improving" | "best_found";
export type Certainty = "likely" | "worth testing" | "uncertain";
export type AdviceStatus = "new" | "applied" | "tested_better" | "tested_worse";

export interface OverviewNumber {
  value: number;
  /** Fraction vs the baseline run (0.33 = +33%). */
  change: number;
}

export interface StoreOverview {
  storeId: string;
  name: string;
  type: StoreType;
  run: number;
  baselineRun: number;
  bestRun: number | null;
  status: OverviewStatus;
  /** One sentence of advice, not a metric. */
  headline: string;
  numbers: {
    customersPerWeek: OverviewNumber;
    energyCostPerWeekGbp: OverviewNumber;
    kwhPerWeek: OverviewNumber;
    /** Margin on extra customers minus extra energy cost, vs the baseline. */
    profitChangePerWeekGbp: number;
  };
  advice: { text: string; gbpPerWeek: number; certainty: Certainty; status: AdviceStatus; suggestion: Suggestion | null }[];
  /** Baseline plus every run that changed this shop's settings, oldest first. */
  history: { run: number; label: string; customersPerWeek: number; kwhPerWeek: number; profitChangePerWeekGbp: number; changes: string[]; best: boolean }[];
  note?: string;
}

// ---------- GET /api/agents/session, GET /api/agents/log (additive) ----------
// The Agents view: the analyst checkpoint and the session's story (hand-offs, proposals, hypotheses,
// experiments, results). Area-level; no prompts, responses or per-store lists.

export interface AgentSession {
  sessionId: string;
  state: "running" | "stopped";
  startedAt: string;
  updatedAt: string;
  /** heuristic | messages | managed */
  backend: string;
  fresh: boolean;
  seed: number;
  baselineRun?: number | null;
  currentRun?: number | null;
  bestRun?: number | null;
  bestObjective?: number | null;
  iterations: number;
  runsThisSession: number[];
  /** Runs in a row below the gain threshold (patience). */
  lowGainStreak: number;
  /** Last completed step, for resume: start | baseline | proposed | chosen | ran | scored | ... */
  step: string;
  stoppedReason?: "threshold" | "max_runs" | "budget" | "error" | null;
  spentGbp: number;
  error?: string | null;
}

export interface AgentEvent {
  at: string;
  /** analyst | store_owner | store_agents | training | ... */
  agent: string;
  type: string;
  run?: number | null;
  data: Record<string, string | number | boolean | null>;
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
  /** null when the backend doesn't serve calibration yet. */
  calibration(): Promise<Calibration | null>;
  /** null when the run has no summary (404). */
  summary(run: number): Promise<RunAreaSummary | null>;
  /** null when the backend has no health endpoint. */
  health(): Promise<Health | null>;
  /** null for clubs, runs without store stats, or a backend without insights (404). */
  insights(storeId: string, run: number): Promise<StoreInsights | null>;
  /** The owner's store page. run omitted = the shop's best run, else the latest. */
  overview(storeId: string, run?: number): Promise<StoreOverview | null>;
  /** POST /api/stores/{id}/optimize: a training session scoped to this shop. Throws ApiError (409 busy, 403 read-only). */
  optimize(storeId: string, maxRuns?: number): Promise<AnalystStatus>;
  /** null before any training session (404). */
  agentSession(): Promise<AgentSession | null>;
  /** The session's story, oldest first ([] when not served). */
  agentLog(run?: number): Promise<AgentEvent[]>;
}

/** An HTTP error with its status, so the UI can say "already running" (409) or "read-only demo" (403). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
