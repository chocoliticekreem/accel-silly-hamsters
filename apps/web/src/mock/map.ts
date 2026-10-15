// Schematic fallback map (mock/realMap.ts uses it only if data/processed/map.json is unusable; tests pin the story on
// it): a cartoon 500 m × 500 m Shoreditch on a street grid, in the exact map.json shape.
// ~25 stores, 2 clubs, 1 station, 4 street entry points. Seeded, so it's the same city every reload.
import type { Building, BuildingKind, CityMap, EntryPoint, Store, StoreType, Street } from "../api/contract";
import { frontage } from "../sim/geometry";
import { LANDMARK_FALLBACKS } from "../sim/london";
import { between, pick, rng } from "./rng";

export const HALF = 250;

/** Vertical (north-south) streets at x, horizontal (east-west) streets at z. */
export const V_STREETS = [
  { x: -180, id: "paul-st", name: "Paul St", width: 10 },
  { x: -90, id: "curtain-rd", name: "Curtain Rd", width: 10 },
  { x: 0, id: "shoreditch-high-st", name: "Shoreditch High St", width: 14 },
  { x: 90, id: "brick-ln", name: "Brick Ln", width: 10 },
  { x: 180, id: "club-row", name: "Club Row", width: 10 },
];
export const H_STREETS = [
  { z: -180, id: "hanbury-st", name: "Hanbury St", width: 10 },
  { z: -90, id: "redchurch-st", name: "Redchurch St", width: 10 },
  { z: 0, id: "bethnal-green-rd", name: "Bethnal Green Rd", width: 12 },
  { z: 90, id: "rivington-st", name: "Rivington St", width: 10 },
  { z: 180, id: "old-st", name: "Old St", width: 14 },
];

/** Streets where shops cluster. */
const HIGH_STREETS = new Set(["shoreditch-high-st", "brick-ln", "rivington-st", "bethnal-green-rd", "redchurch-st"]);

const STORE_NAMES: Record<Exclude<StoreType, "club">, string[]> = {
  cafe: ["Rivington Roast", "Flat White Co", "Arch Coffee", "Bagel House", "Morning Tram"],
  restaurant: ["Dishoom-ish", "Curry Corner", "Pasta Arches", "Smokehouse 9"],
  takeaway: ["Kebab Co", "Late Pizza", "Chicken Shack", "Noodle Box"],
  bar: ["The Owl & Lamp", "Neon Tap", "Rooftop 12", "Vinyl Bar"],
  shop: ["Vintage Rack", "Record Stop", "Print Shop", "Sneaker Lab", "Plant Room"],
  offlicence: ["Night Owl Offie", "Corner Offie", "Bottle & Co"],
};

const STORE_MIX: Exclude<StoreType, "club">[] = [
  ...Array<"cafe">(5).fill("cafe"),
  ...Array<"restaurant">(4).fill("restaurant"),
  ...Array<"takeaway">(4).fill("takeaway"),
  ...Array<"bar">(4).fill("bar"),
  ...Array<"shop">(5).fill("shop"),
  ...Array<"offlicence">(3).fill("offlicence"),
]; // 25

const STATION = { x: 24, z: -20, w: 32, d: 24, h: 9 };

function streetsOf(): Street[] {
  return [
    ...V_STREETS.map((s) => ({ id: s.id, name: s.name, width: s.width, points: [[s.x, -HALF], [s.x, HALF]] as [number, number][] })),
    ...H_STREETS.map((s) => ({ id: s.id, name: s.name, width: s.width, points: [[-HALF, s.z], [HALF, s.z]] as [number, number][] })),
  ];
}

interface Lot {
  x: number;
  z: number;
  w: number;
  d: number;
}

function overlaps(a: Lot, b: Lot, pad = 1) {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + pad * 2 && Math.abs(a.z - b.z) * 2 < a.d + b.d + pad * 2;
}

/** Fills each city block with rows of buildings facing its streets. */
function lots(r: () => number): Lot[] {
  const xs = [-HALF, ...V_STREETS.map((s) => s.x), HALF];
  const zs = [-HALF, ...H_STREETS.map((s) => s.z), HALF];
  const halfAt = (list: { width: number }[], i: number) => (i < 0 || i >= list.length ? -1 : list[i].width / 2 + 3);
  const out: Lot[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i] + Math.max(4, halfAt(V_STREETS, i - 1));
      const x1 = xs[i + 1] - Math.max(4, halfAt(V_STREETS, i));
      const z0 = zs[j] + Math.max(4, halfAt(H_STREETS, j - 1));
      const z1 = zs[j + 1] - Math.max(4, halfAt(H_STREETS, j));
      // blocks touching the two main north-south shopping streets face them; others face east-west streets
      const facesVertical = xs[i] === -90 || xs[i] === 0 || xs[i] === 90;
      const [a0, a1, b0, b1] = facesVertical ? [z0, z1, x0, x1] : [x0, x1, z0, z1];
      const depth = Math.min(18, (b1 - b0) / 2 - 1);
      for (const side of [0, 1]) {
        let a = a0;
        while (a < a1 - 8) {
          const len = Math.min(a1 - a, between(r, 12, 22));
          const dep = depth * between(r, 0.75, 1);
          const along = a + len / 2;
          const across = side === 0 ? b0 + dep / 2 : b1 - dep / 2;
          out.push(facesVertical ? { x: across, z: along, w: dep, d: len - 1 } : { x: along, z: across, w: len - 1, d: dep });
          a += len;
        }
      }
    }
  }
  return out;
}

