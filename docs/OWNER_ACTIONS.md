# Self-learning city: owners who act like owners (spec + contract, v1)

Decided 2026-10-15. Goal: a **self-learning city**. Today the shops only change between runs, when the analyst
applies an experiment. From now on every shop's owner also lives through the 14 days and reacts the way a
real owner would, day by day. Two learning loops:

| Loop | Who | Time scale | Learns from |
| --- | --- | --- | --- |
| Inner | One owner agent per shop (rule-based, cheap; optional weekly LLM review) | End of every sim day, inside a run | Its own day: footfall outside, visits, people who found it shut, energy, street events |
| Outer | The analyst (Opus) + store agents | Between runs | Run results, the owners' own adaptations, the notebook |

The fixed seed still holds: the same 14 days of arrivals, so two runs differ only because of decisions.

## What an owner can do (end of each day, applies from the next morning unless "today")

| Action | Example trigger | Example reason (one line, owner voice) |
| --- | --- | --- |
| `hours_changed` | Missed demand after close; empty first/last hours | "People kept finding us shut after 23:00, staying open till 01:00." |
| `day_closed` | A weekday with almost no visits two weeks running | "Mondays are dead, closing Mondays." |
| `day_reopened` | Footfall on a closed day picks up | "Busy Mondays again, opening." |
| `shut_early` (today) | Heavy traffic / roadworks / disruption cutting footfall | "Roadworks outside, nobody can get in, shutting at 15:00." |
| `open_late` (today) | A club night or event spilling past close | "Club crowd outside, staying open till 03:00 tonight." |
| `temporary_closure` | Street closed for N days | "Street closed for works, closed until Thursday." |
| `lighting_changed` | Lights burning while shut or nobody passing | "Window lights off after close." |
| `closed_permanently` | Losing money N weeks in a row (rare, never in run 1 of a session) | "Not enough trade to cover costs, closing for good." |

Hard rules still apply (backend/agents/rules.py): never outside the licence, never cross-store
coordination, never use another shop's data.

## Street events (what owners react to)

Inputs the owners and citizens both see, per day: `roadworks` (a street segment closed or narrowed;
footfall on it drops), `heavy_traffic` (busy roads, slower walking, fewer stops), `club_night`, `event`
(market, gig), `weather` (rain). Sources: TfL road disruptions / roadworks, club and event listings,
Met Office. In the sim they are deterministic per seed.

## Contract additions (all optional / additive; old clients keep working)

### `GET /api/runs/{run}/stores` → each `StoreRunResult` may add

```json
{
  "schedule": [
    { "fromDay": 1, "week": [{"open":"07:00","close":"18:00"}, {"open":"07:00","close":"18:00"}, null, "...7 entries Mon..Sun, null = closed"] },
    { "fromDay": 8, "week": ["...the schedule the owner switched to on day 8"] }
  ],
  "closedFromDay": null
}
```

- `schedule`: the shop's weekly opening as it changed over the run, oldest first. Absent = `open`/`close` every day (today's behaviour). Day 1 = Monday.
- `closedFromDay`: the day the shop closed for good, else `null`.
- `open`/`close` stay as the run's starting hours (unchanged meaning).

### New `GET /api/runs/{run}/owner-events` → `OwnerEvent[]`, oldest first

```json
[
  {
    "day": 3,
    "t": 3600,
    "storeId": "s13",
    "action": "shut_early",
    "from": "23:00",
    "to": "15:00",
    "reason": "Roadworks outside, nobody can get in, shutting at 15:00.",
    "trigger": { "kind": "roadworks", "value": 0.62, "label": "footfall −62% vs usual" }
  }
]
```

- `action`: one of the table above. `from`/`to`: hours, weekday names or lighting levels, as fits the action (may be absent).
- `trigger.kind`: `missed_demand | empty_hours | dead_day | roadworks | heavy_traffic | club_night | event | weather | losses | lights_waste`.
- Store-scoped data is fine here: this endpoint is the area view (us, judges); the owner page only shows its own shop's events.

### New `GET /api/runs/{run}/street-events` → `StreetEvent[]`

```json
[{ "day": 3, "fromT": 3300, "toT": 4600, "kind": "roadworks", "streetId": "bethnal-green-road", "label": "Roadworks, Bethnal Green Rd", "severity": 0.6 }]
```

## Frontend

- 3D: a shop's open/closed state and lighting follow `schedule` / `closedFromDay` / `owner-events` (today-only actions) at the current time; roadworks render on the street (barriers, cones); a closed-for-good shop shows boarded windows.
- City feed (area view): a live ticker of owner decisions at the current sim time ("Day 3 · 15:00 · Kebab Co shut early: roadworks outside").
- Store card / owner page: the week grid (Mon–Sun × hours) and "What I changed this fortnight" from the shop's events.
- Learning curve: per-day KPI for the run (owners adapting inside the run) next to the per-run curve (the analyst learning across runs).
