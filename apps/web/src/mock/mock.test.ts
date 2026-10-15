import { describe, expect, it } from "vitest";
import { DAYS_PER_RUN } from "../api/contract";
import { createMockState, mockApi } from ".";

const state = createMockState();
const api = mockApi(state);

describe("mock map", () => {
  it("has the spec's cast: ~25 stores, 2 clubs, 1 station, 4 street entries", () => {
    const m = state.map;
    expect(m.stores.filter((s) => s.type !== "club").length).toBe(25);
    expect(m.stores.filter((s) => s.type === "club").length).toBe(2);
    expect(m.buildings.filter((b) => b.kind === "station").length).toBe(1);
    expect(m.entryPoints.filter((e) => e.kind === "street").length).toBe(4);
    expect(m.entryPoints.filter((e) => e.kind === "station").length).toBe(1);
  });

  it("links every store to a store/club building inside the bounds", () => {
    const m = state.map;
    for (const s of m.stores) {
      const b = m.buildings.find((x) => x.id === s.buildingId)!;
      expect(b.storeId).toBe(s.id);
      expect(["store", "club"]).toContain(b.kind);
      expect(Math.abs(b.x)).toBeLessThan(250);
      expect(Math.abs(b.z)).toBeLessThan(250);
    }
  });

  it("names the demo store", () => {
    expect(state.map.stores.some((s) => s.name === "Kebab Co" && s.type === "takeaway")).toBe(true);
  });
});

describe("hard rules", () => {
  it("never opens a store outside its licence, in any run", async () => {
    const { isOpenAt } = await import("../sim/time");
    const runs = await api.runs();
    for (const r of runs) {
      const cfg = state.config(r.run);
      for (const s of state.map.stores) {
        const lic = s.licensedHours!;
        for (let m = 0; m < 1440; m += 30)
          if (isOpenAt(cfg[s.id].open, cfg[s.id].close, m)) expect(isOpenAt(lic.open, lic.close, m), `${s.name} run ${r.run} at ${m}`).toBe(true);
      }
    }
  });

  it("gives every suggestion a confidence and a short reason", async () => {
    for (const s of await api.suggestions(1)) {
      expect(["low", "medium", "high"]).toContain(s.confidence);
      expect(s.reason!.length).toBeLessThan(45);
    }
  });
});

describe("area summary", () => {
  it("serves 24-hour area curves and a smaller footprint for the best run", async () => {
    const a = (await api.summary(1))!;
    const b = (await api.summary(state.bestRun()))!;
    expect(a.demandByHourKw).toHaveLength(24);
    expect(a.footfallByHour).toHaveLength(24);
    expect(a.demandByHourKw[a.peakHour]).toBe(a.peakKw);
    expect(b.co2Kg).toBeLessThan(a.co2Kg);
    expect(b.energyCostGbp).toBeLessThan(a.energyCostGbp);
  });
});

