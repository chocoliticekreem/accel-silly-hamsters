// Renderer creation (the Canvas `gl` factory). WebGL2 is the default: on Apple Silicon Chrome runs it through
// ANGLE → Metal and Safari natively on Metal. `?gpu=webgpu` (or Graphics → Renderer → WebGPU) opts into three's
// WebGPURenderer, which talks to Metal directly; it falls back to WebGL2 when the browser has no WebGPU adapter.
import { WebGLRenderer, type WebGLRendererParameters } from "three";
type DefaultGLProps = { canvas?: unknown };

export type Backend = "webgl" | "webgpu";
/** What the viewer asked for: ?gpu=webgpu only (not persisted, so a plain reload is always the WebGL default). */
export function requestedBackend(): Backend {
  if (typeof window === "undefined") return "webgl";
  return new URLSearchParams(window.location.search).get("gpu") === "webgpu" ? "webgpu" : "webgl";
}

export function webgpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

/** Reloads with the other renderer (a renderer can't be swapped under a live scene). */
export function switchBackend(b: Backend) {
  const url = new URL(window.location.href);
  url.searchParams.delete("gpu");
  if (b === "webgpu") url.searchParams.set("gpu", "webgpu");
  window.location.replace(url.toString());
}

/** The backend actually in use, set once the renderer exists (WebGPU can fall back to WebGL). */
export let activeBackend: Backend = "webgl";
/** True when the scene runs on WebGPURenderer (either of its backends): WebGL-only modules must step aside. */
export const useWebGPURenderer = requestedBackend() === "webgpu";

const GL_PARAMS: WebGLRendererParameters = {
  antialias: false, // MSAA lives in the post composer (High only); SMAA elsewhere
  powerPreference: "high-performance", // the discrete / performance GPU path (Metal on Apple Silicon)
  stencil: false,
  depth: true,
  alpha: false,
  preserveDrawingBuffer: false,
  premultipliedAlpha: true,
};

export async function createRenderer(defaults: DefaultGLProps) {
  if (useWebGPURenderer) {
    try {
      const { WebGPURenderer } = await import("three/webgpu");
      const r = new WebGPURenderer({
        canvas: defaults.canvas as HTMLCanvasElement,
        antialias: false,
        powerPreference: "high-performance",
        // no adapter → three's own WebGL2 backend, same node materials
        forceWebGL: !webgpuAvailable(),
      });
      await r.init();
      activeBackend = (r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl";
      return r as unknown as WebGLRenderer;
    } catch (e) {
      console.warn("WebGPU renderer unavailable, using WebGL", e);
    }
  }
  const r = new WebGLRenderer({ ...GL_PARAMS, canvas: defaults.canvas as HTMLCanvasElement });
  activeBackend = "webgl";
  // kick the parallel-compile extension on so compileAsync can overlap shader builds with frames
  r.extensions.get("KHR_parallel_shader_compile");
  return r;
}
