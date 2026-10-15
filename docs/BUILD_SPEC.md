# Smart City Sim — Build Spec

*15 Oct 2026 · Shoreditch, day to night*

## Pitch

A team of Claude agents that runs overnight and tells independent shops in Shoreditch when to open and how to light their store. Under the hood it's a 3D sim where persona-driven agents live through 14-day runs, and the agents learn better opening hours and lighting run after run.

> "Your opening hours are a guess. Our agents live 14 days of Shoreditch overnight and tell you what to change."

## The business (decided)

Shops are the customer. Government is phase 2 and only ever buys anonymised area data.

| Role | Who | Pays for | Sees |
|---|---|---|---|
| Store owner | User and customer | Weekly report; monthly subscription per store | Only their own store |
| BID | Channel | Bulk seats for its members | Area totals, anonymised |
| Council | Phase 2 | Area energy and footfall insight; street-lighting optimisation | Area totals, anonymised; never individual stores |

**Why a shop owner buys:** hours are a guess · energy is a big visible cost · no analyst · zero effort (public data on day one, approve in one tap).

**Why us:** simulation, not dashboards · one sim per area serves every shop · data advantage compounds · long-running agents are the product.

**Government without breaking shop trust:** data firewall · no enforcement use · separate levers (shops: hours + lighting; council: street lighting) · independent per-store advice (no cross-competitor coordination).

## Go-to-market

1. Pilot Shoreditch through its BID: a handful of shops free for a month.
2. Convert to paid per-store subscriptions; BID buys seats.
3. Repeat area by area across UK high streets.
4. Phase 2: anonymised area view + street-lighting optimisation for councils.

## Pitch arc

~60% one shop's story (dark shop next to the club → agents overnight → report → Approve → replay shows a full shop) → zoom out to the high street → mic drop: council gets carbon savings → close: business model, responsible design.

**Demo moment to protect above everything:** the before/after replay of the same 14 days.

## Product (per store, every week)

- 1–3 concrete changes, e.g. "Close 23:00 → 03:00 Fri–Sat", "Window lights off 20:00–22:00".
- Expected impact: visits, kWh, £ saved, with confidence.
- Evidence: sim replay of that store + cited data.
- Owner approves or rejects; agents learn from the decision next week.

## Agents

| Agent | Count | Lives for | Job |
|---|---|---|---|
| Citizen | ~300–500 | One 14-day run | Walk, shop, eat, club per persona; memory across days |
| Store owner | One per store | Across runs | Reads own stats, proposes hours and lighting; remembers what it tried |
| Analyst | 1 | Whole training session (hours) | Reads run logs, picks next experiment, decides when to stop; persistent lab notebook |

Model split: Opus analyst · Sonnet store agents (batch, structured outputs, caching) · Haiku persona builder (web search, citations).

## Levers (two per store)

| Lever | Per store | Effect |
|---|---|---|
| Opening hours | Open/close time (30-min steps) | Captures flows, e.g. club spill-out 2–4am |
| Lighting | off / low / high per hour | Raises attraction radius; costs kWh |

Fixed anchors (clubs, stations, offices) are not optimised; they create demand.

## Energy model

Floor area × kWh/m² by store type · hourly grid carbon + price · city peak load curve · optional council street-lighting lever.

## Training loop

Run 14 days → score KPIs → plateaued? stop, keep best : propose changes → drop tried configs → next run. Fixed seed, config-hash cache, threshold stop (gain < X% for 2 runs, or 10 runs), single objective (e.g. visits per kWh).

## Data (Shoreditch, ~1 km²)

OpenStreetMap (map, opening_hours) · Reddit + reviews → ~10 persona archetypes · ONS Time Use + TfL (routines) · RA / Dice / Eventbrite (club surges) · EPC register + Carbon Intensity API (energy) · Popular Times + London Datastore (calibration). Open boundary: agents spawn and despawn at street edges and stations; returning regulars vs one-off visitors; return rate is a KPI.

## UI

3D city is the screen; thin overlays; no paragraphs. City HUD (day, run, 3 KPIs) · store card (24h strip, KPIs vs last run) · suggestions as diffs with Apply · History chart + notebook, click to replay · speed 1× / 10× / 100×.

## Responsible design

Human in the loop · honest uncertainty (confidence + "simulated, not guaranteed") · public aggregate data only · licence/noise rules enforced in code · objective rewards energy saved · session budgets and full logging.

### Misuse cases and how we block them

| Misuse | Block |
| --- | --- |
| Council uses store data for licensing enforcement | Councils only get anonymised area totals; written into terms |
| A shop spies on a competitor | No store ever sees another store's data or suggestions |
| Competitors coordinate hours or prices through us | Advice is per store only; no cross-store recommendations |
| Tracking real individuals | Citizens are synthetic archetypes; no usernames or personal data kept |
| Landlord uses footfall to raise rents | Store-level data is owned by the store and shared only with its consent |
| Agents overspend or run away | Session budgets, hard stop, every action logged |

## Judging criteria map

| Criterion | Weight | How we hit it | Priority action |
| --- | --- | --- | --- |
| Real output | 20% | Working end-to-end run producing per-shop reports for real Shoreditch venues | Get a live link and saved run proof (logs, notebook, run files) early; real beats polished |
| Business viability | 20% | Shops as customer, BID channel, council as phase 2; data gaps councils can't fill | Get 2–3 real quotes from Shoreditch shop owners during the hackathon |
| Agent design and architecture | 15% | Orchestrator + team of store agents + sim as tool; planning, hand-offs, memory, checkpoint/resume | Show the notebook, the hand-off and a resume-after-crash live |
| Demo and pitch | 15% | 5-minute story: one shop, agents overnight, approve, zoom out to the council | Rehearse; have a one-page diagram for round 1 at the table |
| Demo clarity | 15% | 3D before/after of the same 14 days; one KPI chart | Pre-cached runs so nothing stalls live |
| Responsible design | 15% | Human approval, licence rules in code, anonymous data only, honest confidence, spend caps, no enforcement use | Name the misuse cases and how we block them |

## Demo plan

1. Open on the analyst's runtime clock and lab notebook (ran overnight, ~10 iterations, replay not live compute).
2. Run 1 at speed: club closes, crowd spills out, nearby shop is dark and shut.
3. Click that shop: "open till 03:00, low light 01–03".
4. Jump to final run: same night, shop open and full. KPI chart climbs then flattens.
5. Open the weekly report, Approve. Zoom out: city-wide kWh saved, cost per store-week.

## Open questions

Optimizer (hill-climb vs LLM) · revenue model (fixed spend per visit vs persona) · which 3–4 anchor venues to name.
