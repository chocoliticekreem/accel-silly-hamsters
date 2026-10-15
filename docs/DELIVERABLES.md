# Deliverables tracker

Living checklist for the hackathon submission. Update the status column as things land; keep answers within the form limits.
Last updated: 2026-10-15.

## Submission form (draft answers)

| Field | Limit | Draft answer | Status |
| --- | --- | --- | --- |
| Project name | required | Smart City Sim (deployed title: "Shoreditch Sim") | Decide final name |
| One-line pitch | 140 chars | Option A (115 chars): "Claude agents live 14 days of Shoreditch overnight and tell each independent shop when to open and how to light it." Option B (129 chars): "PostHog for shop energy: Claude agents simulate 14 days of Shoreditch overnight and tell each shop when to open and how to light." | Pick one |
| Live product link | required | https://shoreditch-sim.vercel.app (frontend live; switches from mock data to the real API once `shoreditch-sim-api` is deployed with the trained runs) | Live (mock data) |
| Agent design | 150 words | See "Agent design (submission text)" below (145 words). Re-check numbers after the live training run. | Draft |
| Proof of a run | upload | `proof/` folder from the overnight session: lab notebook, analyst checkpoint, per-run summaries, agent prompt/response log, cost ledger, owner report PDFs; plus a sped-up screen recording of the run 1 vs best-run replay | Not started |
| Pitch slides link | required | (to make) one shop's story, agents overnight, approve, zoom out to the council; business model; responsible design | Not started |
| Partner tools used | optional | Claude API (Opus 5.5 analyst, Sonnet 5.5 store agents and reports, Haiku 5.5 personas; Message Batches, structured outputs, prompt caching, tool use, Files API, citations), Vercel (hosting), OpenStreetMap / Overpass, TfL open data (NUMBAT), Carbon Intensity API | Trim to the event's partner list |

### Agent design (submission text)

> Three agent layers on Claude. About 800 synthetic citizens a day walk Shoreditch on cheap rules, with memory across all 14 simulated days: a shop found shut on Tuesday changes Wednesday's route. One store-owner agent per shop (Claude Sonnet 5.5) reads only its own shop's data and proposes up to two changes to hours or lighting; all shops run as one Message Batch with structured outputs and a cached shared prompt. One analyst orchestrator (Claude Opus 5.5) plans each experiment, picks which proposals to test, runs the simulation as a tool, and writes a one-line lab notebook entry. A run is 14 simulated days (about 2 seconds of compute); a training session is about 10 runs over hours, unattended. Hard rules in code reject unsafe proposals, state is checkpointed after every step so a crash resumes where it stopped, and spend caps stop the session.

## Judging criteria

| Criterion | Weight | What judges look for | How we hit it | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Real output | 20% | Does it work and produce something useful? Open the live link or the run proof. A working end-to-end run beats a polished mock-up. | End-to-end run on real Shoreditch data (OSM map, TfL arrivals, live carbon profile) producing a weekly report for every shop | Live link; `proof/` folder | In progress |
| Business viability | 20% | Clear customer and a real problem | Shops pay (monthly per store), BID buys seats, council is phase 2 for anonymised area data; £/week impact and cost per store-week shown in the product. Scales area by area: the pipeline is parameterised by box size and centre (Shoreditch went from 0.5 km to 1.5 km in one rebuild), and every area added brings more real data (venues, transit flows, census mix) that strengthens the shared citizen and demand models | [docs/PMF.md](PMF.md) (sourced, fact-checked market, problem, pricing and pilot plan); report £/week; cost per store-week in History; the 1.5 km map rebuild; 2–3 shop-owner quotes | In progress |
| Agent design and architecture | 15% | Do the Claude agents run for longer or work as a team? Planning, hand-offs, memory and error recovery. | Analyst plans each experiment and hands proposals to the sim; store agents work as a batch; lab notebook and owner decisions are memory; checkpoint after every step, resume after a crash | Notebook; agent log; live resume-after-crash | In progress |
| Demo and pitch | 15% | Is the story clear, is the demo live, does the team show what the agents do in 5 minutes? In round 1: how well they explain it at the table. | 5-minute story: one shop, agents overnight, Approve, zoom out to the council; one-page diagram for the table | Slides; diagram | Not started |
| Demo clarity | 15% | Clear demo to showcase your build. | Pre-computed runs so nothing stalls live; 3D before/after of the same 14 days; one KPI chart; click any shop for its insights | Live link replay | In progress |
| Responsible design | 15% | Thoughtful handling of safety, privacy and misuse of the product | Human approval, licence rules in code, data firewall (a shop sees only itself plus anonymised area benchmarks), anonymous archetypes only, honest confidence, spend caps, every agent action logged | Misuse-case table in `docs/BUILD_NOTES.md`; tests proving each block | In progress |

