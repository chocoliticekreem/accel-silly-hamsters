// Composes the owner's store page (StoreOverview, docs/STORE_PAGE.md) from data every backend already serves:
// run list, per-run store results and suggestions. Used by the mock and as the http fallback until the backend
// serves GET /api/stores/{id}/overview. Plain English, this shop only.
import type { AdviceStatus, Certainty, Confidence, RunStores, RunSummary, Store, StoreOverview, Suggestion } from "../api/contract";
import { DAYS_PER_RUN } from "../api/contract";
import { diffStore, type Change } from "./diff";
import { GBP_PER_KWH, profitPerWeek, windowHours } from "./economics";
import { rangeLabel } from "./time";

const WEEKS = DAYS_PER_RUN / 7;

export const CERTAINTY: Record<Confidence, Certainty> = { high: "likely", medium: "worth testing", low: "uncertain" };

/** Short label for a change: "Close 22:30 → 03:30", "Lights 18–24 off". */
export function changeLabel(c: Change): string {
  if (c.field === "lighting") return `Lights ${rangeLabel(c.hours)} ${c.from} → ${c.to}`;
  return `${c.field === "open" ? "Open" : "Close"} ${c.from} → ${c.to}`;
}

/** History label: the first change in words ("Open till 03:30"), or the baseline wording. */
function runLabel(changes: Change[]): string {
  const c = changes[0];
  if (!c) return "Your current settings";
  if (c.field !== "lighting") return c.field === "close" ? `Open till ${c.to}` : `Open from ${c.to}`;
  return `Lights ${rangeLabel(c.hours)} ${c.to}`;
}

/** One plain sentence per suggestion, with the number an owner cares about. */
export function adviceText(s: Suggestion, perWeek: { customers: number; gbp: number }): string {
  const more = Math.round(perWeek.customers);
  const save = Math.abs(Math.round(perWeek.gbp));
  const minutes = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));
  const later = (a: string, b: string) => (minutes(a) - 300 + 1440) % 1440 > (minutes(b) - 300 + 1440) % 1440;
  switch (s.field) {
    case "close":
      return later(s.to, s.from)
        ? `Stay open until ${s.to}: about ${more} more customers a week.`
        : `Close at ${s.to} instead of ${s.from}: the last hours are nearly empty, saving about £${save} a week.`;
    case "open":
      return later(s.from, s.to)
        ? `Open at ${s.to}: catch about ${more} more customers a week.`
        : `Open at ${s.to} instead of ${s.from}: the first hours are nearly empty.`;
    default: {
      const brighter = { off: 0, low: 1, high: 2 }[s.to] > { off: 0, low: 1, high: 2 }[s.from];
      return brighter
        ? `Light the window ${rangeLabel(s.hours)}: about ${more} more customers a week.`
        : `Turn the window lights ${s.to} ${rangeLabel(s.hours)}: saves about £${save} a week.`;
    }
  }
}

export interface OverviewInput {
  store: Store;
  runs: RunSummary[];
  /** run → that run's store results (at least the baseline, the current run and every history run). */
  storesByRun: Map<number, RunStores>;
  baselineRun: number;
  bestRun: number | null;
  analystStopped: boolean;
  run: number;
  /** Suggestions on `run` (all stores; filtered here). */
  suggestions: Suggestion[];
}

