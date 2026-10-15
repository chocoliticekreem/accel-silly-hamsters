// The client view: one shop, one long-running optimisation. The orchestrator keeps testing changes until
// no change beats the threshold, every run is kept and compared, and each run's report sits on the same page.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, API_URL } from "../api/client";
import type { AgentEvent, AgentSession, OwnerReport, StoreOverview } from "../api/contract";
import { absoluteUrl } from "../api/http";
import { navigate, storePath } from "../router";
import { SuggestionRow } from "../ui/SuggestionList";

const DEMO_STORE = "s65";
const LONG_RUN = 20;

const STEPS: { key: Step; title: string; text: string }[] = [
  { key: "plan", title: "The analyst plans", text: "Picks the next experiment from every run so far." },
  { key: "propose", title: "Your shop's agent proposes", text: "Up to two changes to hours or lighting, from your shop's data only." },
  { key: "check", title: "Hard rules check", text: "Licensed hours, safe day lengths, 30-minute steps. Unsafe ideas never run." },
  { key: "simulate", title: "14 days are simulated", text: "Every customer in Shoreditch lives the same fortnight with the new settings." },
  { key: "report", title: "A report is written", text: "Customers, kWh and £ a week, with confidence and evidence." },
  { key: "approve", title: "You approve", text: "Nothing changes in your shop until you say yes." },
];
type Step = "plan" | "propose" | "check" | "simulate" | "report" | "approve";

const STEP_OF: [RegExp, Step][] = [
  [/reject/, "check"],
  [/hypothes|plan|experiment|handoff|hand_off/, "plan"],
  [/propos|suggest/, "propose"],
  [/report/, "report"],
  [/decision|approv/, "approve"],
  [/run|result|sim|scored/, "simulate"],
];

const STOP_WORDS: Record<string, string> = {
  threshold: "Finished: no further change beats the threshold, so nothing else should change",
  max_runs: "Finished: reached the run limit",
  budget: "Stopped at the budget cap",
  stopped: "Stopped by you",
  error: "Stopped by an error; it resumes where it left off",
};

const gbp = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}£${Math.abs(Math.round(v)).toLocaleString("en-GB")}`;
const num = (v: number) => Math.round(v).toLocaleString("en-GB");
const time = (at: string) => (at ? new Date(at).toLocaleTimeString("en-GB", { hour12: false }) : "");

function eventLine(e: AgentEvent): string {
  const d = e.data ?? {};
  for (const k of ["line", "hypothesis", "explanation", "summary", "reason", "text", "message", "notebook"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  const bits = Object.entries(d)
    .filter(([, v]) => v !== null && typeof v !== "object")
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`);
  return bits.join(" · ");
}

async function stopSession() {
  if (!API_URL) return;
  await fetch(`${API_URL.replace(/\/$/, "")}/api/training/stop`, { method: "POST" });
}

