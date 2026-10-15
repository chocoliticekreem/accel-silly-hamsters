// What the OldStreet module (world/modules/OldStreet.tsx) owns, so other modules keep out of it.
// Contract coords (x east, z north). Footprints are from OpenStreetMap (public/areas/oldstreet.json).

/** Backend map buildings the OldStreet module replaces (White Collar Factory campus box b2159, Grind b431);
 * listed in areaKeepouts.ts REPLACED_BUILDINGS. */
export const OLD_STREET_HIDDEN_BUILDINGS = ["b2159", "b431"];

/** OSM ways the OldStreet module draws itself (for city-wide OSM bakers to skip): the White Collar Factory campus,
 * the station entrance pavilion, its lift houses, the Exit 2 stair house, Grind's kiosk, the public space
 * (former gyratory peninsula) and the Promenade of Light. */
export const OLD_STREET_OSM_WAYS = new Set([532318205, 157247473, 971020141, 971020142, 971973854, 694572327, 596678288]);

/** The junction's public realm, the sunken walk, Grind and Exit 4 (registered in areaKeepouts.ts). */
export const OLD_STREET_AREA: [number, number][] = [
  [-1012, 236], [-905, 212], [-870, 232], [-850, 288], [-880, 300], [-918, 324], [-930, 310], [-952, 307], [-975, 297], [-1012, 285],
];
/** White Collar Factory campus (OSM way 532318205). */
export const WHITE_COLLAR_AREA: [number, number][] = [
  [-917.8, 205.4], [-918.4, 211.7], [-919.4, 222.9], [-944.4, 239.9], [-947.0, 241.4], [-952.9, 241.2], [-956.3, 244.5],
  [-969.9, 241.9], [-972.2, 241.3], [-973.1, 239.9], [-970.4, 209.9], [-961.8, 206.6], [-957.8, 201.0], [-953.9, 203.7], [-951.8, 202.9],
];

/** Backend map streets that are pieces of the removed gyratory (wholly within 80 m of the junction): the
 * OldStreet module runs its own traffic on the real lanes there, so the Traffic module skips them. */
export const isOldGyratory = (s: { points: [number, number][] }) => s.points.every(([x, z]) => Math.hypot(x + 893, z - 258) < 80);
