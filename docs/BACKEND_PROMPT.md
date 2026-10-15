# Backend build prompt: Smart City Sim (Shoreditch)

> Give Claude Code this file plus the spec PDF and FRONTEND_PROMPT.md, then say: "Build the first version of the backend described in BACKEND_PROMPT.md. The spec PDF is the product context; the data contract in FRONTEND_PROMPT.md is the API you must serve exactly."

## Context

- **Spec PDF** (Smart City Sim build spec): read it first for the why, levers, agents, data sources and training loop.
- **FRONTEND_PROMPT.md:** the first pass of the 3D frontend is being built from it in parallel. Its **Data contract** section is shared by the whole team: serve those endpoints and JSON shapes exactly. If a change is unavoidable, list it at the top of `backend/CONTRACT_CHANGES.md` so everyone sees it.

**Scope of this pass:** a first, complete version of the data pipeline, simulation, agents (citizens, store owners, analyst), training loop and API. The whole team will iterate on every part afterwards, so keep the code modular and easy for others to pick up (clear module boundaries, typed models for the contract in one file, a short README).

## Stack

- Python 3.11+, FastAPI + uvicorn, pydantic, numpy
- `anthropic` SDK for LLM agents (structured JSON outputs)
- `httpx` / Overpass API for OSM, `praw` for Reddit
- No database: everything is JSON files on disk.

## Repo layout

```
backend/
  api/            FastAPI app, endpoints from the contract
  pipeline/       scrapers + processing → data/processed
  sim/            engine, citizens, energy, KPIs
  agents/         store_owner.py, analyst.py
  cli.py
data/
  raw/            scraped data (gitignored)
  processed/      map.json, personas.json, demand.json, energy.json
runs/
  index.json      run list (served by GET /api/runs)
  {run}/stores.json, suggestions.json, days/{1..14}.json, summary.json
  cache.json      config hash → run id
  analyst_state.json, notebook.json
```

## Build order (get end-to-end first, then make it real)

Each milestone must leave the API working.

1. **M1 Stub API (first ~1h):** FastAPI serving the contract from hand-made sample files in `runs/0/`. Share the URL with the team as soon as it's up so the frontend can switch off mock data.
2. **M2 Map:** `map.json` from OSM, ~500 m × 500 m around Shoreditch High St station (approx. lat 51.5233, lon -0.0754). Convert lat/lon to local metres (origin = station, x east, z north). Simplify to boxes and straight street segments. Keep ~25 stores, 2–3 clubs, 1–2 stations, offices, 4+ street entry points at the map edge.
3. **M3 Simulation with placeholder personas:** a full 14-day run producing every contract file.
4. **M4 Energy + KPIs.**
5. **M5 Store-owner + analyst agents, training loop, cache, threshold.**
6. **M6 Real data:** personas from Reddit/reviews, demand from TfL/Time Use, calibration with Popular Times.
7. **M7 Unattended run:** the analyst runs ~10 iterations overnight before the demo.

## Simulation (`sim/`)

- **Deterministic:** everything driven by a `seed`. The same seed + same store configs = identical run. Runs being compared use the same seed.
- **Tick:** 5 sim-minutes. 14 days = 4032 ticks. Must finish a full run in a few minutes on a laptop.
- **Open boundary:** agents spawn at entry points (street edges, stations) using hourly arrival rates from `demand.json`, and despawn when they leave.
- **Two visitor types:**
  - **Returning** (residents, office workers, regular club-goers): a fixed pool with persistent identities across all 14 days. They have **memory**: which stores were open or closed when they tried, and satisfaction per store. Memory changes later choices.
  - **One-off** (tourists, passers-by): appear once, never return.
- **Citizen decisions are rule-based** (no LLM in the tick loop). For each candidate store, the choice weight =
  persona preference for the store type × distance decay × open? × lighting attraction (night only, by level) × memory factor.
  Pick by weighted random using the seeded RNG.
