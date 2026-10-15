// Go-to bar: one click flies the camera to a place (Encode Hub first, then XOYO, art'otel, Old Street, Boxpark,
// the station and the Goodsyard cranes); "More" lists the map's clubs and stations. Places with an interior get an
// Enter button that opens the multi-floor cutaway (world/modules/Landmarks), with a floor stepper above the playback bar.
// Positions: world/landmarks/places (map stores and buildings, sim/london landmarks, fallbacks).
// Keys: PgUp/PgDn or ] / [ step floors, Esc leaves the interior. (Number keys stay playback speed.)
// Deep links: #goto=xoyo flies there; #goto=encode&floor=1 opens the interior on that floor.
import { Building2, ChevronDown, ChevronUp, Construction, DoorOpen, Hotel, LogOut, MapPin, MoreHorizontal, Music, ShoppingBag, TrainFront } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "../state/data";
import { useTravel } from "../state/travel";
import { enterPlace, goPlace } from "../world/landmarks/actions";
import { LEVELS } from "../world/landmarks/floors";
import { placesFor, type Place } from "../world/landmarks/places";
import "./travel.css";

const ICONS: Record<string, typeof MapPin> = {
  encode: Building2,
  xoyo: Music,
  artotel: Hotel,
  oldstreet: MapPin,
  boxpark: ShoppingBag,
  station: TrainFront,
  goodsyard: Construction,
};
const iconFor = (p: Place) => ICONS[p.key] ?? (p.group === "clubs" ? Music : p.group === "stations" ? TrainFront : MapPin);

function parseHash() {
  const q = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const floor = q.get("floor");
  return { key: q.get("goto")?.toLowerCase() ?? null, floor: floor === null ? null : Number(floor), enter: q.has("enter") || floor !== null };
}

function writeHash(key: string | null, floor: number | null) {
  const h = key ? `#goto=${key}${floor !== null ? `&floor=${floor}` : ""}` : "";
  if (h !== window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search + h);
}

