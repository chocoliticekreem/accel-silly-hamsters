// Builds the store page from endpoints every backend already serves, for backends without
// GET /api/stores/{id}/overview yet. Same shape as the real endpoint (docs/STORE_PAGE.md).
import { composeOverview } from "../sim/overview";
import type { Api, RunStores, StoreOverview } from "./contract";

type Parts = Pick<Api, "map" | "runs" | "runStores" | "suggestions" | "analyst">;

export async function overviewFromParts(api: Parts, storeId: string, run?: number): Promise<StoreOverview | null> {
  const [map, runs, analyst] = await Promise.all([api.map(), api.runs(), api.analyst()]);
  const store = map.stores.find((s) => s.id === storeId);
  const done = runs.filter((r) => r.status === "done");
  if (!store || store.type === "club" || !done.length) return null;
  const baselineRun = analyst.baselineRun ?? done[0].run;
  const target = run ?? analyst.bestRun ?? done[done.length - 1].run;
  const storesByRun = new Map<number, RunStores>();
  await Promise.all(done.map(async (r) => storesByRun.set(r.run, await api.runStores(r.run))));
  if (!storesByRun.get(target)?.[storeId] || !storesByRun.get(baselineRun)?.[storeId]) return null;
  return composeOverview({
    store,
    runs,
    storesByRun,
    baselineRun,
    bestRun: analyst.bestRun,
    analystStopped: analyst.state === "stopped",
    run: target,
    suggestions: await api.suggestions(target).catch(() => []),
  });
}
