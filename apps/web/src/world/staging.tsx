// Start-up without a frozen tab: World mounts its modules a few at a time, in priority order, with a painted frame
// between each, instead of all ~36 in one giant commit. Tier 0 is the ground the camera looks at (sky, ground, the
// real city), tier 1 the landmarks and areas, tier 2 everything that moves (people, traffic, cyclists, physics).
// Each finished tier seals its loading-screen stage (state/loading.ts). ?stage=0 mounts everything at once.
//
// Also here, the canvas-level safety nets: FrameGuard (a module whose useFrame throws is switched off instead of
// stopping the render loop for good) and the WebGL context-loss watcher behind ContextLostOverlay.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { REAL_HIDES } from "./graphics";
import { useRealCity } from "./realcity/data";
import { seal, useLoading, allComplete, type StageId } from "../state/loading";

/** Module → tier. Modules not listed (new ones) go in tier 1. */
const TIER: Record<string, 0 | 1 | 2> = {
  Sky: 0,
  Ground: 0,
  RealLand: 0,
  RealRoads: 0,
  RealBuildings: 0,
  RealRail: 0,
  Surroundings: 0,
  Streets: 0,
  Buildings: 0,
  Heatmap: 0,
  Skyline: 0,
  CameraRig: 0,
  FreeCam: 0,
  StreetEvents: 2,
  Traffic: 2,
  Cyclists: 2,
  ClubLife: 2,
  Incidents: 2,
  Police: 2,
  Footfall: 2,
  Agents: 2,
  Glow: 2,
};
export const tierOf = (name: string) => TIER[name] ?? 1;

/** Loading-screen stage each tier completes. */
const TIER_STAGES: StageId[][] = [["city"], ["landmarks"], ["people", "run"]];

const noStaging = () => new URLSearchParams(window.location.search).get("stage") === "0";

/** Waits for a painted frame, then a moment of idle time (capped so a busy page still makes progress). */
function afterFrame(cb: () => void): () => void {
  let idle = 0;
  let timer = 0;
  const raf = requestAnimationFrame(() => {
    if ("requestIdleCallback" in window) idle = window.requestIdleCallback(cb, { timeout: 100 });
    else timer = setTimeout(cb, 0) as unknown as number;
  });
  return () => {
    cancelAnimationFrame(raf);
    if (idle) window.cancelIdleCallback(idle);
    if (timer) window.clearTimeout(timer);
  };
}

/** Is tier `t` allowed to start? Landmarks wait for the city data, movers for the city on screen (both capped). */
function tierGate(t: number, since: number): boolean {
  if (t === 0) return true;
  const { status, drawn } = useRealCity.getState();
  const waited = performance.now() - since;
  if (status === "missing" || status === "idle") return true;
  if (t === 1) return status === "ready" || waited > 4000;
  return drawn || waited > 7000;
}

/**
 * The subset of `names` mounted so far, plus the highest tier fully mounted (-1 before tier 0 is). Names keep their
 * order; mounting follows tier then list order, one module per painted frame.
 */