export function AgentsPage({ storeId: requested }: { storeId: string | null }) {
  const [storeId, setStoreId] = useState<string | null>(requested);
  const [overview, setOverview] = useState<StoreOverview | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [log, setLog] = useState<AgentEvent[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [report, setReport] = useState<OwnerReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, "approve" | "reject">>({});

  // /agents without a shop: the demo shop when the map has it, else the first shop
  useEffect(() => {
    if (storeId) return;
    void api.map().then((m) => {
      const shops = m.stores.filter((s) => s.type !== "club");
      setStoreId(shops.find((s) => s.id === DEMO_STORE)?.id ?? shops[0]?.id ?? null);
    });
  }, [storeId]);

  const running = session?.state === "running";
  const refresh = useCallback(async () => {
    if (!storeId) return;
    const [o, s, l] = await Promise.all([
      api.overview(storeId).catch(() => null),
      api.agentSession().catch(() => null),
      api.agentLog().catch(() => [] as AgentEvent[]),
    ]);
    if (o) setOverview(o);
    setSession(s ?? null);
    setLog(l);
  }, [storeId]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), running ? 2000 : 8000);
    return () => window.clearInterval(id);
  }, [refresh, running]);

  const history = overview?.history ?? [];
  const best = history.find((h) => h.best) ?? null;
  const shownRun = picked ?? best?.run ?? history[history.length - 1]?.run ?? null;

  useEffect(() => {
    if (!storeId || shownRun === null) return;
    let live = true;
    setReport(null);
    api
      .report(storeId, shownRun)
      .then((r) => live && setReport(r))
      .catch(() => live && setReport(null));
    return () => {
      live = false;
    };
  }, [storeId, shownRun, history.length]);

  const counts = useMemo(() => {
    const c: Record<Step, number> = { plan: 0, propose: 0, check: 0, simulate: 0, report: 0, approve: 0 };
    for (const e of log) {
      const t = `${e.type} ${e.agent}`.toLowerCase();
      const hit = STEP_OF.find(([re]) => re.test(t));
      if (hit) c[hit[1]] += 1;
    }
    c.simulate = Math.max(c.simulate, history.length);
    c.approve += Object.values(decided).filter((d) => d === "approve").length;
    return c;
  }, [log, history.length, decided]);

  const start = async () => {
    if (!storeId) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.optimize(storeId, LONG_RUN);
      setMessage("The agents are running. New runs appear below as they finish.");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not start the agents");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopSession();
      setMessage("Stopping after the current run.");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (i: number, decision: "approve" | "reject") => {
    if (!storeId || shownRun === null) return;
    await api.decision({ run: shownRun, storeId, suggestionIndex: i, decision }).catch(() => null);
    setDecided((d) => ({ ...d, [`${shownRun}:${i}`]: decision }));
  };

  if (!storeId || !overview) {
    return (
      <main className="ag-page">
        <p className="ag-muted">Loading the shop…</p>
      </main>
    );
  }

  const status = running ? "Running" : session?.stoppedReason ? STOP_WORDS[session.stoppedReason] ?? "Finished" : history.length > 1 ? "Finished" : "Not started";
  const bestProfit = best?.profitChangePerWeekGbp ?? 0;
  const maxAbs = Math.max(1, ...history.map((h) => Math.abs(h.profitChangePerWeekGbp)));
  const pdf = report?.pdfUrl ? absoluteUrl(API_URL, report.pdfUrl) : null;

  return (
    <main className="ag-page">
      <nav className="ag-nav">
        <button className="ag-link" onClick={() => navigate("/")}>
          ← Back to the city
        </button>
        <button className="ag-link" onClick={() => navigate(storePath(storeId))}>
          Shop page
        </button>
      </nav>

      <header className="ag-head">
        <div>
          <div className="ag-eyebrow">Your agents · {overview.type}</div>
          <h1>{overview.name}</h1>
          <p className="ag-sub">One orchestrator keeps testing changes to your hours and lighting until no change makes you more money. Every run is kept and compared.</p>
        </div>
        <div className="ag-controls">
          <span className={`ag-pill ${running ? "on" : ""}`}>{status}</span>
          {running ? (
            <button className="ag-btn" disabled={busy} onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button className="ag-btn ag-primary" disabled={busy} onClick={() => void start()}>
              {history.length > 1 ? "Run the agents again" : "Start the agents"}
            </button>
          )}
          {session && (
            <span className="ag-muted">
              {session.iterations} runs · £{session.spentGbp.toFixed(2)} of agent time
            </span>
          )}
        </div>
      </header>
      {message && <p className="ag-message">{message}</p>}

      <section className="ag-card">
        <h2>How the agents work</h2>
        <ol className="ag-flow">
          {STEPS.map((s, i) => (
            <li key={s.key} className={running && counts[s.key] > 0 ? "live" : ""}>
              <span className="ag-step-n">{i + 1}</span>
              <b>{s.title}</b>
              <span className="ag-muted">{s.text}</span>
              <span className="ag-count">{counts[s.key]}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="ag-grid">
        <div className="ag-card">
          <h2>Profit a week, run by run</h2>
          <p className="ag-muted">
            {best && best.run !== overview.baselineRun
              ? `Best so far: run ${best.run}, ${gbp(bestProfit)} a week vs your current settings.`
              : "No run has beaten your current settings yet."}
          </p>
          <div className="ag-bars">
            {history.map((h) => (
              <button key={h.run} className={`ag-bar ${h.best ? "best" : ""} ${h.run === shownRun ? "sel" : ""}`} onClick={() => setPicked(h.run)} title={h.changes.join(" · ") || "your current settings"}>
                <span className="ag-bar-fill" style={{ height: `${Math.max(4, (Math.abs(h.profitChangePerWeekGbp) / maxAbs) * 100)}%` }} data-neg={h.profitChangePerWeekGbp < 0} />
                <span className="ag-bar-label">{h.run === overview.baselineRun ? "start" : `run ${h.run}`}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ag-card">
          <h2>Recommendation</h2>
          <p>{overview.headline}</p>
          <ul className="ag-advice">
            {overview.advice.map((a, i) => (
              <li key={i}>
                <span>{a.text}</span>
                <b>{gbp(a.gbpPerWeek)} a week</b>
                <span className="ag-muted">{a.certainty}</span>
              </li>
            ))}
          </ul>
          <p className="ag-muted">{overview.note ?? "Simulated, not guaranteed."}</p>
        </div>
      </section>

      <section className="ag-card">
        <h2>Every run</h2>
        <table className="ag-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>What it tested</th>
              <th>Customers / week</th>
              <th>kWh / week</th>
              <th>Profit vs start</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().map((h) => {
              const verdict = h.run === overview.baselineRun ? "Your settings" : h.best ? "Best" : h.profitChangePerWeekGbp < bestProfit ? "Worse than best" : "Better";
              return (
                <tr key={h.run} className={h.run === shownRun ? "sel" : ""} onClick={() => setPicked(h.run)}>
                  <td>{h.run === overview.baselineRun ? "start" : h.run}</td>
                  <td>{h.changes.length ? h.changes.join(" · ") : "Current hours and lighting"}</td>
                  <td>{num(h.customersPerWeek)}</td>
                  <td>{num(h.kwhPerWeek)}</td>
                  <td className={h.profitChangePerWeekGbp >= 0 ? "ag-good" : "ag-bad"}>{gbp(h.profitChangePerWeekGbp)}</td>
                  <td>
                    <span className={`ag-badge ${verdict === "Best" ? "best" : verdict === "Worse than best" ? "worse" : ""}`}>{verdict}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="ag-grid">
        <div className="ag-card">
          <h2>Report · run {shownRun ?? "—"}</h2>
          {!report && <p className="ag-muted">The report appears once the run has finished.</p>}
          {report && (
            <>
              <div className="ag-impact">
                <span>
                  <b>{report.impact.visits >= 0 ? "+" : ""}{num(report.impact.visits)}</b> customers
                </span>
                <span>
                  <b>{report.impact.kwh >= 0 ? "+" : ""}{num(report.impact.kwh)}</b> kWh
                </span>
                <span>
                  <b>{gbp(report.impact.gbpPerWeek)}</b> a week
                </span>
                <span className="ag-muted">confidence: {report.confidence}</span>
              </div>
              {report.changes.length === 0 && <p className="ag-muted">No changes in this run.</p>}
              {report.changes.map((s, i) => {
                const d = decided[`${shownRun}:${i}`];
                return (
                  <SuggestionRow
                    key={i}
                    s={s}
                    actions={
                      d ? (
                        <span className="ag-muted">{d === "approve" ? "Approved" : "Not for me"}</span>
                      ) : (
                        <span className="ag-actions">
                          <button className="ag-btn ag-primary" onClick={() => void decide(i, "approve")}>
                            Approve
                          </button>
                          <button className="ag-btn" onClick={() => void decide(i, "reject")}>
                            Not for me
                          </button>
                        </span>
                      )
                    }
                  />
                );
              })}
              {report.evidence.length > 0 && (
                <p className="ag-muted">
                  Evidence:{" "}
                  {report.evidence.map((e, i) => (
                    <a key={i} href={e.url} target="_blank" rel="noreferrer">
                      {e.label}
                      {i < report.evidence.length - 1 ? ", " : ""}
                    </a>
                  ))}
                </p>
              )}
              {pdf && (
                <a className="ag-btn" href={pdf} target="_blank" rel="noreferrer">
                  Download the PDF report
                </a>
              )}
            </>
          )}
        </div>

        <div className="ag-card">
          <h2>What the agents are doing</h2>
          {log.length === 0 && <p className="ag-muted">Start the agents to see their work here, live.</p>}
          <ol className="ag-log">
            {[...log]
              .reverse()
              .slice(0, 40)
              .map((e, i) => (
                <li key={i}>
                  <span className="ag-muted">{time(e.at)}</span>
                  <b>{e.agent.replace(/_/g, " ")}</b>
                  <span>{e.type.replace(/_/g, " ")}</span>
                  <span className="ag-muted">{eventLine(e)}</span>
                </li>
              ))}
          </ol>
        </div>
      </section>
    </main>
  );
}
