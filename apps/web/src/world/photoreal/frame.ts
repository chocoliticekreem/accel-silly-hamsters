// Where the contract frame sits on the real Earth, and how Google 3D Tiles are mapped into it.
//
// Contract coords (backend/pipeline/osm_map.py): metres from the Shoreditch High Street railway=station node
// (OSM node/6991130547), equirectangular on a sphere of radius 6 371 008.8 m: x = east, z = north. Scene = toScene(x, z)
// = [x, -z], y up.
//
// Tiles chain: ECEF --ReorientationPlugin(lat0, lon0)--> object frame (origin at the station, +X west, +Y up, +Z north)
// --wrapper group: rotate π about Y--> +X east, -Z north (the scene). Then the wrapper scales X by R/N and Z by R/M
// (WGS84 prime-vertical / meridional radii at lat0), because the contract projection uses the mean sphere radius:
// without it, points 500 m out are ~1.6 m off east-west. Checked with the library's own WGS84 maths
// (Ellipsoid.getCartographicToPosition → object frame → wrapper) against the contract projection: the art'otel corner
// (x -530, z 320) lands within 4.4 cm, Shoreditch High St (x -207, z 17) within 4 mm, the map corner (500, 500) 5.5 cm.

export const GOOGLE_TILES_KEY: string | undefined = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || undefined;

/** Contract origin: Shoreditch High Street station (OSM node/6991130547), degrees. */
export const ORIGIN_LAT = 51.5232534;
export const ORIGIN_LON = -0.0744674;

/** Sphere radius the contract projection uses (osm_map.EARTH_RADIUS_M). */
export const EARTH_RADIUS = 6_371_008.8;
const R = EARTH_RADIUS;
const WGS84_A = 6_378_137;
const WGS84_E2 = 6.69437999014e-3;
const s2 = Math.sin((ORIGIN_LAT * Math.PI) / 180) ** 2;
const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s2);
const M = (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * s2, 1.5);

/** Wrapper scale so ellipsoidal metres match contract (spherical) metres: ≈ 0.99683 east-west, 0.99943 north-south. */
export const SCALE_X = R / N;
export const SCALE_Z = R / M;

/**
 * First guess at the WGS84 ellipsoid height of street level at the station: ~17 m above Ordnance Datum plus the
 * ~46 m geoid undulation in London. Refined at runtime from raycasts against the streets (Tiles.tsx).
 */
export const GROUND_ELLIPSOID_HEIGHT_GUESS = 63;
