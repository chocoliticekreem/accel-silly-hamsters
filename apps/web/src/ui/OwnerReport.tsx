// The product moment: one store's weekly report. 1–3 changes with Approve / Reject (human in the loop),
// impact in visits, kWh and £/week, a confidence badge, evidence links and the PDF.
import { useState } from "react";
import { api, API_URL } from "../api/client";
import { absoluteUrl } from "../api/http";
import { useAnalyst, useMap, useReport } from "../state/data";
import { useSim } from "../state/store";
import { STORE_COLORS } from "../world/palette";
import { Delta } from "./Delta";
import { Icon } from "./icons";
import { SuggestionRow } from "./SuggestionList";

type Decision = "approve" | "reject";

export function OwnerReport() {
  const id = useSim((s) => s.selectedStoreId);
  const viewRun = useSim((s) => s.run);
  // the owner's weekly report is written for the analyst's best run; fall back to the run on screen
  const run = useAnalyst().data?.bestRun ?? viewRun;
  const map = useMap().data;
  const { data: report, error } = useReport(id, run);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [pending, setPending] = useState<string | null>(null);
  const store = map?.stores.find((s) => s.id === id);
  if (!id || !store) return null;
  const close = () => useSim.getState().openPanel(null);

  const decide = async (i: number, decision: Decision) => {
    const key = `${id}:${run}:${i}`;
    setPending(key);
    try {
      await api.decision({ run, storeId: id, suggestionIndex: i, decision });
      setDecisions((d) => ({ ...d, [key]: decision }));
    } catch {
      useSim.getState().showToast("Couldn't save decision");
    } finally {
      setPending(null);
    }
  };

  /** Evidence links that point back into the sim (?run=…) replay in place instead of navigating. */
  const openEvidence = (url: string) => {
    const s = useSim.getState();
    // backend replay evidence: /api/runs/{run}/days/{day} → replay that day from 18:00 (the evening and night)
    const api = url.match(/\/api\/runs\/(\d+)\/days\/(\d+)/);
    if (api) {
      s.selectStore(id);
      s.replay(Number(api[1]), (Number(api[2]) - 1) * 1440 + 18 * 60);
      return true;
    }
    if (!url.startsWith("?")) return false;
    const q = new URLSearchParams(url);
    s.selectStore(q.get("store") ?? id);
    s.replay(Number(q.get("run") ?? run), Number(q.get("t") ?? 0));
    return true;
  };
  const inApp = (url: string) => url.startsWith("?") || /\/api\/runs\/\d+\/days\/\d+/.test(url);

  return (
    <div className="modal-backdrop" onClick={close}>
      <section className="report panel" role="dialog" aria-label="Weekly report" onClick={(e) => e.stopPropagation()}>
        <header className="card-head" style={{ ["--accent" as string]: STORE_COLORS[store.type].awning }}>
          <span className="type-badge">{STORE_COLORS[store.type].icon}</span>
          <div>
            <div className="eyebrow">Weekly report · run {run}</div>
            <h2>{store.name}</h2>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        {error && <div className="empty">No report for run {run} yet · the store agents write it after a training run</div>}
        {!report && !error && <div className="empty">…</div>}
        {report && (
          <>
            <div className="impact">
              <div className="impact-tile">
                <span className="kpi-label">Visits</span>
                <Delta value={report.impact.visits} metric="visits" size="md" />
              </div>
              <div className="impact-tile">
                <span className="kpi-label">Energy</span>
                <Delta value={report.impact.kwh} metric="kwh" size="md" />
              </div>
              <div className="impact-tile impact-gbp">
                <span className="kpi-label">£ / week</span>
                <span className="gbp">
                  {report.impact.gbpPerWeek >= 0 ? "+" : "−"}£{Math.abs(report.impact.gbpPerWeek)}
                </span>
              </div>
              <span className={`confidence conf-${report.confidence}`}>
                <i />
                <i />
                <i />
                {report.confidence} confidence
              </span>
            </div>

            <h3 className="section-title">Changes</h3>
            {report.changes.length === 0 && <div className="empty">No changes · keep as is</div>}
            <ul className="sugg-list">
              {report.changes.map((c, i) => {
                const key = `${id}:${run}:${i}`;
                const d = decisions[key];
                return (
                  <SuggestionRow
                    key={key}
                    s={c}
                    actions={
                      d ? (
                        <span className={`decided decided-${d}`}>
                          <Icon name={d === "approve" ? "check" : "reject"} size={14} /> {d === "approve" ? "Approved" : "Rejected"}
                          <button className="link" onClick={() =>
                              setDecisions((x) => {
                                const { [key]: _undone, ...rest } = x;
                                return rest;
                              })
                            }>
                            undo
                          </button>
                        </span>
                      ) : (
                        <>
                          <button className="btn btn-approve" disabled={pending === key} onClick={() => decide(i, "approve")}>
                            <Icon name="check" size={14} /> Approve
                          </button>
                          <button className="btn btn-reject" disabled={pending === key} onClick={() => decide(i, "reject")}>
                            <Icon name="reject" size={14} /> Reject
                          </button>
                        </>
                      )
                    }
                  />
                );
              })}
            </ul>

            <h3 className="section-title">Evidence</h3>
            <div className="evidence">
              {report.evidence.map((e) => (
                <a
                  key={e.label}
                  title={e.fetchedAt ? `fetched ${e.fetchedAt.slice(0, 10)}` : undefined}
                  className="evidence-chip"
                  href={e.url}
                  target={inApp(e.url) ? undefined : "_blank"}
                  rel="noreferrer"
                  onClick={(ev) => openEvidence(e.url) && ev.preventDefault()}
                >
                  <Icon name={inApp(e.url) ? "replay" : "link"} size={13} /> {e.label}
                </a>
              ))}
            </div>

            <footer className="report-foot">
              <span className="disclaimer">{report.note ?? "Simulated, not guaranteed."} · you approve every change</span>
              {report.pdfUrl ? (
                <a className="btn" href={absoluteUrl(API_URL, report.pdfUrl)} download={`${store.name} weekly report.pdf`} target="_blank" rel="noreferrer">
                  <Icon name="download" size={14} /> PDF
                </a>
              ) : (
                <span className="btn" aria-disabled>PDF pending</span>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
