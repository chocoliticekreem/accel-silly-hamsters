// The guided demo (docs/BUILD_SPEC.md "Demo plan"): one click per step, from the analyst's overnight session to the
// area view. Each step sets the run, the moment, the selected shop and the open panel; nothing is computed live.
// Rendered on both pages, so the "report" step can open the shop's page and the next step comes back to the city.
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useMemo } from "react";
import { navigate, storePath } from "../router";
import { DEMO_STEPS, demoRuns, pickDemoMoment } from "../state/demo";
import { useAnalyst, useMap, useRuns, useRunStores } from "../state/data";
import { useSim } from "../state/store";
import { dayOf, formatHHMM } from "../sim/time";
import { WEEKDAYS } from "./format";

/** Data the steps need: baseline and best run, and the shop + moment to show. */
export function useDemoPlan() {
  const runs = useRuns().data;
  const analyst = useAnalyst().data;
  const map = useMap().data;
  const r = runs ? demoRuns(runs, analyst) : null;
  const base = useRunStores(r?.base ?? null).data;
  const best = useRunStores(r?.best ?? null).data;
  return useMemo(() => {
    if (!r || !base || !best || !map) return null;
    const optimisable = new Set(map.stores.filter((s) => s.type !== "club").map((s) => s.id));
    const moment = pickDemoMoment(base, best, (id) => optimisable.has(id));
    if (!moment) return null;
    const name = map.stores.find((s) => s.id === moment.storeId)?.name ?? moment.storeId;
    return { ...r, ...moment, name };
    // r is rebuilt every render; its numbers are the identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.base, r?.best, base, best, map]);
}

type Plan = NonNullable<ReturnType<typeof useDemoPlan>>;

/** Put the app into step `i` of the demo plan. Idempotent, so going back and forth is safe. */
export function goToStep(i: number, plan: Plan) {
  const s = useSim.getState();
  const key = DEMO_STEPS[i].key;
  const inCity = key !== "report";
  if (inCity && window.location.pathname !== "/") navigate("/");
  s.setCompare(false);
  s.setDemo(i);
  switch (key) {
    case "analyst":
      // the runtime clock is the analyst chip; the notebook and KPI chart are History
      useSim.setState({ run: plan.best, playing: false, selectedStoreId: null, panel: "history" });
      break;
    case "before":
      // run 1 at the shop's night, 45 sim-minutes early at 1x: the crowd walks past a shut, dark shop
      useSim.setState({ run: plan.base, t: plan.t - 45, speed: 1, playing: true, selectedStoreId: null, panel: null });
      break;
    case "shop":
      useSim.setState({ run: plan.base, t: plan.t, playing: false, selectedStoreId: plan.storeId, panel: null });
      break;
    case "after":
      // same night, final run; History shows the KPI climb and the stop line
      useSim.setState({ run: plan.best, t: plan.t, playing: false, selectedStoreId: plan.storeId, panel: "history" });
      break;
    case "report":
      useSim.setState({ playing: false });
      // the report the owner got before the change: its advice is still open to Approve (the best run has none left)
      navigate(storePath(plan.storeId, plan.base));
      break;
    case "area":
      useSim.setState({ run: plan.best, playing: false, selectedStoreId: null, panel: "area" });
      break;
  }
}

function caption(i: number, plan: Plan) {
  const when = `${WEEKDAYS[(dayOf(plan.t) - 1) % 7]} ${formatHHMM(plan.t)}`;
  switch (DEMO_STEPS[i].key) {
    case "analyst":
      return "Ran overnight · runtime, notebook, KPI per run";
    case "before":
      return `Run ${plan.base} · ${when} · watch ${plan.name}`;
    case "shop":
      return `${plan.name} · ${plan.night ? "shut and dark" : "as the owner runs it"} · the advice`;
    case "after":
      return `Run ${plan.best} · same night · ${plan.name} open`;
    case "report":
      return `${plan.name} · run ${plan.base} report · Approve the advice`;
    case "area":
      return "High street · kWh, CO₂, £ · cost per store-week";
  }
}

/** The "Demo" chip: starts the walkthrough (disabled until the runs needed for it have loaded). */
export function DemoChip() {
  const plan = useDemoPlan();
  const demo = useSim((s) => s.demo);
  return (
    <button
      className={`chip ${demo !== null ? "on" : ""}`}
      disabled={!plan}
      title={plan ? "Walk the demo plan in six steps" : "Needs a baseline and a best run"}
      onClick={() => (demo !== null ? useSim.getState().setDemo(null) : plan && goToStep(0, plan))}
    >
      <ChevronRight size={14} /> Demo
    </button>
  );
}

export function DemoBar() {
  const demo = useSim((s) => s.demo);
  const plan = useDemoPlan();
  if (demo === null || !plan) return null;
  const last = DEMO_STEPS.length - 1;
  return (
    <nav className="demo-bar panel" aria-label="Demo steps">
      <button className="icon-btn" disabled={demo === 0} onClick={() => goToStep(demo - 1, plan)} aria-label="Previous step">
        <ChevronLeft size={16} />
      </button>
      <ol className="demo-steps">
        {DEMO_STEPS.map((s, i) => (
          <li key={s.key}>
            <button className={i === demo ? "on" : i < demo ? "done" : ""} onClick={() => goToStep(i, plan)} aria-current={i === demo ? "step" : undefined} aria-label={`Step ${i + 1}: ${s.label}`} title={s.label}>
              {i + 1}
            </button>
          </li>
        ))}
      </ol>
      <div className="demo-text">
        <b>{DEMO_STEPS[demo].label}</b>
        <span className="muted">{caption(demo, plan)}</span>
      </div>
      {demo < last ? (
        <button className="btn btn-lamp demo-next" onClick={() => goToStep(demo + 1, plan)}>
          Next <ChevronRight size={14} />
        </button>
      ) : (
        <button className="btn demo-next" onClick={() => useSim.getState().setDemo(null)}>
          Done
        </button>
      )}
      <button className="icon-btn" onClick={() => useSim.getState().setDemo(null)} aria-label="Exit demo">
        <X size={16} />
      </button>
    </nav>
  );
}