- **Movement:** walk along the simplified street segments (grid A* or straight segments is fine). Record **keyframes** `[t, x, z]` only at turns, entries and exits; the frontend interpolates between them.
- **Clubs and stations are fixed anchors** (not optimized). Clubs create spill-out at closing time.

## Energy (`sim/energy.py`)

- Store baseline per open hour = floor area (from building footprint) × typical kWh/m² for the store type (put the constants in `energy.json`).
- Lighting adds kW by level: off / low / high.
- Hourly grid carbon intensity from the Carbon Intensity API (cache a typical 24h profile in `energy.json`). Report kWh and CO2.
- City demand curve = the sum of all stores by hour (for the city view).

## KPIs (per run and per store)

`visits`, `kwh`, `visitsPerKwh`, `returnRate`; plus city `peakKw` and CO2 in `summary.json`. The main optimization objective is `visitsPerKwh` (one number; keep it configurable).

## Product framing (read this first)

The **customer is the store owner** (restaurants, cafes, shops, bars; all day, not just late night). The product is a team of Claude agents that runs for hours, overnight, and produces a **weekly report per store**: 1–3 concrete changes to hours and lighting, the expected impact (visits, kWh, £ saved), a confidence level and cited evidence. **The owner approves or rejects**; the agents learn from that decision. Judging criteria: real output, agent design and architecture, long-running agents and teamwork, use of the Claude API, business viability, demo clarity, responsible design.

## Claude API architecture

Each feature has a real job. Check the docs at https://platform.claude.com/docs for current request shapes before coding each one.

| Part | Model | Claude features |
| --- | --- | --- |
| Analyst (orchestrator) | `claude-opus-5-5` | Managed Agents session; multiagent orchestration; memory store (lab notebook); define outcomes (stop criterion); session budgets (spend cap); compaction for long logs; code execution (analyse run data, make charts) |
| Weekly re-run | n/a | Managed Agents scheduled deployment + webhook when the report is ready |
| Store agents (team) | `claude-sonnet-5-5` | Message Batches (all stores per iteration in one batch); structured outputs (suggestion schema); prompt caching (shared city context first in the prompt) |
| Sim as tools | n/a | Custom tools for the analyst: `run_sim(config, seed)`, `get_kpis(run)`, `get_store_stats(run, storeId)`, `propose_config(changes)` |
| Persona builder | `claude-haiku-5-5` | Web search / web fetch + citations; Batch for volume |
| Owner report | `claude-sonnet-5-5` | Citations; Files API for the downloadable report |

**Fallback:** if Managed Agents access is blocked during the hackathon, run the analyst as a plain Messages API tool-use loop (SDK Tool Runner), with the same tools, the notebook as a local file and checkpointing as below. Keep the agent logic behind one interface so either backend works.

**Cost tracking:** record tokens and cost per agent call; report **cost per store-week** in `summary.json` (it goes on a pitch slide).

## Caching (cut token cost and time everywhere, except fresh training runs)

Cache aggressively by default. Put all cache logic in one module (`backend/cache.py`) so it's easy to see and switch off.

| Layer | What | Key | Notes |
| --- | --- | --- | --- |
| Prompt caching | Stable prompt prefixes: system prompts, tool definitions, shared city context, persona definitions, store history | n/a (Claude API cache breakpoints) | Order every prompt stable-first, variable-last. Always on, including fresh runs: it never changes outputs, only cost and latency. Log cache hit rates. |
| LLM response cache | Full responses for deterministic, non-training calls: persona extraction, scraped-text summaries, report wording for an unchanged run | hash of model + prompt + params | `data/cache/llm/`. Reuse when the exact input repeats. |
| Scrape cache | Raw scraped data and API responses (OSM, Reddit, reviews, TfL, Popular Times, carbon intensity) | URL + params | `data/raw/`. Never re-scrape what's already on disk unless `--refresh`. |
| Pipeline outputs | `data/processed/*.json` | hash of inputs | Rebuild a step only when its inputs change. |
| Sim results | Finished runs | hash of store configs + seed + sim version | `runs/cache.json`. Used for demo replays and the API. |
| Batch | Store-agent proposals | n/a | Batch API for all stores at once (cheaper, async). |

