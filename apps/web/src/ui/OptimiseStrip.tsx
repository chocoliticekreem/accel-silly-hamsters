// Live progress for "Optimise for me": polls the agent session every 3 s while it runs, then refreshes the
// page's data and says what the session found, from the refreshed overview.
import { CircleCheck, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { doneLabel, progressLabel, sessionFinished } from "./optimiseStatus";

const POLL_MS = 3000;
const MAX_POLLS = 200; // ~10 minutes

export function OptimiseStrip({ storeId, onDone, onClose }: { storeId: string; onDone: () => void; onClose: () => void }) {
  const [label, setLabel] = useState(() => progressLabel(null));
  const [done, setDone] = useState<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let alive = true;
    let sawRunning = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = await api.agentSession().catch(() => null);
      if (!alive) return;
      polls++;
      if (s?.state === "running") {
        sawRunning = true;
        setLabel(progressLabel(s));
      }
      if (sessionFinished(s, sawRunning, polls)) {
        onDoneRef.current();
        const o = await api.overview(storeId).catch(() => null);
        if (alive) setDone(doneLabel(o));
        return;
      }
      if (polls >= MAX_POLLS) {
        setDone("Still optimising: check back later");
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [storeId]);

  return (
    <div className={`sp-optimise ${done ? "done" : "running"}`} role="status" aria-live="polite">
      {done ? <CircleCheck size={16} /> : <LoaderCircle size={16} className="spin" />}
      <span>{done ?? label}</span>
      {!done && <span className="sp-optimise-bar" aria-hidden />}
      {done && (
        <button className="icon-btn" onClick={onClose} aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
