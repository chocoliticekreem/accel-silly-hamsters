// Google Photorealistic 3D Tiles for the Photoreal module (lazy-loaded: only fetched in Photoreal mode).
// - Streams https://tile.googleapis.com/v1/3dtiles/root.json (GoogleCloudAuthPlugin handles the session + key).
// - Reorients the globe so the station is the origin, then maps it onto the contract frame (frame.ts).
// - Calibrates street level: raycasts the road surface at every street sample (lowest hit, so railway bridges over
//   the road don't count), sets y = 0 at the median street height near the station and publishes per-point heights
//   to world/ground.ts so people and cars stand on the real tarmac.
// - Hides the visible store boxes (picking still raycasts them; R3F only tests objects with handlers, never tiles),
//   keeps their glow pools / beacons / labels, darkens the photo texture at night so the sim's lights read.
// - Shows Google's required attribution over the canvas while on.
// - Any failure (bad key, API not enabled, quota) drops back to the stylised city with a toast.
import { TilesAttributionOverlay, TilesPlugin, TilesRenderer } from "3d-tiles-renderer/r3f";
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TilesFadePlugin, UpdateOnChangePlugin } from "3d-tiles-renderer/plugins";
import type { TilesRenderer as TilesImpl } from "3d-tiles-renderer/three";
import { useFrame, useThree } from "@react-three/fiber";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Color, MeshBasicMaterial, Raycaster, Vector3, type Group, type Material, type Mesh, type Object3D, type PerspectiveCamera } from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { CityMap } from "../../api/contract";
import { toScene } from "../../sim/geometry";
import { nightLevel } from "../../sim/sky";
import { hourOf } from "../../sim/time";
import { useSim } from "../../state/store";
import { groundField, groundY } from "../ground";
import { GROUND_ELLIPSOID_HEIGHT_GUESS, ORIGIN_LAT, ORIGIN_LON, SCALE_X, SCALE_Z } from "./frame";

const DEG = Math.PI / 180;
const DRACO_PATH = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";
const BASIS_PATH = "https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/basis/";

// Performance (target ≥ 40 fps on a MacBook): Google's recommended screen-space error, a bounded cache, short fades.
const ERROR_TARGET = 20;
const CACHE = { minSize: 1200, maxSize: 2400, minBytesSize: 220 * 2 ** 20, maxBytesSize: 380 * 2 ** 20 };
const FAR = 12_000; // tiles to the horizon (stylised mode uses 4 km)
const MIN_DIST = 40; // below this the street-level photogrammetry turns to mush
const MAX_DIST = 900;

// Street-level calibration
const SAMPLE_STEP = 6; // m along each street
const PAVEMENT_OFFSET = 2.5; // m beyond the carriageway edge
const CALIBRATION_RADIUS = 160; // m around the station used for the y = 0 datum
const RAYS_FAST = 24; // per frame until the first pass is done
const RAYS_SLOW = 6; // afterwards: keep refining as better tiles stream in

const NIGHT_TINT = new Color(0.17, 0.2, 0.32);
const WHITE = new Color(1, 1, 1);

interface Props {
  apiKey: string;
  map: CityMap;
}

export default function Tiles(props: Props) {
  return (
    <Fallback>
      <TilesInner {...props} />
    </Fallback>
  );
}

function fallBackToStylised(reason: string) {
  const s = useSim.getState();
  if (s.graphicsMode !== "photoreal") return;
  console.warn("[photoreal]", reason);
  s.setGraphicsMode("stylised");
  s.showToast("Photoreal tiles unavailable: check the Google Maps key and that the Map Tiles API is enabled");
}

class Fallback extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    fallBackToStylised(String(error));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function TilesInner({ apiKey, map }: Props) {
  const gl = useThree((s) => s.gl);
  const [tiles, setTiles] = useState<TilesImpl | null>(null);
  const wrapper = useRef<Group>(null);

  const loaders = useMemo(() => {
    const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
    const ktx = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(gl);
    return { draco, ktx };
  }, [gl]);
  useEffect(() => () => {
    loaders.draco.dispose();
    loaders.ktx.dispose();
  }, [loaders]);

  // renderer tuning (set on the instance: typed, and after the auth plugin's own defaults)
  useEffect(() => {
    if (!tiles) return;
    tiles.errorTarget = ERROR_TARGET;
    Object.assign(tiles.lruCache, CACHE);
  }, [tiles]);

  useCameraLimits();
  const tint = useNightTint(tiles);
  useStreetLevel(tiles, wrapper, map);
  useStoreBodiesHidden();

