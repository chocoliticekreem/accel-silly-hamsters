// Start-up screen over the city while it loads (state/loading.ts has the stages). A real bar: bytes where the
// server says how many, task weights otherwise. Fades out once a frame has rendered with everything in; never
// blocks: "Continue anyway" appears after 20 s, or straight away when a stage reports an error.
import { useEffect, useRef, useState } from "react";
import { overallProgress, stageViews, task, useLoading } from "../state/loading";
import { useGpu, retryGpu } from "../world/staging";

const CONTINUE_AFTER_MS = 20_000;

/** Shoreditch at night: terraces, the Tea Building, a gasholder frame, the City's towers behind. */
function Skyline() {
  return (
    <svg className="ld-skyline" viewBox="0 0 640 120" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <path
        className="ld-far"
        d="M0 120V78h28V60h14v18h20V40h10v-8h8v8h10v80M150 120V52l18-10 16 10v68M390 120V30h10V14h12v16h10v90M440 120V48l14-8v-6h4v6l14 8v72M520 120V24l12-8 12 8v96M560 120V58h26v62"
      />
      <path
        className="ld-near"
        d="M0 120V96l12-8 12 8v-6l12-8 12 8v-4h18V74h46v22h10V86l10-6 10 6v10h16V70h8v-6h20v6h8v50zM196 120V84h40V66h52v54zM300 120V92l10-6 10 6V80h28v-8h6v8h16v40zM366 120V88h50v-6h30v38zM456 120V90l12-8 12 8 12-8 12 8v30zM512 120V76h22l6-6h14v50zM560 120V94h22v-8h20v8h38v26z"
      />
      <g className="ld-gas">
        <path d="M228 120V70M246 120V66M264 120V66M282 120V70M226 82h58M226 98h58" />
        <ellipse cx="255" cy="68" rx="29" ry="4" />
      </g>
      <g className="ld-lit">
        <rect x="80" y="84" width="4" height="5" />
        <rect x="100" y="78" width="4" height="5" />
        <rect x="212" y="90" width="4" height="5" />
        <rect x="310" y="96" width="4" height="5" />
        <rect x="380" y="94" width="4" height="5" />
        <rect x="396" y="102" width="4" height="5" />
        <rect x="520" y="82" width="4" height="5" />
        <rect x="586" y="100" width="4" height="5" />
      </g>
    </svg>
  );
}

export function LoadingScreen() {
  const state = useLoading();
  const views = stageViews(state);
  const raw = overallProgress(views);
  // never moves backwards (a new task joining a stage would otherwise pull it back)
  const shown = useRef(0);
  shown.current = Math.max(shown.current, raw);
  const pct = Math.round(shown.current * 100);
  const errors = views.flatMap((v) => v.errors.map((e) => ({ stage: v.label, e })));
  const [slow, setSlow] = useState(false);
  const [gone, setGone] = useState(false);
  const leaving = state.framed || state.dismissed;

  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), CONTINUE_AFTER_MS);
    // the fonts are part of the first look
    const f = task("map", "fonts");
    (document.fonts?.ready ?? Promise.resolve()).then(() => f.done(), () => f.done());
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!leaving) return;
    useLoading.setState({ dismissed: true });
    const t = window.setTimeout(() => setGone(true), 700);
    return () => window.clearTimeout(t);
  }, [leaving]);

  if (gone) return null;
  const active = views.find((v) => !v.complete && v.started) ?? views.find((v) => !v.complete);
  return (
    <div className={`loading${leaving ? " leaving" : ""}`} role="status" aria-live="polite" aria-busy={!leaving}>
      <div className="ld-glow" />
      <Skyline />
      <div className="ld-card panel">
        <div className="ld-head">
          <svg className="ld-roundel" viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="14" />
            <rect x="2" y="17" width="36" height="6" rx="1" />
          </svg>
          <div>
            <div className="ld-title">Shoreditch</div>
            <div className="ld-sub">{active ? active.label : "Ready"}</div>
          </div>
          <div className="ld-pct mono">{pct}%</div>
        </div>
        <div className="ld-bar" aria-hidden="true">
          <div className="ld-fill" style={{ transform: `scaleX(${shown.current})` }} />
        </div>
        <ol className="ld-stages">
          {views.map((v) => (
            <li key={v.id} className={v.errors.length ? "err" : v.complete ? "done" : v.started ? "on" : ""}>
              <span className="ld-dot" />
              <span className="ld-name">{v.label}</span>
              <span className="ld-val mono">{v.errors.length ? "issue" : v.complete ? "ready" : v.started ? `${Math.round(v.progress * 100)}%` : ""}</span>
            </li>
          ))}
        </ol>
        {errors.length > 0 && (
          <ul className="ld-errors">
            {errors.slice(0, 3).map((x, i) => (
              <li key={i}>
                <b>{x.stage}</b> <span className="mono">{x.e}</span>
              </li>
            ))}
          </ul>
        )}
        {(slow || errors.length > 0) && !leaving && (
          <div className="ld-actions">
            <span className="ld-hint">{errors.length ? "Some parts didn't load." : "Taking longer than usual."}</span>
            <button className="ld-btn" onClick={() => useLoading.setState({ dismissed: true })}>
              Continue anyway
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Over the canvas when the GPU drops the context; recovery runs by itself (world/staging.tsx). */
export function ContextLostOverlay() {
  const status = useGpu((s) => s.status);
  if (status === "ok") return null;
  return (
    <div className="gpu-lost" role="status">
      <div className="panel gpu-card">
        <div className="ld-title">{status === "failed" ? "Graphics stopped" : "Graphics paused"}</div>
        <div className="ld-sub">{status === "failed" ? "The graphics card dropped the city." : "Reconnecting to the graphics card…"}</div>
        {status === "failed" ? (
          <div className="ld-actions">
            <button className="ld-btn" onClick={retryGpu}>Try again</button>
            <button className="ld-btn ghost" onClick={() => location.reload()}>Reload</button>
          </div>
        ) : (
          <div className="ld-bar indet" aria-hidden="true">
            <div className="ld-fill" />
          </div>
        )}
      </div>
    </div>
  );
}
