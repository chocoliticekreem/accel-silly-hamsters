// Store insights ("PostHog for shop energy"): ranked actions first, then the evidence behind them —
// funnel, the 24-hour picture (passers-by, visits, people who found it shut), where the kWh goes,
// anonymous benchmarks and who comes in. Numbers and short labels only.
import { ChartColumn, Clock, DoorClosed, Flashlight, Lightbulb, type LucideIcon } from "lucide-react";
import type { StoreInsights } from "../api/contract";
import { useInsights } from "../state/data";
import { useSim } from "../state/store";
import { personaColor } from "../world/palette";
import { Delta } from "./Delta";
import { fmtInt } from "./format";
import { Icon } from "./icons";
import { Pips, SuggestionRow } from "./SuggestionList";

type Insight = StoreInsights["insights"][number];

const KIND_ICON: Record<Insight["kind"], LucideIcon> = {
  missed_demand: DoorClosed,
  wasted_energy: Lightbulb,
  dead_hours: Clock,
  lighting_opportunity: Flashlight,
  benchmark: ChartColumn,
};

function replayFrom(url: string, storeId: string) {
  const m = url.match(/\/api\/runs\/(\d+)\/days\/(\d+)/);
  if (!m) return false;
  const s = useSim.getState();
  s.selectStore(storeId);
  s.replay(Number(m[1]), (Number(m[2]) - 1) * 1440 + 18 * 60);
  return true;
}

function InsightCard({ ins, storeId, onApply }: { ins: Insight; storeId: string; onApply?: () => void }) {
  return (
    <li className={`insight sev-${ins.severity}`}>
      <div className="insight-head">
        <span className="insight-icon" aria-hidden>
          {(() => {
            const I = KIND_ICON[ins.kind];
            return <I size={14} />;
          })()}
        </span>
        <b className="insight-title">{ins.title}</b>
        <Pips level={ins.confidence} />
      </div>
      <div className="insight-metric mono">
        {fmtInt(ins.metric.value)} <span className="muted">{ins.metric.unit}</span>
        <span className="muted"> · {ins.metric.label}</span>
      </div>
      <div className="insight-detail" title={ins.detail}>
        {ins.detail}
      </div>
      {ins.kind !== "benchmark" && (
        <div className="sugg-deltas">
          {ins.impact.gbpPerWeek !== 0 && (
            <span className={`gbp-chip ${ins.impact.gbpPerWeek > 0 ? "pos" : "neg"}`}>
              {ins.impact.gbpPerWeek > 0 ? "+" : "−"}£{Math.abs(ins.impact.gbpPerWeek)}/wk
            </span>
          )}
          <Delta value={ins.impact.visits} metric="visits" />
          <span className="unit">visits</span>
          <Delta value={ins.impact.kwh} metric="kwh" />
          <span className="unit">kWh</span>
        </div>
      )}
      {ins.suggestion && (
        <ul className="sugg-list insight-sugg">
          <SuggestionRow
            s={{ ...ins.suggestion, reason: null, confidence: null }}
            actions={
              onApply && (
                <button className="btn btn-lamp" onClick={onApply}>
                  Try it
                </button>
              )
            }
          />
        </ul>
      )}
      {ins.evidence.length > 0 && (
        <div className="insight-evidence">
          {ins.evidence.slice(0, 2).map((e) => (
            <a
              key={e.url}
              href={e.url}
              className="evidence-chip"
              target="_blank"
              rel="noreferrer"
              onClick={(ev) => replayFrom(e.url, storeId) && ev.preventDefault()}
            >
              <Icon name={/\/api\/runs\//.test(e.url) ? "replay" : "link"} size={12} /> {e.label}
            </a>
          ))}
        </div>
      )}
    </li>
  );
}

function Funnel({ f }: { f: StoreInsights["funnel"] }) {
  const max = Math.max(1, f.passersBy);
  const rows = [
    { label: "Passed by", v: f.passersBy },
    { label: "Came in", v: f.visits },
    { label: "Came back", v: f.returningVisitors },
  ];
  return (
    <div className="funnel">
      {rows.map((r) => (
        <div key={r.label} className="funnel-row">
          <span className="funnel-label">{r.label}</span>
          <span className="funnel-bar">
            <i style={{ width: `${Math.max(1.5, (r.v / max) * 100)}%` }} />
          </span>
          <span className="mono funnel-v">{fmtInt(r.v)}</span>
        </div>
      ))}
      <div className="foot-note">
        capture {(f.captureRate * 100).toFixed(1)}% · return {Math.round(f.returnRate * 100)}% · 14 days
      </div>
    </div>
  );
}

/** 24 columns: passers-by (faint), visits (lamp), people who found it shut (red cap); closed hours shaded. */
function Day({ h }: { h: StoreInsights["hourly"] }) {
  const W = 300;
  const H = 70;
  const cw = W / 24;
  const peak = Math.max(1, ...h.footfall, ...h.visits.map((v, i) => v + h.missedDemand[i]));
  const y = (v: number) => (v / peak) * (H - 4);
  return (
    <>
      <svg className="day-chart" viewBox={`0 0 ${W} ${H}`} aria-label="Visits, passers-by and missed demand by hour">
        {h.openFraction.map((o, i) => (o < 1 ? <rect key={`c${i}`} x={i * cw} y={0} width={cw} height={H} className="dc-closed" style={{ opacity: 1 - o }} /> : null))}
        {h.footfall.map((v, i) => (
          <rect key={`f${i}`} x={i * cw + 1} y={H - y(v)} width={cw - 2} height={y(v)} className="dc-foot" />
        ))}
        {h.visits.map((v, i) => (
          <rect key={`v${i}`} x={i * cw + 3} y={H - y(v)} width={cw - 6} height={y(v)} className="dc-visit" />
        ))}
        {h.missedDemand.map((v, i) =>
          v > 0 ? <rect key={`m${i}`} x={i * cw + 3} y={H - y(h.visits[i]) - y(v)} width={cw - 6} height={Math.max(1.5, y(v))} className="dc-missed" /> : null,
        )}
      </svg>
      {/* HTML, not SVG text: the chart scales with its card, and the hour labels must stay 12px */}
      <div className="dc-axis">
        {[0, 6, 12, 18].map((t) => (
          <span key={t} style={{ left: `${(t / 24) * 100}%` }}>
            {String(t).padStart(2, "0")}
          </span>
        ))}
      </div>
    </>
  );
}

function Energy({ e }: { e: StoreInsights["energy"] }) {
  const closedOther = Math.max(0, e.kwhWhileClosed - e.kwhLightingWhileClosed);
  const parts = [
    { k: "Lights while shut", v: e.kwhLightingWhileClosed, cls: "en-light" },
    { k: "Other while shut", v: closedOther, cls: "en-closed" },
    { k: "Open, near-empty", v: e.kwhLowTrafficOpen, cls: "en-dead" },
    { k: "Open, trading", v: Math.max(0, e.kwh - e.kwhWhileClosed - e.kwhLowTrafficOpen), cls: "en-good" },
  ];
  const total = Math.max(1, e.kwh);
  return (
    <div className="energy">
      <div className="energy-bar">
        {parts.map((p) => (p.v > 0 ? <i key={p.k} className={p.cls} style={{ width: `${(p.v / total) * 100}%` }} title={`${p.k}: ${fmtInt(p.v)} kWh`} /> : null))}
      </div>
      <div className="energy-legend">
        {parts.map((p) => (
          <span key={p.k}>
            <i className={`sw ${p.cls}`} /> {p.k} <b className="mono">{Math.round((p.v / total) * 100)}%</b>
          </span>
        ))}
      </div>
      <div className="foot-note">
        {fmtInt(e.kwh)} kWh · £{fmtInt(e.costGbp)} · {fmtInt(e.co2Kg)} kg CO₂ · 14 days
      </div>
    </div>
  );
}

function Meter({ label, pct, note }: { label: string; pct: number; note: string }) {
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{label}</span>
        <b className="mono">better than {Math.round(pct * 100)}%</b>
      </div>
      <div className="meter-track">
        <i style={{ left: `${pct * 100}%` }} />
      </div>
      <div className="foot-note">{note}</div>
    </div>
  );
}

