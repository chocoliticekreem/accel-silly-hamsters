// Off the main thread: downloads public/city/*.json (reporting byte progress), parses and decodes them, and builds
// the real buildings' merged geometry arrays, which go back to the page as transferred buffers. The page keeps
// running at frame rate meanwhile. Protocol (realcity/data.ts is the only client):
//   page → { type: "load", base }            worker → { type: "progress", p } … { type: "city", city } | { type: "error" }
//   page → { type: "build", id, map }        worker → { type: "built", id, built } | { type: "error", id }
import type { CityMap } from "../../api/contract";
import { buildCityArrays, transferables } from "./buildCity";
import { decode, type RealCity } from "./data";

// typed by hand: the app's tsconfig has the DOM lib, not the WebWorker one
const ctx = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

let city: RealCity | null = null;

/** Rough sizes of the baked files, for progress when the server doesn't send a usable Content-Length. */
const GUESS: Record<string, number> = { "buildings.json": 1_700_000, "roads.json": 600_000, "land.json": 300_000 };

async function loadAll(base: string) {
  const files = ["buildings.json", "roads.json", "land.json"];
  const got = files.map(() => 0);
  const total = files.map((f) => GUESS[f]);
  let lastPost = 0;
  const post = (force = false) => {
    const now = performance.now();
    if (!force && now - lastPost < 60) return;
    lastPost = now;
    const p = got.reduce((a, g, i) => a + Math.min(g, total[i]), 0) / total.reduce((a, t) => a + t, 0);
    ctx.postMessage({ type: "progress", p: Math.min(0.97, p) });
  };
  const texts = await Promise.all(
    files.map(async (f, i) => {
      const res = await fetch(base + f);
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) throw new Error(`${f}: ${res.status}`);
      const enc = res.headers.get("content-encoding");
      const len = Number(res.headers.get("content-length")) || 0;
      if (len && (!enc || enc === "identity")) total[i] = len;
      if (!res.body) return res.text();
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got[i] += value.length;
        if (got[i] > total[i]) total[i] = got[i] * 1.1;
        post();
      }
      got[i] = total[i];
      post(true);
      const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) all.set(p, o), (o += p.length);
      return new TextDecoder().decode(all);
    }),
  );
  const [b, r, l] = texts.map((t) => JSON.parse(t));
  city = decode(b, r, l);
  ctx.postMessage({ type: "city", city });
}

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: "load"; base: string } | { type: "build"; id: number; map: CityMap };
  if (m.type === "load") {
    loadAll(m.base).catch((err: unknown) => ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }));
  } else if (m.type === "build") {
    try {
      if (!city) throw new Error("city not loaded in worker");
      const built = buildCityArrays(city, m.map);
      ctx.postMessage({ type: "built", id: m.id, built }, transferables(built));
    } catch (err) {
      ctx.postMessage({ type: "error", id: m.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
