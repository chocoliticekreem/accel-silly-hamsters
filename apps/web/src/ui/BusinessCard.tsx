// Side card for a real business the sim doesn't model (state/businesses): what it is, its hours (open or closed at
// the sim clock), address, website, and an *estimated* electricity profile from floor area, type and hours
// (sim/businessEnergy, the backend's own factors). Same look as the StoreCard; only one of the two is open at once.
import { ExternalLink, MapPin, Navigation } from "lucide-react";
import { useEffect, useMemo } from "react";
import { estimate } from "../sim/businessEnergy";
import { nextChange, openAt, parseOpeningHours, weekRows } from "../sim/openingHours";
import { weekdayIndex } from "../sim/storeState";
import { dayOf, hourOf, minuteOfDay } from "../sim/time";
import { landmarkMap, useBusinesses, useBusinessList } from "../state/businesses";
import { useFootfall, useMap } from "../state/data";
import { useSim } from "../state/store";
import { flyTo } from "../world/flyTo";
import { STORE_COLORS } from "../world/palette";
import { fmtInt } from "./format";
import { Icon } from "./icons";
import { TypeIcon } from "./TypeIcon";
import "./business.css";

const kwh = (v: number) => (v >= 100 ? fmtInt(v) : v.toFixed(1));

export function BusinessCard() {
  const map = useMap().data;
  const id = useBusinesses((s) => s.selected);
  const { byId } = useBusinessList(map);
  const run = useSim((s) => s.run);
  const day = useSim((s) => dayOf(s.t));
  const minute = useSim((s) => Math.floor(minuteOfDay(s.t) / 5) * 5);
  const footfall = useFootfall(run).data;
  landmarkMap.current = map ?? null;

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useBusinesses.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);

  const b = id ? byId.get(id) : undefined;
  const wd = weekdayIndex(day);
  const est = useMemo(() => (b ? estimate(b.units, wd) : null), [b, wd]);
  if (!b || !est) return null;

  const week = b.units[0]?.week ?? parseOpeningHours(b.hours) ?? parseOpeningHours("Mo-Su 00:00-24:00")!;
  const typical = b.units[0]?.typicalHours ?? true;
  const open = b.units.length ? b.units.some((u) => openAt(u.week, wd, minute)) : openAt(week, wd, minute);
  const change = nextChange(week, wd, minute);
  const rows = weekRows(week);
  const estimated = b.units.length > 0;
  const hour = Math.floor(hourOf(minute));
  const peak = Math.max(...est.hourly, 0.001);
  const street = footfall?.onStreetByDayHour[day - 1]?.[hour];
  const close = () => useBusinesses.getState().select(null);
  const isLandmark = b.osmType === "landmark";

  return (
    <aside className="store-card biz-card panel" aria-label={`${b.name} card`}>
      <header className="card-head" style={{ ["--accent" as string]: STORE_COLORS[b.cat].awning }}>
        <span className="type-badge">
          <TypeIcon type={b.cat} />
        </span>
        <div>
          <h2>{b.name}</h2>
          <div className="card-sub">
            {b.label}
            {b.cuisine ? ` · ${b.cuisine}` : ""}
            {b.sub ? ` · ${b.sub}` : ""}
          </div>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      <div className="status-row">
        <span className={`status ${open ? "status-open" : "status-closed"}`}>{open ? "Open" : "Closed"}</span>
        {change && <span className="status">{change}</span>}
        {estimated && (
          <span className="status" title="Unit floor area used for the estimate">
            {fmtInt(est.areaM2)} m²
          </span>
        )}
      </div>

      {b.simStores && (
        <>
          <h3 className="section-title">
            Simulated here <span className="muted">{b.simStores.length} shops</span>
          </h3>
          <ul className="biz-units biz-sim">
            {b.simStores.map((s) => (
              <li key={s.id}>
                <button onClick={() => useSim.getState().selectStore(s.id)}>
                  <TypeIcon type={s.type} size={13} /> {s.name}
                </button>
                <span className="muted">live data</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="biz-note">
        <b>Not in this simulation run:</b> live footfall and energy only for the {map?.stores.length ?? 72} simulated shops.{" "}
        {b.simStores && !estimated ? "Open a shop above for its numbers." : b.simStores ? "The rest of the building is estimated below from its size, type and hours." : "The numbers below are an estimate from its size, type and hours."}
      </div>

      <h3 className="section-title">
        Hours <span className="muted">{typical ? (isLandmark ? "assumed" : "typical, none on OSM") : "OpenStreetMap"}</span>
      </h3>
      <dl className="biz-hours">
        {rows.map(([d, h]) => (
          <div key={d}>
            <dt>{d}</dt>
            <dd>{h}</dd>
          </div>
        ))}
      </dl>

      {estimated && (
      <>
      <h3 className="section-title">
        Electricity <span className="biz-est">Estimate (not simulated)</span>
      </h3>
      <div className="biz-curve" role="img" aria-label={`Estimated kWh by hour today: ${kwh(est.dayKwh)} kWh`}>
        {est.hourly.map((v, h) => (
          <i key={h} className={h === hour ? "now" : ""} style={{ height: `${Math.max(4, (v / peak) * 100)}%` }} title={`${String(h).padStart(2, "0")}:00 · ${v.toFixed(2)} kWh`} />
        ))}
      </div>
      <div className="biz-curve-axis">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div className="mini-kpis">
        <div className="mini-kpi">
          <span className="kpi-label">Today</span>
          <span className="kpi-value">{kwh(est.dayKwh)}</span>
          <span className="biz-unit">kWh</span>
        </div>
        <div className="mini-kpi">
          <span className="kpi-label">Week</span>
          <span className="kpi-value">{kwh(est.weekKwh)}</span>
          <span className="biz-unit">kWh</span>
        </div>
        <div className="mini-kpi">
          <span className="kpi-label">Cost</span>
          <span className="kpi-value">£{fmtInt(est.weekCostGbp)}</span>
          <span className="biz-unit">a week</span>
        </div>
        <div className="mini-kpi">
          <span className="kpi-label">CO₂</span>
          <span className="kpi-value">{kwh(est.weekCo2Kg)}</span>
          <span className="biz-unit">kg a week</span>
        </div>
        <div className="mini-kpi">
          <span className="kpi-label">Open</span>
          <span className="kpi-value">{fmtInt(est.openHoursWeek)}</span>
          <span className="biz-unit">h a week</span>
        </div>
        <div className="mini-kpi" title="Sim citizens on the street across the whole map this hour (the sim has no visits for this business)">
          <span className="kpi-label">Street</span>
          <span className="kpi-value">{street != null ? fmtInt(street) : footfall === undefined ? "…" : "—"}</span>
          <span className="biz-unit">on foot, area</span>
        </div>
      </div>
      {b.units.length > 1 && (
        <>
          <h3 className="section-title">
            Units <span className="muted">{b.units.length}</span>
          </h3>
          <ul className="biz-units">
            {b.units.slice(0, 40).map((u, i) => (
              <li key={i}>
                <span>{u.name}</span>
                <span className="muted">{fmtInt(u.areaM2)} m²</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="foot-note">kWh/m² by type, standby and facade lighting from the sim's energy model · London grid carbon by hour · £0.32/kWh</div>
      </>
      )}

      {(b.address || b.website) && (
        <div className="biz-contact">
          {b.address && (
            <div>
              <MapPin size={13} /> {b.address}
            </div>
          )}
          {b.website && (
            <a href={b.website} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={13} /> {b.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
            </a>
          )}
        </div>
      )}

      <button className="btn btn-lamp biz-go" onClick={() => flyTo(b.x, b.z, isLandmark ? 140 : 70, isLandmark ? 6 : 3)}>
        <Navigation size={14} /> Go there
      </button>
      <div className="disclaimer card-note">© OpenStreetMap contributors · estimate, not a measurement</div>
    </aside>
  );
}
