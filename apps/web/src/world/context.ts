// What every 3D module can read: the map, which run this view shows, that run's store results,
// and a small mutable "live" bag modules use to share per-frame facts (never put per-frame data in React state).
import { createContext, useContext } from "react";
import type { CityMap, RunStores } from "../api/contract";

export interface Live {
  /** storeId → agents inside right now. Written by Agents, read by Stores. */
  occupancy: Map<string, number>;
  /** Agents visible on the street right now. */
  onStreet: number;
}

export interface WorldCtx {
  map: CityMap;
  run: number;
  stores: RunStores | undefined;
  /** Shared camera group (compare mode keeps both views on the same camera). */
  cameraGroup: string;
  live: Live;
  /** false in the secondary compare view: no picking there. */
  interactive: boolean;
}

export const WorldContext = createContext<WorldCtx | null>(null);

export function useWorld(): WorldCtx {
  const ctx = useContext(WorldContext);
  if (!ctx) throw new Error("useWorld must be used inside <World>");
  return ctx;
}

export const newLive = (): Live => ({ occupancy: new Map(), onStreet: 0 });
