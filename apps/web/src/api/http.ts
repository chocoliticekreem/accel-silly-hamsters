// Real backend client. Every path matches docs/FRONTEND_PROMPT.md.
import type { Api } from "./contract";

export function httpApi(base: string): Api {
  const root = base.replace(/\/$/, "");

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${root}${path}`);
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
    decision: (req) => post("/api/decision", req),
    calibration: async () => {
      const res = await fetch(`${root}/api/calibration`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET /api/calibration → ${res.status}`);
      return res.json();
    },
  };
}

/** Resolves a backend-relative URL (e.g. a report pdfUrl) against the API origin. */
export function absoluteUrl(base: string | undefined, url: string) {
  if (!base || /^https?:/.test(url)) return url;
  return `${base.replace(/\/$/, "")}${url}`;
}
