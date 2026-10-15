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
| `GET /api/map` | Optional `landmarks`: `[{id, name, kind, buildingId, x, z, h, note?}]`, named real places to label or render specially. `kind` is `venue` \| `hotel` \| `station` \| `market` \| `landmark`; `buildingId` is the map building that is the place, or `null` (Old Street station is underground); `x`/`z` in map metres; `h` = the building's height in metres (where to hang a label; `0` = street level). The OSM map has `shoreditch-high-street` (station, the origin), `old-street` (station), `encode-hub` (venue, the hackathon), `artotel-london-hoxton` (hotel, 92.2 m) and `boxpark-shoreditch` (market); the fallback map only the station. Absent in maps built before it was added. |
| `GET /api/map` → `bounds` | No longer a square around the origin: the OSM map is the rectangle `minX -1050, maxX 300, minZ -300, maxZ 650` (Old Street roundabout to Brick Lane, Quaker Street to Hoxton). The origin is still Shoreditch High Street station. The hand-written fallback keeps ±250 m. |
| `GET /api/map` → `entryPoints` | Several `kind: "station"` entries: `st1` is Shoreditch High Street; `st2`... are Old Street's street entrances, all named `"Old Street"`. Group station entries by `name`. |
| Suggestions (`GET /api/runs/{run}/suggestions`, report `changes`) | Optional `confidence` (`low` \| `medium` \| `high`) and `reason` (one line). |
| `GET /api/stores/{storeId}/report` | `note`, always present (default `"Simulated, not guaranteed."`). `evidence[]` items may carry `fetchedAt`. |
| `pdfUrl` | Format `/files/reports/{run}/{storeId}.pdf` (the sample shows `/files/reports/s3.pdf`), relative to the API origin. `null` when no PDF was written. |
| `GET /api/analyst` | `stoppedReason` adds `budget` (spend cap reached) and `error`. `startedAt` and `bestRun` are `null` before the analyst has ever run. |
| `GET /api/runs` | `status` adds `queued`, `running` and `failed`. `kpis` is `null` until the run is `done`. |
| `POST /api/decision` | Optional `?run=` query parameter pins the run whose report the owner saw. Default: the report endpoint's default run. |
| New `GET /files/reports/{run}/{storeId}.pdf` | The PDF behind `pdfUrl` (`application/pdf`). |
| New `GET /api/runs/{run}/summary` | `RunSummary` (`backend/schemas.py`) for the city view: `kpis`, `objective`, `objectiveValue`, `peakKw`, `peakHour`, `co2Kg`, `energyCostGbp`, `demandByHourKw[24]`, `footfallByHour[24]`, `agents`, `durationSec`, `cost`, `cache`. Area totals only, no store ids. Optional `daily`: the in-run learning curve, 14 entries `{day, visits, kwh, visitsPerKwh, profitGbp, ownerActions}` (e.g. `{"day": 1, "visits": 1012, "kwh": 1603.4, "visitsPerKwh": 0.631, "profitGbp": 412.5, "ownerActions": 3}`): that sim day's area totals over non-club stores; `profitGbp` = margin on the visits (spend per visit x gross margin by store type, `backend/economics.py`) minus that day's energy bill; `ownerActions` = owner events dated that day (0 with adaptation off). Visits count on the day they start (a trip past midnight of day 14 counts on day 14), so the 14 entries sum to `kpis.visits` and, within rounding, to `kpis.kwh`. Every new run has it; runs from before it was added omit it. |
| New `GET /api/notebook` | Analyst lab notebook: `[{run, line, objectiveValue, at}]`, one line per run. |
| New `GET /api/health` | `{ok, simVersion, mapSource, realRuns}`. `mapSource` is `processed`, `sample` or `missing`. |
| New `GET /api/stores/{storeId}/insights?run=` | `StoreInsights` (`backend/contract.py`): one shop's 14-day `kpis`, `funnel` (passers-by → visits → returning), `hourly` (visits, footfall, missedDemand, kWh, lighting, openFraction), `weekdayVsWeekend`, `personas`, `energy` (incl. kWh while closed), anonymised `benchmarks` (peer count ≥ 3, percentiles only; may be `null`) and up to 5 ranked `insights` (kind, severity, title, detail, metric, impact, confidence, `suggestion` or `null`, evidence). Store-scoped: no other shop's id, name or numbers. Default run as for the report. 404 for clubs, unknown stores/runs and runs without store stats; 503 when processed data is missing. |
| New `GET /api/agents/session` | `AgentSession` (`backend/contract.py`): the analyst checkpoint in full (sessionId, state, backend, startedAt, updatedAt, baselineRun, currentRun, bestRun, bestObjective, iterations, runsThisSession, lowGainStreak, step, stoppedReason, spentGbp, error). 404 before the analyst has ever run. `GET /api/analyst` is unchanged. |
| New `GET /api/agents/log?run=&limit=` | `AgentEvent[]` oldest first: the session's story from `runs/llm_log.jsonl` and `runs/{run}/llm_log.jsonl`, filtered to hand-offs, proposals, hypotheses, tool calls, experiments, results, rule rejections, stops and costs. Scalar fields only under `data`: no prompts, responses or per-store id lists (lists become `<name>Count`), strings capped at 240 chars. |
| New `GET /api/calibration` | `data/processed/calibration.json` as built (`CalibrationFile`): anchor `venues[]` with `name`, `storeId`, `type`, `weekday[24]`, `weekend[24]` busyness (0–100), `measured`, `source`; plus `fallback`, `notes`, `sources`. `measured: false` = a placeholder shape, never proof. 404 until the pipeline has built it (the frontend hides its calibration tab). |
| `GET /api/runs/{run}/stores` → each `StoreRunResult` | Optional `schedule`: `[{fromDay, week[7]}]`, the shop's weekly hours as its owner changed them during the run, oldest first; `week` is Mon..Sun, each `{open, close}` or `null` (closed that weekday). Absent = `open`/`close` every day. Optional `closedFromDay`: the day the shop closed for good (absent = still trading). `open`/`close` keep meaning the run's starting hours. See `docs/OWNER_ACTIONS.md`. |
| New `GET /api/runs/{run}/owner-events` | `OwnerEvent[]` oldest first (`t`, then `storeId`): `day`, `t` (sim minute), `storeId`, `action` (`hours_changed` \| `day_closed` \| `day_reopened` \| `shut_early` \| `open_late` \| `temporary_closure` \| `lighting_changed` \| `closed_permanently`), optional `from`/`to` (`HH:MM`, a weekday like `mon`, or a lighting level), `reason` (one owner-voice sentence, ≤ 100 chars), `trigger` `{kind, value, label}`. 404 like other run files (runs from before this feature have none). |
| New `GET /api/runs/{run}/street-events` | `StreetEvent[]` oldest first: `day`, `fromT`, `toT` (sim minutes), `kind` (`roadworks` \| `heavy_traffic` \| `club_night` \| `event` \| `weather`), `streetId` (a map `Street.id`), `label`, `severity` (0–1). 404 like other run files. |
| New `GET /api/stores/{storeId}/overview?run=` | `StoreOverview` (`backend/contract.py`, `docs/STORE_PAGE.md`): the owner's store page in one call. `storeId`, `name`, `type`, `run`, `baselineRun`, `bestRun` (this shop's most profitable run vs its baseline; `null` while only the baseline exists), `status` (`not_started` \| `improving` \| `best_found`), `headline` (one sentence), `numbers` (`customersPerWeek`, `energyCostPerWeekGbp`, `kwhPerWeek` as `{value, change}` with `change` a fraction vs the baseline, plus `profitChangePerWeekGbp`), up to 3 `advice[]` (`text`, `gbpPerWeek`, `certainty` `likely` \| `worth testing` \| `uncertain`, `status` `new` \| `applied` \| `tested_better` \| `tested_worse`, `suggestion`), `history[]` (`run`, `label`, `customersPerWeek`, `kwhPerWeek`, `profitChangePerWeekGbp`, `changes[]`, `best`), `note`. Optional `ownerChanges`: how many times the shop's owner adapted during `run` (absent when the run has no `owner_events.json`). Store-scoped: no other shop's id, name or numbers (a suggestion `reason` naming another shop is dropped). 404 for clubs, unknown stores, unknown or unfinished runs, and before any run has finished. |
| New `POST /api/stores/{storeId}/optimize` | Body `{maxRuns?}` (2–10, default 6; the baseline counts). Starts a training session scoped to this shop as a background task and answers **202** with `AnalystStatus` (`state: "running"`). Only this shop's settings change (every other store stays at the baseline) and the objective is its profit change per week. 403 when the server runs with `READ_ONLY=1` (hosted demo), 404 for clubs and unknown stores, 409 while any session is `running` (a `running` checkpoint not updated for 30 min counts as dead), 422 for `maxRuns` out of range, 503 without `data/processed/map.json`. |

