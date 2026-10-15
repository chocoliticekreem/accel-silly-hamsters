// Sim agents that enter or leave by a street on the map edge walk in from / out to the city beyond (sim/edges.ts).
import { useMemo } from "react";
import type { CityMap } from "../api/contract";
import { extendAgentEdges } from "../sim/edges";
import type { PreparedAgent } from "../sim/interp";

export function useEdgeAgents(agents: PreparedAgent[], map: CityMap): PreparedAgent[] {
  return useMemo(() => extendAgentEdges(agents, map), [agents, map]);
}
