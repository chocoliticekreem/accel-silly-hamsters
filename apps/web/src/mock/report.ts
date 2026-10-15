// Suggestions = the config diff between a run and the next one. Owner report = the diff between what a store
// runs in a given run and the best run found, with impact taken from the simulated results.
import type { ExpectedDelta, OwnerReport, RunStores, StoreType, Suggestion } from "../api/contract";
import { DAYS_PER_RUN, type Confidence } from "../api/contract";
import { parseHHMM } from "../sim/time";
import type { RunConfig } from "./configs";
import { LIGHT_KWH } from "./simulate";

import { diffStore, type Change } from "../sim/diff";
export { GBP_PER_KWH, marginPerVisit, SPEND_GBP } from "../sim/economics";
import { profitPerWeek } from "../sim/economics";
export { diffStore, type Change };

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
  const confidence = confidenceFor(from.kpis.visits + to.kpis.visits);
  return changes.map((c, i) => {
    const kwh = c.field === "lighting" ? lightK[i] : hourChanges ? restK / hourChanges : 0;
    const expectedDelta: ExpectedDelta = { visits: round2((dv * vW[i]) / vs), kwh: round2(kwh) };
    return { ...c, expectedDelta, confidence, reason: reasonFor(c) } as Suggestion;
  });
}

export function confidenceFor(visits: number): Confidence {
  return visits > 400 ? "high" : visits > 120 ? "medium" : "low";
}

/** Minutes after 05:00, so "03:00" counts as later than "23:00". */
const late = (hhmm: string) => (parseHHMM(hhmm) - 300 + 1440) % 1440;

/** One short line, never a paragraph. */
export function reasonFor(c: Change): string {
  const rank = { off: 0, low: 1, high: 2 } as const;
  switch (c.field) {
    case "close":
      return late(c.to) > late(c.from) ? `Foot traffic continues after ${c.from}` : `Quiet after ${c.to}`;
    case "open":
      return late(c.to) < late(c.from) ? `Demand before ${c.from}` : `Empty before ${c.to}`;
    default:
      return rank[c.to] > rank[c.from] ? "Dark window loses night trade" : "Lit while shut or quiet";
  }
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
  const gbpPerWeek = Math.round(profitPerWeek(type, (b.visits - a.visits) / weeks, (b.kwh - a.kwh) / weeks, ((b.openHours ?? 0) - (a.openHours ?? 0)) / weeks));
  const confidence = confidenceFor(a.visits + b.visits);
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
    note: "Simulated, not guaranteed.",
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
