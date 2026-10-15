// Ask the camera (CameraRig) to fly somewhere that isn't a store: a landmark, Old Street, the station.
// Contract coords (x east, z north). The rig picks the request up on its next frame.
export interface FlyRequest {
  x: number;
  z: number;
  /** Camera distance from the target (m). */
  dist: number;
  /** Optional height of the point to look at. */
  y?: number;
  /** Angle from straight down (radians); default 0.95. */
  polar?: number;
  /** Exact camera position (scene coords), e.g. to return to a saved shot; overrides dist/polar. */
  position?: [number, number, number];
  seq: number;
}

let seq = 0;
export const flyRequest: { current: FlyRequest | null } = { current: null };

export function flyTo(x: number, z: number, dist = 220, y = 0, opts: { polar?: number; position?: [number, number, number] } = {}) {
  flyRequest.current = { x, z, dist, y, ...opts, seq: ++seq };
}

/** `?cam=px,py,pz,tx,ty,tz` (scene coords): open on an exact shot (screenshots, demos). */
export function camFromUrl(): { position: [number, number, number]; target: [number, number, number] } | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("cam");
  const n = v?.split(",").map(Number);
  if (!n || n.length !== 6 || n.some((k) => !Number.isFinite(k))) return null;
  return { position: [n[0], n[1], n[2]], target: [n[3], n[4], n[5]] };
}