## Behaviour notes (not shape changes)

- **Store overview semantics** (`backend/overview.py`). Baseline = the analyst checkpoint's
  `baselineRun`, else the first finished run without a parent. `history` = the baseline plus every
  later finished run (same seed) whose config changed this shop against its `parentRun`, oldest
  first; `changes` are those diffs ("Close 23:00 → 03:00", "Lights 18–00 low → off"), `label`
  words the first one ("Open till 03:00", "Open from 10:00", "Lights 18–00 off"). Profit =
  `economics.profit_vs` against the baseline. `best` / `bestRun` = this shop's most profitable
  history run (the baseline when every change lost money), **not** the analyst's area-wide
  `bestRun`. Default `run` = `bestRun`, else the latest finished run. `status`: `not_started` while
  the history is only the baseline, `improving` while a session is running, else `best_found`.
  `advice` = this shop's suggestions on `run`, priced with `expectedDelta` on the run's numbers,
  sorted by `gbpPerWeek`, top 3; `applied` = a change already on `run`'s parent chain,
  `tested_better`/`tested_worse` = an earlier run made it and the shop's profit rose/fell.
  `headline`: when `run` costs the shop money, "going back is better" (to its original settings or
  to its best earlier test, with the £/week gap); else the top advice; else a keep/no-change line.
