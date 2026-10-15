# Frontend build prompt: Smart City Sim (Shoreditch)

> Give this whole file to Claude Code and say: "Build the first version of the frontend described in FRONTEND_PROMPT.md."

## What we're building

A hackathon demo (theme: **Long Horizon**). A cartoon 3D sim of a ~500 m × 500 m slice of Shoreditch, London. Persona-driven agents walk around for 14 simulated days. Shops change **opening hours** and **lighting** between training runs, and a long-running **analyst agent** improves them run after run. The demo shows run 1 vs. the final run of the same 14 days, side by side in time.

**The paying customer is the store owner** (restaurants, cafes, shops, bars). The 3D city is how we show the agents' work; the owner report with Approve / Reject is the product moment.

**Scope of this pass:** a first, complete version of the frontend. The backend (simulation, agents, data, optimizer) is being built in parallel and will serve the files and API in the contract below. Until it's ready, build against **mock data you generate yourself** in the exact same shapes. Expect the whole team to iterate on every part of the product afterwards, so keep the code modular and easy for others to pick up (clear component boundaries, typed contract in one file, a short README).

## Tech

- Vite + React + TypeScript
- Three.js via React Three Fiber (+ drei)
- Styling: your choice, but keep it minimal
- Charts: any lightweight lib (e.g. Recharts)

## Visual style

- Cartoonish, low-poly, soft. Not a map-accurate model.
- Streets: simplified straight blocks. Buildings: boxes with a lit facade.
- Agents: small capsules or dots, coloured by persona type.
- Day/night cycle: sky and ambient light follow sim time. At night, store glow = its lighting level (off / low / high). Street lights optional.
- Calm palette: muted blues and greys, warm yellow for lit windows.

## UI principles (important)

- **The 3D city is the screen; everything else is a thin overlay.**
- **No paragraphs anywhere.** Numbers, short labels, diffs, icons.
- Show only what a viewer needs; hide everything else behind a click.

## Screens / components

1. **City view (default)**
   - Full-screen 3D scene, orbit camera.
   - Corner HUD: `Day 3 · 22:40`, `Run 4 / 10`, and 3 KPIs: visits, kWh, visits/kWh. Each KPI shows a delta vs. the previous run.
   - Playback bar: play/pause, scrub through 14 days, speed 1× / 10× / 100× (14 days ≈ 1 min at max).
   - Analyst status chip: `Analyst running · 9h 12m · 10 experiments`.
2. **Store card** (click a store)
   - Side card: name, type, 24h strip showing open hours and lighting level per hour.
   - KPIs vs. last run: visits, kWh, return rate.
3. **Suggestions**
   - Diffs, not text: `Close 23:00 → 03:00`, `Light 01–03: off → low`, each with expected +/− delta.
   - Buttons: **Apply to this store** / **Apply all**.
4. **History**
   - One line chart: main KPI across runs, with a dashed threshold line where training stopped.
   - Under it, the analyst's lab notebook: one line per run.
   - Click a point → load and replay that run.
5. **Owner report (key product screen)**
   - From the store card: "Weekly report". Shows 1–3 changes, impact (visits, kWh, £/week), a confidence badge, evidence links, and a small "simulated, not guaranteed" note.
   - **Approve / Reject** per change (`POST /api/decision`). This is the human-in-the-loop moment in the demo.
   - Link to download the PDF.
6. **Compare mode (stretch)**
   - Split screen: run 1 vs. best run, synced clock.

## Data contract (shared across the whole team; change a shape only by updating this contract for everyone)

**Coordinates:** metres, origin at Shoreditch High St station, `x` = east, `z` = north, `y` = up.
**Time:** `t` = sim minutes since Day 1 00:00 (so Day 2 08:00 = 1440 + 480 = 1920). 14 days = 20160.

### `GET /api/map` → `map.json`

```json
{
  "bounds": { "minX": -250, "maxX": 250, "minZ": -250, "maxZ": 250 },
  "streets": [{ "id": "shoreditch-high-st", "name": "Shoreditch High St", "points": [[0,-250],[0,250]], "width": 12 }],
  "buildings": [
    { "id": "b12", "kind": "store", "storeId": "s3", "x": 30, "z": 40, "w": 20, "d": 15, "h": 12 },
    { "id": "b13", "kind": "office", "x": -60, "z": 10, "w": 40, "d": 30, "h": 30 },
    { "id": "b14", "kind": "club", "storeId": "c1", "x": 80, "z": -30, "w": 30, "d": 25, "h": 10 }
  ],
  "stores": [{ "id": "s3", "name": "Cafe", "type": "cafe", "buildingId": "b12" }],
  "entryPoints": [{ "id": "e1", "kind": "street", "x": 0, "z": 250 }, { "id": "st1", "kind": "station", "name": "Shoreditch High St", "x": 0, "z": 0 }]
}
```

