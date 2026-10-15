// Drop-in mount for the city feed: <CityFeedMount /> inside App's .overlay. Bottom-left, above the legend and
// playback bar; hidden in compare mode and while a left-side panel (History) is open.
import { useEconomy } from "../state/economy";
import { useSim } from "../state/store";
import { CityFeed } from "./CityFeed";

export function CityFeedMount() {
  const compare = useSim((s) => s.compare);
  const panel = useSim((s) => s.panel);
  const selected = useSim((s) => s.selectedStoreId);
  // narrow screens: the store card and the feed share the same space; the card wins
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  const person = useEconomy((s) => s.personId); // the life card uses the left column
  if (compare || person || panel === "history" || panel === "agents" || panel === "area" || (selected && narrow)) return null;
  return (
    <div className="city-feed-mount">
      <CityFeed />
    </div>
  );
}
