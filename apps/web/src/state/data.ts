// Data hooks over the Api (mock or http). Each request is cached by key, so switching runs back and forth is instant.
// Agent days are loaded one at a time; the next day is prefetched while playing (spec: performance).
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { AgentDay, AnalystStatus, CityMap, OwnerReport, RunStores, RunSummary, Suggestion } from "../api/contract";
import { DAYS_PER_RUN } from "../api/contract";
import { prepareAgents, type PreparedAgent } from "../sim/interp";

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

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/** Loads `key` (null = skip). Keeps showing the previous data while a new key loads, so panels don't flash. */
export function useResource<T>(key: string | null, loader: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: Error }>({ key: null });
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
  }, [key]);
  return { data: key ? state.data : undefined, error: state.error, loading: !!key && state.key !== key };
}

export const useMap = () => useResource<CityMap>("map", () => api.map());
export const useRuns = () => useResource<RunSummary[]>("runs", () => api.runs());
export const useAnalyst = () => useResource<AnalystStatus>("analyst", () => api.analyst());
export const useRunStores = (run: number | null) => useResource<RunStores>(run == null ? null : `stores:${run}`, () => api.runStores(run!));
export const useSuggestions = (run: number) => useResource<Suggestion[]>(`suggestions:${run}`, () => api.suggestions(run));
export const useReport = (storeId: string | null, run: number) =>
  useResource<OwnerReport>(storeId ? `report:${storeId}:${run}` : null, () => api.report(storeId!, run));

const loadDay = (run: number, day: number) => load(`day:${run}:${day}`, () => api.day(run, day));

/**
 * Agents to draw around `day`: that day plus the previous one (night-outs spill past midnight).
 * Returns prepared (typed-array) agents; prefetches day + 1.
 */
export function useDayAgents(run: number, day: number): PreparedAgent[] {
  const [agents, setAgents] = useState<{ key: string; list: PreparedAgent[] }>({ key: "", list: [] });
  const key = `${run}:${day}`;
  useEffect(() => {
    let alive = true;
    const days = [day - 1, day].filter((d) => d >= 1);
    Promise.all(days.map((d) => loadDay(run, d))).then((ds) => {
      if (!alive) return;
      const list: AgentDay[] = ds.flatMap((d) => d.agents);
      setAgents({ key, list: prepareAgents(list) });
    });
    if (day < DAYS_PER_RUN) void loadDay(run, day + 1).catch(() => {});
    return () => {
      alive = false;
    };
  }, [run, day, key]);
  return agents.list;
}

/** Previous run's summary (for deltas), or undefined for run 1. */
export function usePrevRun(run: number) {
  const runs = useRuns().data;
  return useMemo(() => {
    const cur = runs?.find((r) => r.run === run);
    const prev = runs?.find((r) => r.run === run - 1);
    return { cur, prev, total: runs?.length ?? 0 };
  }, [runs, run]);
}