export function InsightsPanel({ storeId, run, onApply }: { storeId: string; run: number; onApply?: () => void }) {
  const { data, error, loading } = useInsights(storeId, run);
  if (error) return <div className="empty">Insights unavailable</div>;
  if (loading && !data) return <div className="empty">…</div>;
  if (!data) return <div className="empty">No insights for run {run} yet</div>;
  const b = data.benchmarks;
  const peerLabel = b ? `${b.peers} ${b.peerType === "all" ? "shops" : `${b.peerType}s`} nearby, anonymous` : "";

  return (
    <div className="insights">
      <h3 className="section-title">
        Top actions <span className="muted">£ per week</span>
      </h3>
      {data.insights.length ? (
        <ul className="insight-list">
          {data.insights.map((i) => (
            <InsightCard key={i.id} ins={i} storeId={storeId} onApply={i.suggestion ? onApply : undefined} />
          ))}
        </ul>
      ) : (
        <div className="empty">Nothing to fix · running well</div>
      )}

      <h3 className="section-title">Funnel</h3>
      <Funnel f={data.funnel} />

      <h3 className="section-title">
        A day here <span className="muted">avg per hour</span>
      </h3>
      <Day h={data.hourly} />
      <div className="strip-legend">
        <span>
          <i className="sw dc-foot" /> passed by
        </span>
        <span>
          <i className="sw dc-visit" /> came in
        </span>
        <span>
          <i className="sw dc-missed" /> found it shut
        </span>
        <span>
          <i className="sw dc-closed" /> closed
        </span>
      </div>

      <h3 className="section-title">Where the kWh go</h3>
      <Energy e={data.energy} />

      {b && (
        <>
          <h3 className="section-title">Vs the area</h3>
          <Meter label="Visits per kWh" pct={b.visitsPerKwhPercentile} note={`median ${b.areaMedianVisitsPerKwh} · ${peerLabel}`} />
          <Meter label="Passers-by who come in" pct={b.captureRatePercentile} note={`median ${(b.areaMedianCaptureRate * 100).toFixed(1)}% · ${peerLabel}`} />
        </>
      )}

      {data.personas.length > 0 && (
        <>
          <h3 className="section-title">Who comes in</h3>
          <div className="personas">
            {data.personas.slice(0, 5).map((p) => (
              <span key={p.persona} className="persona-chip">
                <i style={{ background: personaColor(p.persona) }} /> {p.persona} <b className="mono">{Math.round(p.share * 100)}%</b>
              </span>
            ))}
          </div>
        </>
      )}
      <div className="disclaimer insights-note">{data.note ?? "Simulated, not guaranteed."} · only this shop's data</div>
    </div>
  );
}
