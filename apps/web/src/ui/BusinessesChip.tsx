// Filter chip: show / hide the signs of the real businesses the sim doesn't model (world/modules/Businesses).
import { Store } from "lucide-react";
import { isPoi, useBusinesses, useBusinessList } from "../state/businesses";
import { useMap } from "../state/data";
import { fmtInt } from "./format";
import "./business.css";

/** How many real businesses have a sign (sim stores and landmarks excluded). */
export function useBusinessCount() {
  const map = useMap().data;
  return useBusinessList(map).list.filter(isPoi).length;
}

export function BusinessesChip() {
  const show = useBusinesses((s) => s.show);
  const n = useBusinessCount();
  if (!n) return null;
  return (
    <button
      className={`chip ${show ? "on" : ""}`}
      aria-pressed={show}
      title={`${show ? "Hide" : "Show"} the ${fmtInt(n)} real businesses the sim doesn't model (click a sign for its card)`}
      onClick={() => useBusinesses.getState().setShow(!show)}
    >
      <Store size={14} /> Businesses <span className="chip-count">{fmtInt(n)}</span>
    </button>
  );
}

/** The Go-to "More" menu's Businesses group: the count, and a switch for their signs. */
export function BusinessesMenuRow() {
  const show = useBusinesses((s) => s.show);
  const n = useBusinessCount();
  if (!n) return null;
  return (
    <div className="goto-group">
      <div className="goto-group-title">Businesses</div>
      <div className="goto-row">
        <button className="goto-row-main" role="menuitemcheckbox" aria-checked={show} onClick={() => useBusinesses.getState().setShow(!show)}>
          <Store size={14} /> <span>{fmtInt(n)} real shops, cafés and pubs</span>
          <span className="goto-out">{show ? "signs on" : "signs off"}</span>
        </button>
      </div>
    </div>
  );
}
