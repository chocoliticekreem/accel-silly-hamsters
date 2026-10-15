# Owners are people, and the city has an economy (spec + contract, v1)

Decided 2026-10-15. Builds on docs/OWNER_ACTIONS.md (owners adapt day by day). Now every shop owner is a
**person in the city**, not a rule attached to a shop: they have a home, a commute, working hours, a bank
balance and a business account. Money moves through an append-only **ledger**; the live state is flat
arrays updated in fixed time steps. This is the "throughput system": hot state in memory, history on disk.

## Owners as people

- Each non-club shop has one owner (a synthetic person: name from a neutral list, anonymous archetype, home at
  a residential building on the map; never a real person).
- Daily life, in the day files like any citizen: leave home → walk to the shop → **open up** (the shop opens
  when its owner arrives; late owner = late opening) → inside during open hours (a visit to their own shop) →
  close up → maybe a pint or a takeaway → home. Days the shop is closed they stay home or go out as a resident.
- **Money**: a business account (takings in; energy, rent, stock and wages out) and a personal balance
  (drawings from the business pay rent at home and living costs). Daily figures, in £.
- **Money changes behaviour**: low business balance → more cautious (no speculative late hours, lights off
  sooner); a healthy balance → willing to test longer hours. Going **bust** (business balance below zero for
  N days) is what closes a shop for good (replaces "losing money 7 days").
- Owners are agents in the same arrays as everyone else; their decisions are still the owner actions of
  OWNER_ACTIONS.md, now weighed against their own balance.

## The throughput system (how state is kept)

| Layer | What | Where |
| --- | --- | --- |
| Live state | Flat struct-of-arrays for every person: position, home, work, state, business/personal balance; one index per person, no per-entity objects | In memory, numpy arrays |
| Time | Fixed tick loop (e.g. 5 sim-minutes), decoupled from wall clock | `backend/sim/engine.py` |
| Ledger (truth) | Append-only transactions, batched: sale, energy, rent, stock, wages, drawings | `runs/{run}/ledger.parquet` (or `.jsonl` if no parquet engine) |
| Snapshots | All arrays dumped at the end of every sim day | `runs/{run}/snapshots/day-NN.npz` |
| History queries | Read the ledger/snapshots (DuckDB if installed, else pandas) | API endpoints below |

Balances are a cache of the ledger: replaying the ledger from a snapshot reproduces them exactly (tested).

## Contract additions (optional / additive)

### Day files: `AgentDay` may add

```json
{ "role": "owner", "worksAt": "s13", "name": "Sam Okafor" }
```

Owners appear in `GET /api/runs/{run}/days/{day}` with `role: "owner"`; their visit to their own shop spans
their working hours. Ordinary citizens omit `role`.

### New `GET /api/runs/{run}/owners` → `OwnerPerson[]`

```json
[{
  "personId": "o13",
  "storeId": "s13",
  "name": "Sam Okafor",
  "home": { "x": -120.5, "z": 88.0 },
  "commuteMinutes": 14,
  "business": { "startGbp": 4000, "endGbp": 4630, "daily": [4000, 4051, "...14 values, end of each day"] },
  "personal": { "startGbp": 1500, "endGbp": 1620, "daily": ["...14"] },
  "totals": { "takingsGbp": 5210, "energyGbp": 610, "rentGbp": 1400, "stockGbp": 1820, "wagesGbp": 760, "drawingsGbp": 0 },
  "status": "trading"
}]
```

`status`: `trading | cautious | bust`. Store-scoped: the owner page shows only its own owner.

### New `GET /api/runs/{run}/ledger?storeId=&day=&limit=` → `LedgerEntry[]`

```json
[{ "t": 3605, "day": 3, "storeId": "s13", "kind": "sale", "amountGbp": 9.0, "account": "business" }]
```

`kind`: `sale | energy | rent | stock | wages | drawings | living`. Amounts signed (+ in, − out). Large result
sets are aggregated by hour when `limit` would be exceeded.

## Frontend

- 3D: owners are drawn as people with a distinct look (an apron colour per store type) walking to work in the
  morning and home at night; the shutter goes up when they arrive.
- Click any person: a small life card (citizen: persona, home → where they went today; owner: name, shop,
  hours worked today, business and personal balance, trend).
- Owner page (`/store/:id`): "Your money this fortnight": business balance line over 14 days with takings and
  costs breakdown, from `/owners` (+ ledger for detail).
- City feed: "Day 9 · Sam closed early: cash is tight" when a money reason drives a decision.

## What makes it memorable (from the design notes)

Scale gets attention; individual stories and counterfactuals are what judges remember.

### 1. Click anyone, read their life (biography)

Every person has a short story built from their own events and ledger, plain English, three to five lines:
"Sam opened Dumbo at 11:00 after a 14-minute walk from Arnold Circus. Busy lunch, quiet afternoon. Roadworks
on Bethnal Green Rd cut takings on Wednesday, so Sam shut at 15:00. Down £40 this week, still trading."
Citizens get the same: where they came from, where they went, what they spent.

New `GET /api/runs/{run}/people/{personId}` → `{ personId, role, name?, persona, home, story: string[], spentGbp?,
balance?: { daily: number[] }, visits: [{ storeId, day, tIn, tOut, spentGbp }] }` (store-scoped data only for
owners; citizens are synthetic archetypes, no real person).

### 2. Intervene: fork the same 14 days

An "Intervene" button with a few levers: close Shoreditch High St station (a day or all fortnight), roadworks
on a chosen street, double the electricity price, a big event at the club, a rainy week. The sim forks from the
baseline snapshot with the intervention applied (same seed, so the only difference is the change) and the UI
shows the two side by side on one clock, with the area deltas.

New `POST /api/interventions` `{ kind, params, baseRun? }` → `{ queuedRun }` (poll /api/runs as for apply);
the run's `run.json` records `intervention: { kind, params, label }` and `GET /api/runs` items may add
`intervention?: { kind, label }`. Kinds: `station_closed | roadworks | energy_price | club_event | rain`.

### 3. Heatmaps

Toggle the 3D ground between wealth (owners' and residents' balances by home), footfall, and missed demand
(people who found a shop shut). From day files + `/owners` (frontend can compute; no new endpoint needed).

### 4. A journalist writes the day's headline

One notable LLM-written character (cheap: one short call per sim day, cached; heuristic fallback offline)
reads the day's area numbers, street events and owner decisions and writes a one-line headline:
"Brick Lane digs up, four shops shut early; club crowd keeps Kebab Co busy till 3."
New `GET /api/runs/{run}/headlines` → `[{ day, text }]`.