export function GoToBar() {
  const map = useMap().data ?? null;
  const list = useMemo(() => (map ? placesFor(map) : []), [map]);
  const main = list.filter((p) => p.group === "places");
  const more = list.filter((p) => p.group !== "places");
  const focus = useTravel((s) => s.focusPlace);
  const interiorOpen = useTravel((s) => s.interiorOpen);
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);

  // #goto= deep links, on load and when the hash is edited
  useEffect(() => {
    if (!list.length) return;
    const apply = () => {
      const h = parseHash();
      const p = h.key ? list.find((k) => k.key === h.key) : undefined;
      if (!p) return;
      if (h.enter && p.interior) enterPlace(p, h.floor !== null && Number.isFinite(h.floor) ? h.floor : undefined);
      else goPlace(p);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [list]);

  // keep the hash shareable
  useEffect(
    () =>
      useTravel.subscribe((s) => {
        if (s.focusPlace) writeHash(s.focusPlace, s.interiorOpen ? s.floor : null);
      }),
    [],
  );

  // floors and exit from the keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const t = useTravel.getState();
      if (e.key === "Escape" && menu) {
        setMenu(false);
        e.stopImmediatePropagation();
      } else if (!t.interiorOpen) return;
      else if (e.key === "PageUp" || e.key === "]") {
        e.preventDefault();
        t.stepFloor(1);
      } else if (e.key === "PageDown" || e.key === "[") {
        e.preventDefault();
        t.stepFloor(-1);
      } else if (e.key === "Escape") {
        t.exit();
        e.stopImmediatePropagation();
      }
    };
    // capture: runs before the playback hotkeys, so Esc leaves the interior without also closing panels
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!wrap.current?.contains(n) && !menuEl.current?.contains(n)) setMenu(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [menu]);

  return (
    <>
      <nav className="goto-bar" aria-label="Go to">
        <span className="goto-label">Go to</span>
        {main.map((p) => {
          const Icon = iconFor(p);
          const inside = interiorOpen && focus === p.key;
          return (
            <span key={p.key} className={`goto-item ${p.interior ? "has-enter" : ""}`}>
              <button
                className={`goto-btn ${p.key === "encode" ? "goto-hero" : ""} ${focus === p.key ? "on" : ""}`}
                title={`Fly to ${p.name} · ${p.sub}${p.outside ? " (outside map)" : ""}`}
                onClick={() => goPlace(p)}
              >
                <Icon size={15} /> {p.name}
                {p.outside && <span className="goto-out">outside map</span>}
              </button>
              {p.interior && (
                <button
                  className={`goto-enter ${inside ? "on" : ""}`}
                  title={inside ? `Leave ${p.name}` : `Go inside ${p.name}`}
                  aria-label={inside ? `Leave ${p.name}` : `Enter ${p.name}`}
                  onClick={() => (inside ? useTravel.getState().exit() : enterPlace(p))}
                >
                  {inside ? <LogOut size={14} /> : <DoorOpen size={14} />}
                </button>
              )}
            </span>
          );
        })}
        {more.length > 0 && (
          <div className="goto-more" ref={wrap}>
            <button className={`goto-btn ${menu ? "on" : ""}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <MoreHorizontal size={15} /> More
            </button>
          </div>
        )}
      </nav>
      {menu && (
        <div className="goto-menu panel" role="menu" ref={menuEl}>
          {(["clubs", "stations"] as const).map((g) => {
            const items = more.filter((p) => p.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="goto-group">
                <div className="goto-group-title">{g === "clubs" ? "Clubs" : "Stations"}</div>
                {items.map((p) => {
                  const Icon = iconFor(p);
                  return (
                    <div key={p.key} className="goto-row">
                      <button
                        className="goto-row-main"
                        role="menuitem"
                        onClick={() => {
                          goPlace(p);
                          setMenu(false);
                        }}
                      >
                        <Icon size={14} /> <span>{p.name}</span>
                        {p.outside && <span className="goto-out">outside map</span>}
                      </button>
                      {g === "clubs" && (
                        <button
                          className="goto-enter"
                          title={`Go inside ${p.name}`}
                          aria-label={`Enter ${p.name}`}
                          onClick={() => {
                            enterPlace(p);
                            setMenu(false);
                          }}
                        >
                          <DoorOpen size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      <FloorStepper list={list} />
    </>
  );
}

/** Floor picker for the open landmark interior (a strip above the playback bar): down/up, the floors, Exit. */
function FloorStepper({ list }: { list: Place[] }) {
  const open = useTravel((s) => s.interiorOpen);
  const key = useTravel((s) => s.focusPlace);
  const floor = useTravel((s) => s.floor);
  const place = list.find((p) => p.key === key);
  if (!open || !place?.interior) return null;
  const levels = LEVELS[place.interior];
  const t = useTravel.getState();
  return (
    <section className="floor-stepper panel" aria-label={`${place.name} floors`}>
      <header>
        <div>
          <div className="floor-place">{place.name}</div>
          <div className="floor-now">{levels[floor]?.label}</div>
        </div>
        <button className="btn floor-exit" onClick={() => t.exit()} title="Leave (Esc)">
          <LogOut size={14} /> Exit
        </button>
      </header>
      <div className="floor-row">
        <button className="floor-step" onClick={() => t.stepFloor(-1)} disabled={floor <= 0} aria-label="Floor down" title="Floor down (PgDn or [)">
          <ChevronDown size={16} />
        </button>
        <ol className="floor-list">
          {levels.map((l, i) => (
            <li key={i}>
              <button className={`floor-btn ${i === floor ? "on" : ""} ${i > floor ? "above" : ""}`} onClick={() => t.setFloor(i)} aria-current={i === floor} title={l.label}>
                <span className="floor-short">{l.short}</span>
              </button>
            </li>
          ))}
        </ol>
        <button className="floor-step" onClick={() => t.stepFloor(1)} disabled={floor >= levels.length - 1} aria-label="Floor up" title="Floor up (PgUp or ])">
          <ChevronUp size={16} />
        </button>
      </div>
      <div className="floor-hint">PgUp/PgDn or [ ] · Esc to leave</div>
    </section>
  );
}
