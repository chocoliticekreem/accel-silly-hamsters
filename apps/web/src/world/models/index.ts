// Hero model catalog: every procedural hero model by name, with the facts a consumer needs (what it is, real
// size, which named nodes animate, which slot to tint). Builders are pure (no DOM) and cached per name; signs
// paint their canvases lazily in materials.ts. People are not here: see people.ts (instanced + shader-animated).
//
// Import directly from other modules:
//   import { heroModel, HERO_CATALOG } from "../models";        // geometry + metadata
//   import { heroObject, heroMaterials, setHeroNight } from "../models/materials";
//   import { flatten } from "../models/kit";                     // one geometry per slot, for InstancedMesh
import type { HeroModel } from "./kit";
import { artotel, boxpark, encodeHub, oldStreet, xoyo } from "./landmarks";
import { busStop, k6Box, planeTree, roundelSign, towerCrane } from "./street";
import { ambulance, blackCab, deliveryVan, flatbedLorry, overgroundCar, policeCar, routemaster } from "./vehicles";

export type HeroKind = "vehicle" | "landmark" | "street";

export interface HeroEntry {
  kind: HeroKind;
  build: () => HeroModel;
  label: string;
  /** Named child nodes and what to do with them. */
  nodes: Record<string, string>;
  /** Which slot to recolour per instance (via repaint() on a clone, or white + instanceColor). */
  tint?: string;
}

const WHEELS = { "wheel*": "rotate about local x by distance / radius" };

export const HERO_CATALOG: Record<string, HeroEntry> = {
  routemaster: { kind: "vehicle", build: routemaster, label: "New Routemaster (NB4L) bus", nodes: WHEELS },
  "black-cab": { kind: "vehicle", build: () => blackCab(), label: "LEVC TX black cab", nodes: WHEELS, tint: "paint" },
  "police-car": { kind: "vehicle", build: policeCar, label: "Met Police estate", nodes: { ...WHEELS, "lampL/lampR": "flash alternately (toggle visible or scale)" } },
  ambulance: { kind: "vehicle", build: ambulance, label: "LAS ambulance", nodes: { ...WHEELS, "lampL/lampR/lampRearL/lampRearR": "flash" } },
  "overground-378-cab": { kind: "vehicle", build: () => overgroundCar({ cab: true }), label: "Overground Class 378 driving car", nodes: { "door{L|R}{0-2}{a|b}": "slide ±0.8 m along z (a toward +z)" } },
  "overground-378": { kind: "vehicle", build: () => overgroundCar({ cab: false }), label: "Overground Class 378 intermediate car", nodes: { "door{L|R}{0-2}{a|b}": "slide ±0.8 m along z" } },
  "delivery-van": { kind: "vehicle", build: () => deliveryVan(), label: "Panel van", nodes: WHEELS, tint: "paint" },
  "flatbed-lorry": { kind: "vehicle", build: () => flatbedLorry(), label: "Flatbed lorry with pallets", nodes: WHEELS, tint: "paint" },
  "landmark-xoyo": { kind: "landmark", build: xoyo, label: "XOYO, Cowper St", nodes: {} },
  "landmark-artotel": { kind: "landmark", build: artotel, label: "art'otel London Hoxton", nodes: {} },
  "landmark-encode": { kind: "landmark", build: encodeHub, label: "Encode Hub, 41 Pitfield St", nodes: {} },
  "landmark-boxpark": { kind: "landmark", build: boxpark, label: "Boxpark Shoreditch", nodes: {} },
  "landmark-oldstreet": { kind: "landmark", build: oldStreet, label: "Old Street roundabout + station", nodes: {} },
  "k6-phone-box": { kind: "street", build: k6Box, label: "K6 telephone box", nodes: {} },
  "tube-roundel": { kind: "street", build: () => roundelSign(), label: "Station roundel on a post", nodes: {} },
  "bus-stop": { kind: "street", build: busStop, label: "TfL bus shelter + flag", nodes: {} },
  "plane-tree": { kind: "street", build: () => planeTree(1), label: "London plane tree", nodes: {} },
  "tower-crane": { kind: "street", build: () => towerCrane(), label: "Tower crane", nodes: { slew: "rotate about y" } },
};

export type HeroName = keyof typeof HERO_CATALOG;

const cache = new Map<string, HeroModel>();

/** Build (once) and return a hero model by catalog name. */
export function heroModel(name: string): HeroModel {
  let m = cache.get(name);
  if (!m) {
    const e = HERO_CATALOG[name];
    if (!e) throw new Error(`unknown hero model: ${name}`);
    cache.set(name, (m = e.build()));
  }
  return m;
}

/** Triangle count (all slots + nodes) for budgeting. */
export function heroTris(m: HeroModel): number {
  let n = 0;
  const count = (g?: { getAttribute: (k: string) => { count: number } }) => (n += g ? g.getAttribute("position").count / 3 : 0);
  Object.values(m.parts).forEach(count);
  m.nodes.forEach((x) => Object.values(x.parts).forEach(count));
  return Math.round(n + m.signs.length * 2);
}

export * from "./kit";
export { heroMaterials, heroObject, setHeroNight } from "./materials";
export * from "./people";
export { LANDMARKS } from "./landmarks";
export { drawBusStop, drawCycleDock, drawK6, drawPlaneTree, drawRoundelPanel, drawRoundelPost } from "./street";
export { ambulance, blackCab, deliveryVan, flatbedLorry, overgroundCar, policeCar, routemaster } from "./vehicles";
