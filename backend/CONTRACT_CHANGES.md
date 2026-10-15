# Contract changes

Differences between what `backend/api` serves and the "Data contract" in `docs/FRONTEND_PROMPT.md`.
Models: `backend/contract.py`. **All differences are additive; none are breaking.** Every contract
endpoint and field is served with the same name and shape, so a client written against the
contract keeps working if it ignores everything below. Optional extras are omitted when unset,
not sent as `null`.

## Additive differences

| Where | Difference |
| --- | --- |
| `GET /api/map` → `stores[]` | Optional `licensedHours` `{open, close}`, `defaultHours` `{open, close}`, `floorArea` (m²) and `osmId`. |
| `GET /api/map` | `sources`: `[{label, url, fetchedAt?}]`, citations for the map data. |
| Suggestions (`GET /api/runs/{run}/suggestions`, report `changes`) | Optional `confidence` (`low` \| `medium` \| `high`) and `reason` (one line). |
| `GET /api/stores/{storeId}/report` | `note`, always present (default `"Simulated, not guaranteed."`). `evidence[]` items may carry `fetchedAt`. |
| `pdfUrl` | Format `/files/reports/{run}/{storeId}.pdf` (the sample shows `/files/reports/s3.pdf`), relative to the API origin. `null` when no PDF was written. |
| `GET /api/analyst` | `stoppedReason` adds `budget` (spend cap reached) and `error`. `startedAt` and `bestRun` are `null` before the analyst has ever run. |
| `GET /api/runs` | `status` adds `queued`, `running` and `failed`. `kpis` is `null` until the run is `done`. |
| `POST /api/decision` | Optional `?run=` query parameter pins the run whose report the owner saw. Default: the report endpoint's default run. |
| New `GET /files/reports/{run}/{storeId}.pdf` | The PDF behind `pdfUrl` (`application/pdf`). |
| New `GET /api/runs/{run}/summary` | `RunSummary` (`backend/schemas.py`) for the city view: `kpis`, `objective`, `objectiveValue`, `peakKw`, `peakHour`, `co2Kg`, `energyCostGbp`, `demandByHourKw[24]`, `footfallByHour[24]`, `agents`, `durationSec`, `cost`, `cache`. Area totals only, no store ids. |
| New `GET /api/notebook` | Analyst lab notebook: `[{run, line, objectiveValue, at}]`, one line per run. |
| New `GET /api/health` | `{ok, simVersion, mapSource, realRuns}`. `mapSource` is `processed`, `sample` or `missing`. |
| New `GET /api/stores/{storeId}/insights?run=` | `StoreInsights` (`backend/contract.py`): one shop's 14-day `kpis`, `funnel` (passers-by → visits → returning), `hourly` (visits, footfall, missedDemand, kWh, lighting, openFraction), `weekdayVsWeekend`, `personas`, `energy` (incl. kWh while closed), anonymised `benchmarks` (peer count ≥ 3, percentiles only; may be `null`) and up to 5 ranked `insights` (kind, severity, title, detail, metric, impact, confidence, `suggestion` or `null`, evidence). Store-scoped: no other shop's id, name or numbers. Default run as for the report. 404 for clubs, unknown stores/runs and runs without store stats; 503 when processed data is missing. |
| New `GET /api/agents/session` | `AgentSession` (`backend/contract.py`): the analyst checkpoint in full (sessionId, state, backend, startedAt, updatedAt, baselineRun, currentRun, bestRun, bestObjective, iterations, runsThisSession, lowGainStreak, step, stoppedReason, spentGbp, error). 404 before the analyst has ever run. `GET /api/analyst` is unchanged. |
| New `GET /api/agents/log?run=&limit=` | `AgentEvent[]` oldest first: the session's story from `runs/llm_log.jsonl` and `runs/{run}/llm_log.jsonl`, filtered to hand-offs, proposals, hypotheses, tool calls, experiments, results, rule rejections, stops and costs. Scalar fields only under `data`: no prompts, responses or per-store id lists (lists become `<name>Count`), strings capped at 240 chars. |
| New `GET /api/calibration` | `data/processed/calibration.json` as built (`CalibrationFile`): anchor `venues[]` with `name`, `storeId`, `type`, `weekday[24]`, `weekend[24]` busyness (0–100), `measured`, `source`; plus `fallback`, `notes`, `sources`. `measured: false` = a placeholder shape, never proof. 404 until the pipeline has built it (the frontend hides its calibration tab). |

## Behaviour notes (not shape changes)

- **Sample run 0** (`runs/0/`, hand-made, not simulated). `GET /api/runs` lists it while
  `runs/index.json` has no real run and drops it once one exists. Its files stay readable at
  `/api/runs/0/...`.
- **Sample map.** `GET /api/map` serves `runs/0/map.json` only while `data/processed/map.json` is
  missing; `GET /api/health` → `mapSource` says which one is live.
- **Default report run** (report and decision without `?run=`): the analyst's `bestRun`, else the
  latest `done` run, else run 0 while no real run exists.
- **`costPerStoreWeekGbp`** (contract text) is on every `GET /api/runs` item; `0` without LLM spend.
- **`POST /api/apply`** uses the base run's seed and the run cache. On a cache hit, `queuedRun` is the
  existing (finished) run. Otherwise the new run shows in `GET /api/runs` as `queued` → `running` →
  `done` or `failed`; poll `/api/runs`. Suggestions go through the hard rules
  (`backend/agents/rules.py`); rejected ones are not applied.
- **Day files** are streamed as the sim wrote them (compact JSON, same shape). Conventions:
  a trip that runs past midnight is listed in both day files with the same id and identical path,
  so each file plays back its own 24 hours; a regular can therefore appear twice in one day file
  (last night's trip and today's), never overlapping in time. Returning ids are `r{n}` and persist
  across days; one-off ids are `v{day}-{n}` and never repeat. Spawn, `tIn` and `tOut` sit on the
  5-minute grid; corners, door arrivals and exits are integer minutes from walking at 1.3 m/s.
- **CORS:** `settings.CORS_ORIGINS` plus any `http(s)://localhost` or `127.0.0.1` port.

## Errors

All errors are `{"detail": ...}`.

| Status | When |
| --- | --- |
| 404 | Unknown run, day (outside 1–14), store, report or PDF. The detail names the missing file and the run status while it is `queued` or `running`. |
| 422 | Invalid input: wrong types, unknown fields, `scope: "store"` without `storeIds`, `suggestionIndex` out of range. |
| 409 | `POST /api/apply` on the sample run, with nothing to apply, or with every selected suggestion rejected by the hard rules (`detail.rejections`). |
| 503 | The sim, the hard rules or `data/processed/map.json` is unavailable, so nothing was queued. |
| 500 | A data file on disk no longer matches its schema; the detail names the file or the schema. |
