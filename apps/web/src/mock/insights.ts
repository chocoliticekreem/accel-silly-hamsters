// Mock GET /api/stores/{id}/insights: built from the mock sim's own visits, misses, energy model and the
// analyst's suggestions, in the StoreInsights shape. Store-scoped like the backend: peers appear only as
// anonymous percentiles over >= 3 stores.
import type { CityMap, Severity, StoreInsights, StoreType, Suggestion } from "../api/contract";
import { DAYS_PER_RUN, MINUTES_PER_DAY } from "../api/contract";
import { frontage } from "../sim/geometry";
import { isOpenAt } from "../sim/time";
import type { RunConfig } from "./configs";
import { GBP_PER_KWH, GROSS_MARGIN, SPEND_GBP } from "./report";
import type { RunResult } from "./simulate";

const NEARBY_M = 45;
const CO2_KG_PER_KWH = 0.145;
const DEAD_VISITS_PER_OPEN_HOUR = 0.5;
const weeks = DAYS_PER_RUN / 7;

/** Passers-by per store per hour (14-day totals): agents whose path comes within NEARBY_M of the door. */
function footfallNearby(map: CityMap, res: RunResult): Record<string, number[]> {
  const doors = map.stores.flatMap((s) => {
    const b = map.buildings.find((x) => x.id === s.buildingId);
    if (!b) return [];
    const f = frontage(b, map.streets);
    return [{ id: s.id, x: f.doorX, z: f.doorZ }];
  });
  const out: Record<string, number[]> = Object.fromEntries(doors.map((d) => [d.id, Array(24).fill(0)]));
  for (const day of res.days)
    for (const a of day.agents) {
      if ((a as { role?: string }).role === "owner") continue; // the owner is not a passer-by
      const seen = new Set<string>();
      for (const [t, x, z] of a.path)
        for (const d of doors) {
          if (Math.abs(x - d.x) > NEARBY_M || Math.abs(z - d.z) > NEARBY_M) continue;
          const key = `${d.id}:${Math.floor(t / 60)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out[d.id][Math.floor((((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60)] += 1;
        }
    }
  return out;
}

const percentile = (value: number, peers: number[]) =>
  peers.length ? peers.reduce((n, p) => n + (p < value ? 1 : p === value ? 0.5 : 0), 0) / peers.length : 0.5;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

const footCache = new WeakMap<RunResult, Record<string, number[]>>();

export function buildInsights(map: CityMap, run: number, cfg: RunConfig, res: RunResult, suggestions: Suggestion[], storeId: string): StoreInsights | null {
  {
    const store = map.stores.find((s) => s.id === storeId);
    if (!store || store.type === "club") return null;
    if (!footCache.has(res)) footCache.set(res, footfallNearby(map, res));
    const foot = footCache.get(res)!;
    const r = res.stores[storeId];
    const c = cfg[storeId];
    const kwhHour = res.kwhByHour[storeId];
    const openFraction = Array.from({ length: 24 }, (_, h) => (Number(isOpenAt(c.open, c.close, h * 60 + 15)) + Number(isOpenAt(c.open, c.close, h * 60 + 45))) / 2);
    const visits = r.kpis.visits;
    const kwh = r.kpis.kwh;
    const costGbp = kwh * GBP_PER_KWH;

    // funnel
    const passersBy = foot[storeId].reduce((a, b) => a + b, 0);
    const visitors = new Map<string, Set<number>>();
    const personas = new Map<string, number>();
    const byDow = { weekday: Array(24).fill(0), weekend: Array(24).fill(0) };
    for (const d of res.days)
      for (const a of d.agents.filter((x) => (x as { role?: string }).role !== "owner"))
        for (const v of a.visits) {
          if (v.storeId !== storeId) continue;
          const id = a.id.split("~")[0];
          if (!visitors.has(id)) visitors.set(id, new Set());
          visitors.get(id)!.add(d.day);
          personas.set(a.persona, (personas.get(a.persona) ?? 0) + 1);
          const weekend = (d.day - 1) % 7 >= 5;
          byDow[weekend ? "weekend" : "weekday"][Math.floor((v.tIn % MINUTES_PER_DAY) / 60)] += 1;
        }
    const returning = [...visitors.values()].filter((x) => x.size > 1).length;
    const captureRate = passersBy ? visits / passersBy : 0;

    // energy
    let kwhWhileClosed = 0;
    let kwhLightingWhileClosed = 0;
    let kwhLowTrafficOpen = 0;
    const lightKw = { off: 0, low: 0.001, high: 0.003 };
    const b = map.buildings.find((x) => x.id === store.buildingId)!;
    for (let h = 0; h < 24; h++) {
      const day = kwhHour[h] * DAYS_PER_RUN;
      if (openFraction[h] === 0) {
        kwhWhileClosed += day;
        kwhLightingWhileClosed += lightKw[c.lighting[h]] * b.w * b.d * DAYS_PER_RUN;
      } else if (r.visitsByHour[h] < DEAD_VISITS_PER_OPEN_HOUR) kwhLowTrafficOpen += day;
    }

    // anonymous benchmarks: same-type peers if >= 3, else everyone
    const others = map.stores.filter((s) => s.id !== storeId && s.type !== "club");
    const sameType = others.filter((s) => s.type === store.type);
    const peers = sameType.length >= 3 ? sameType : others;
    const peerVpk = peers.map((s) => res.stores[s.id].kpis.visits / Math.max(1, res.stores[s.id].kpis.kwh));
    const peerCap = peers.map((s) => res.stores[s.id].kpis.visits / Math.max(1, foot[s.id].reduce((a, x) => a + x, 0)));
    const vpk = visits / Math.max(1, kwh);
    const benchmarks =
      peers.length >= 3
        ? {
            peers: peers.length,
            peerType: (sameType.length >= 3 ? store.type : "all") as StoreType | "all",
            areaMedianVisitsPerKwh: r2(median(peerVpk)),
            visitsPerKwhPercentile: r2(percentile(vpk, peerVpk)),
            areaMedianCaptureRate: r2(median(peerCap)),
            captureRatePercentile: r2(percentile(captureRate, peerCap)),
          }
        : null;

    // ranked insights from the analyst's suggestions + what the numbers show
    const gbp = (dv: number, dk: number) => Math.round(((dv * visits * SPEND_GBP[store.type] * GROSS_MARGIN) - dk * kwh * GBP_PER_KWH) / weeks);
    const missedTotal = res.missedByHour[storeId].reduce((a, x) => a + x, 0) * DAYS_PER_RUN;
    const evidence = [{ label: `Sim replay, run ${run}`, url: `/api/runs/${run}/days/5` }];
    const mine = suggestions.filter((s) => s.storeId === storeId);
    const insights: StoreInsights["insights"] = mine.map((sug, i) => {
      const kind =
        sug.field === "lighting"
          ? sug.to === "off" || (sug.to === "low" && sug.from === "high")
            ? "wasted_energy"
            : "lighting_opportunity"
          : (sug.field === "close" && sug.to < sug.from && sug.to > "06:00") || (sug.field === "open" && sug.to > sug.from)
            ? "dead_hours"
            : "missed_demand";
      const titles = {
        missed_demand: `${Math.round(missedTotal / weeks)} people a week find it shut`,
        wasted_energy: "Lights on while shut or quiet",
        dead_hours: "Open hours with almost no visits",
        lighting_opportunity: "Dark window loses night trade",
        benchmark: "",
      };
      const sev: Severity = Math.abs(sug.expectedDelta.visits) > 0.1 || Math.abs(sug.expectedDelta.kwh) > 0.1 ? "high" : Math.abs(sug.expectedDelta.visits) > 0.03 || Math.abs(sug.expectedDelta.kwh) > 0.03 ? "medium" : "low";
      const metric =
        kind === "missed_demand"
          ? { label: "Turned away", value: Math.round(missedTotal / weeks), unit: "people/week" }
          : kind === "wasted_energy"
            ? { label: "Lighting while shut", value: Math.round(kwhLightingWhileClosed / weeks), unit: "kWh/week" }
            : kind === "dead_hours"
              ? { label: "Low-traffic open hours", value: Math.round(kwhLowTrafficOpen / weeks), unit: "kWh/week" }
              : { label: "Night passers-by", value: Math.round(foot[storeId].slice(19).reduce((a, x) => a + x, 0) / weeks), unit: "people/week" };
      return {
        id: `${kind}-${i}`,
        kind,
        severity: sev,
        title: titles[kind].slice(0, 60),
        detail: (sug.reason ?? "From 14 simulated days of this shop").slice(0, 140),
        metric,
        impact: { visits: sug.expectedDelta.visits, kwh: sug.expectedDelta.kwh, gbpPerWeek: gbp(sug.expectedDelta.visits, sug.expectedDelta.kwh) },
        confidence: sug.confidence ?? "medium",
        suggestion: sug,
        evidence,
      };
    });
    if (benchmarks)
      insights.push({
        id: "benchmark-vpk",
        kind: "benchmark",
        severity: benchmarks.visitsPerKwhPercentile < 0.34 ? "medium" : "low",
        title: `Visits per kWh: top ${Math.max(1, Math.round((1 - benchmarks.visitsPerKwhPercentile) * 100))}% of ${benchmarks.peers} ${benchmarks.peerType === "all" ? "shops" : `${store.type}s`}`.slice(0, 60),
        detail: `Area median ${benchmarks.areaMedianVisitsPerKwh} visits/kWh; anonymous peers only.`,
        metric: { label: "Visits per kWh", value: r2(vpk), unit: "visits/kWh" },
        impact: { visits: 0, kwh: 0, gbpPerWeek: 0 },
        confidence: "medium",
        suggestion: null,
        evidence,
      });
    insights.sort((a, b2) => b2.impact.gbpPerWeek - a.impact.gbpPerWeek || "hml".indexOf(a.severity[0]) - "hml".indexOf(b2.severity[0]));

    return {
      storeId,
      run,
      name: store.name,
      type: store.type,
      days: DAYS_PER_RUN,
      kpis: { visits, kwh, visitsPerKwh: r2(vpk), returnRate: r.kpis.returnRate, energyCostGbp: r2(costGbp), co2Kg: r2(kwh * CO2_KG_PER_KWH) },
      funnel: { passersBy, visits, uniqueVisitors: visitors.size, returningVisitors: returning, captureRate: r2(captureRate), returnRate: visitors.size ? r2(returning / visitors.size) : 0 },
      hourly: {
        visits: r.visitsByHour,
        footfall: foot[storeId].map((n) => r2(n / DAYS_PER_RUN)),
        missedDemand: res.missedByHour[storeId],
        kwh: kwhHour,
        lighting: c.lighting,
        openFraction,
      },
      weekdayVsWeekend: { weekday: byDow.weekday.map((n) => r2(n / 10)), weekend: byDow.weekend.map((n) => r2(n / 4)) },
      personas: [...personas.entries()].sort((a, b2) => b2[1] - a[1]).map(([persona, n]) => ({ persona, visits: n, share: r2(n / Math.max(1, visits)) })),
      energy: { kwh, kwhWhileClosed: r2(kwhWhileClosed), kwhLightingWhileClosed: r2(kwhLightingWhileClosed), kwhLowTrafficOpen: r2(kwhLowTrafficOpen), costGbp: r2(costGbp), co2Kg: r2(kwh * CO2_KG_PER_KWH), visitsPerKwh: r2(vpk) },
      benchmarks,
      insights: insights.slice(0, 5),
      note: "Simulated, not guaranteed.",
    };
  }
}