`kind` values: `store | club | office | residential | station`. `type` values for stores: `cafe | restaurant | takeaway | bar | shop | offlicence | club`.

### `GET /api/runs` → list of runs

```json
[
  {
    "run": 4,
    "seed": 42,
    "status": "done",
    "kpis": { "visits": 18230, "kwh": 9120, "visitsPerKwh": 2.0, "returnRate": 0.34 },
    "notebook": "Opened Cafe till 03:00 → +18% night visits",
    "createdAt": "2026-10-16T02:14:00Z"
  }
]
```

### `GET /api/runs/{run}/stores` → store configs + per-store results

```json
{
  "s3": {
    "open": "07:00", "close": "23:00",
    "lighting": ["off","off","off","off","off","off","low","high", "...24 values total"],
    "kpis": { "visits": 812, "kwh": 340, "returnRate": 0.41 },
    "visitsByHour": [0,0,0,0,0,0,3,20, "...24 values, averaged over 14 days"]
  }
}
```

### `GET /api/runs/{run}/days/{day}` → agent movement for one day (1–14)

Keyframes only; **interpolate linearly** between them in the frontend.

```json
{
  "day": 3,
  "agents": [
    {
      "id": "a17",
      "persona": "night-owl",
      "returning": true,
      "path": [[2880, 0, 250], [2895, 0, 120], [2900, 30, 40]],
      "visits": [{ "storeId": "s3", "tIn": 2900, "tOut": 2930 }]
    }
  ]
}
```

`path` items are `[t, x, z]`. An agent exists only between its first and last keyframe (it enters/leaves via entry points). Hide the agent while it's inside a store (`visits`).

### `GET /api/runs/{run}/suggestions`

```json
[
  { "storeId": "s3", "field": "close", "from": "23:00", "to": "03:00", "expectedDelta": { "visits": 0.18, "kwh": 0.05 } },
  { "storeId": "s3", "field": "lighting", "hours": [1,2], "from": "off", "to": "low", "expectedDelta": { "visits": 0.04, "kwh": 0.01 } }
]
```

### `POST /api/apply`

Request: `{ "run": 4, "scope": "store", "storeIds": ["s3"] }` or `{ "run": 4, "scope": "all" }`
Response: `{ "queuedRun": 5 }`

### `GET /api/analyst`

```json
{ "state": "running", "startedAt": "2026-10-15T23:00:00Z", "iterations": 10, "bestRun": 9, "stoppedReason": null }
```

`state`: `running | stopped`. `stoppedReason`: `threshold | max_runs | null`.

### `GET /api/stores/{storeId}/report?run={run}`

```json
{
  "storeId": "s3",
  "changes": [{ "storeId": "s3", "field": "close", "from": "23:00", "to": "03:00", "expectedDelta": { "visits": 0.18, "kwh": 0.05 } }],
  "impact": { "visits": 0.12, "kwh": -0.08, "gbpPerWeek": 34 },
  "confidence": "medium",
  "evidence": [{ "label": "Popular Times, Fri nights", "url": "https://..." }],
  "pdfUrl": "/files/reports/s3.pdf"
}
```

### `POST /api/decision`

Request: `{ "storeId": "s3", "suggestionIndex": 0, "decision": "approve", "reason": "optional" }` → `{ "ok": true }`

`GET /api/runs` items also include `"costPerStoreWeekGbp": 0.42` (show it small in the History view).

## Mock data first

Build `src/mock/` that generates data in these exact shapes: ~25 stores, 2 clubs, 1 station, 4 street entry points, ~300 agents, 3 runs with improving KPIs. Switch between mock and real with one env var: `VITE_API_URL` (unset = mock).

## Performance

- 300–500 agents: use `InstancedMesh`.
- Load one day at a time; prefetch the next day while playing.

## Definition of done (v1)

- [ ] City renders from `map.json` with day/night cycle
- [ ] Agents play back a day smoothly at 1× / 10× / 100×
- [ ] HUD with KPIs and deltas
- [ ] Click store → store card
- [ ] Suggestions with Apply buttons calling `POST /api/apply`
- [ ] History chart + notebook, click to replay a run
- [ ] Owner report with Approve / Reject
- [ ] Works fully on mock data, then on real API by setting `VITE_API_URL`
