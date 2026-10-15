// The Agents view: what the long-running team is doing. The loop (store agents → analyst → simulator → score)
// with the current step lit, the session's vitals (backend, runtime, spend, patience, resume step), and one card
// per experiment: how many proposals came in, the analyst's hypothesis and expected gain, and what actually happened.
// Polls while a session is running. Data: GET /api/agents/session + /api/agents/log.
import { Bot, Brain, Cpu, FlaskConical, Gauge, RotateCcw, Store as StoreIcon, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentEvent, AgentSession } from "../api/contract";
import { invalidate, useAgentLog, useAgentSession } from "../state/data";
import { useSim } from "../state/store";
import { duration } from "./format";

const BACKEND_LABEL: Record<string, string> = {
  heuristic: "Heuristic analyst (offline)",
  messages: "Claude Opus · tool loop",
  managed: "Claude Managed Agent",
};

/** Which loop node the checkpoint's last completed step points at (the next one is running). */
const STEP_NODE: Record<string, number> = { start: 0, baseline: 0, scored: 0, proposed: 1, chosen: 2, ran: 3 };

interface Round {
  parent: number;
  run?: number;
  stores?: number;
  proposals?: number;
  hypothesis?: string;
  expected?: number;
  changes?: number;
  gain?: number;
  newBest?: boolean;
  notebook?: string;
  rejected: number;
}

function rounds(events: AgentEvent[]): Round[] {
  const byParent = new Map<number, Round>();
  const parentOf = new Map<number, number>();
  const get = (p: number) => {
    if (!byParent.has(p)) byParent.set(p, { parent: p, rejected: 0 });
    return byParent.get(p)!;
  };
  for (const e of events) {
    const d = e.data;
    if (e.type === "proposals" && e.run != null) Object.assign(get(e.run), { stores: d.stores as number, proposals: d.suggestions as number });
    if (e.type === "hypothesis" && e.run != null) Object.assign(get(e.run), { hypothesis: d.text as string, expected: d.expectedGain as number, changes: d.changesCount as number });
    if (e.type === "rule_rejection" && e.run != null) get(e.run).rejected++;
    if (e.type === "experiment" && e.run != null && typeof d.parentRun === "number") {
      parentOf.set(e.run, d.parentRun);
      get(d.parentRun).run = e.run;
    }
    if (e.type === "result" && e.run != null) {
      const p = parentOf.get(e.run);
      if (p != null) Object.assign(get(p), { gain: d.gain as number, newBest: !!d.newBest, notebook: d.notebook as string });
    }
  }
  return [...byParent.values()].filter((r) => r.hypothesis || r.run).sort((a, b) => b.parent - a.parent);
}