export function useStagedModules(names: string[]): { mounted: ReadonlySet<string>; tier: number } {
  const [all] = useState(noStaging);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => (all ? new Set(names) : new Set()));
  const [tier, setTier] = useState(all ? 2 : -1);
  const key = names.join(",");
  const done = useRef(new Set<string>());

  useEffect(() => {
    if (all) {
      for (const s of TIER_STAGES.flat()) seal(s);
      setMounted(new Set(names));
      return;
    }
    const queue = [...names].filter((n) => !done.current.has(n)).sort((a, b) => tierOf(a) - tierOf(b));
    let cancel = () => {};
    let tierStart = performance.now();
    let current = queue.length ? tierOf(queue[0]) : 2;
    const finishTiersBelow = (t: number) => {
      for (let k = 0; k < t && k < TIER_STAGES.length; k++) TIER_STAGES[k].forEach(seal);
      setTier((x) => Math.max(x, t - 1));
    };
    // the procedural stand-ins (box city, flat ground) are hidden as soon as the real city draws: while it is on its
    // way they wait at the back, and only mount if it turns out to be missing (or is very slow)
    const realComing = names.some((n) => n.startsWith("Real"));
    const t0 = performance.now();
    const standIn = (n: string) => realComing && REAL_HIDES.has(n) && useRealCity.getState().status !== "missing" && performance.now() - t0 < 12000;
    const later: string[] = [];
    const step = () => {
      while (queue.length && standIn(queue[0])) later.push(queue.shift()!);
      if (!queue.length) {
        finishTiersBelow(3);
        // drawn: World hides them anyway (and drops them from `names`)
        if (!later.length || useRealCity.getState().drawn) return;
        if (standIn(later[0])) {
          cancel = afterFrame(step);
          return;
        }
        queue.push(later.shift()!);
      }
      const next = queue[0];
      const t = tierOf(next);
      if (t !== current) {
        // the tier before is all mounted (its modules' effects have run): its stage has every task it will get
        finishTiersBelow(t);
        current = t;
        tierStart = performance.now();
      }
      if (!tierGate(t, tierStart)) {
        cancel = afterFrame(step);
        return;
      }
      queue.shift();
      done.current.add(next);
      setMounted((m) => new Set(m).add(next));
      cancel = afterFrame(step);
    };
    // modules already done before this tier (e.g. ?only): seal what's below the first queued tier
    finishTiersBelow(current);
    cancel = afterFrame(step);
    return () => cancel();
    // `key` stands for `names`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, all]);

  return { mounted, tier };
}

// ---------- inside the canvas ----------

/**
 * Wraps every useFrame subscription so one that throws is logged and switched off after a few errors, instead of
 * aborting the frame (r3f stops calling the rest and never renders again: a frozen city). Installed before any
 * module mounts (it renders first; modules come later through the staged mount).
 */
export function FrameGuard() {
  const store = useThree((s) => s.get);
  const internal = store().internal as unknown as {
    subscribe: (ref: { current: (...a: unknown[]) => void }, priority: number, store: unknown) => () => void;
    __guarded?: boolean;
  };
  if (!internal.__guarded) {
    internal.__guarded = true;
    const subscribe = internal.subscribe;
    internal.subscribe = (ref, priority, st) => {
      let last: ((...a: unknown[]) => void) | null = null;
      let wrapped: (...a: unknown[]) => void = () => {};
      let errors = 0;
      const guard = {
        get current() {
          const f = ref.current;
          if (f !== last) {
            last = f;
            wrapped = (...a: unknown[]) => {
              if (errors > 3) return;
              try {
                f(...a);
              } catch (e) {
                errors++;
                if (errors === 1 || errors > 3) console.error(errors > 3 ? "[city] a frame callback kept failing and was switched off" : "[city] frame callback failed", e);
              }
            };
          }
          return wrapped;
        },
      };
      return subscribe(guard, priority, st);
    };
  }
  return null;
}

/** Marks the loading screen "framed" once frames are rendering with every stage complete. */
export function FrameProbe() {
  const frames = useRef(0);
  useFrame(() => {
    const s = useLoading.getState();
    if (s.framed) return;
    if (!allComplete(s)) {
      frames.current = 0;
      return;
    }
    // a few frames in: shaders compiled, the last uploads done
    if (++frames.current >= 3) useLoading.setState({ framed: true });
  });
  return null;
}

// ---------- WebGL context loss ----------

interface GpuState {
  /** "lost": context gone, waiting; "failed": recovery attempts used up. */
  status: "ok" | "lost" | "failed";
  /** Bumped to remount the Canvas with a fresh context. */
  epoch: number;
  attempts: number;
}

export const useGpu = create<GpuState>(() => ({ status: "ok", epoch: 0, attempts: 0 }));

const MAX_ATTEMPTS = 3;

function remount() {
  const s = useGpu.getState();
  if (s.attempts >= MAX_ATTEMPTS) {
    useGpu.setState({ status: "failed" });
    return;
  }
  useGpu.setState({ epoch: s.epoch + 1, attempts: s.attempts + 1 });
}

/** Retry by hand (the overlay's button once the automatic attempts are used up). */
export function retryGpu() {
  useGpu.setState({ attempts: 0, status: "lost" });
  remount();
}

/**
 * Inside the Canvas: listens for the context going away. The browser may hand it back by itself (restored event);
 * if not, it is asked to (WEBGL_lose_context), and failing that the whole Canvas is remounted with a new one.
 * Either way the scene is rebuilt from scratch on a fresh renderer (render targets such as the sky's look-up tables
 * don't survive a context loss).
 */
export function ContextWatch() {
  const gl = useThree((s) => s.gl) as unknown as { domElement: HTMLCanvasElement; forceContextRestore?: () => void };
  useLayoutEffect(() => {
    const el = gl.domElement;
    let t1 = 0;
    let t2 = 0;
    const lost = (e: Event) => {
      e.preventDefault(); // tell the browser we'd like it back
      console.warn("[city] WebGL context lost");
      useGpu.setState({ status: "lost" });
      t1 = window.setTimeout(() => {
        try {
          gl.forceContextRestore?.();
        } catch {
          /* only works when the context can be restored */
        }
      }, 1500);
      t2 = window.setTimeout(remount, 5000);
    };
    const restored = () => {
      console.info("[city] WebGL context restored, rebuilding the scene");
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      remount();
    };
    el.addEventListener("webglcontextlost", lost);
    el.addEventListener("webglcontextrestored", restored);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      el.removeEventListener("webglcontextlost", lost);
      el.removeEventListener("webglcontextrestored", restored);
    };
  }, [gl]);
  // a fresh canvas drawing frames again: all clear
  useFrame(() => {
    const s = useGpu.getState();
    if (s.status === "lost" && !(gl as unknown as { getContext?: () => WebGLRenderingContext }).getContext?.().isContextLost?.()) {
      useGpu.setState({ status: "ok" });
    }
  });
  return null;
}
