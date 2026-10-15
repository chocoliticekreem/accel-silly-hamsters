// Real-world data for the hero landmarks (pure constants, shared by the model builders and the keep-out plots).

/** art'otel tower centre, OSM way 1561019538 (27 levels), contract coords (x east, z north). */
export const ARTOTEL_CENTRE = { x: -615.0, z: 336.2 };

/** art'otel podium wing, OSM way 1561019539 (3 levels): contract offsets (east, north) from the tower centre. */
export const ARTOTEL_PODIUM: [number, number][] = [
  [7.3, 24.3], [24.2, 28.2], [24.9, 26.2], [33.7, 28.1], [36.4, 15.2], [28.7, 14.4], [19.0, 12.9], [20.4, 8.2],
  [21.0, 4.0], [21.6, -1.9], [39.7, -0.8], [40.1, -13.9], [17.9, -14.9], [19.4, -10.0], [12.6, -7.1], [13.8, -3.0],
  [13.4, 2.3], [12.5, 7.4], [11.1, 11.4], [9.2, 14.2], [15.1, 17.5],
];

/** art'otel footprint as contract-offset rects: the oval tower (incl. its widest shelves) and the podium wing. */
export const ARTOTEL_FOOTPRINT = [
  { x0: -15.6, x1: 15.6, z0: -20.3, z1: 20.3 },
  { x0: 7.3, x1: 40.1, z0: -14.9, z1: 28.2 },
];
