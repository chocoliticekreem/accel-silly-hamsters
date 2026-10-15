// Static deploys (Vercel) have no backend: the backend's GET responses are snapshotted into public/snapshot/
// (scripts/snapshot-api.py, gzipped) and served through a fetch shim, so every client (http.ts, economy.ts,
// incidents.ts) runs unchanged against SNAPSHOT_BASE as if it were the real API. GETs map to
// /snapshot/<path>[@<query>].json.gz (inflated in the browser); anything not snapshotted is a 404, which the
// clients already treat as "not served". Writes (apply, decisions, optimise) answer 503: a snapshot is read-only.
export const SNAPSHOT_BASE = "/__snapshot__";

let installed = false;

export function installSnapshotFetch() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const at = url.indexOf(SNAPSHOT_BASE);
    if (at < 0 || (at > 0 && !/^https?:\/\/[^/]+$/.test(url.slice(0, at)))) return realFetch(input, init);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const json = { "Content-Type": "application/json" };
    if (method !== "GET") return new Response(JSON.stringify({ detail: "read-only snapshot" }), { status: 503, headers: json });
    const rest = url.slice(at + SNAPSHOT_BASE.length);
    const [path, query] = rest.split("?");
    const file = `${import.meta.env.BASE_URL}snapshot/${decodeURIComponent(path).replace(/^\//, "").split("/").map(encodeURIComponent).join("/")}${query ? `@${query}` : ""}.json.gz`;
    const res = await realFetch(file);
    if (!res.ok || !res.body) return new Response(JSON.stringify({ detail: "not in snapshot" }), { status: 404, headers: json });
    // the host may already have decoded it (Content-Encoding: gzip); gzip magic bytes tell
    const bytes = new Uint8Array(await res.arrayBuffer());
    const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const body = gz ? new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).body : new Blob([bytes]).stream();
    return new Response(body, { status: 200, headers: json });
  };
}