## Build checklist

| Deliverable | Owner | Link / where | Status |
| --- | --- | --- | --- |
| 3D city frontend | Arvin | `apps/web`, https://shoreditch-sim.vercel.app | Live (mock data) |
| City visuals and accuracy pass | Arvin | `apps/web/src/world` | In progress |
| Backend API | Anson | `backend/api`, Vercel project `shoreditch-sim-api` | Merged; not deployed |
| Real OSM map | Anson | `data/processed/map.json` | In progress |
| Energy, personas, demand, calibration data | Anson | `data/processed/*.json` (PRs #5, #7, #8) | Done |
| 14-day simulation | Anson | `backend/sim` (about 1.3 s per run) | In progress |
| Store agents, analyst, training loop | Anson | `backend/agents` | In progress |
| Adjustable training (objective, threshold, max runs, levers, stores, budget) | Anson | CLI + API | Not started |
| Per-store insights ("PostHog for shop energy") | Anson | `GET /api/stores/{id}/insights`, Insights panel | In progress |
| Owner report for every shop (+ PDF) | Anson | `GET /api/stores/{id}/report` | In progress |
| Calibration chart | Arvin + Anson | History panel; `GET /api/calibration` | Placeholder targets (needs `BESTTIME_API_KEY` for real Popular Times) |
| Overnight Claude training session (~10 runs, $30 cap) | Anson | `python -m backend.cli train` | Not started |
| Run proof folder | Anson | `proof/` | Not started |
| Sped-up recording | Arvin | upload | Not started |
| Pitch slides | Anson | link | Not started |
| One-page architecture diagram | Anson | link | Not started |
| Responsible-design note (misuse case → code → test) | Anson | [docs/RESPONSIBLE_DESIGN.md](RESPONSIBLE_DESIGN.md), tests/test_responsible_design.py | Done (14 open gaps listed) |
| 2–3 real shop-owner quotes | Team | notes | Not started |

## Run proof: where it lives

| What | Path |
| --- | --- |
| Run list with KPIs and notebook lines | `runs/index.json` |
| Lab notebook (one line per run) | `runs/notebook.json` |
| Analyst checkpoint (resume state, best run, stop reason) | `runs/analyst_state.json` |
| Every agent prompt, tool call, response and rule rejection | `runs/{run}/llm_log.jsonl` |
| Cost ledger (tokens, cache reads, GBP per call) | `runs/costs.jsonl` |
| Per-run KPIs, peak kW, CO2, cost per store-week | `runs/{run}/summary.json` |
| Owner reports | `runs/{run}/reports/{storeId}.json` and `.pdf` |

`runs/` is gitignored; the submission copy goes in `proof/`. To regenerate: `python -m backend.cli pipeline all`, then `python -m backend.cli train --max-runs 10`, then `uvicorn backend.api.main:app`.

## Open items

- [ ] Pick the project name and the one-line pitch
- [ ] Run the overnight Claude training session and copy the run proof into `proof/`
- [ ] Deploy the API with the trained runs and point the live frontend at it
- [ ] Record the sped-up replay
- [ ] Make the slides and the one-page diagram
- [ ] Collect 2–3 shop-owner quotes
- [ ] Decide whether to show placeholder calibration targets or buy BestTime credits (about 10 credits for 5 venues)