**Fresh training runs are the exception:** `train --fresh` must compute everything new — new sims, new store-agent proposals, new analyst decisions — and never read the LLM response cache or the sim-result cache. Prompt caching stays on. Within one fresh session, the analyst may still reuse runs it produced earlier in that same session (the "don't retry a tried config" rule). Without `--fresh`, `train` resumes from the checkpoint and reuses caches.

Report token usage, cache-read tokens and £ saved by caching in `summary.json`; it's a good pitch number.

## Agents (`agents/`)

Log every prompt, tool call and response to `runs/{run}/llm_log.jsonl` (replayable audit trail).

- **Store owner (one per store):** input = this store's KPIs, `visitsByHour`, the footfall nearby by hour, and its config history. Output = 0–2 proposed changes in the contract's `suggestions` shape. Constraints: hours in 30-min steps; lighting levels `off | low | high`. Never propose a config already in `cache.json`.
- **Analyst (one, long-running):** the training loop.
  1. Read the latest run summary, all store proposals, the notebook and the cache.
  2. Pick which proposals to apply (cap at ~3–5 stores per iteration so effects stay attributable).
  3. Hash the resulting config; skip it if cached.
  4. Run the sim (same seed), then score the run.
  5. Write one notebook line, ≤ 12 words, e.g. "Opened Cafe till 03:00 → +18% night visits".
  6. **Stop** when the objective gain is < 2% for 2 consecutive runs (`threshold`), or after 10 runs (`max_runs`). Keep the best run.
  - **Checkpoint** `analyst_state.json` after every step; on restart, resume from it. This is part of the demo ("running 9h, 10 experiments").
  - Expose its state via `GET /api/analyst`.
- `POST /api/apply` (manual apply from the UI) queues one run as a FastAPI background task, using the same cache and seed rules.
- **Report agent:** after training, write one report per store (`runs/{run}/reports/{storeId}.json` + PDF): changes, expected impact (visits, kWh, £), confidence, cited evidence, and a "simulated, not guaranteed" note.

## Responsible design (enforce in code, not just prompts)

- **Human in the loop:** nothing is "live" until the owner approves (`POST /api/decision`). Store decisions in the memory store; the store agent reads them next week.
- **Hard rules checked in code** on every proposal: within the store's licensed hours (`licensedHours` per store in `map.json`; default to a sensible cap), no closing for less than 30 min, max 2 changes per store per week. Reject proposals that break the rules and log why.
- **Privacy:** never store usernames or raw personal posts after persona extraction; keep only anonymous archetypes and source links.
- **Honest confidence:** derive confidence from the calibration error and the variance across seeds; show it with every suggestion.
- **Spend cap:** session budget on the analyst; hard stop and checkpoint on hitting it.

## Extra endpoints (also add these to the contract for the frontend)

- `GET /api/stores/{storeId}/report?run={run}` → `{ "storeId", "changes": [suggestion...], "impact": { "visits": 0.12, "kwh": -0.08, "gbpPerWeek": 34 }, "confidence": "medium", "evidence": [{ "label", "url" }], "pdfUrl" }`
- `POST /api/decision` → `{ "storeId": "s3", "suggestionIndex": 0, "decision": "approve" | "reject", "reason": "optional" }`
- `GET /api/runs` items also carry `"costPerStoreWeekGbp"`.

## Data pipeline (`pipeline/`)

Write each step as a standalone script that writes to `data/processed/`. **Every step must have a fallback** (hand-written defaults) so the sim never blocks on scraping.

