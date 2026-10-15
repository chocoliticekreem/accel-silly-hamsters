// Real backend client. Every path matches docs/FRONTEND_PROMPT.md.
import type { Api } from "./contract";

export function httpApi(base: string): Api {
  const root = base.replace(/\/$/, "");

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${root}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** GET that treats 404 as "not available" (optional endpoints, runs without a file). */
  async function getOptional<T>(path: string): Promise<T | null> {
    const res = await fetch(`${root}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${root}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  return {
    map: () => get("/api/map"),
    runs: () => get("/api/runs"),
    runStores: (run) => get(`/api/runs/${run}/stores`),
    day: (run, day) => get(`/api/runs/${run}/days/${day}`),
    suggestions: (run) => get(`/api/runs/${run}/suggestions`),
    apply: (req) => post("/api/apply", req),
    analyst: () => get("/api/analyst"),
    report: (storeId, run) => get(`/api/stores/${encodeURIComponent(storeId)}/report?run=${run}`),
    decision: ({ run, ...body }) => post(`/api/decision${run === undefined ? "" : `?run=${run}`}`, body),
    calibration: () => getOptional("/api/calibration"),
    summary: (run) => getOptional(`/api/runs/${run}/summary`),
    health: () => getOptional("/api/health"),
    insights: (storeId, run) => getOptional(`/api/stores/${encodeURIComponent(storeId)}/insights?run=${run}`),
  };
}

/** Resolves a backend-relative URL (e.g. a report pdfUrl) against the API origin. */
export function absoluteUrl(base: string | undefined, url: string) {
  if (!base || /^https?:/.test(url)) return url;
  return `${base.replace(/\/$/, "")}${url}`;
}
