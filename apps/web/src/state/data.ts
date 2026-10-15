// Data hooks over the Api (mock or http). Each request is cached by key, so switching runs back and forth is instant.
// Agent days are loaded one at a time; the next day is prefetched while playing (spec: performance).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../api/client";
import type { AgentDay, AgentEvent, AgentSession, AnalystStatus, Calibration, Health, RunAreaSummary, RunFootfall, StoreInsights, CityMap, OwnerEvent, OwnerReport, RunStores, RunSummary, StreetEvent, Suggestion } from "../api/contract";
import { DAYS_PER_RUN } from "../api/contract";
import { resolveOverlaps } from "../sim/footprints";
import { mergeDays, prepareAgents, type PreparedAgent } from "../sim/interp";
import { task, watchBytes, type StageId } from "./loading";

/** Start-up loads the loading screen follows: one task, byte progress from api/http.ts for paths under `prefix`. */
function tracked<T>(stage: StageId, key: string, prefix: string, start: () => Promise<T>, optional = false): Promise<T> {
  const t = task(stage, key);
  let best = 0;
  const unwatch = watchBytes(prefix, (p) => {
    if (p > best) t.progress((best = p));
  });
  const p = start();
  p.then(
    () => (unwatch(), t.done()),
    (e: unknown) => (unwatch(), optional ? t.done() : t.fail(e instanceof Error ? e.message : String(e))),
  );
  return p;
}

const cache = new Map<string, Promise<unknown>>();

export function load<T>(key: string, loader: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    const p = loader().catch((e) => {
      cache.delete(key); // let a later render retry
      throw e;
    });
    cache.set(key, p);
  }
  return cache.get(key) as Promise<T>;
}

// Bumped by invalidate(), so every mounted resource refetches what was dropped.
let version = 0;
const listeners = new Set<() => void>();
const useDataVersion = () =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
  version++;
  listeners.forEach((fn) => fn());
}

/**
 * After POST /api/apply: poll /api/runs until the queued run finishes, then refresh everything that depends on runs.
 * Resolves with the final status ("done" / "failed"), or "timeout" after ~10 minutes.
 */
