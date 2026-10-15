"""Snapshot the running backend's GET API into apps/web/public/snapshot/ so the static Vercel build shows the real
map, runs, days and store data (api/static.ts reads it when VITE_API_URL is unset).

    uv run python apps/web/scripts/snapshot-api.py [http://localhost:8000]

Each response is stored gzipped at public/snapshot/<path>[@<query>].json.gz (the browser inflates it), plus a
manifest.json listing every file. Re-run after new runs to refresh the deployed data.
"""

import gzip
import json
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
OUT = Path(__file__).resolve().parents[1] / "public" / "snapshot"


def fetch(path: str):
    try:
        with urllib.request.urlopen(BASE + path, timeout=120) as r:
            return r.read()
    except urllib.error.HTTPError:
        return None


def file_for(path: str) -> str:
    p, _, q = path.partition("?")
    return p.lstrip("/") + (("@" + q) if q else "") + ".json.gz"


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    runs = json.loads(fetch("/api/runs"))
    # only the runs on the current map: finished runs from the last baseline on (older ones used older store sets)
    done = [r for r in runs if r.get("status") == "done"]
    base = max((r["run"] for r in done if str(r.get("notebook", "")).startswith("Baseline")), default=done[0]["run"])
    runs = [r for r in done if r["run"] >= base]
    run_ids = [r["run"] for r in runs]
    stores = json.loads(fetch("/api/map"))["stores"]
    paths = ["/api/map", "/api/analyst", "/api/calibration", "/api/health", "/api/agents/session", "/api/agents/log"]
    for r in run_ids:
        paths += [f"/api/runs/{r}/{x}" for x in ("stores", "suggestions", "summary", "footfall", "owner-events", "street-events", "owners", "headlines", "citizens", "incidents")]
        paths += [f"/api/runs/{r}/days/{d}" for d in range(1, 15)]
        paths.append(f"/api/agents/log?run={r}")
    for s in stores:
        sid = urllib.parse.quote(s["id"], safe="")
        paths.append(f"/api/stores/{sid}/overview")
        paths.append(f"/api/stores/{sid}/insights?run={run_ids[-1]}")

    saved = ["api/runs.json.gz"]
    (OUT / "api").mkdir(parents=True, exist_ok=True)
    (OUT / "api" / "runs.json.gz").write_bytes(gzip.compress(json.dumps(runs).encode(), 9))

    def save(path: str):
        body = fetch(path)
        if body is None:
            return None
        f = OUT / file_for(path)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(gzip.compress(body, 9))
        return file_for(path)

    with ThreadPoolExecutor(12) as ex:
        for res in ex.map(save, paths):
            if res:
                saved.append(res)
    (OUT / "manifest.json").write_text(json.dumps({"source": BASE, "files": sorted(saved)}))
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"saved {len(saved)}/{len(paths)} responses, {size / 1e6:.1f} MB gzipped -> {OUT}")


if __name__ == "__main__":
    main()