describe("store insights", () => {
  it("serves a store-scoped insights panel with ranked, short insights", async () => {
    const id = state.map.stores.find((s) => s.name === "Kebab Co")!.id;
    const ins = (await api.insights(id, 1))!;
    expect(ins.storeId).toBe(id);
    expect(ins.hourly.visits).toHaveLength(24);
    expect(ins.hourly.missedDemand).toHaveLength(24);
    expect(ins.funnel.passersBy).toBeGreaterThan(ins.funnel.visits);
    expect(ins.insights.length).toBeGreaterThan(0);
    expect(ins.insights.length).toBeLessThanOrEqual(5);
    for (const i of ins.insights) {
      expect(i.title.length).toBeLessThanOrEqual(60);
      expect(i.detail.length).toBeLessThanOrEqual(140);
    }
    // the data firewall: no other store's id anywhere in the payload
    const others = state.map.stores.filter((s) => s.id !== id).map((s) => `"${s.id}"`);
    const json = JSON.stringify(ins);
    for (const o of others) expect(json).not.toContain(o);
    // Kebab Co shuts at 23:00 in run 1 while the club crowd is out: that shows up as missed demand
    expect(ins.hourly.missedDemand.slice(0, 4).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("returns null for clubs", async () => {
    expect(await api.insights("c1", 1)).toBeNull();
  });
});

describe("store overview (owner page)", () => {
  const kebab = () => state.map.stores.find((s) => s.name === "Kebab Co")!.id;

  it("defaults to the best run and tells the owner, in plain words, what changed and what it earned", async () => {
    const o = (await api.overview(kebab()))!;
    expect(o.run).toBe(state.bestRun());
    expect(o.status).toBe("best_found");
    expect(o.history[0]).toMatchObject({ run: 1, label: "Your current settings" });
    expect(o.history.some((h) => h.label === "Open till 03:00")).toBe(true);
    expect(o.numbers.customersPerWeek.change).toBeGreaterThan(0);
    expect(o.numbers.profitChangePerWeekGbp).toBeGreaterThan(0);
    expect(o.headline).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji
    // "best" in the history is this shop's most profitable run
    const best = o.history.filter((h) => h.best);
    expect(best).toHaveLength(1);
    expect(best[0].profitChangePerWeekGbp).toBe(Math.max(...o.history.map((h) => h.profitChangePerWeekGbp)));
  });

  it("gives run-1 advice as plain sentences, best £ first, at most three", async () => {
    const o = (await api.overview(kebab(), 1))!;
    expect(o.advice.length).toBeGreaterThan(0);
    expect(o.advice.length).toBeLessThanOrEqual(3);
    expect(o.advice.some((a) => /^Stay open until 03:00: about \d+ more customers a week\.$/.test(a.text))).toBe(true);
    expect(o.advice[0].gbpPerWeek).toBeGreaterThanOrEqual(o.advice[o.advice.length - 1].gbpPerWeek);
    for (const a of o.advice) expect(["likely", "worth testing", "uncertain"]).toContain(a.certainty);
    expect(o.headline).toBe(o.advice[0].text);
  });

  it("keeps to this shop (data firewall) and has no page for clubs", async () => {
    const o = (await api.overview(kebab()))!;
    const json = JSON.stringify(o);
    for (const s of state.map.stores) if (s.id !== kebab()) expect(json).not.toContain(`"${s.id}"`);
    expect(await api.overview("c1")).toBeNull();
  });
});

describe("mock runs", () => {
  it("returns runs whose main KPI improves from run 1 to the best run", async () => {
    const runs = await api.runs();
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const v = runs.map((r) => r.kpis?.visitsPerKwh ?? 0);
    expect(v.every((x) => x > 0)).toBe(true); // mock runs are all done
    expect(Math.max(...v)).toBeGreaterThan(v[0] * 1.1);
    for (const r of runs) expect(r.notebook.length).toBeLessThan(90);
  });

  it("serves 14 days of agents with time-ordered paths", async () => {
    const d = await api.day(1, 5);
    expect(d.day).toBe(5);
    expect(d.agents.length).toBeGreaterThan(200);
    expect(d.agents.length).toBeLessThan(5000);
    for (const a of d.agents) {
      for (let i = 1; i < a.path.length; i++) expect(a.path[i][0]).toBeGreaterThanOrEqual(a.path[i - 1][0]);
      for (const v of a.visits) expect(v.tOut).toBeGreaterThanOrEqual(v.tIn);
    }
    expect(state.result(1).days).toHaveLength(DAYS_PER_RUN);
  });

  it("serves 24-slot store results", async () => {
    const stores = await api.runStores(1);
    for (const s of Object.values(stores)) {
      expect(s.lighting).toHaveLength(24);
      expect(s.visitsByHour).toHaveLength(24);
    }
  });

  it("gets Kebab Co more night visits once it opens late", async () => {
    const id = state.map.stores.find((s) => s.name === "Kebab Co")!.id;
    const before = (await api.runStores(1))[id].visitsByHour.slice(0, 4).reduce((a, b) => a + b, 0);
    const after = (await api.runStores(3))[id].visitsByHour.slice(0, 4).reduce((a, b) => a + b, 0);
    expect(after).toBeGreaterThan(before);
  });

  it("suggests the next experiment as diffs", async () => {
    const s = await api.suggestions(1);
    const id = state.map.stores.find((x) => x.name === "Kebab Co")!.id;
    expect(s.find((x) => x.storeId === id && x.field === "close")).toMatchObject({ from: "23:00", to: "03:00" });
  });

  it("builds an owner report and records decisions", async () => {
    const id = state.map.stores.find((x) => x.name === "Kebab Co")!.id;
    const r = await api.report(id, 1);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(r.changes.length).toBeLessThanOrEqual(3);
    expect(["low", "medium", "high"]).toContain(r.confidence);
    expect(await api.decision({ storeId: id, suggestionIndex: 0, decision: "approve" })).toEqual({ ok: true });
    expect(state.decisions).toHaveLength(1);
  });

  it("stops the analyst on threshold at the best run", async () => {
    const a = await api.analyst();
    const runs = await api.runs();
    expect(a.iterations).toBe(runs.length);
    expect(a.bestRun).toBe(state.bestRun());
  });
});