export function generateMap(seed = 42): CityMap {
  const r = rng(seed);
  const streets = streetsOf();
  const station: Lot = STATION;
  const all = lots(r).filter((l) => !overlaps(l, station, 3));

  const buildings: Building[] = all.map((l, i) => ({ id: `b${i + 1}`, kind: "residential", x: round(l.x), z: round(l.z), w: round(l.w), d: round(l.d), h: 10 }));
  const front = new Map(buildings.map((b) => [b.id, frontage(b, streets)]));

  // offices up north (Old St tech), residential terraces elsewhere
  for (const b of buildings) {
    if (b.z > 100 && r() < 0.7) {
      b.kind = "office";
      b.h = round(between(r, 22, 42));
    } else {
      b.h = round(between(r, 9, 16));
    }
  }

  const stores: Store[] = [];
  const setStore = (b: Building, id: string, name: string, type: StoreType) => {
    b.kind = type === "club" ? "club" : "store";
    b.storeId = id;
    if (type === "club") b.h = round(between(r, 9, 12));
    else b.h = round(between(r, 8, 13));
    stores.push({ id, name, type, buildingId: b.id });
  };

  // two clubs: the biggest lots in two blocks near the station
  const biggestIn = (x0: number, x1: number, z0: number, z1: number) =>
    buildings
      .filter((b) => b.kind !== "store" && b.kind !== "club" && b.x > x0 && b.x < x1 && b.z > z0 && b.z < z1)
      .sort((a, b) => b.w * b.d - a.w * a.d)[0];
  const c1 = biggestIn(90, 180, -90, 0);
  const c2 = biggestIn(-90, 0, 0, 90);
  setStore(c1, "c1", "Basement 45", "club");
  setStore(c2, "c2", "The Vault", "club");

  // shop candidates: small lots on the shopping streets, not offices
  const candidates = buildings.filter(
    (b) => b.kind === "residential" && HIGH_STREETS.has(front.get(b.id)!.street.id) && Math.abs(b.x) < 200 && Math.abs(b.z) < 200,
  );
  const dist = (a: Building, b: Building) => Math.hypot(a.x - b.x, a.z - b.z);
  const take = (b: Building) => candidates.splice(candidates.indexOf(b), 1)[0];
  const nearest = (to: Building) => candidates.slice().sort((a, b) => dist(a, to) - dist(b, to))[0];

  // the demo story: a dark takeaway right next to each club
  const names = Object.fromEntries(Object.entries(STORE_NAMES).map(([k, v]) => [k, [...v]])) as Record<string, string[]>;
  const nextName = (t: string) => names[t].shift() ?? `${t} ${stores.length}`;
  const mix = [...STORE_MIX];
  const use = (type: Exclude<StoreType, "club">, b: Building, name?: string) => {
    mix.splice(mix.indexOf(type), 1);
    if (name) names[type].splice(names[type].indexOf(name), 1);
    setStore(take(b), `s${stores.length - 1}`, name ?? nextName(type), type);
  };
  use("takeaway", nearest(c1), "Kebab Co");
  use("offlicence", nearest(c2), "Night Owl Offie");
  // a cafe by the station for the morning commute
  const stationB = { ...STATION, id: "_", kind: "station" as BuildingKind };
  use("cafe", nearest(stationB), "Arch Coffee");

  // the rest spread out: alternate picks so stores don't all clump on one street
  while (mix.length && candidates.length) {
    const type = mix[0];
    const b = pick(r, candidates);
    if (stores.some((s) => dist(buildings.find((x) => x.id === s.buildingId)!, b) < 18) && r() < 0.8) continue;
    use(type, b);
  }

  buildings.push({ id: "b-station", kind: "station", x: STATION.x, z: STATION.z, w: STATION.w, d: STATION.d, h: STATION.h });

  const entryPoints: EntryPoint[] = [
    { id: "e1", kind: "street", x: 0, z: HALF },
    { id: "e2", kind: "street", x: 0, z: -HALF },
    { id: "e3", kind: "street", x: -HALF, z: 0 },
    { id: "e4", kind: "street", x: HALF, z: 90 },
    { id: "st1", kind: "station", name: "Shoreditch High St", x: 0, z: 0 },
  ];

  // the real-world landmarks just outside the cartoon map (art'otel, Encode Hub), so the landmark layers have data
  const landmarks = LANDMARK_FALLBACKS.filter((l) => l.kind !== "station");
  return { bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF }, streets, buildings, stores, entryPoints, landmarks };
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