function Loop({ session, stores }: { session: AgentSession; stores?: number }) {
  const active = session.state === "running" ? (STEP_NODE[session.step] ?? 0) : -1;
  const nodes = [
    { icon: StoreIcon, label: "Store agents", sub: stores ? `${stores} shops` : "one per shop" },
    { icon: Brain, label: "Analyst", sub: session.backend === "heuristic" ? "heuristic" : "Claude" },
    { icon: Cpu, label: "Simulator", sub: "14 days · ~2 s" },
    { icon: Gauge, label: "Score", sub: "vs best run" },
  ];
  return (
    <div className="ag-loop" aria-label="Agent loop">
      {nodes.map((n, i) => {
        const I = n.icon;
        return (
          <div key={n.label} className={`ag-node ${i === active ? "on" : ""}`}>
            <I size={16} />
            <b>{n.label}</b>
            <span>{n.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

const pct = (x: number | undefined) => (x === undefined ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`);

export function AgentsPanel() {
  const session = useAgentSession().data;
  const log = useAgentLog().data ?? [];
  const [now, setNow] = useState(() => Date.now());
  const running = session?.state === "running";

  // live: poll the checkpoint and the log while a session runs
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      invalidate("agents:");
      invalidate("runs");
      invalidate("analyst");
      setNow(Date.now());
    }, 4000);
    return () => clearInterval(id);
  }, [running]);

  const list = useMemo(() => rounds(log), [log]);
  const lastProposals = [...log].reverse().find((e) => e.type === "proposals");
  const close = () => useSim.getState().openPanel(null);
  const replay = (run?: number) => run != null && useSim.getState().replay(run, useSim.getState().t);

  return (
    <aside className="history agents panel" aria-label="Agents">
      <header className="card-head">
        <span className="type-badge">
          <Bot size={18} />
        </span>
        <div>
          <h2>Agents</h2>
          <div className="card-sub">{session ? (BACKEND_LABEL[session.backend] ?? session.backend) : "no session yet"}</div>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      {!session && <div className="empty">The analyst hasn't run yet · start a training session</div>}
      {session && (
        <>
          <Loop session={session} stores={lastProposals?.data.stores as number | undefined} />
          <div className="ag-vitals">
            <span className={`status ${running ? "status-open" : ""}`}>{running ? "running" : `stopped · ${session.stoppedReason ?? "—"}`}</span>
            <span className="status">{duration((running ? now : Date.parse(session.updatedAt)) - Date.parse(session.startedAt))}</span>
            <span className="status">{session.runsThisSession.length} runs</span>
            <span className="status">£{session.spentGbp.toFixed(2)} spent</span>
            <span className="status" title="Runs in a row below the gain threshold">patience {session.lowGainStreak}</span>
          </div>
          <div className="ag-resume">
            <RotateCcw size={12} /> checkpointed after every step · last: <b>{session.step}</b>
            {session.bestRun != null && (
              <>
                {" "}
                · best run <b>{session.bestRun}</b>
              </>
            )}
          </div>
          {session.error && <div className="calib-warn">{session.error}</div>}

          <h3 className="section-title">
            Experiments <span className="muted">newest first</span>
          </h3>
          {list.length === 0 && <div className="empty">No experiments yet</div>}
          <ol className="ag-rounds">
            {list.map((r) => {
              const scale = Math.max(Math.abs(r.expected ?? 0), Math.abs(r.gain ?? 0), 0.005);
              return (
                <li key={r.parent} className={r.newBest ? "best" : ""}>
                  <button onClick={() => replay(r.run)} disabled={r.run == null}>
                    <div className="ag-round-head">
                      <FlaskConical size={14} />
                      <b>
                        Run {r.parent} → {r.run ?? "…"}
                      </b>
                      {r.newBest && <span className="tag tag-lamp">new best</span>}
                      {r.gain !== undefined && !r.newBest && <span className="tag">kept best</span>}
                    </div>
                    {r.proposals != null && (
                      <div className="ag-line muted">
                        {r.stores} store agents · {r.proposals} proposals{r.changes ? ` · ${r.changes} chosen` : ""}
                        {r.rejected ? ` · ${r.rejected} blocked by rules` : ""}
                      </div>
                    )}
                    {r.hypothesis && <div className="ag-hyp">“{r.hypothesis}”</div>}
                    <div className="ag-bars">
                      <span className="ag-bar-label">expected</span>
                      <span className="ag-bar">
                        <i className="exp" style={{ width: `${(Math.abs(r.expected ?? 0) / scale) * 100}%` }} />
                      </span>
                      <span className="mono">{pct(r.expected)}</span>
                      <span className="ag-bar-label">actual</span>
                      <span className="ag-bar">
                        <i className={(r.gain ?? 0) >= 0 ? "act" : "neg"} style={{ width: `${(Math.abs(r.gain ?? 0) / scale) * 100}%` }} />
                      </span>
                      <span className="mono">{pct(r.gain)}</span>
                    </div>
                    {r.notebook && <div className="ag-line">{r.notebook}</div>}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="foot-note">Hand-offs, proposals and results from the agents' audit log · prompts stay server-side</div>
        </>
      )}
    </aside>
  );
}
