// Suggestions = the config diff between a run and the next one. Owner report = the diff between what a store
// runs in a given run and the best run found, with impact taken from the simulated results.
import type { ExpectedDelta, LightLevel, OwnerReport, RunStores, StoreType, Suggestion } from "../api/contract";
import { DAYS_PER_RUN } from "../api/contract";
import type { RunConfig, StoreConfig } from "./configs";
import { LIGHT_KWH } from "./simulate";

/** Average spend per visit (£) by type, for the £/week line. */
export const SPEND_GBP: Record<StoreType, number> = { cafe: 6, restaurant: 22, takeaway: 9, bar: 14, shop: 15, offlicence: 8, club: 0 };
export const GBP_PER_KWH = 0.28;
/** Share of extra takings an owner keeps (the £/week line is profit, not revenue). */
export const GROSS_MARGIN = 0.3;

/** A suggestion before its expected delta is known (Omit that keeps the field union intact). */
export type Change = Suggestion extends infer S ? (S extends Suggestion ? Omit<S, "expectedDelta"> : never) : never;

/** Groups consecutive hours whose lighting changed the same way into one suggestion. */
function lightingDiff(storeId: string, a: LightLevel[], b: LightLevel[]): Omit<Extract<Suggestion, { field: "lighting" }>, "expectedDelta">[] {
  const out: Omit<Extract<Suggestion, { field: "lighting" }>, "expectedDelta">[] = [];
  // walk the day starting at 05:00 so overnight ranges (23–03) stay together
  const order = Array.from({ length: 24 }, (_, i) => (i + 5) % 24);
  let cur: (typeof out)[number] | null = null;
  for (const h of order) {
    if (a[h] === b[h]) {
      cur = null;
      continue;
    }
    if (cur && cur.from === a[h] && cur.to === b[h] && cur.hours[cur.hours.length - 1] === (h + 23) % 24) cur.hours.push(h);
    else {
      cur = { storeId, field: "lighting", hours: [h], from: a[h], to: b[h] };
      out.push(cur);
    }
  }
  return out;
}

export function diffStore(storeId: string, a: StoreConfig, b: StoreConfig): Change[] {
  const out: Change[] = [];
  if (a.open !== b.open) out.push({ storeId, field: "open", from: a.open, to: b.open });
  if (a.close !== b.close) out.push({ storeId, field: "close", from: a.close, to: b.close });
  out.push(...lightingDiff(storeId, a.lighting, b.lighting));
  return out;
}

const frac = (a: number, b: number) => (a > 0 ? Math.round(((b - a) / a) * 100) / 100 : 0);

/**
 * Expected delta per change. Lighting kWh is exact from the energy model; whatever kWh change remains is put on
 * the hours changes. Visits go to hours changes and to brightening (dimming is assumed not to cost visits).
 */
function withDeltas(changes: Change[], from: RunStores[string], to: RunStores[string], area: number): Suggestion[] {
  const dv = frac(from.kpis.visits, to.kpis.visits);
  const base = from.kpis.kwh || 1;
  const rank = { off: 0, low: 1, high: 2 } as const;
  const lightK = changes.map((c) =>
    c.field === "lighting" ? (c.hours.length * (LIGHT_KWH[c.to] - LIGHT_KWH[c.from]) * area * DAYS_PER_RUN) / base : 0,
  );
  const hourChanges = changes.filter((c) => c.field !== "lighting").length;
  const restK = frac(from.kpis.kwh, to.kpis.kwh) - lightK.reduce((a, b) => a + b, 0);
  const vW: number[] = changes.map((c) => (c.field === "lighting" ? (rank[c.to] > rank[c.from] ? 0.25 : 0) : 1));
  const vs = vW.reduce((x, y) => x + y, 0) || 1;
  return changes.map((c, i) => {
    const kwh = c.field === "lighting" ? lightK[i] : hourChanges ? restK / hourChanges : 0;
    const expectedDelta: ExpectedDelta = { visits: round2((dv * vW[i]) / vs), kwh: round2(kwh) };
    return { ...c, expectedDelta } as Suggestion;
  });
}

export function suggestionsBetween(cfgA: RunConfig, cfgB: RunConfig, resA: RunStores, resB: RunStores, areas: Record<string, number>): Suggestion[] {
  const out: Suggestion[] = [];
  for (const id of Object.keys(cfgA)) {
    if (id.startsWith("c")) continue; // clubs are anchors, never optimised
    const changes = diffStore(id, cfgA[id], cfgB[id]);
    if (changes.length) out.push(...withDeltas(changes, resA[id], resB[id], areas[id]));
  }
  return out;
}

export function buildReport(
  storeId: string,
  type: StoreType,
  cfgFrom: RunConfig,
  cfgBest: RunConfig,
  resFrom: RunStores,
  resBest: RunStores,
  area: number,
  replayHref: string,
  pdfUrl: string,
): OwnerReport {
  const changes = withDeltas(diffStore(storeId, cfgFrom[storeId], cfgBest[storeId]), resFrom[storeId], resBest[storeId], area).slice(0, 3);
  const a = resFrom[storeId].kpis;
  const b = resBest[storeId].kpis;
  const weeks = 2;
  const gbpPerWeek = Math.round(((b.visits - a.visits) * SPEND_GBP[type] * GROSS_MARGIN - (b.kwh - a.kwh) * GBP_PER_KWH) / weeks);
  const confidence = a.visits + b.visits > 400 ? "high" : a.visits + b.visits > 120 ? "medium" : "low";
  return {
    storeId,
    changes,
    impact: { visits: frac(a.visits, b.visits), kwh: frac(a.kwh, b.kwh), gbpPerWeek },
    confidence,
    evidence: [
      { label: "Sim replay, same 14 days", url: replayHref },
      { label: "TfL station exits, Night Tube", url: "https://tfl.gov.uk/info-for/open-data-users/" },
      { label: "Grid carbon by hour, London", url: "https://carbonintensity.org.uk/" },
      { label: "Opening hours, OpenStreetMap", url: "https://www.openstreetmap.org/#map=17/51.5265/-0.0777" },
    ],
    pdfUrl,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// ---------- tiny PDF writer (so the mock "Download PDF" link really downloads something) ----------

export function makePdf(title: string, lines: string[]): Blob {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "-");
  const body = [
    "BT /F1 20 Tf 56 780 Td (" + esc(title) + ") Tj ET",
    ...lines.map((l, i) => `BT /F1 12 Tf 56 ${744 - i * 20} Td (${esc(l)}) Tj ET`),
  ].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}
