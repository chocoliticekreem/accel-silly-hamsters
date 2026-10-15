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
| `GET /api/analyst` | `stoppedReason` adds `budget` (spend cap reached), `error` and `stopped` (a stop request, `POST /api/training/stop`). Optional `baselineRun`: the session's baseline run (compare mode's left side). Without an analyst session but with real runs, the runs stand in: `startedAt` = the first real run's `createdAt`, `bestRun` = the best finished real run by `settings.OBJECTIVE`, `baselineRun` = the first real run; so `baselineRun` is present whenever real runs exist. Before any real run: `startedAt` and `bestRun` are `null`, `baselineRun` is omitted. |
| `GET /api/runs` | `status` adds `queued`, `running` and `failed`. `kpis` is `null` until the run is `done`. |
| `POST /api/decision` | Optional `?run=` query parameter pins the run whose report the owner saw. Default: the report endpoint's default run. |
| New `GET /files/reports/{run}/{storeId}.pdf` | The PDF behind `pdfUrl` (`application/pdf`). |
| New `GET /api/runs/{run}/summary` | `RunSummary` (`backend/schemas.py`) for the city view: `kpis`, `objective`, `objectiveValue`, `peakKw`, `peakHour`, `co2Kg`, `energyCostGbp`, `demandByHourKw[24]`, `footfallByHour[24]`, `agents`, `durationSec`, `cost`, `cache`. Area totals only, no store ids. |
| New `GET /api/notebook` | Analyst lab notebook: `[{run, line, objectiveValue, at, objective}]`, one line per run. `objective` names what `objectiveValue` measures (`visitsPerKwh`, `visits` or `netValueGbp` in GBP a week; `null` in entries written before training was configurable): sessions with different objectives leave values in different units. |
| New `GET /api/health` | `{ok, simVersion, mapSource, realRuns}`. `mapSource` is `processed`, `sample` or `missing`. |
| New `GET /api/calibration` | `data/processed/calibration.json` as built (`CalibrationFile`): anchor `venues[]` with `name`, `storeId`, `type`, `weekday[24]`, `weekend[24]` busyness (0–100), `measured`, `source`; plus `fallback`, `notes`, `sources`. `measured: false` = a placeholder shape, never proof. 404 until the pipeline has built it (the frontend hides its calibration tab). |
| New `GET /api/training` | `{config, options, status, running}`. `config`: the saved `TrainingConfig` (table below; `runs/training_config.json`, settings defaults until one is saved), what the next session runs with. `options`: what each field accepts: `{values: [...]}` for choices, `{min, max?}` for numbers (`max` absent = unbounded), `levers: {values: ["hours", "lighting"], minEnabled: 1}`, `storeIds: {stores: [{id, name, type}], null}` (`null` = every non-club store). `status`: `AnalystStatus`, as `GET /api/analyst`. `running`: a session started by this API process is running. |
| New `PUT /api/training/config` | Body: a `TrainingConfig` (missing fields take the settings defaults). Validated, saved, answered back. 409 while a session runs, 422 on a bad value or a `storeIds` entry that is unknown or a club, 403 when read-only. |
| New `POST /api/training/start` | Body (optional): `{config?: TrainingConfig, fresh?: false}`. Starts a session in a background thread of the API, or resumes the last one (same seed and objective, not `fresh`); a body `config` is saved as the current config first, else the saved one runs. Answers `AnalystStatus`, already `running`. One at a time: 409 while one runs in this API, or while another process (e.g. a CLI `train`) runs a session on the same `runs/` (it holds `runs/training.lock`; its stop request is left alone). 422 on a bad config, 403 when read-only. |
| New `POST /api/training/stop` | Asks the running session to stop at its next step boundary (the step in progress finishes); it then checkpoints with `stoppedReason: "stopped"`. Also stops a CLI session on the same `runs/` (flag file). Answers `AnalystStatus` at once (still `running` until the step and the wrap-up end, see below). 403 when read-only. |

### `TrainingConfig` (`backend/schemas.py`)

| Field | Accepts | Default |
| --- | --- | --- |
| `objective` | `visitsPerKwh` \| `netValueGbp` (weekly margin on visits minus the energy bill, `backend/economics.py`) \| `visits` | `settings.OBJECTIVE` |
| `threshold` | 0–1: stop when the gain over the best run stays below it... | `settings.THRESHOLD` (0.02) |
| `patience` | ≥ 1: ...for this many runs in a row | 2 |
| `maxRuns` | 2–50, the baseline included | `settings.MAX_RUNS` (10) |
| `maxStoresPerIteration` | 1–24 stores changed per experiment | 4 |
| `maxChangesPerStore` | 1–2 changes per store per week | 2 |
| `seed` | ≥ 0 | 42 |
| `levers` | `{hours: bool, lighting: bool}`, at least one `true` | both `true` |
| `storeIds` | participating store ids (no clubs), or `null` = every non-club store; the others stay frozen | `null` |
| `sessionBudgetUsd` | 0.01 – `settings.SPEND_CAP_USD` (30) | `settings.SESSION_BUDGET_USD` (15) |
| `analystBackend` | `auto` \| `heuristic` \| `messages` \| `managed` | `settings.ANALYST_BACKEND` |
| `storeAgents` | `auto` \| `heuristic` \| `batch` | `auto` |

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
- **Read-only deployments** (`VERCEL=1` or `READ_ONLY=1`, i.e. the hosted demo that replays
  pre-computed runs): `PUT /api/training/config`, `POST /api/training/start` and
  `POST /api/training/stop` answer 403; every read works.
- **Training stop is cooperative:** a session checks for a stop request between steps, so
  `state` stays `running` until the step in progress (e.g. a 14-day simulation) finishes, then
  through the wrap-up every stop gets (next week's proposals on the best run, owner reports,
  costs). `stopped` therefore means the session's files are all written.

## Errors

All errors are `{"detail": ...}`.

| Status | When |
| --- | --- |
| 403 | A training write (`PUT /api/training/config`, `POST /api/training/start`, `POST /api/training/stop`) on a read-only deployment, checked before the body (a bad body there is 403 too). |
| 404 | Unknown run, day (outside 1–14), store, report or PDF. The detail names the missing file and the run status while it is `queued` or `running`. |
| 422 | Invalid input: wrong types, unknown fields, `scope: "store"` without `storeIds`, `suggestionIndex` out of range, a `TrainingConfig` value out of range or a `storeIds` entry that is unknown or a club. |
| 409 | `POST /api/apply` on the sample run, with nothing to apply, or with every selected suggestion rejected by the hard rules (`detail.rejections`). `PUT /api/training/config` or `POST /api/training/start` while a session is running (start: also in another process). |
| 503 | The sim, the hard rules, the training module or `data/processed/map.json` is unavailable, so nothing was queued or started. |
| 500 | A data file on disk no longer matches its schema; the detail names the file or the schema. |