| Output | Sources | Notes |
| --- | --- | --- |
| `map.json` | [OpenStreetMap](https://www.openstreetmap.org) via [Overpass API](https://overpass-api.de) | Footprints, names, `opening_hours` as starting configs |
| `personas.json` | [Reddit](https://www.reddit.com/r/london/) (r/london, r/AskLondon, r/londonsocialclub) via [PRAW](https://praw.readthedocs.io); reviews from Google Maps, [Yelp](https://www.yelp.co.uk), [TripAdvisor](https://www.tripadvisor.co.uk), [Time Out](https://www.timeout.com/london) | LLM summarises into ~10 archetypes: store-type preferences, active hours, lighting sensitivity, returning probability |
| `demand.json` | [TfL open data](https://tfl.gov.uk/info-for/open-data-users/) (station entry/exit, Night Tube), [ONS Time Use Survey](https://www.ons.gov.uk/peoplepopulationandcommunity/personalandhouseholdfinances/incomeandwealth/bulletins/timeuseintheuk/latest), club events ([Resident Advisor](https://ra.co), [Dice](https://dice.fm), [Eventbrite](https://www.eventbrite.co.uk)) | Hourly arrival rate per entry point, weekday vs. weekend |
| `energy.json` | [Non-domestic EPC register](https://epc.opendatacommunities.org), [Carbon Intensity API](https://carbonintensity.org.uk) | kWh/m² by store type, 24h carbon profile |
| `calibration.json` | Google Popular Times via [BestTime](https://besttime.app), [Outscraper](https://outscraper.com) or [SerpAPI](https://serpapi.com); [London Datastore](https://data.london.gov.uk) footfall | Hourly busyness for 3–5 anchor venues |

**Source in parallel with subagents.** Launch one subagent per row (or per source) at the start of M6, all in one go. Each subagent:

1. Checks access: terms of use, whether an API key is needed, rate limits. If a key is missing, it says so and builds the fallback instead of blocking.
2. Fetches a small, scoped sample for the Shoreditch area (cached in `data/raw/`, see Caching).
3. Writes its processed output to `data/processed/` in the agreed shape, with a `sources` list (URL + date fetched) for citations.
4. Reports back: what it got, gaps, and data quality notes.

Then a final step merges the outputs, runs calibration, and flags any source that fell back to defaults.

**Calibration:** add a script that compares simulated `visitsByHour` against Popular Times for the anchor venues, and writes a chart PNG. Tune the persona weights until the shapes roughly match; that chart goes on a demo slide.

Respect each site's terms and rate limits; keep scraping volumes small (a few thousand posts and reviews is enough).

## CLI

```
python -m backend.cli pipeline all        # build data/processed (with fallbacks)
python -m backend.cli run --seed 42       # one 14-day run → runs/{n}
python -m backend.cli train --max-runs 10 # analyst loop, resumable, uses caches
python -m backend.cli train --fresh       # new training session, no reuse of cached LLM outputs or runs
python -m backend.cli pipeline all --refresh  # re-scrape instead of using data/raw
uvicorn backend.api.main:app --reload
```

## Env

**Required:** a Claude API key; all LLM calls go directly to the Claude API. Vercel AI Gateway is available but optional; don't depend on it.

`.env`: `ANTHROPIC_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `BESTTIME_API_KEY` (or `OUTSCRAPER_API_KEY`). Enable CORS for the frontend dev server.

## Definition of done

- [ ] All contract endpoints served with correct shapes (test against the sample JSON in FRONTEND_PROMPT.md)
- [ ] A full deterministic 14-day run in a few minutes
- [ ] Returning vs. one-off agents with memory; open boundary
- [ ] Energy + KPIs incl. return rate and city peak
- [ ] Store-owner proposals + analyst loop with cache, threshold, checkpoint/resume
- [ ] Notebook lines per run
- [ ] Analyst on Managed Agents (or the fallback loop) with memory, outcome-based stop, budget
- [ ] Store agents via Batch + structured outputs + prompt caching
- [ ] Per-store reports with citations; approve/reject endpoint; hard rules enforced
- [ ] Cost per store-week reported
- [ ] All cache layers in place; `--fresh` bypasses response and run caches; cache hit rates logged
- [ ] Pipeline with fallbacks + calibration chart
- [ ] ~10 iterations pre-computed before the demo
