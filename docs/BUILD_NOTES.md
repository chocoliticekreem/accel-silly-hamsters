# Build notes (backend v1)

Decisions and conventions for the first backend pass. Product context: `docs/Smart City Sim - Build Spec.pdf`.
Build brief: `docs/BACKEND_PROMPT.md`. API contract: `docs/FRONTEND_PROMPT.md` → typed in `backend/contract.py`.

## The business in five lines

- Customer = the independent store owner (cafe, restaurant, takeaway, bar, shop). They pay for a **weekly
  per-store report**: 1–3 changes to **opening hours and lighting**, impact (visits, kWh, £ energy saved),
  confidence, cited evidence, Approve / Reject.
- One sim per area serves every shop in it, so each extra store is nearly free. BID = channel. Council =
  phase 2, anonymised area totals only, never individual stores.
- Two levers only: open/close (30-min steps) and lighting per hour (`off | low | high`).
- Demo moment to protect: run 1 vs best run of the same 14 days. Club closes ~03:00, crowd spills out, the
  takeaway next door is dark and shut; after training it is open and full. KPI climbs, then plateaus at
  the threshold. Owner taps Approve.
- Responsible design is enforced in code: human approval, licence rules, per-store independent advice
  (a store agent only ever sees its own data plus public area footfall — never a competitor's config),
  privacy (anonymous archetypes only), honest confidence, spend caps.

## Judging criteria → what the backend must prove (spec, updated 2026-10-15)

| Criterion | Weight | Backend implication |
| --- | --- | --- |
| Real output | 20% | End-to-end run producing per-shop reports for **real** Shoreditch venues (OSM names). Saved run proof (llm_log, notebook, run files) kept and shareable early; a live link to the API. |
| Business viability | 20% | Human task (2–3 shop-owner quotes). Backend supports it with £/week impact and cost per store-week. |
| Agent design & architecture | 15% | Orchestrator + team of store agents + sim as a tool: visible planning (hypothesis before each experiment), hand-offs (analyst → store agents → analyst, logged), memory (notebook, decisions), checkpoint/resume shown live after a crash. |
| Demo & pitch | 15% | 5-minute story: one shop, agents overnight, approve, zoom out to the council. |
| Demo clarity | 15% | Pre-cached runs: the demo replays, nothing computes live. |
| Responsible design | 15% | Name the misuse cases and block each in code (table below), with tests as proof. |

### Misuse cases and how we block them

| Misuse | Block (spec) | Enforced in code by |
| --- | --- | --- |
| Council uses store data for licensing enforcement | Councils only get anonymised area totals | area-level endpoints carry no store ids or store-level fields |
| A shop spies on a competitor | No store sees another store's data or suggestions | store agent input built from that store only; store-scoped report access |
| Competitors coordinate hours or prices through us | Advice per store only; no cross-store recommendations | each proposal names exactly one store and is derived from its own data |
| Tracking real individuals | Citizens are synthetic archetypes; no personal data | personas carry archetypes + source links only; sim agents are synthetic ids |
| Landlord uses footfall to raise rents | Store-level data owned by the store, shared with consent | no store-level footfall in area outputs |
| Agents overspend or run away | Session budgets, hard stop, every action logged | `llm.check_budget` ($30 global, $15 per session) before every call/batch; `llm.log_event` audit trail |

## Module ownership (one owner per file; shared seams are read-only during the parallel build)

| Path | Owner |
| --- | --- |
| `backend/contract.py`, `schemas.py`, `store.py`, `cache.py`, `llm.py`, `settings.py`, `timeutil.py`, `pipeline/common.py` | shared seams (hand-written). Don't edit during the parallel build; report needed changes. |
| `backend/pipeline/osm_map.py` → `data/processed/map.json` | map builder |
| `backend/pipeline/personas.py` → `personas.json` | personas builder |
| `backend/pipeline/demand.py` → `demand.json` | demand builder |
| `backend/pipeline/energy.py` → `energy.json` | energy builder |
| `backend/pipeline/calibration_data.py` → `calibration.json` | calibration builder |
| `backend/sim/*` | sim builder |
| `backend/api/*`, `runs/0/*` | API builder |
| `backend/agents/*` | agents builder |
| `backend/cli.py`, `backend/pipeline/run_all.py`, `backend/sim/calibrate.py`, README | integration |

Tests live in `tests/test_<module>*.py`, one file set per owner.

## Conventions

- Python 3.12 venv at `.venv` (`uv sync` installs everything). Don't add dependencies; if one is truly
  needed, report it.
- Gate before reporting done (scope to your files): `.venv/bin/ruff format <paths>`,
  `.venv/bin/ruff check <paths>`, `.venv/bin/mypy <paths>`, `.venv/bin/pytest -q tests/test_<module>*.py`.
- Every processed file carries `sources` (label, url, fetchedAt) and `fallback: true` when hand-written
  defaults were used. A fallback is labelled as such everywhere it surfaces — never pass placeholder data
  off as measured (especially calibration).
- Fetch through `backend.pipeline.common.fetch` (scrape cache in `data/raw/`, `--refresh` bypasses it).
  Each pipeline step exposes `build(refresh: bool = False) -> <FileModel>` and `main()`; it rebuilds only
  when `cache.pipeline_up_to_date(step, inputs)` is False, then `cache.pipeline_mark`.
- No API keys exist in the build environment: no `ANTHROPIC_API_KEY`, Reddit, BestTime/Outscraper or EPC
  key. Network works (Overpass, Carbon Intensity, TfL, ONS are reachable). LLM code paths are written
  against the claude-api skill docs and must degrade to deterministic offline behaviour when
  `llm.available()` is False.

## Time, hours, lighting

- `t` = sim minutes since Day 1 00:00; Day 1 is a **Monday** (`timeutil`). Weekend = Sat/Sun for demand.
- Opening windows wrap past midnight when close ≤ open; open == close = 24 h (`timeutil.is_open`).
- Baseline config (`sim.runner.baseline_configs`): open/close from `MapStore.defaultHours`; lighting:
  open 07–17 → `low`, open 17–07 → `high`; closed 18–24 → `low` (window display), closed 00–07 → `off`.
  Clubs: their `ClubNight` hours, lighting `high` while open, else `off`. Clubs never change.
- Lighting attracts only while the store is open, at night (roughly 17:00–07:00), scaled by the persona's
  `lightingSensitivity`. Lighting costs energy whenever it is on, open or closed.

## Energy and KPIs (definitions everyone uses)

- Store kWh per clock hour = (open fraction × floorArea × `kwhPerM2PerOpenHour[type]`) + (closed fraction ×
  floorArea × `standbyKwhPerM2PerHour[type]`) + `lightingKw[level]`.
- KPIs exclude clubs (fixed anchors). `visits` = store visits over 14 days. `kwh` = store energy over 14 days.
  `visitsPerKwh` = visits / kwh. `returnRate` = Σ repeatVisitors / Σ uniqueVisitors (repeat = visited the
  same store on 2+ different days); per store the same ratio for that store.
- City: `peakKw` = max of the average-day demand curve (sum of stores by hour), `co2Kg` = Σ kWh_h ×
  carbon_h / 1000, `energyCostGbp` = Σ kWh_h × price_h.
- Objective = `settings.OBJECTIVE` (default `visitsPerKwh`).
- `expectedDelta` values are fractions relative to the store's current value (0.18 = +18%).
- Report `impact.gbpPerWeek` = energy £ saved per week (positive = saving), best run vs baseline.

## Simulation targets

- Deterministic in `seed` (numpy `default_rng(seed)`; derive sub-streams per day/agent so a change at one
  store does not reshuffle who arrives). Same seed + same configs = byte-identical run files.
- The map is 1.5 km × 1.5 km (bounds x −800 to 700 m, z ±750 m around Shoreditch High Street station,
  so XOYO is inside): ~68 stores plus 2–4 real nightclubs, stations Shoreditch High Street (st1) and
  Liverpool Street (st2), an entry on every street that leaves the edge, ≤ 2,500 buildings. The
  hand-written fallback stays a 500 m schematic; read `bounds` from map.json.
- 2,000–4,000 general arrivals per weekday (`demand.SIM_WEEKDAY_ARRIVALS` = 3,500, so each store keeps
  the ~41 visits a day the 500 m map gave; club-goers on top), peak concurrent ≲ 600. Day file < 3 MB.
  Full run ~5 s on a laptop (`sim.citizens.GENERAL_ARRIVALS_PER_DAY` caps the level at 4,000).
- Returning pool fixed across the 14 days with memory (found-closed by store × hour band, satisfaction per
  store). One-offs appear once.
- Club spill-out at club close on club nights; spill-out agents look for late food/drink near the club,
  then leave via a station or edge. `foundClosedByHour` records agents who wanted a shut store.

## Run files (`runs/{run}/`)

`config.json` (RunConfig) · `stores.json` (contract `{storeId: StoreRunResult}`) · `store_stats.json`
(`{storeId: StoreStats}`) · `suggestions.json` (contract list) · `days/{1..14}.json` (DayData) ·
`summary.json` (RunSummary) · `llm_log.jsonl` · `reports/{storeId}.json` (StoreReport) +
`reports/{storeId}.pdf`, served at `pdfUrl = /files/reports/{run}/{storeId}.pdf`.
Global: `runs/index.json`, `cache.json`, `notebook.json`, `analyst_state.json`, `decisions.json`, `costs.jsonl`.
Run 0 is the hand-made sample from the contract; it disappears from `/api/runs` once real runs exist.

## Agents

- Store owner: own KPIs, `visitsByHour`, own `StoreStats` (footfall nearby, found-closed), own config history,
  own approve/reject decisions → 0–2 suggestions. Online: Sonnet 5.5 via Message Batches + structured
  outputs, shared city context first in the prompt (prompt cache). Offline: deterministic heuristic.
- Hard rules (`agents/rules.py`, applied to every proposal from any source, rejections logged): 30-min
  steps; inside `licensedHours` (default caps by type); open window ≥ 60 min and closed gap ≥ 30 min;
  a day no longer than the type's cap (`MAX_OPEN_HOURS`: cafe 13 h, restaurant 14, takeaway 17, bar 15,
  shop 12, off-licence 16), unless the owner already trades longer; ≤ 2 changes per store per week
  (= per iteration); valid levels/hours; clubs immutable; never a store config already tried
  (`cache.store_config_tried`). The cap exists because extra hours cost staff time the sim does not
  price yet; once revenue is on real scale, wages per open hour replace it as the brake.
- Analyst: `training.py` owns the loop, checkpoint after every step, stop rule (gain < THRESHOLD for
  PATIENCE runs, or MAX_RUNS, or budget). Decisions sit behind one `AnalystBackend` interface:
  heuristic (offline), messages (Messages API tool-use loop with `run_sim`, `get_kpis`,
  `get_store_stats`, `propose_config`), managed (Managed Agents session).
- Report: best run vs baseline per store, confidence from seed variance (re-evaluate both configs on extra
  seeds with `sim.runner.evaluate`) and calibration error, evidence = cited sources + replay, PDF.
