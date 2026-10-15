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