  // give up gracefully: the root failing means a bad key / API not enabled; a burst of failures before anything shows, quota
  const errors = useRef(0);
  const onLoadError = (e: { tile: unknown; error: Error; url: string | URL }) => {
    errors.current++;
    if (e.tile === null || (errors.current >= 8 && !(tiles && tiles.visibleTiles.size > 0))) fallBackToStylised(`${e.url}: ${e.error?.message ?? e.error}`);
  };

  return (
    <group ref={wrapper} rotation-y={Math.PI} scale={[SCALE_X, 1, SCALE_Z]} position-y={-GROUND_ELLIPSOID_HEIGHT_GUESS} name="photoreal-tiles">
      <TilesRenderer key={apiKey} ref={setTiles} onLoadError={onLoadError} onLoadModel={tint.add} onDisposeModel={tint.remove}>
        <TilesPlugin plugin={GoogleCloudAuthPlugin} args={[{ apiToken: apiKey, autoRefreshToken: true, useRecommendedSettings: false }]} />
        <TilesPlugin plugin={ReorientationPlugin} args={[{ lat: ORIGIN_LAT * DEG, lon: ORIGIN_LON * DEG, height: 0, recenter: true }]} />
        <TilesPlugin plugin={GLTFExtensionsPlugin} args={[{ dracoLoader: loaders.draco, ktxLoader: loaders.ktx }]} />
        <TilesPlugin plugin={TilesFadePlugin} args={[{ fadeDuration: 250, maximumFadeOutTiles: 50 }]} />
        <TilesPlugin plugin={UpdateOnChangePlugin} />
        <TilesAttributionOverlay
          style={{ top: 8, bottom: "auto", left: "50%", transform: "translateX(-50%)", padding: "2px 8px", textAlign: "center", fontSize: 10, color: "rgba(255,255,255,0.85)", textShadow: "0 1px 2px rgba(0,0,0,0.8)", maxWidth: "60%" }}
          generateAttributions={(atts) => (
            <>
              <b style={{ fontSize: 12, letterSpacing: 0.2 }}>Google</b>
              {atts
                .filter((a) => a.type === "string" && a.value)
                .map((a, i) => (
                  <span key={i}> · {String(a.value)}</span>
                ))}
            </>
          )}
        />
      </TilesRenderer>
    </group>
  );
}

/** Wider far plane and a zoom range the photogrammetry holds up at; restored when leaving photoreal. */
function useCameraLimits() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as { minDistance: number; maxDistance: number } | null;
  useEffect(() => {
    const far = camera.far;
    camera.far = FAR;
    camera.updateProjectionMatrix();
    return () => {
      camera.far = far;
      camera.updateProjectionMatrix();
    };
  }, [camera]);
  useEffect(() => {
    if (!controls) return;
    const { minDistance, maxDistance } = controls;
    controls.minDistance = Math.max(minDistance, MIN_DIST);
    controls.maxDistance = Math.min(maxDistance, MAX_DIST);
    return () => {
      controls.minDistance = minDistance;
      controls.maxDistance = maxDistance;
    };
  }, [controls]);
}

/** Photo textures are unlit (baked daylight): dim and cool them with the sim's night so glows and lamps read. */
function useNightTint(tiles: TilesImpl | null) {
  const mats = useRef(new Set<MeshBasicMaterial>());
  const last = useRef(-1);
  const color = useRef(new Color());
  const api = useMemo(
    () => ({
      add: ({ scene }: { scene: Object3D }) => {
        scene.traverse((o) => {
          const m = (o as Mesh).material as Material | Material[] | undefined;
          for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
            if (mat instanceof MeshBasicMaterial) {
              mats.current.add(mat);
              mat.color.copy(color.current);
            }
          }
        });
      },
      remove: ({ scene }: { scene: Object3D }) => {
        scene.traverse((o) => {
          const m = (o as Mesh).material as Material | Material[] | undefined;
          for (const mat of Array.isArray(m) ? m : m ? [m] : []) if (mat instanceof MeshBasicMaterial) mats.current.delete(mat);
        });
      },
    }),
    [],
  );
  useEffect(() => {
    const set = mats.current;
    return () => set.clear();
  }, [tiles]);
  useFrame(() => {
    const k = nightLevel(hourOf(useSim.getState().t));
    if (Math.abs(k - last.current) < 0.004) return;
    last.current = k;
    color.current.copy(WHITE).lerp(NIGHT_TINT, k);
    for (const m of mats.current) m.color.copy(color.current);
  });
  return api;
}

