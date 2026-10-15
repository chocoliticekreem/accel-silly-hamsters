// Every real business in the map (public/city/pois.json, baked from OSM by scripts/bake-pois.mjs) that the sim
// doesn't model, plus the landmarks (Encode Hub, art'otel, Boxpark) until the backend simulates them. Clicking one
// opens ui/BusinessCard with its details and an *estimated* electricity profile (sim/businessEnergy).
// Sim stores always win: a POI matching a map.stores entry (osmId, else same name within 30 m) is dropped, a
// landmark whose building already holds a sim store opens that store's card, and selecting a sim store clears this.
import { create } from "zustand";
import type { CityMap, StoreType } from "../api/contract";
import { clampArea, unitHours, type EnergyUnit } from "../sim/businessEnergy";
import { landmarkPlots, type HeroLandmarkKey } from "../world/models/plots";
import { useSim } from "./store";
import { useTravel } from "./travel";

export interface Business {
  /** OSM id ("node/123") or "landmark:<key>". */
  id: string;
  name: string;
  /** OSM category: "cafe", "pub", "shop:clothes"… or "landmark". */
  osmType: string;
  /** Human label: "Pub", "Clothes shop", "Coworking venue". */
  label: string;
  /** Closest sim store type (icon, colour and energy factors). */
  cat: StoreType;
  /** Contract coords (x east, z north). */
  x: number;
  z: number;
  /** Outward facade normal, contract frame radians (atan2(nz, nx)); null = free-standing. */
  angle: number | null;
  hours: string;
  website: string;
  cuisine: string;
  address: string;
  /** Energy units (one for a shop; several for a landmark). */
  units: EnergyUnit[];
  /** Short line under the name for landmarks. */
  sub?: string;
  /** Landmark whose building holds several sim stores: the card lists them (each opens its own store card). */
  simStores?: { id: string; name: string; type: StoreType }[];
}

const AMENITY: Record<string, [string, StoreType]> = {
  cafe: ["Café", "cafe"],
  restaurant: ["Restaurant", "restaurant"],
  fast_food: ["Fast food", "takeaway"],
  bar: ["Bar", "bar"],
  pub: ["Pub", "bar"],
  nightclub: ["Nightclub", "club"],
};
const SHOP_LABEL: Record<string, string> = {
  yes: "Shop", convenience: "Convenience store", supermarket: "Supermarket", hairdresser: "Hairdresser", beauty: "Beauty salon",
  clothes: "Clothes shop", alcohol: "Off-licence", wine: "Wine merchant", bakery: "Bakery", pastry: "Pâtisserie", jewelry: "Jeweller",
  optician: "Optician", newsagent: "Newsagent", florist: "Florist", books: "Bookshop", mall: "Market", dry_cleaning: "Dry cleaner",
  massage: "Massage", tattoo: "Tattoo studio", mobile_phone: "Phone shop", deli: "Deli", butcher: "Butcher", greengrocer: "Greengrocer",
  chemist: "Chemist", second_hand: "Second-hand shop", charity: "Charity shop", furniture: "Furniture shop", art: "Art shop",
};

export function describeType(t: string): [string, StoreType] {
  if (AMENITY[t]) return AMENITY[t];
  const shop = t.replace(/^shop:/, "");
  if (shop === "alcohol" || shop === "wine") return [SHOP_LABEL[shop], "offlicence"];
  const words = shop.replace(/_/g, " ");
  return [SHOP_LABEL[shop] ?? `${words[0].toUpperCase()}${words.slice(1)} shop`, "shop"];
}

type Row = [string, string, number, number, number, number | null, string, string, string, string, number, number];
interface Baked {
  types: string[];
  p: Row[];
  attribution: string;
}

interface BusinessState {
  status: "idle" | "loading" | "ready" | "missing";
  raw: Business[];
  /** Markers drawn (the filter chip). */
  show: boolean;
  selected: string | null;
  hovered: string | null;
  setShow: (v: boolean) => void;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
}

const SHOW_KEY = "scs.businesses.show";
const readShow = () => {
  try {
    return localStorage.getItem(SHOW_KEY) !== "0";
  } catch {
    return true;
  }
};