- **One-shop sessions** (`POST .../optimize`, `training.train(scope_store=...)`) write the same
  `runs/analyst_state.json` as the area session (with `scopeStore`, kept out of
  `GET /api/agents/session`), so `GET /api/analyst` shows them and, while one is the last session,
  the report's default run is that shop's best run. The choice is a deterministic ranking of the
  shop's proposals by expected £/week (no analyst LLM); store-agent proposals use the usual
  backend (Batch API online, heuristic offline). Reports are written for that shop only; the
  shared baseline run keeps its area session's cost.

- **Owners adapt inside a run** (`docs/OWNER_ACTIONS.md`, `backend/sim/owners.py`), switch
  `OWNER_ADAPTATION` (env, default on; `0` = the pre-adaptation sim, byte-identical files apart
  from `owner_events.json` / `street_events.json` being `[]`). Decisions taken at the end of day
  *d* apply from day *d*+1 and their `t` is 00:00 of that day; `shut_early` has `t` = the moment
  the owner decided (that day) and `to` = the new close; `open_late` has `t` = an hour before the
  usual close and `to` = tonight's close (past midnight = the next morning); `temporary_closure`
  has `day` = the first closed day and `to` = the weekday it reopens, followed by a `day_reopened`
  on that day. Today-only actions (`shut_early`, `open_late`, `temporary_closure`) are not in
  `schedule`: apply them from the events. Every decision passes the hard rules (licence hours,
  minimum open/closed time). `closed_permanently` never happens in a run whose parent is the
  baseline. Street events cut (roadworks, heavy traffic) or lift (event) stop-ins at the shops on
  that street; walking routes are unchanged. Owners decide with money in mind
  (`backend/economics.py`): a later close only when the margin on the expected extra visits beats
  the extra energy bill (lights included); a first/last hour is trimmed when its visits don't pay
  for its energy (an extension that didn't pay is taken back); window lights go off while shut and
  sign lights in daylight (a lit window only draws people at night while open). `day_closed`
  comes from a weekly review at the end of day 7: a weekday that was clearly dead in week 1 (under
  10% of an average day's visits and its margin below its energy bill) is closed from week 2;
  `day_reopened` (`trigger.kind` `dead_day`) follows when people keep trying the door or the
  footfall past the shut door is close to an open day's (it applies from the next week, which may
  be past day 14).
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
| 403 | `POST /api/stores/{storeId}/optimize` on a read-only server (`READ_ONLY=1`). |
| 409 | `POST /api/apply` on the sample run, with nothing to apply, or with every selected suggestion rejected by the hard rules (`detail.rejections`). `POST /api/stores/{storeId}/optimize` while a training session is running. |
| 503 | The sim, the hard rules or `data/processed/map.json` is unavailable, so nothing was queued. |
| 500 | A data file on disk no longer matches its schema; the detail names the file or the schema. |
