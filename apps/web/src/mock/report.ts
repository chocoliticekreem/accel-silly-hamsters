// Suggestions = the config diff between a run and the next one. Owner report = the diff between what a store
// runs in a given run and the best run found, with impact taken from the simulated results.
import type { ExpectedDelta, LightLevel, OwnerReport, RunStores, StoreType, Suggestion } from "../api/contract";
import type { RunConfig, StoreConfig } from "./configs";

/** Average spend per visit (£) by type, for the £/week line. */
export const SPEND_GBP: Record<StoreType, number> = { cafe: 6, restaurant: 22, takeaway: 9, bar: 14, shop: 15, offlicence: 8, club: 0 };
export const GBP_PER_KWH = 0.28;

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

export function diffStore(storeId: string, a: StoreConfig, b: StoreConfig): Omit<Suggestion, "expectedDelta">[] {
  const out: Omit<Suggestion, "expectedDelta">[] = [];
  if (a.open !== b.open) out.push({ storeId, field: "open", from: a.open, to: b.open });
  if (a.close !== b.close) out.push({ storeId, field: "close", from: a.close, to: b.close });
  out.push(...lightingDiff(storeId, a.lighting, b.lighting));
  return out;
}

const frac = (a: number, b: number) => (a > 0 ? Math.round(((b - a) / a) * 100) / 100 : 0);

/** Spreads a store's measured change across its suggestions: hours drive visits, lighting drives kWh. */
function withDeltas(changes: Omit<Suggestion, "expectedDelta">[], from: RunStores[string], to: RunStores[string]): Suggestion[] {
  const dv = frac(from.kpis.visits, to.kpis.visits);
  const dk = frac(from.kpis.kwh, to.kpis.kwh);
  const vW = changes.map((c) => (c.field === "lighting" ? 0.25 : 1));
  const kW = changes.map((c) => ("hours" in c ? c.hours.length : 2));
  const vs = vW.reduce((x, y) => x + y, 0) || 1;
  const ks = kW.reduce((x, y) => x + y, 0) || 1;
  return changes.map((c, i) => {
    const expectedDelta: ExpectedDelta = { visits: round2((dv * vW[i]) / vs), kwh: round2((dk * kW[i]) / ks) };
    return { ...c, expectedDelta } as Suggestion;
  });
}

export function suggestionsBetween(cfgA: RunConfig, cfgB: RunConfig, resA: RunStores, resB: RunStores): Suggestion[] {
  const out: Suggestion[] = [];
  for (const id of Object.keys(cfgA)) {
    if (id.startsWith("c")) continue; // clubs are anchors, never optimised
    const changes = diffStore(id, cfgA[id], cfgB[id]);
    if (changes.length) out.push(...withDeltas(changes, resA[id], resB[id]));
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
  replayHref: string,
  pdfUrl: string,
): OwnerReport {
  const changes = withDeltas(diffStore(storeId, cfgFrom[storeId], cfgBest[storeId]), resFrom[storeId], resBest[storeId]).slice(0, 3);
  const a = resFrom[storeId].kpis;
  const b = resBest[storeId].kpis;
  const weeks = 2;
  const gbpPerWeek = Math.round(((b.visits - a.visits) * SPEND_GBP[type] - (b.kwh - a.kwh) * GBP_PER_KWH) / weeks);
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
