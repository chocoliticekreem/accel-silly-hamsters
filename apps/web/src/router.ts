// Two pages, scoped by URL (docs/STORE_PAGE.md): "/" is the area view (3D city), "/store/:storeId" is one
// shop owner's page. Tiny history-API router; no dependency. Query params (?run=, ?t=) pass through.
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== "undefined") window.addEventListener("popstate", emit);

export function navigate(to: string) {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", to);
  window.scrollTo(0, 0);
  emit();
}

export function useLocation() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => window.location.pathname + window.location.search,
  );
}

export type Route = { page: "area" } | { page: "store"; storeId: string; run?: number } | { page: "agents"; storeId: string | null };

export function parseRoute(location: string): Route {
  const url = new URL(location, "http://x");
  const a = url.pathname.match(/^\/agents(?:\/([^/]+))?\/?$/);
  if (a) return { page: "agents", storeId: a[1] ? decodeURIComponent(a[1]) : null };
  const m = url.pathname.match(/^\/store\/([^/]+)\/?$/);
  if (m) {
    const run = url.searchParams.get("run");
    return { page: "store", storeId: decodeURIComponent(m[1]), run: run === null ? undefined : Number(run) };
  }
  return { page: "area" };
}

export const storePath = (storeId: string, run?: number) => `/store/${encodeURIComponent(storeId)}${run === undefined ? "" : `?run=${run}`}`;
export const agentsPath = (storeId: string) => `/agents/${encodeURIComponent(storeId)}`;
