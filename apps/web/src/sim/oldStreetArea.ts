// What the OldStreet module (world/modules/OldStreet.tsx) owns, so other modules keep out of it.
// Contract coords (x east, z north). Footprints are from OpenStreetMap (public/areas/oldstreet.json).

/** Backend map buildings the OldStreet module replaces with its own model (White Collar Factory campus box). */
export const OLD_STREET_HIDDEN_BUILDINGS = new Set(["b2159", "b431"]);

/** OSM ways the OldStreet module draws itself (for city-wide OSM bakers to skip): the White Collar Factory campus,
 * the station entrance pavilion, its lift houses, the Exit 2 stair house, Grind's kiosk, the public space
 * (former gyratory peninsula) and the Promenade of Light. */
export const OLD_STREET_OSM_WAYS = new Set([532318205, 157247473, 971020141, 971020142, 971973854, 694572327, 596678288]);

/** Axis-aligned keep-out rectangles (centre + size) for procedural infill: the peninsula, the promenade, the
 * sunken St Agnes Well walk and the White Collar Factory. */
export const OLD_STREET_KEEPOUTS: { x: number; z: number; w: number; d: number }[] = [
  { x: -916, z: 265, w: 62, d: 48 }, // peninsula + pavilion
  { x: -975, z: 268, w: 70, d: 26 }, // promenade + St Agnes Well
  { x: -945, z: 222, w: 58, d: 42 }, // White Collar Factory
  { x: -896, z: 280, w: 14, d: 12 }, // lift houses
];
