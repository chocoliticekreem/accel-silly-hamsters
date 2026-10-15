// Real backend client. Every path matches docs/FRONTEND_PROMPT.md.
import { ApiError, type AgentEvent, type Api, type AnalystStatus, type OwnerEvent, type StreetEvent } from "./contract";
import { overviewFromParts } from "./overviewFallback";

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
    if (!res.ok) throw new ApiError(`POST ${path} → ${res.status}`, res.status);
    return res.json() as Promise<T>;
  }

  const self: Api = {
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
    // the real endpoint when served, else composed from runs + store results + suggestions
    overview: async (storeId, run) =>
      (await getOptional(`/api/stores/${encodeURIComponent(storeId)}/overview${run === undefined ? "" : `?run=${run}`}`)) ??
      overviewFromParts(self, storeId, run),
    agentSession: () => getOptional("/api/agents/session"),
    agentLog: async (run) => (await getOptional<AgentEvent[]>(`/api/agents/log${run === undefined ? "" : `?run=${run}`}`)) ?? [],
    ownerEvents: async (run) => (await getOptional<OwnerEvent[]>(`/api/runs/${run}/owner-events`)) ?? [],
    streetEvents: async (run) => (await getOptional<StreetEvent[]>(`/api/runs/${run}/street-events`)) ?? [],
    optimize: (storeId, maxRuns) => post<AnalystStatus>(`/api/stores/${encodeURIComponent(storeId)}/optimize`, maxRuns ? { maxRuns } : {}),
  };
  return self;
}

/** Resolves a backend-relative URL (e.g. a report pdfUrl) against the API origin. */
export function absoluteUrl(base: string | undefined, url: string) {
  if (!base || /^https?:/.test(url)) return url;
  return `${base.replace(/\/$/, "")}${url}`;
}