export async function watchRun(run: number, everyMs = 3000, maxTries = 200): Promise<"done" | "failed" | "timeout"> {
  for (let i = 0; i < maxTries; i++) {
    const r = (await api.runs()).find((x) => x.run === run);
    if (r && (r.status === "done" || r.status === "failed")) {
      invalidate("runs");
      invalidate("analyst");
      // a footfall asked for while the run was still going came back empty (404)
      invalidate(`footfall:${run}`);
      return r.status;
    }
    await new Promise((res) => setTimeout(res, everyMs));
  }
  return "timeout";
}

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/** Loads `key` (null = skip). Keeps showing the previous data while a new key loads, so panels don't flash. */
export function useResource<T>(key: string | null, loader: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: Error }>({ key: null });
  const v = useDataVersion();
  useEffect(() => {
    if (!key) return;
    let alive = true;
    load(key, loader).then(
      (data) => alive && setState({ key, data }),
      (error: Error) => alive && setState((s) => ({ key, data: s.data, error })),
    );
    return () => {
      alive = false;
    };
    // the key fully identifies the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v]);
  return { data: key ? state.data : undefined, error: state.error, loading: !!key && state.key !== key };
}

// OSM bounding boxes overlap; trim them once so walls never run through each other (sim/footprints.ts)
export const useMap = () =>
  useResource<CityMap>("map", () => tracked("map", "map", "/api/map", () => api.map().then((m) => ({ ...m, buildings: resolveOverlaps(m.buildings) }))));
export const useRuns = () => useResource<RunSummary[]>("runs", () => tracked("run", "runs", "/api/runs", () => api.runs()));
export const useAnalyst = () => useResource<AnalystStatus>("analyst", () => api.analyst());
export const useHealth = () => useResource<Health | null>("health", () => api.health());
export const useSummary = (run: number | null) => useResource<RunAreaSummary | null>(run == null ? null : `summary:${run}`, () => api.summary(run!));
export const useFootfall = (run: number) => useResource<RunFootfall | null>(`footfall:${run}`, () => api.footfall(run));
export const useInsights = (storeId: string | null, run: number) =>
  useResource<StoreInsights | null>(storeId ? `insights:${storeId}:${run}` : null, () => api.insights(storeId!, run));
export const useAgentSession = () => useResource<AgentSession | null>("agents:session", () => api.agentSession());
export const useAgentLog = () => useResource<AgentEvent[]>("agents:log", () => api.agentLog());
export const useCalibration = () => useResource<Calibration | null>("calibration", () => api.calibration());
export const useRunStores = (run: number | null) =>
  useResource<RunStores>(run == null ? null : `stores:${run}`, () => tracked("run", `stores:${run}`, `/api/runs/${run}/stores`, () => api.runStores(run!), true));
/** Owners' day-by-day decisions this run ([] when the backend doesn't serve them). */
export const useOwnerEvents = (run: number | null) => useResource<OwnerEvent[]>(run == null ? null : `owner-events:${run}`, () => api.ownerEvents(run!));
/** Roadworks, traffic, club nights... this run ([] when not served). */
export const useStreetEvents = (run: number | null) => useResource<StreetEvent[]>(run == null ? null : `street-events:${run}`, () => api.streetEvents(run!));
export const useSuggestions = (run: number) => useResource<Suggestion[]>(`suggestions:${run}`, () => api.suggestions(run));
export const useReport = (storeId: string | null, run: number) =>
  useResource<OwnerReport>(storeId ? `report:${storeId}:${run}` : null, () => api.report(storeId!, run));

const loadDay = (run: number, day: number) => load(`day:${run}:${day}`, () => api.day(run, day));

const NO_AGENTS: PreparedAgent[] = [];

/** One prepared day ("run:day"): `list` is set once it has loaded, so a render can read it synchronously. */
interface PreparedDay {
  promise: Promise<PreparedAgent[]>;
  list?: PreparedAgent[];
}
/** The last few prepared days (each holds ~1–2 MB of typed arrays); oldest first. */
const preparedDays = new Map<string, PreparedDay>();
const KEEP_PREPARED_DAYS = 8;

const dayTracked = new Set<number>();

/** Loads and prepares the agents around `day` once, shared by every module that draws them. */
export function prepareDay(run: number, day: number): PreparedDay {
  const key = `${run}:${day}`;
  const known = preparedDays.get(key);
  if (known) return known;
  const days = [day - 1, day].filter((d) => d >= 1);
  const start = () =>
    Promise.all(days.map((d) => loadDay(run, d))).then((ds) => {
      // trips past midnight sit in both files: draw (and count) each once
      const list: AgentDay[] = mergeDays(ds);
      entry.list = prepareAgents(list);
      return entry.list;
    });
  // the first day drawn is part of start-up (the loading screen's "Today's run")
  // (the first asked for per run: a default run the backend lacks fails quietly, the app then moves to a real one)
  const first = !dayTracked.has(run);
  dayTracked.add(run);
  const entry: PreparedDay = { promise: first ? tracked("run", `day:${run}`, `/api/runs/${run}/days/`, start, true) : start() };
  entry.promise.catch(() => {
    if (preparedDays.get(key) === entry) preparedDays.delete(key); // let a later render retry
  });
  preparedDays.set(key, entry);
  if (preparedDays.size > KEEP_PREPARED_DAYS) preparedDays.delete(preparedDays.keys().next().value!);
  return entry;
}

/**
 * Agents to draw around `day`: that day plus the previous one (night-outs spill past midnight).
 * Returns prepared (typed-array) agents and prepares day + 1 ahead, so crossing midnight swaps lists in the same
 * frame. Only ever this run and day's agents: [] while they load, and [] when a day fails to load.
 */
export function useDayAgents(run: number, day: number): PreparedAgent[] {
  const [agents, setAgents] = useState<{ key: string; list: PreparedAgent[] }>({ key: "", list: NO_AGENTS });
  const key = `${run}:${day}`;
  useEffect(() => {
    let alive = true;
    prepareDay(run, day).promise.then(
      (list) => {
        if (alive) setAgents({ key, list });
      },
      (e: unknown) => {
        if (!alive) return;
        console.warn(`[city] agents for run ${run} day ${day} unavailable`, e);
        setAgents({ key, list: NO_AGENTS });
      },
    );
    if (day < DAYS_PER_RUN) void prepareDay(run, day + 1).promise.catch(() => {});
    return () => {
      alive = false;
    };
  }, [run, day, key]);
  if (agents.key === key) return agents.list;
  // the clock just reached a day prepared ahead: draw it now rather than a blank frame until the effect catches up
  return preparedDays.get(key)?.list ?? NO_AGENTS;
}

/** Previous run's summary (for deltas), or undefined for run 1. */
export function usePrevRun(run: number) {
  const runs = useRuns().data;
  return useMemo(() => {
    const cur = runs?.find((r) => r.run === run);
    const prev = runs?.find((r) => r.run === run - 1);
    return { cur, prev, total: runs?.length ? Math.max(...runs.map((r) => r.run)) : 0 };
  }, [runs, run]);
}