/** Sample the real street surface and publish heights; set the datum so the street at the station is y = 0. */
function useStreetLevel(tiles: TilesImpl | null, wrapper: RefObject<Group | null>, map: CityMap) {
  const samples = useMemo(() => {
    const pts: [number, number][] = [];
    for (const s of map.streets) {
      for (let i = 0; i < s.points.length - 1; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.01) continue;
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        const off = s.width / 2 + PAVEMENT_OFFSET;
        for (let d = 0; d < len; d += SAMPLE_STEP) {
          const x = ax + ux * d;
          const z = az + uz * d;
          pts.push([x, z], [x - uz * off, z + ux * off], [x + uz * off, z - ux * off]);
        }
      }
    }
    // nearest the station first: they set the datum, and they're where the camera starts
    pts.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
    const n = pts.length;
    const xs = new Float32Array(n);
    const zs = new Float32Array(n);
    pts.forEach(([x, z], i) => {
      [xs[i], zs[i]] = toScene(x, z);
    });
    let near = 0;
    while (near < n && Math.hypot(pts[near][0], pts[near][1]) < CALIBRATION_RADIUS) near++;
    return { n, xs, zs, near: Math.max(near, Math.min(n, 30)), raw: new Float32Array(n).fill(NaN) };
  }, [map]);

  const state = useRef({ cursor: 0, base: GROUND_ELLIPSOID_HEIGHT_GUESS, calibrated: false, passes: 0 });
  const ray = useMemo(() => {
    const r = new Raycaster();
    r.far = 5000;
    return r;
  }, []);
  const origin = useMemo(() => new Vector3(), []);
  const down = useMemo(() => new Vector3(0, -1, 0), []);

  useEffect(() => {
    const { minX, maxX, minZ, maxZ } = map.bounds;
    // scene rect of the map (+ margin): sceneZ = -contractZ
    groundField.reset(minX - 60, maxX + 60, -maxZ - 60, -minZ + 60);
    samples.raw.fill(NaN);
    state.current = { cursor: 0, base: GROUND_ELLIPSOID_HEIGHT_GUESS, calibrated: false, passes: 0 };
    return () => groundField.clear();
  }, [map, samples]);

  const recalibrate = () => {
    const st = state.current;
    const near: number[] = [];
    for (let i = 0; i < samples.near; i++) if (samples.raw[i] === samples.raw[i]) near.push(samples.raw[i]);
    if (near.length < Math.min(20, samples.near)) return;
    near.sort((a, b) => a - b);
    const base = near[near.length >> 1];
    if (st.calibrated && Math.abs(base - st.base) < 0.05) return;
    st.base = base;
    st.calibrated = true;
    if (wrapper.current) wrapper.current.position.y = -base;
    for (let i = 0; i < samples.n; i++) if (samples.raw[i] === samples.raw[i]) groundField.set(samples.xs[i], samples.zs[i], samples.raw[i] - base);
    (tiles as unknown as { dispatchEvent?: (e: { type: string }) => void } | null)?.dispatchEvent?.({ type: "needs-update" });
  };

  useFrame(() => {
    const g = wrapper.current;
    if (!tiles || !g || !tiles.root || tiles.visibleTiles.size === 0 || samples.n === 0) return;
    const st = state.current;
    g.updateWorldMatrix(true, false);
    const appliedBase = -g.position.y;
    const rays = st.passes === 0 ? RAYS_FAST : RAYS_SLOW;
    for (let k = 0; k < rays; k++) {
      const i = st.cursor;
      origin.set(samples.xs[i], 800, samples.zs[i]);
      ray.set(origin, down);
      const hits = ray.intersectObject(tiles.group, true);
      if (hits.length) {
        // lowest hit = the road, under any railway bridge, awning or tree
        let y = Infinity;
        for (const h of hits) y = Math.min(y, h.point.y);
        const raw = y + appliedBase;
        samples.raw[i] = raw;
        if (st.calibrated) groundField.set(samples.xs[i], samples.zs[i], raw - st.base);
      }
      st.cursor = (i + 1) % samples.n;
      if (st.cursor === samples.near || st.cursor === 0) {
        if (st.cursor === 0) st.passes++;
        recalibrate();
      }
    }
  });
}

/** Stores: hide the pastel box (keeps picking), sit the rest (glow pool, ring, beacon, label) on the real ground. */
function useStoreBodiesHidden() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const touched = new Set<Object3D>();
    const apply = () => {
      const root = scene.getObjectByName("stores");
      if (!root) return;
      for (const store of root.children) {
        const body = store.getObjectByName("store-body");
        if (body && !touched.has(body)) {
          body.traverse((o) => {
            const m = (o as Mesh).material as Material | Material[] | undefined;
            for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.visible = false;
          });
          touched.add(body);
        }
        store.position.y = groundY(store.position.x, store.position.z);
      }
    };
    apply();
    const id = window.setInterval(apply, 700);
    return () => {
      window.clearInterval(id);
      for (const body of touched)
        body.traverse((o) => {
          const m = (o as Mesh).material as Material | Material[] | undefined;
          for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.visible = true;
        });
      scene.getObjectByName("stores")?.children.forEach((s) => (s.position.y = 0));
    };
  }, [scene]);
}
