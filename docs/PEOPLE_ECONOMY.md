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