export const useBusinesses = create<BusinessState>((set) => ({
  status: "idle",
  raw: [],
  show: readShow(),
  selected: null,
  hovered: null,
  setShow: (show) => {
    try {
      localStorage.setItem(SHOW_KEY, show ? "1" : "0");
    } catch {
      /* not remembered */
    }
    set(show ? { show } : { show, hovered: null });
  },
  select: (selected) => {
    // one card at a time: a business card replaces the sim store card
    if (selected && useSim.getState().selectedStoreId) useSim.getState().selectStore(null);
    set({ selected });
  },
  hover: (hovered) => set({ hovered }),
}));

function decode(b: Baked): Business[] {
  return b.p.map((r) => {
    const osmType = b.types[r[2]];
    const [label, cat] = describeType(osmType);
    const { week, typicalHours } = unitHours(cat, r[6]);
    return {
      id: r[0],
      name: r[1],
      osmType,
      label,
      cat,
      x: r[3] / 10,
      z: r[4] / 10,
      angle: r[5] === null ? null : r[5] / 1000,
      hours: r[6],
      website: r[7],
      cuisine: r[8],
      address: r[9],
      units: [{ name: r[1], type: cat, areaM2: clampArea(r[10]), week, typicalHours }],
    };
  });
}

export function loadBusinesses() {
  if (useBusinesses.getState().status !== "idle") return;
  useBusinesses.setState({ status: "loading" });
  fetch(`${import.meta.env.BASE_URL}city/pois.json`)
    .then((res) => {
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) throw new Error(`pois.json: ${res.status}`);
      return res.json() as Promise<Baked>;
    })
    .then((b) => useBusinesses.setState({ status: "ready", raw: decode(b) }))
    .catch((e) => {
      console.warn("business list unavailable:", e);
      useBusinesses.setState({ status: "missing" });
    });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Landmarks the sim doesn't model yet, as businesses with estimated units. */
function landmarkBusinesses(map: CityMap, pois: Business[]): Business[] {
  const out: Business[] = [];
  for (const p of landmarkPlots(map)) {
    if (p.key === "xoyo") continue; // a sim club already
    const host = p.hostId ? map.buildings.find((b) => b.id === p.hostId) : undefined;
    const footprint = p.w * p.d;
    const sims = p.hostId ? map.stores.filter((s) => s.buildingId === p.hostId) : [];
    // one sim store: its own card opens instead (see the travel hook below)
    if (sims.length === 1) continue;
    const simStores = sims.length > 1 ? sims.map((s) => ({ id: s.id, name: s.name, type: s.type })) : undefined;
    const base = { id: `landmark:${p.key}`, osmType: "landmark", x: p.x, z: p.z, angle: null, website: "", cuisine: "", simStores };
    if (p.key === "encode") {
      const levels = Math.max(1, Math.round((host?.h ?? 19) / 4));
      const h = unitHours("shop", "Mo-Fr 09:00-22:00; Sa-Su 10:00-20:00");
      out.push({
        ...base, name: "Encode Hub", label: "Coworking venue", cat: "cafe", sub: "Hackathon venue · 41 Pitfield St",
        hours: "Mo-Fr 09:00-22:00; Sa-Su 10:00-20:00", address: "41 Pitfield Street, N1 6DA",
        // office-like load: the shop factor (ND-NEED shops ~ offices); every floor is in use
        units: [{ name: "Coworking floors", type: "shop", areaM2: Math.round(footprint * levels), week: h.week, typicalHours: true },
          { name: "Café", type: "cafe", areaM2: 60, ...unitHours("cafe", "Mo-Fr 08:00-17:00") }],
      });
    } else if (p.key === "artotel") {
      out.push({
        ...base, name: "art'otel London Hoxton", label: "Hotel restaurant & rooftop bar", cat: "restaurant", sub: "Hotel tower · Old St",
        hours: "Mo-Su 07:00-23:00", address: "1-3 Rivington Street, EC2A 3DT",
        // simulated already (restaurant + rooftop bar as sim stores): nothing left to estimate
        units: simStores ? [] : [
          { name: "Ground-floor restaurant", type: "restaurant", areaM2: clampArea(footprint * 0.6), ...unitHours("restaurant", "Mo-Su 07:00-23:00") },
          { name: "Rooftop bar", type: "bar", areaM2: 250, ...unitHours("bar", "Mo-Th 17:00-24:00; Fr-Sa 17:00-02:00; Su 17:00-23:00") },
        ],
      });
    } else if (p.key === "boxpark") {
      // the market = its traders: every POI on the plot
      const r = Math.max(p.w, p.d) / 2 + 6;
      const traders = pois.filter((b) => Math.hypot(b.x - p.x, b.z - p.z) < r && b.osmType !== "shop:mall");
      const units = traders.length ? traders.map((t) => ({ ...t.units[0], areaM2: 30 })) : [{ name: "Traders", type: "takeaway" as StoreType, areaM2: footprint, ...unitHours("takeaway", "") }];
      out.push({
        ...base, name: "Boxpark Shoreditch", label: "Container market", cat: "takeaway", sub: `${traders.length || "Many"} traders · Bethnal Green Rd`,
        hours: "Mo-Sa 08:00-23:00; Su 10:00-22:00", address: "2-10 Bethnal Green Road, E1 6GY", units,
      });
    }
  }
  return out;
}