export function composeOverview(i: OverviewInput): StoreOverview {
  const id = i.store.id;
  const done = i.runs.filter((r) => r.status === "done" && i.storesByRun.has(r.run)).sort((a, b) => a.run - b.run);
  const base = i.storesByRun.get(i.baselineRun)![id];
  const cur = i.storesByRun.get(i.run)![id];
  const perWeek = (x: typeof cur) => ({ customers: x.kpis.visits / WEEKS, kwh: x.kpis.kwh / WEEKS, hours: (x.kpis.openHours ?? 0) / WEEKS });
  const b = perWeek(base);
  const c = perWeek(cur);
  const frac = (from: number, to: number) => (from > 0 ? (to - from) / from : 0);
  const profit = (x: typeof cur) => profitPerWeek(i.store.type, perWeek(x).customers - b.customers, perWeek(x).kwh - b.kwh, perWeek(x).hours - b.hours);

  // history: baseline + every run that changed this shop's settings vs the run before it
  const history: StoreOverview["history"] = [];
  let prev: typeof cur | null = null;
  for (const r of done) {
    const s = i.storesByRun.get(r.run)![id];
    if (!s) continue;
    const changes = r.run === i.baselineRun ? [] : prev ? diffStore(id, prev, s) : [];
    if (r.run === i.baselineRun || changes.length)
      history.push({
        run: r.run,
        label: runLabel(changes),
        customersPerWeek: Math.round(perWeek(s).customers),
        kwhPerWeek: Math.round(perWeek(s).kwh),
        profitChangePerWeekGbp: Math.round(profit(s)),
        changes: changes.map(changeLabel),
        best: false,
      });
    prev = s;
  }
  // "best" is this shop's best (profit vs its original settings), not the area-wide best run
  const shopBest = history.reduce<(typeof history)[number] | null>((m, h) => (!m || h.profitChangePerWeekGbp > m.profitChangePerWeekGbp ? h : m), null);
  if (shopBest && history.length > 1) shopBest.best = true;

  // advice: this shop's suggestions, best £ first, with whether an earlier run already tried them
  const tried = new Map<string, number>();
  prev = null;
  for (const r of done) {
    const s = i.storesByRun.get(r.run)![id];
    if (prev) for (const ch of diffStore(id, prev, s)) tried.set(JSON.stringify({ ...ch, storeId: "" }), profit(s) - profit(prev));
    prev = s;
  }
  const advice: StoreOverview["advice"] = i.suggestions
    .filter((s) => s.storeId === id)
    .map((s) => {
      const dCustomers = c.customers * s.expectedDelta.visits;
      const dKwh = c.kwh * s.expectedDelta.kwh;
      // an hours change also changes the wage bill: scale the hours actually open by the new window (backend/economics.py)
      const window = (o: string, cl: string) => windowHours(o, cl);
      const dHours =
        s.field === "open" || s.field === "close"
          ? c.hours * (window(s.field === "open" ? String(s.to) : cur.open, s.field === "close" ? String(s.to) : cur.close) / window(cur.open, cur.close) - 1)
          : 0;
      const gbpPerWeek = Math.round(profitPerWeek(i.store.type, dCustomers, dKwh, dHours));
      const { expectedDelta: _d, confidence: _c, reason: _r, ...change } = s;
      const key = JSON.stringify({ ...change, storeId: "" });
      const status: AdviceStatus = tried.has(key) ? ((tried.get(key) ?? 0) >= 0 ? "tested_better" : "tested_worse") : "new";
      return { text: adviceText(s, { customers: dCustomers, gbp: gbpPerWeek }), gbpPerWeek, certainty: CERTAINTY[s.confidence ?? "medium"], status, suggestion: s };
    })
    .sort((x, y) => y.gbpPerWeek - x.gbpPerWeek)
    .slice(0, 3);
  // advice already in this run's settings
  const applied = history.filter((h) => h.run <= i.run && h.run !== i.baselineRun).flatMap((h) => h.changes);
  for (const a of advice) if (a.suggestion && applied.includes(changeLabel(a.suggestion))) a.status = "applied";

  const onlyBaseline = done.length <= 1;
  const status: StoreOverview["status"] = onlyBaseline ? "not_started" : i.analystStopped && i.bestRun != null ? "best_found" : "improving";
  const profitNow = Math.round(profit(cur));
  const headline =
    advice[0]?.text ??
    (status === "not_started"
      ? "No changes tested for your shop yet: run the agents to get this week's advice."
      : profitNow < 0
        ? `Your original settings did better: going back is about £${-profitNow} a week better for you.`
        : profitNow > 0
          ? `Keep these settings: about ${Math.round(c.customers)} customers a week, £${profitNow} a week better off.`
          : `No change has beaten your original settings yet: about ${Math.round(c.customers)} customers a week.`);

  return {
    storeId: id,
    name: i.store.name,
    type: i.store.type,
    run: i.run,
    baselineRun: i.baselineRun,
    bestRun: i.bestRun,
    status,
    headline,
    numbers: {
      customersPerWeek: { value: Math.round(c.customers), change: frac(b.customers, c.customers) },
      energyCostPerWeekGbp: { value: Math.round(c.kwh * GBP_PER_KWH * 100) / 100, change: frac(b.kwh, c.kwh) },
      kwhPerWeek: { value: Math.round(c.kwh), change: frac(b.kwh, c.kwh) },
      profitChangePerWeekGbp: profitNow,
    },
    advice,
    history,
    note: "Simulated, not guaranteed.",
  };
}
