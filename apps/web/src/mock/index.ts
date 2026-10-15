// mockApi(): the full backend contract served from memory. Same interface as http.ts.
// Runs are simulated lazily and cached; everything is deterministic (seed 42).
import type { AnalystStatus, Api, Calibration, RunAreaSummary, CalibrationVenue, CityMap, DecisionRequest, RunSummary } from "../api/contract";
// The backend pipeline's calibration targets (placeholder shapes until Popular Times is measured).
import calibrationData from "../../../../data/processed/calibration.json";
// The pipeline's live London carbon and price profile, so mock area totals use real numbers.
import energyData from "../../../../data/processed/energy.json";
import { formatHHMM } from "../sim/time";
import { configForRun, LICENCE, MOCK_RUN_COUNT, notebookLabel, type RunConfig } from "./configs";
import { generateMap } from "./map";
import { buildInsights } from "./insights";
import { buildReport, makePdf, suggestionsBetween } from "./report";
import { simulateRun, type RunResult } from "./simulate";

export const MOCK_SEED = 42;
const STARTED_AT = Date.parse("2026-10-15T23:00:00Z");
const MINUTES_PER_RUN = 69; // analyst wall-clock per iteration → ~9h 12m for 8 runs

export interface MockState {
  map: CityMap;
  config(run: number): RunConfig;
  result(run: number): RunResult;
  runs(): RunSummary[];
  bestRun(): number;
  decisions: DecisionRequest[];
}

export function createMockState(): MockState {
  const map = generateMap(MOCK_SEED);
  const configs = new Map<number, RunConfig>();
  const results = new Map<number, RunResult>();
  const config = (run: number) => {
    if (!configs.has(run)) configs.set(run, configForRun(map, run));
    return configs.get(run)!;
  };
  const result = (run: number) => {
    if (!results.has(run)) results.set(run, simulateRun(map, config(run), MOCK_SEED));
    return results.get(run)!;
  };
  // additive map fields the real backend serves: licence, current hours, floor area, sources
  for (const s of map.stores) {
    const b = map.buildings.find((x) => x.id === s.buildingId)!;
    s.licensedHours = LICENCE[s.type];
    s.defaultHours = { open: config(1)[s.id].open, close: config(1)[s.id].close };
    s.floorArea = Math.round(b.w * b.d);
  }
  map.sources = [
    { label: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright" },
    { label: "EPC register", url: "https://epc.opendatacommunities.org/" },
    { label: "Carbon Intensity API", url: "https://carbonintensity.org.uk/" },
  ];
  let summaries: RunSummary[] | null = null;
  const runs = () => {
    if (summaries) return summaries;
    summaries = Array.from({ length: MOCK_RUN_COUNT }, (_, i) => {
      const run = i + 1;
      const k = result(run).kpis;
      const prev = run > 1 ? result(run - 1).kpis : null;
      const d = prev ? (k.visitsPerKwh - prev.visitsPerKwh) / prev.visitsPerKwh : 0;
      const sign = d >= 0 ? "+" : "−";
      const effect = prev ? ` → ${sign}${Math.abs(Math.round(d * 100))}% visits/kWh` : "";
      return {
        run,
        seed: MOCK_SEED,
        status: "done" as const,
        kpis: k,
        notebook: `${notebookLabel(run)}${effect}`,
        createdAt: new Date(STARTED_AT + run * MINUTES_PER_RUN * 60_000).toISOString(),
        costPerStoreWeekGbp: Math.round((0.38 + 0.01 * (run % 4)) * 100) / 100,
      };
    });
    return summaries;
  };
  const bestRun = () => runs().reduce((best, r) => ((r.kpis?.visitsPerKwh ?? 0) > (best.kpis?.visitsPerKwh ?? 0) ? r : best)).run;
  return { map, config, result, runs, bestRun, decisions: [] };
}

/** Simulated network latency, so loading states get exercised in mock mode too. */
const later = <T>(fn: () => T, ms = 60): Promise<T> =>
  new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(structuredClone(fn()));
      } catch (e) {
        reject(e);
      }
    }, ms),
  );

const pdfUrls = new Map<string, string>();