let cache: { map: CityMap | null; raw: Business[] | null; list: Business[]; byId: Map<string, Business> } = { map: null, raw: null, list: [], byId: new Map() };

/** POIs minus sim stores, plus unsimulated landmarks (memoised per map + bake). */
export function businessesFor(map: CityMap, raw: Business[]): { list: Business[]; byId: Map<string, Business> } {
  if (cache.map === map && cache.raw === raw) return cache;
  const osm = new Set(map.stores.flatMap((s) => (s.osmId ? [s.osmId] : [])));
  const bById = new Map(map.buildings.map((b) => [b.id, b]));
  const named = map.stores.flatMap((s) => {
    const b = bById.get(s.buildingId);
    return b ? [{ n: norm(s.name), x: b.x, z: b.z }] : [];
  });
  const pois = raw.filter((p) => !osm.has(p.id) && !named.some((s) => s.n === norm(p.name) && Math.hypot(s.x - p.x, s.z - p.z) < 30));
  const list = [...pois, ...landmarkBusinesses(map, pois)];
  cache = { map, raw, list, byId: new Map(list.map((b) => [b.id, b])) };
  return cache;
}

/** Map POIs only (no landmarks): what the markers draw. */
export const isPoi = (b: Business) => b.osmType !== "landmark";

/** The visible list for a map; starts the load on first use. */
export function useBusinessList(map: CityMap | null | undefined) {
  const raw = useBusinesses((s) => s.raw);
  if (useBusinesses.getState().status === "idle") queueMicrotask(loadBusinesses);
  return map ? businessesFor(map, raw) : { list: [], byId: new Map<string, Business>() };
}

// selecting a sim store closes the business card
useSim.subscribe((s, prev) => {
  if (s.selectedStoreId && s.selectedStoreId !== prev.selectedStoreId && useBusinesses.getState().selected) useBusinesses.setState({ selected: null });
});

/** Map for the landmark hook below (set by the card while mounted). */
export const landmarkMap: { current: CityMap | null } = { current: null };

// going to (or into) a landmark the sim doesn't model opens its estimate card (on a map without landmark stores)
useTravel.subscribe((s, prev) => {
  if (s.focusPlace === prev.focusPlace && s.interiorOpen === prev.interiorOpen) return;
  const key = s.focusPlace as HeroLandmarkKey | null;
  if (!key || !["encode", "artotel", "boxpark"].includes(key) || !landmarkMap.current) return;
  if (s.focusPlace === prev.focusPlace && !s.interiorOpen) return; // leaving the interior keeps whatever is open
  const map = landmarkMap.current;
  const plot = landmarkPlots(map).find((p) => p.key === key);
  const here = plot?.hostId ? map.stores.filter((st) => st.buildingId === plot.hostId) : [];
  // sim stores there: goPlace / enterPlace open the place's store card (world/landmarks/actions)
  if (!here.length) useBusinesses.getState().select(`landmark:${key}`);
});
