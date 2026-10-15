// Response routes for the 3D incident layer, computed once per map + incident list and shared by the Police and
// Incidents modules (cars drive them; officers step out when the car arrives).
import { useMemo } from "react";
import type { CityMap, Street } from "../../api/contract";
import type { Incident } from "../../api/incidents";
import { closestOnStreet } from "../../sim/geometry";
import { driveMinutes, makeRoute, policeBase, policeRoute, type Route } from "../../sim/incidents";
import { buildStreetGraph, type StreetGraph } from "../../sim/streetGraph";

export interface Response {
  incident: Incident;
  police: Route | null;
  ambulance: Route | null;
  /** Minutes until the first police car is on scene. */
  policeArrive: number;
  ambulanceArrive: number;
  /** Chases: the pursuit route and how long it lasts (sim minutes). */
  chase: { route: Route; minutes: number } | null;
}

const graphs = new WeakMap<CityMap, StreetGraph>();
export function graphFor(map: CityMap): StreetGraph {
  let g = graphs.get(map);
  if (!g) graphs.set(map, (g = buildStreetGraph(map.streets)));
  return g;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Ambulances come in from the east (towards the Royal London Hospital). */
const ambulanceBase = (b: CityMap["bounds"]): [number, number] => [b.maxX, b.minZ + (b.maxZ - b.minZ) * 0.45];

export function responsesFor(map: CityMap, incidents: readonly Incident[]): Response[] {
  const g = graphFor(map);
  const base = policeBase(map.bounds);
  const amb = ambulanceBase(map.bounds);
  return incidents.map((i) => {
    const to: [number, number] = [i.x, i.z];
    let chase: Response["chase"] = null;
    let police: Route | null = null;
    if (i.kind === "chase" && i.from) {
      // a longer pursuit: from the edge, through a detour node, to the stop
      const routable = g.nodes.map((_, n) => n).filter((n) => g.adj[n].length >= 3);
      const via = routable.length ? g.nodes[routable[hash(i.id) % routable.length]] : to;
      const a = policeRoute(g, [i.from.x, i.from.z], via);
      const b = policeRoute(g, via, to);
      const route = makeRoute([...a.points, ...b.points.slice(1)]);
      chase = { route, minutes: Math.max(6, Math.min(14, route.length / 160)) };
    } else if (i.response.police) police = policeRoute(g, base, to);
    const ambulance = i.response.ambulance ? policeRoute(g, amb, to) : null;
    return {
      incident: i,
      police,
      ambulance,
      policeArrive: chase ? chase.minutes : police ? driveMinutes(police) : 0,
      ambulanceArrive: ambulance ? driveMinutes(ambulance) + 2 : 0,
      chase,
    };
  });
}

export function useResponses(map: CityMap, incidents: readonly Incident[] | undefined): Response[] {
  return useMemo(() => responsesFor(map, incidents ?? []), [map, incidents]);
}

/** Contract heading (atan2(dx, dz)) of the street through (x, z): along its nearest segment. */
export function streetHeading(street: Street | undefined, x: number, z: number): number {
  if (!street) return 0;
  let best = { d: Infinity, h: 0 };
  for (let k = 0; k < street.points.length - 1; k++) {
    const seg = { ...street, points: [street.points[k], street.points[k + 1]] as [number, number][] };
    const d = closestOnStreet(seg, x, z)[2];
    if (d < best.d) best = { d, h: Math.atan2(street.points[k + 1][0] - street.points[k][0], street.points[k + 1][1] - street.points[k][1]) };
  }
  return best.h;
}