export function mockApi(state: MockState = createMockState()): Api {
  const { map } = state;
  const storeName = (id: string) => map.stores.find((s) => s.id === id)?.name ?? id;
  const areas = Object.fromEntries(
    map.stores.map((s) => {
      const b = map.buildings.find((x) => x.id === s.buildingId)!;
      return [s.id, b.w * b.d];
    }),
  );

  return {
    map: () => later(() => map),
    runs: async () => {
      // simulate runs one by one, yielding between them, so the first paint isn't blocked
      for (let r = 1; r <= MOCK_RUN_COUNT; r++) {
        state.result(r);
        await new Promise((res) => setTimeout(res, 0));
      }
      return later(() => state.runs());
    },
    runStores: (run) => later(() => state.result(run).stores),
    day: (run, day) => later(() => state.result(run).days[day - 1], 30),
    // what the store agents propose from this run: the diff to the best config the analyst found
    suggestions: (run) =>
      later(() => {
        const best = state.bestRun();
        return run >= best ? [] : suggestionsBetween(state.config(run), state.config(best), state.result(run).stores, state.result(best).stores, areas);
      }),
    // like the backend's run cache: the config was already tried, so the "queued" run is an existing, finished one
    apply: (req) => later(() => ({ queuedRun: Math.min(req.run + 1, MOCK_RUN_COUNT) })),
    analyst: () =>
      later<AnalystStatus>(() => ({
        state: "stopped",
        startedAt: new Date(STARTED_AT).toISOString(),
        iterations: MOCK_RUN_COUNT,
        bestRun: state.bestRun(),
        stoppedReason: "threshold",
      })),
    report: (storeId, run) =>
      later(() => {
        const best = state.bestRun();
        // the owner's report: what this run's config should change to reach the best one (run 1 if already best)
        const from = run === best ? 1 : run;
        const store = map.stores.find((s) => s.id === storeId)!;
        const key = `${storeId}:${from}`;
        let report = buildReport(storeId, store.type, state.config(from), state.config(best), state.result(from).stores, state.result(best).stores, areas[storeId], `?run=${best}&store=${storeId}&t=${4 * 1440 + 2 * 60}`, "");
        if (!pdfUrls.has(key) && typeof URL.createObjectURL === "function") {
          const lines = [
            `Run ${from} -> best run ${best}`,
            ...report.changes.map((c) =>
              c.field === "lighting"
                ? `Light ${String(c.hours[0]).padStart(2, "0")}h (+${c.hours.length}h): ${c.from} -> ${c.to}`
                : `${c.field === "open" ? "Open" : "Close"} ${c.from} -> ${c.to}`,
            ),
            `Visits ${pct(report.impact.visits)}, kWh ${pct(report.impact.kwh)}, GBP ${report.impact.gbpPerWeek}/week`,
            `Confidence: ${report.confidence}. Simulated, not guaranteed.`,
            `Generated ${formatHHMM(new Date().getHours() * 60 + new Date().getMinutes())}`,
          ];
          pdfUrls.set(key, URL.createObjectURL(makePdf(`Weekly report: ${storeName(storeId)}`, lines)));
        }
        report = { ...report, pdfUrl: pdfUrls.get(key) ?? `/files/reports/${storeId}.pdf` };
        return report;
      }),
    // the backend's targets, re-pointed at the mock store of the same type (the demo takeaway for takeaways)
    calibration: () =>
      later<Calibration>(() => {
        const used = new Set<string>();
        const venues = (calibrationData.venues as CalibrationVenue[]).flatMap((v) => {
          const pick =
            (v.type === "takeaway" && map.stores.find((s) => s.name === "Kebab Co")) ||
            map.stores.find((s) => s.type === v.type && !used.has(s.id));
          if (!pick) return [];
          used.add(pick.id);
          return [{ ...v, storeId: pick.id }];
        });
        return { venues, fallback: calibrationData.fallback, notes: calibrationData.notes };
      }),
    summary: (run) =>
      later<RunAreaSummary>(() => {
        const r = state.result(run);
        const peakKw = Math.max(...r.demandByHourKw);
        const days = 14;
        const co2Kg = r.demandByHourKw.reduce((sum, kw, h) => sum + kw * energyData.carbonGPerKwh[h], 0) * days / 1000;
        const energyCostGbp = r.demandByHourKw.reduce((sum, kw, h) => sum + kw * energyData.priceGbpPerKwh[h], 0) * days;
        return {
          run,
          seed: MOCK_SEED,
          kpis: r.kpis,
          objective: "visitsPerKwh",
          objectiveValue: r.kpis.visitsPerKwh,
          peakKw: Math.round(peakKw * 100) / 100,
          peakHour: r.demandByHourKw.indexOf(peakKw),
          co2Kg: Math.round(co2Kg * 10) / 10,
          energyCostGbp: Math.round(energyCostGbp * 100) / 100,
          demandByHourKw: r.demandByHourKw,
          footfallByHour: r.footfallByHour,
          agents: r.agents,
          durationSec: 0,
        };
      }),
    insights: (storeId, run) =>
      later(() => {
        const best = state.bestRun();
        const sugg = run >= best ? [] : suggestionsBetween(state.config(run), state.config(best), state.result(run).stores, state.result(best).stores, areas);
        return buildInsights(map, run, state.config(run), state.result(run), sugg, storeId);
      }),
    health: () => later(() => ({ ok: true, simVersion: "mock", mapSource: "sample" as const, realRuns: MOCK_RUN_COUNT })),
    decision: (req) =>
      later(() => {
        state.decisions.push(req);
        return { ok: true };
      }),
  };
}

function pct(n: number) {
  return `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;
}
