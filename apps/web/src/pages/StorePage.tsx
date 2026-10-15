// The shop owner's page (docs/STORE_PAGE.md): a plain-English weekly report. Headline, three numbers vs the
// shop's original settings, 1–3 pieces of advice with Apply, "Optimise for me", the run history, and the
// granular analytics only behind "Details". No emoji; always "simulated, not guaranteed".
import { ArrowLeft, Check, ChevronDown, ChevronRight, Download, ExternalLink, FlaskConical, NotebookPen, PlayCircle, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { API_URL, api } from "../api/client";
import { absoluteUrl } from "../api/http";
import { ApiError, type StoreOverview } from "../api/contract";
import { navigate, storePath } from "../router";
import { invalidate, useReport, useResource, watchRun } from "../state/data";
import { useSim } from "../state/store";
import { fmtInt, fmtPct, TYPE_LABEL } from "../ui/format";
import { InsightsPanel } from "../ui/InsightsPanel";
import { OptimiseStrip } from "../ui/OptimiseStrip";
import { OwnerTimeline } from "../ui/OwnerTimeline";
import { WeekSchedule } from "../ui/WeekSchedule";
import { DemoBar } from "../ui/DemoBar";
import { Toast } from "../ui/Toast";
import { TypeIcon } from "../ui/TypeIcon";
import { STORE_COLORS } from "../world/palette";
import { OwnerMoney } from "../ui/OwnerMoney";

const STATUS_LABEL: Record<StoreOverview["status"], string> = {
  not_started: "Not started",
  improving: "Improving",
  best_found: "Best found",
};
const ADVICE_STATUS: Record<StoreOverview["advice"][number]["status"], string | null> = {
  new: null,
  applied: "In your settings",
  tested_better: "Tested: it helped",
  tested_worse: "Tested: it hurt",
};

function Change({ value, upIsGood = true }: { value: number; upIsGood?: boolean }) {
  if (Math.abs(value) < 0.005) return <span className="sp-change flat">same as before</span>;
  const good = value > 0 === upIsGood;
  return (
    <span className={`sp-change ${good ? "good" : "bad"}`}>
      {fmtPct(value)} <span className="muted">vs your original settings</span>
    </span>
  );
}

const money = (n: number) => `${n < 0 ? "−" : ""}£${fmtInt(Math.abs(n))}`;

/** Sim replay evidence (/api/runs/{run}/days/{day}) → that run and day from 18:00, in the 3D city. */
const replayLink = (url: string) => url.match(/\/api\/runs\/(\d+)\/days\/(\d+)/);

export function StorePage({ storeId, run }: { storeId: string; run?: number }) {
  const key = `overview:${storeId}:${run ?? "default"}`;
  const { data: o, error, loading } = useResource<StoreOverview | null>(key, () => api.overview(storeId, run));
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<number, "applied" | "rejected">>({});
  const toast = useSim((s) => s.showToast);
  // evidence links and the PDF come from the weekly report for the same run
  const report = useReport(o ? storeId : null, o?.run ?? 0).data;

  const refresh = () => {
    invalidate("overview:");
    invalidate("runs");
    invalidate("analyst");
    invalidate("insights:");
  };
  // "Optimise for me": bumped per start, so each session gets a fresh progress strip (0 = none)
  const [optimising, setOptimising] = useState(0);
  const optimiseDone = () => {
    refresh();
    invalidate("agents:");
    invalidate("summary:");
  };

  const apply = async (i: number) => {
    if (!o) return;
    setBusy(`apply-${i}`);
    try {
      await api.decision({ run: o.run, storeId, suggestionIndex: i, decision: "approve" });
      const res = await api.apply({ run: o.run, scope: "store", storeIds: [storeId] });
      setDecided((d) => ({ ...d, [i]: "applied" }));
      toast(`Approved · testing it in run ${res.queuedRun}`);
      void watchRun(res.queuedRun).then((s) => {
        if (s === "done") {
          toast(`Run ${res.queuedRun} ready`);
          refresh();
        }
      });
    } catch {
      toast("Couldn't apply that");
    } finally {
      setBusy(null);
    }
  };

  const reject = async (i: number) => {
    if (!o) return;
    setBusy(`reject-${i}`);
    try {
      await api.decision({ run: o.run, storeId, suggestionIndex: i, decision: "reject" });
      setDecided((d) => ({ ...d, [i]: "rejected" }));
    } catch {
      toast("Couldn't save that");
    } finally {
      setBusy(null);
    }
  };

  const optimise = async () => {
    setBusy("optimise");
    try {
      await api.optimize(storeId);
      setOptimising((n) => n + 1);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? "Already optimising: check back in a minute" : e instanceof ApiError && e.status === 403 ? "Read-only demo: optimising is off here" : "Couldn't start optimising");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="store-page">
      <header className="sp-top">
        <button className="sp-back" onClick={() => navigate("/")}>
          <ArrowLeft size={16} /> Shoreditch
        </button>

      </header>

      {error && <div className="empty">Couldn't load this shop</div>}
      {!o && loading && <div className="sp-loading">Loading your report…</div>}
      {o === null && !loading && <div className="empty">No report for this shop yet</div>}

      {o && (
        <main className="sp-main">
          <section className="sp-hero">
            <div className="sp-shop">
              <span className="type-badge" style={{ ["--accent" as string]: STORE_COLORS[o.type].awning }}>
                <TypeIcon type={o.type} />
              </span>
              <div>
                <h1>{o.name}</h1>
                <div className="card-sub">
                  {TYPE_LABEL[o.type]} · weekly report · run {o.run}
                </div>
              </div>
              <span className={`sp-status ${o.status}`}>{STATUS_LABEL[o.status]}</span>
            </div>
            <p className="sp-headline">{o.headline}</p>
            <div className="sp-numbers">
              <div className="sp-number">
                <span className="kpi-label">Customers a week</span>
                <b>{fmtInt(o.numbers.customersPerWeek.value)}</b>
                <Change value={o.numbers.customersPerWeek.change} />
              </div>
              <div className="sp-number">
                <span className="kpi-label">Energy cost a week</span>
                <b>£{o.numbers.energyCostPerWeekGbp.value.toFixed(2)}</b>
                <Change value={o.numbers.energyCostPerWeekGbp.change} upIsGood={false} />
              </div>
              <div className="sp-number">
                <span className="kpi-label">Electricity a week</span>
                <b>
                  {fmtInt(o.numbers.kwhPerWeek.value)} <small>kWh</small>
                </b>
                <Change value={o.numbers.kwhPerWeek.change} upIsGood={false} />
              </div>
            </div>
            {o.numbers.profitChangePerWeekGbp !== 0 && (
              <div className={`sp-profit ${o.numbers.profitChangePerWeekGbp > 0 ? "good" : "bad"}`}>
                {money(o.numbers.profitChangePerWeekGbp)} a week {o.numbers.profitChangePerWeekGbp > 0 ? "better off" : "worse off"} than your original settings
              </div>
            )}
            {o.ownerChanges != null && (
              <p className="sp-owner-changes">
                <NotebookPen size={14} aria-hidden /> Owner adapted <b>{o.ownerChanges}</b> time{o.ownerChanges === 1 ? "" : "s"} this fortnight
              </p>
            )}
          </section>

          <OwnerMoney storeId={storeId} run={o.run} />

          <section className="sp-card">
            <div className="sp-card-head">
              <h2>This week's advice</h2>
              <button className="btn btn-lamp" disabled={busy === "optimise"} onClick={optimise}>
                <Sparkles size={14} /> {busy === "optimise" ? "Starting…" : "Optimise for me"}
              </button>
            </div>
            {optimising > 0 && <OptimiseStrip key={optimising} storeId={storeId} onDone={optimiseDone} onClose={() => setOptimising(0)} />}
            {o.advice.length === 0 && <div className="empty">Nothing to change this week</div>}
            <ol className="sp-advice">
              {o.advice.map((a, i) => {
                const d = decided[i];
                const tag = ADVICE_STATUS[a.status];
                return (
                  <li key={i}>
                    <p>{a.text}</p>
                    <div className="sp-advice-meta">
                      <span className={`gbp-chip ${a.gbpPerWeek >= 0 ? "pos" : "neg"}`}>{money(a.gbpPerWeek)}/week</span>
                      <span className="sp-certainty">
                        how sure: <b>{a.certainty}</b>
                      </span>
                      {tag && <span className="tag">{tag}</span>}
                    </div>
                    <div className="sp-advice-actions">
                      {d ? (
                        <span className={`decided decided-${d === "applied" ? "approve" : "reject"}`}>
                          {d === "applied" ? <Check size={14} /> : <X size={14} />} {d === "applied" ? "Approved: testing it now" : "Rejected"}
                        </span>
                      ) : (
                        <>
                          <button className="btn btn-approve" disabled={!!busy || a.status === "applied"} onClick={() => apply(i)}>
                            <Check size={14} /> Approve
                          </button>
                          <button className="btn btn-reject" disabled={!!busy} onClick={() => reject(i)}>
                            <X size={14} /> Reject
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {report && (report.evidence.length > 0 || report.pdfUrl) && (
              <div className="sp-evidence">
                <span className="kpi-label">Evidence</span>
                {report.evidence.map((e) => {
                  const m = replayLink(e.url);
                  return (
                    <a
                      key={e.url + e.label}
                      className="evidence-chip"
                      href={e.url}
                      title={e.label}
                      target={m ? undefined : "_blank"}
                      rel="noreferrer"
                      onClick={(ev) => {
                        if (!m) return;
                        ev.preventDefault();
                        const s = useSim.getState();
                        s.selectStore(storeId);
                        s.replay(Number(m[1]), (Number(m[2]) - 1) * 1440 + 18 * 60);
                        navigate("/");
                      }}
                    >
                      {m ? <PlayCircle size={13} /> : <ExternalLink size={13} />} <span>{e.label}</span>
                    </a>
                  );
                })}
                {report.pdfUrl && (
                  <a className="evidence-chip" href={absoluteUrl(API_URL, report.pdfUrl)} download={`${o.name} weekly report.pdf`} target="_blank" rel="noreferrer">
                    <Download size={13} /> PDF report
                  </a>
                )}
              </div>
            )}
          </section>

          <section className="sp-card">
            <OwnerTimeline storeId={storeId} run={o.run} title="What I changed this fortnight" />
            <WeekSchedule storeId={storeId} run={o.run} />
          </section>

          <section className="sp-card">
            <div className="sp-card-head">
              <h2>What we tried</h2>
              <span className="muted">same 14 days, re-run</span>
            </div>
            <div className="sp-table-wrap">
            <table className="sp-history">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Settings</th>
                  <th>Customers/wk</th>
                  <th>kWh/wk</th>
                  <th>vs original</th>
                </tr>
              </thead>
              <tbody>
                {o.history.map((h) => (
                  <tr key={h.run} className={h.run === o.run ? "on" : ""} onClick={() => navigate(storePath(storeId, h.run))} title={h.changes.join(" · ")}>
                    <td className="mono">{h.run}</td>
                    <td>
                      {h.label}
                      {h.best && <span className="tag tag-lamp">best</span>}
                    </td>
                    <td className="mono">{fmtInt(h.customersPerWeek)}</td>
                    <td className="mono">{fmtInt(h.kwhPerWeek)}</td>
                    <td className={`mono ${h.profitChangePerWeekGbp > 0 ? "good" : h.profitChangePerWeekGbp < 0 ? "bad" : ""}`}>{h.profitChangePerWeekGbp === 0 ? "—" : `${money(h.profitChangePerWeekGbp)}/wk`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <button
              className="sp-link"
              onClick={() => {
                const s = useSim.getState();
                s.selectStore(storeId);
                s.replay(o.run, 4 * 1440 + 20 * 60);
                navigate("/");
              }}
            >
              <FlaskConical size={14} /> Watch this run in the 3D city
            </button>
          </section>

          <section className="sp-card">
            <button className="sp-details-toggle" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
              {details ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Details
              <span className="muted">funnel, hourly, energy, area comparison</span>
            </button>
            {details && <InsightsPanel storeId={storeId} run={o.run} />}
          </section>

        </main>
      )}
      <DemoBar />
      <Toast />
    </div>
  );
}
