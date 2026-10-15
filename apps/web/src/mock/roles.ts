// The demo story's cast, found on whatever map the mock runs on: the late takeaway beside a club (the spill-out
// story), the off-licence by another club, the cafe by the station (the morning commute), a second late takeaway,
// and the club that runs till 04:00. On the schematic map these are its named stores (Kebab Co, Night Owl Offie,
// Arch Coffee, Late Pizza, The Vault); on the real map the nearest real stores of each type.
import type { Building, CityMap, Store, StoreType } from "../api/contract";

export interface DemoRoles {
  /** The takeaway nearest a club: the analyst keeps it open late for the club crowd. */
  takeaway: Store;
  /** The off-licence nearest another club. */
  offlicence: Store;
  /** The cafe nearest the station. */
  cafe: Store;
  /** Another takeaway that tries a late close. */
  lateTakeaway: Store | null;
  /** The club with a 04:00 licence close. */
  lateClub: Store | null;
}

const SCHEMATIC = { takeaway: "Kebab Co", offlicence: "Night Owl Offie", cafe: "Arch Coffee", lateTakeaway: "Late Pizza", lateClub: "The Vault" };

const cache = new WeakMap<CityMap, DemoRoles>();

export function demoRoles(map: CityMap): DemoRoles {
  const hit = cache.get(map);
  if (hit) return hit;
  const bOf = new Map(map.buildings.map((b) => [b.id, b]));
  const at = (s: Store): Building | undefined => bOf.get(s.buildingId);
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
  const named = (name: string) => map.stores.find((s) => s.name === name) ?? null;
  const ofType = (t: StoreType) => map.stores.filter((s) => s.type === t && at(s));
  const nearestTo = (t: StoreType, to: { x: number; z: number }, not: Store[] = []) =>
    ofType(t)
      .filter((s) => !not.includes(s))
      .sort((a, b) => dist(at(a)!, to) - dist(at(b)!, to) || a.id.localeCompare(b.id))[0] ?? null;
  const clubs = ofType("club");
  const station = map.entryPoints.find((e) => e.kind === "station") ?? { x: 0, z: 0 };

  // the takeaway closest to any club, and that club
  let takeaway: Store | null = named(SCHEMATIC.takeaway);
  let firstClub: Store | null = null;
  if (!takeaway) {
    let best = Infinity;
    for (const c of clubs) {
      const t = nearestTo("takeaway", at(c)!);
      if (t && dist(at(t)!, at(c)!) < best) [best, takeaway, firstClub] = [dist(at(t)!, at(c)!), t, c];
    }
  }
  takeaway ??= ofType("takeaway")[0] ?? map.stores.find((s) => s.type !== "club")!;
  const otherClubs = clubs.filter((c) => c !== firstClub);
  // the off-licence closest to another club
  let offlicence: Store | null = named(SCHEMATIC.offlicence);
  let secondClub: Store | null = null;
  if (!offlicence) {
    let best = Infinity;
    for (const c of otherClubs.length ? otherClubs : clubs) {
      const o = nearestTo("offlicence", at(c)!);
      if (o && dist(at(o)!, at(c)!) < best) [best, offlicence, secondClub] = [dist(at(o)!, at(c)!), o, c];
    }
  }
  offlicence ??= ofType("offlicence")[0] ?? takeaway;
  const cafe = named(SCHEMATIC.cafe) ?? nearestTo("cafe", station) ?? takeaway;
  const lateTakeaway = named(SCHEMATIC.lateTakeaway) ?? (firstClub || clubs[0] ? nearestTo("takeaway", at((secondClub ?? clubs[0])!)!, [takeaway]) : null);
  const lateClub = named(SCHEMATIC.lateClub) ?? secondClub ?? otherClubs[0] ?? null;
  const roles: DemoRoles = { takeaway, offlicence, cafe, lateTakeaway, lateClub };
  cache.set(map, roles);
  return roles;
}
