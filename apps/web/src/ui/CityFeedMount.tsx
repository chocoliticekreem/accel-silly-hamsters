// Drop-in mount for the city feed: <CityFeedMount /> inside App's .overlay. Bottom-left, above the legend and
// playback bar; hidden in compare mode and while a left-side panel (History) is open.
import { useSim } from "../state/store";
import { CityFeed } from "./CityFeed";

export function CityFeedMount() {
  const compare = useSim((s) => s.compare);
  const panel = useSim((s) => s.panel);
  if (compare || panel === "history") return null;
  return (
    <div className="city-feed-mount">
      <CityFeed />
    </div>
  );
}
