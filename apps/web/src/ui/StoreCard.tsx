// Side card for the selected store: status now, 24h strip, KPIs vs last run, suggestions with Apply buttons,
// and the way into the owner's weekly report.
import { useState } from "react";
import { api } from "../api/client";
import { hourOf, isOpenAt, minuteOfDay } from "../sim/time";
import { invalidate, useMap, useRunStores, useSuggestions } from "../state/data";
import { useSim } from "../state/store";
import { STORE_COLORS } from "../world/palette";
import { Delta } from "./Delta";
import { change, fmtInt, TYPE_LABEL } from "./format";
import { HourStrip } from "./HourStrip";
import { Icon } from "./icons";
import { SuggestionList } from "./SuggestionList";

export function StoreCard() {
  const id = useSim((s) => s.selectedStoreId);
  const run = useSim((s) => s.run);
  const hour = useSim((s) => Math.floor(hourOf(s.t) * 4) / 4);
  const minute = useSim((s) => Math.floor(minuteOfDay(s.t)));
  const map = useMap().data;
  const stores = useRunStores(run).data;
  const prevStores = useRunStores(run > 1 ? run - 1 : null).data;
  const suggestions = useSuggestions(run).data;
  const [busy, setBusy] = useState<null | "store" | "all">(null);

  const store = map?.stores.find((s) => s.id === id);
  if (!id || !store) return null;
  const cfg = stores?.[id];
  const prev = prevStores?.[id];
  const mine = suggestions?.filter((s) => s.storeId === id) ?? [];
  const open = cfg ? isOpenAt(cfg.open, cfg.close, minute) : false;
  const light = cfg?.lighting[Math.floor(hour) % 24] ?? "off";
  const isClub = store.type === "club";

  const apply = async (scope: "store" | "all") => {
    setBusy(scope);
    try {
      const res = await api.apply(scope === "store" ? { run, scope, storeIds: [id] } : { run, scope });
      invalidate("runs");
      useSim.getState().showToast(`Queued run ${res.queuedRun}`);
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
        <span className="type-badge">{STORE_COLORS[store.type].icon}</span>
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
        <span className={`status ${open ? "status-open" : "status-closed"}`}>{open ? "Open" : "Closed"}</span>
        <span className={`status status-light light-${light}`}>
          <Icon name="bolt" size={12} /> {light}
        </span>
        {isClub && <span className="status">anchor · not optimised</span>}
      </div>

      {cfg && <HourStrip cfg={cfg} hour={hour} prev={prev} />}

      <div className="mini-kpis">
        {kpis.map((k) => (
          <div key={k.key} className="mini-kpi">
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.v ?? "…"}</span>
            <Delta value={k.d} metric={k.key} />
          </div>
        ))}
      </div>
      <div className="foot-note">vs run {run > 1 ? run - 1 : "—"}</div>

      {!isClub && (
        <>
          <h3 className="section-title">
            Next experiment <span className="muted">run {run} → {run + 1}</span>
          </h3>
          {suggestions ? <SuggestionList items={mine} /> : <div className="empty">…</div>}
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
        </>
      )}
    </aside>
  );
}
