// Side card for the selected store: status now, 24h strip, KPIs vs last run, suggestions with Apply buttons,
// and the way into the owner's weekly report.
import { useState } from "react";
import { GBP_PER_KWH, staffPerOpenHour } from "../sim/economics";
import { api } from "../api/client";
import { storeStateAt } from "../sim/storeState";
import { hourOf, isOpenAt, minuteOfDay } from "../sim/time";
import { OwnerTimeline } from "./OwnerTimeline";
import { WeekSchedule } from "./WeekSchedule";
import { invalidate, useAnalyst, useMap, useOwnerEvents, watchRun, useRunStores, useSuggestions } from "../state/data";
import { useSim } from "../state/store";
import { STORE_COLORS } from "../world/palette";
import { Delta } from "./Delta";
import { change, fmtInt, TYPE_LABEL } from "./format";
import { HourStrip } from "./HourStrip";
import { Icon } from "./icons";
import { InsightsPanel } from "./InsightsPanel";
import { BusyTimes } from "./BusyTimes";
import { SuggestionList } from "./SuggestionList";
import { TypeIcon } from "./TypeIcon";
import { agentsPath, navigate, storePath } from "../router";
import { SafetyCardExtras } from "./SafetyCardExtras";

export function StoreCard() {
  const id = useSim((s) => s.selectedStoreId);
  const run = useSim((s) => s.run);
  const hour = useSim((s) => Math.floor(hourOf(s.t) * 4) / 4);
  const minute = useSim((s) => Math.floor(minuteOfDay(s.t)));
  const tNow = useSim((s) => Math.floor(s.t));
  const ownerEvents = useOwnerEvents(run).data;
  const map = useMap().data;
  const stores = useRunStores(run).data;
  const prevStores = useRunStores(run > 1 ? run - 1 : null).data;
  const suggestions = useSuggestions(run).data;
  const analystRan = (useAnalyst().data?.iterations ?? 0) > 0;
  const [busy, setBusy] = useState<null | "store" | "all">(null);
  const [tab, setTab] = useState<"overview" | "insights">("overview");

  const store = map?.stores.find((s) => s.id === id);
  if (!id || !store) return null;
  const cfg = stores?.[id];
  const prev = prevStores?.[id];
  const mine = suggestions?.filter((s) => s.storeId === id) ?? [];
  // what the shop is really doing now: the owner's schedule and today-only decisions, not just the starting hours
  const state = cfg ? storeStateAt(cfg, (ownerEvents ?? []).filter((e) => e.storeId === id), tNow) : null;
  const open = state ? state.open : cfg ? isOpenAt(cfg.open, cfg.close, minute) : false;
  const light = state?.lighting ?? cfg?.lighting[Math.floor(hour) % 24] ?? "off";
  const isClub = store.type === "club";

  const apply = async (scope: "store" | "all") => {
    setBusy(scope);
    try {
      const res = await api.apply(scope === "store" ? { run, scope, storeIds: [id] } : { run, scope });
      invalidate("runs");
      useSim.getState().showToast(`Queued run ${res.queuedRun}`);
      // the backend runs it in the background; tell the owner when it lands
      void watchRun(res.queuedRun).then((status) => {
        if (status === "done") useSim.getState().showToast(`Run ${res.queuedRun} ready · open History to replay`);
        else if (status === "failed") useSim.getState().showToast(`Run ${res.queuedRun} failed`);
      });
    } catch {
      useSim.getState().showToast("Apply failed");
    } finally {
      setBusy(null);
    }
  };

  const kpis = [
    { key: "visits", label: "Visits", v: cfg && fmtInt(cfg.kpis.visits), d: change(prev?.kpis.visits, cfg?.kpis.visits) },
    { key: "kwh", label: "kWh", v: cfg && fmtInt(cfg.kpis.kwh), d: change(prev?.kpis.kwh, cfg?.kpis.kwh) },
    { key: "returnRate", label: "Return", v: cfg && `${Math.round(cfg.kpis.returnRate * 100)}%`, d: change(prev?.kpis.returnRate, cfg?.kpis.returnRate) },
  ];

  return (
    <aside className="store-card panel" aria-label={`${store.name} card`}>
      <header className="card-head" style={{ ["--accent" as string]: STORE_COLORS[store.type].awning }}>
        <span className="type-badge">
          <TypeIcon type={store.type} />
        </span>
        <div>
          <h2>{store.name}</h2>
          <div className="card-sub">
            {TYPE_LABEL[store.type]} · {cfg ? `${cfg.open}–${cfg.close}` : "…"}
          </div>
        </div>
        <button className="icon-btn" onClick={() => useSim.getState().selectStore(null)} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      <div className="status-row">
        <span className={`status ${open ? "status-open" : "status-closed"}`}>
          {state?.closedForGood ? "Closed for good" : open ? (state?.todayAction === "open_late" ? "Open late tonight" : "Open") : state?.shutAllDay ? "Shut today" : state?.todayAction === "shut_early" ? "Shut early" : "Closed"}
        </span>
        <span className={`status status-light light-${light}`}>
          <Icon name="bolt" size={12} /> {light}
        </span>
        {isClub && <span className="status">anchor · not optimised</span>}
        {store.licensedHours && (
          <span className="status" title="Premises licence: suggestions never go outside it">
            licence {store.licensedHours.open}–{store.licensedHours.close}
          </span>
        )}
        {store.floorArea ? <span className="status">{Math.round(store.floorArea)} m²</span> : null}
      </div>

      {!isClub && (
        <div className="tabs" role="tablist">
          {(["overview", "insights"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "overview" ? "Overview" : "Insights"}
            </button>
          ))}
        </div>
      )}

      {tab === "insights" && !isClub ? (
        <>
          <InsightsPanel storeId={id} run={run} onApply={() => apply("store")} />
          <button className="btn btn-report" onClick={() => useSim.getState().openPanel("report")}>
            <Icon name="report" /> Weekly report
          </button>
          <button className="btn btn-report" onClick={() => navigate(agentsPath(id))}>
            Run the agents
          </button>
          <button className="btn" onClick={() => navigate(storePath(id))}>
            Open shop page
          </button>
        </>
      ) : (
      <>
      {state?.reason && <div className="owner-now">“{state.reason}”</div>}
      <SafetyCardExtras storeId={id} />
      {cfg && <HourStrip cfg={cfg} hour={hour} prev={prev} licence={store.licensedHours ?? undefined} />}
      <BusyTimes storeId={id} />
      {!isClub && (
        <>
          <WeekSchedule storeId={id} run={run} />
          <OwnerTimeline storeId={id} run={run} />
        </>
      )}

      <div className="mini-kpis">
        {kpis.map((k) => (
          <div key={k.key} className="mini-kpi">
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.v ?? "…"}</span>
            <Delta value={k.d} metric={k.key} />
          </div>
        ))}
      </div>
      {cfg?.kpis.openHours != null && store.type !== "club" && (
        <div className="foot-note">
          Open {fmtInt(cfg.kpis.openHours / 2)} h/week · wages ≈ £{fmtInt((cfg.kpis.openHours / 2) * staffPerOpenHour(store.type))} · energy ≈ £
          {fmtInt((cfg.kpis.kwh / 2) * GBP_PER_KWH)}
        </div>
      )}
      <div className="foot-note">vs run {run > 1 ? run - 1 : "—"}</div>

      {!isClub && (
        <>
          <h3 className="section-title">
            Suggestions <span className="muted">{mine.length} change{mine.length === 1 ? "" : "s"}</span>
          </h3>
          {suggestions ? <SuggestionList items={mine} empty={analystRan ? undefined : "No suggestions yet · agents haven't run"} /> : <div className="empty">…</div>}
          <div className="btn-row">
            <button className="btn btn-lamp" disabled={!mine.length || !!busy} onClick={() => apply("store")}>
              {busy === "store" ? "Applying…" : "Apply to this store"}
            </button>
            <button className="btn" disabled={!suggestions?.length || !!busy} onClick={() => apply("all")}>
              {busy === "all" ? "Applying…" : "Apply all"}
            </button>
          </div>
          <button className="btn btn-report" onClick={() => useSim.getState().openPanel("report")}>
            <Icon name="report" /> Weekly report
          </button>
          <button className="btn btn-report" onClick={() => navigate(agentsPath(id))}>
            Run the agents
          </button>
          <button className="btn" onClick={() => navigate(storePath(id))}>
            Open shop page
          </button>
        </>
      )}
      </>
      )}
    </aside>
  );
}
