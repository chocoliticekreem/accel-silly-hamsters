// Start-up progress for the loading screen (ui/LoadingScreen.tsx). Work registers itself as tasks under a named
// stage; a stage is complete once it is sealed (World's staged mount says "every module of this tier has mounted, no
// more tasks are coming") and all its tasks have finished. Byte progress comes from fetches that know their
// Content-Length; anything else counts by task weight. Nothing here ever blocks the app: it only reports.
import { create } from "zustand";

export type StageId = "map" | "city" | "landmarks" | "people" | "lighting" | "run";

export const STAGES: { id: StageId; label: string; weight: number }[] = [
  { id: "map", label: "Map", weight: 1 },
  { id: "city", label: "Streets and buildings", weight: 4 },
  { id: "landmarks", label: "Landmarks", weight: 2 },
  { id: "people", label: "People and traffic", weight: 2 },
  { id: "lighting", label: "Lighting", weight: 1 },
  { id: "run", label: "Today's run", weight: 2 },
];

interface Task {
  w: number;
  p: number;
  done: boolean;
  error?: string;
}

interface LoadingState {
  tasks: Record<StageId, Record<string, Task>>;
  sealed: Record<StageId, boolean>;
  /** A frame has rendered with every stage complete. */
  framed: boolean;
  /** The loading screen has gone (faded out or "Continue anyway"). Never comes back. */
  dismissed: boolean;
  /** Modules that crashed and were left out (shown as a quiet note). */
  skipped: string[];
}

const empty = <T,>(v: () => T) => Object.fromEntries(STAGES.map((s) => [s.id, v()])) as Record<StageId, T>;

export const useLoading = create<LoadingState>(() => ({
  tasks: empty(() => ({})),
  sealed: empty(() => false),
  framed: false,
  dismissed: false,
  skipped: [],
}));

function patch(stage: StageId, key: string, t: Partial<Task>) {
  useLoading.setState((s) => {
    const cur = s.tasks[stage][key];
    if (!cur) return s;
    return { tasks: { ...s.tasks, [stage]: { ...s.tasks[stage], [key]: { ...cur, ...t } } } };
  });
}

export interface TaskHandle {
  progress(p: number): void;
  done(): void;
  fail(message: string): void;
}

const NOOP: TaskHandle = { progress() {}, done() {}, fail() {} };

/**
 * Registers a task (idempotent per stage + key: a second mount of the same work never pulls the bar backwards, and
 * once the loading screen has gone nothing is tracked at all).
 */
export function task(stage: StageId, key: string, weight = 1): TaskHandle {
  const s = useLoading.getState();
  if (s.dismissed) return NOOP;
  const existing = s.tasks[stage][key];
  if (existing?.done) return NOOP;
  if (!existing)
    useLoading.setState((st) => ({ tasks: { ...st.tasks, [stage]: { ...st.tasks[stage], [key]: { w: weight, p: 0, done: false } } } }));
  let last = 0;
  let lastAt = 0;
  return {
    progress(p) {
      const now = performance.now();
      // a few updates a second is plenty for a bar
      if (p < 1 && p - last < 0.03 && now - lastAt < 120) return;
      last = p;
      lastAt = now;
      patch(stage, key, { p: Math.max(0, Math.min(0.99, p)) });
    },
    done() {
      patch(stage, key, { p: 1, done: true });
    },
    fail(message) {
      patch(stage, key, { p: 1, done: true, error: message });
    },
  };
}

/** Tracks a promise as one task. `optional` failures complete quietly (the module copes without the data). */
export function track<T>(stage: StageId, key: string, p: Promise<T>, opts: { weight?: number; optional?: boolean } = {}): Promise<T> {
  const t = task(stage, key, opts.weight);
  p.then(
    () => t.done(),
    (e: unknown) => (opts.optional ? t.done() : t.fail(e instanceof Error ? e.message : String(e))),
  );
  return p;
}

export function seal(stage: StageId) {
  if (useLoading.getState().sealed[stage]) return;
  useLoading.setState((s) => ({ sealed: { ...s.sealed, [stage]: true } }));
}

export function noteSkipped(name: string) {
  useLoading.setState((s) => (s.skipped.includes(name) ? s : { skipped: [...s.skipped, name] }));
}

export interface StageView {
  id: StageId;
  label: string;
  /** 0..1 */
  progress: number;
  complete: boolean;
  started: boolean;
  errors: string[];
}

export function stageViews(s: LoadingState): StageView[] {
  return STAGES.map(({ id, label }) => {
    const ts = Object.values(s.tasks[id]);
    const w = ts.reduce((a, t) => a + t.w, 0);
    const p = w ? ts.reduce((a, t) => a + t.w * (t.done ? 1 : t.p), 0) / w : 0;
    const allDone = ts.every((t) => t.done);
    const complete = s.sealed[id] && allDone;
    return {
      id,
      label,
      progress: complete ? 1 : s.sealed[id] ? p : p * 0.9,
      complete,
      started: ts.length > 0 || s.sealed[id],
      errors: ts.filter((t) => t.error).map((t) => t.error!),
    };
  });
}

export const allComplete = (s: LoadingState) => stageViews(s).every((v) => v.complete);

export function overallProgress(views: StageView[]): number {
  const total = STAGES.reduce((a, s) => a + s.weight, 0);
  return views.reduce((a, v, i) => a + STAGES[i].weight * v.progress, 0) / total;
}

// ---------- fetch with byte progress ----------

/**
 * Reads a response body, reporting bytes received / Content-Length when the length is known and the body isn't
 * compressed (a compressed length can't be compared with decoded bytes); otherwise an easing guess that never
 * reaches 1 before the body ends.
 */
export async function readJson<T>(res: Response, onProgress?: (p: number) => void): Promise<T> {
  if (!onProgress || !res.body) return res.json() as Promise<T>;
  const enc = res.headers.get("content-encoding");
  const len = Number(res.headers.get("content-length")) || 0;
  const total = !enc || enc === "identity" ? len : 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(total ? got / total : got / (got + 400_000));
  }
  const all = new Uint8Array(got);
  let o = 0;
  for (const p of parts) all.set(p, o), (o += p.length);
  return JSON.parse(new TextDecoder().decode(all)) as T;
}

/**
 * fetch + JSON with byte progress, tracked as a task. Rejects on HTTP errors; with `optional` a failure resolves null
 * and completes the task quietly.
 */
export function fetchJsonTracked<T>(url: string, stage: StageId, key: string, opts: { weight?: number; optional?: boolean } = {}): Promise<T | null> {
  const t = task(stage, key, opts.weight);
  const p = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`${key}: ${res.status}`);
      return readJson<T>(res, (x) => t.progress(x));
    })
    .then(
      (d) => (t.done(), d),
      (e: unknown) => {
        if (opts.optional) {
          t.done();
          return null;
        }
        t.fail(e instanceof Error ? e.message : String(e));
        throw e;
      },
    );
  return p;
}

// ---------- API byte progress (api/http.ts asks here whether anyone wants progress for a path) ----------

const byteWatchers: { prefix: string; fn: (p: number) => void }[] = [];

export function watchBytes(prefix: string, fn: (p: number) => void): () => void {
  const w = { prefix, fn };
  byteWatchers.push(w);
  return () => {
    const i = byteWatchers.indexOf(w);
    if (i >= 0) byteWatchers.splice(i, 1);
  };
}

export function bytesListener(path: string): ((p: number) => void) | undefined {
  const ws = byteWatchers.filter((w) => path.startsWith(w.prefix));
  return ws.length ? (p) => ws.forEach((w) => w.fn(p)) : undefined;
}
