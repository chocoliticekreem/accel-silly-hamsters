// Land that a hand-built area module draws itself, so the procedural Infill leaves it empty (contract coords, axis-
// aligned rects: centre x/z, size w/d). Read by sim/infill.ts when it rasterises the map (real map only).
//
// Bishopsgate Goodsyard (OSM landuse=construction "The Goodsyard", way 387346794): the fenced site south of
// Shoreditch High Street station with the listed Braithwaite Viaduct across it (world/modules/ShoreditchStation).
// Its north edge is taken up to the station box (world/shoreditch/area.ts does the same to the hoarding line).
export const AREA_KEEPOUTS: { x: number; z: number; w: number; d: number }[] = [
  // west yard, between Shoreditch High Street and Braithwaite Street, up to the station
  { x: -117, z: -51, w: 134, d: 82 },
  // the strip along Shoreditch High Street, up to the viaduct
  { x: -191.5, z: -21, w: 17, d: 62 },
  // east of Braithwaite Street: under the station's south side, then the band to Brick Lane
  { x: 3, z: -20, w: 106, d: 20 },
  { x: 15, z: -52, w: 130, d: 44 },
  { x: 137, z: -44, w: 114, d: 30 },
];
