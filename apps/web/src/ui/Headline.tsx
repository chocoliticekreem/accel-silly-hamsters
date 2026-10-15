// The day's headline, under the clock (docs/PEOPLE_ECONOMY.md "A journalist writes the day's headline").
// One line per sim day from GET /api/runs/{run}/headlines; hidden when the backend doesn't serve them.
import { Newspaper } from "lucide-react";
import { dayOf } from "../sim/time";
import { useHeadlines } from "../state/economy";
import { useSim } from "../state/store";
import "./economy.css";

export function Headline() {
  const run = useSim((s) => s.run);
  const day = useSim((s) => dayOf(s.t));
  const compare = useSim((s) => s.compare);
  const h = useHeadlines(compare ? null : run).data?.find((x) => x.day === day);
  if (!h) return null;
  return (
    <div className="headline panel" role="status" aria-live="polite" key={`${run}:${day}`}>
      <span className="headline-mast">
        <Newspaper size={13} /> Shoreditch Daily · {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][(day - 1) % 7]}
      </span>
      <p>{h.text}</p>
    </div>
  );
}
