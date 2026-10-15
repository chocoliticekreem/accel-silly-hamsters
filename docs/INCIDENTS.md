# Nightlife and public safety: incidents (spec + contract proposal, v1)

Decided 2026-10-15. The city now has nights out that sometimes go wrong. Clubs (in the mock: Basement 45 and
The Vault, plus XOYO drawn at its real position off the map) have queues, door staff and a spill-out at close.
Incidents happen on the street: fights at closing time, a rare serious assault, thefts, antisocial behaviour,
police chases and road collisions. Police and ambulances respond. A serious incident outside a club triggers a
**licence review** that shuts the club for the next nights, which changes where the night-out crowd goes.

This is **place-based safety**. An incident is a time, a place and the response it drew. It never describes or
predicts a person. See "Responsible design" below and in docs/BUILD_SPEC.md.

## Contract (new, optional, additive)

### `GET /api/runs/{run}/incidents` → `Incident[]`, oldest first

```json
[{
  "id": "inc-6-assault-9",
  "day": 6,
  "t": 7415,
  "kind": "assault",
  "severity": 3,
  "x": 41.2, "z": -96.8,
  "streetId": "redchurch-st",
  "nearStoreId": "c2",
  "label": "Serious assault outside The Vault",
  "response": { "police": true, "ambulance": true, "durationMin": 160 },
  "effects": { "closedStoreId": "c2", "closedDays": 2, "footfallDrop": 0.4, "streetClosedMin": 113 },
  "insideMin": 9,
  "from": null
}]
```

| Field | Meaning |
| --- | --- |
| `day`, `t` | Day of `t` (1-based) and the sim minute the police were called. A 03:00 incident on day 6 belongs to Friday night's session. |
| `kind` | `fight` · `assault` · `theft` · `antisocial` · `chase` · `collision` |
| `severity` | 1 minor · 2 moderate · 3 serious |
| `x`, `z`, `streetId?`, `nearStoreId?` | Where, in map coordinates. `nearStoreId` = the venue or shop it happened outside, if any. |
| `label` | One calm, factual line ("Fight outside The Vault", "Theft reported near Arch Coffee", "Collision at Old St / Brick Ln"). |
| `response` | Whether police and an ambulance attended, and minutes on scene from `t`. |
| `effects.closedStoreId`, `closedDays` | Licence review: the venue is shut for the next `closedDays` nights. Nights start the evening after an early-hours incident (`closureStartDay` in apps/web/src/sim/incidents.ts). |
| `effects.footfallDrop` | 0..1 fewer people on `streetId` while the response is on scene (or the cordon is up). |
| `effects.streetClosedMin` | Minutes the street is cordoned off from `t`. |
| `insideMin?` | Additive: the incident began inside `nearStoreId` this many minutes before `t`; door staff walked it out. |
| `from?` | Additive, chases only: where the pursuit began (it ends at `x`, `z`). |

404 = not served; the UI shows no incidents (client: apps/web/src/api/incidents.ts). Types live in that file until
the backend adopts them; then move them to contract.ts.

### How a licence review reaches the rest of the contract

The closure goes through the existing **`schedule`** of `GET /api/runs/{run}/stores` (docs/OWNER_ACTIONS.md): the
club's `StoreRunResult` gains a schedule entry from the first closed night with those weekdays `null`, and another
from the night after restoring the week. No new field: every consumer of `schedule` (3D shop state, store card,
the sim's customers) sees the club shut. Clubs omit `schedule` when nothing changed, as before.

## Rules (what the backend sim should do; the mock does exactly this)

- **Deterministic per seed and the same in every run** (fixed-seed rule): incidents don't depend on the owners'
  decisions, so two runs still differ only because of decisions.
- **Club fights** cluster at closing time: about two thirds start inside in the last hour before close and are
  walked out (`insideMin` 4–7), the rest flare up in the spill-out up to 40 minutes after close. Rates per club
  per night: Saturday 75%, Friday 60%, Thursday 40%, other nights 8%; every Friday and Saturday has at least one.
- **One serious assault** in week one (the first Friday night), outside a club: police and ambulance, a cordon
  (100–140 min), footfall −40% on the street, and a licence review closing the club for **2 nights**. A rare second
  serious one may happen in week two. In the mock it falls on the club furthest from the demo takeaway, so the demo
  story (Kebab Co feeding the club crowd) keeps its spill-out.
- A club shut by a review has **no incidents and no visits** those nights. The night-out crowd picks among the clubs
  that are open; if none are, they skip the club and go straight to bars and takeaways.
- **Thefts**: daytime (11:00–18:30) at busy shops, cafés, restaurants and the station; 1–2 at weekends.
- **Antisocial behaviour**: late weekend evenings near bars, off-licences and takeaways; police attend half of them.
- **Chases**: one a week, late evening, from the map edge to a stop on a main street.
- **Collisions**: 3–5 a fortnight at junctions (wider roads more often), weekday rush hours or late night; police,
  an ambulance for moderate ones, the junction blocked 25–50 minutes, footfall −20% nearby.
- Response cars come from the south (towards Bishopsgate) along the street graph and take 4–9 minutes;
  ambulances come from the east (towards the Royal London).

## Frontend (built)

| Where | What |
| --- | --- |
| `world/modules/Police.tsx` | Met response cars (white, blue and yellow battenberg, flashing blue light bar with bloom, siren pulse while driving) along the street graph to each call; a second car for serious calls; ambulances; chases (a car pursued along a route until boxed in). |
| `world/modules/Incidents.tsx` | At each live scene: blue-and-white police tape, officers in hi-vis, paramedics, the people involved as neutral figures standing apart, collisions (two stopped cars with hazards, steam, queued traffic), a small label ("Police called · fight outside The Vault"). The **Safety** layer: severity-weighted incident density so far this run. |
| `world/modules/ClubLife.tsx` | Queues behind a rope (building from 21:15, longest Thu–Sat), door staff, lit entrance, name sign and neon trim pulsing with the bass, spill-out at close (or when a serious incident clears the club), roller shutter and a "Closed by licensing" notice. |
| `world/modules/Interiors.tsx` | "Look inside" cutaway (store card button, or click a club): dancefloor, DJ booth and lasers, bar, cloakroom, dancers = the sim's occupancy; cafés seat their customers. A venue fight starts here: the two square up, a ring opens, door staff walk them out. |
| City feed | Incident rows and the licence review ("Licence review · The Vault closed 2 nights"); click plays the moment at 1×. |
| Store card | "Licence review: closed 2 nights after a serious assault outside" on the club. |
| Toolbar | **Safety** chip toggles the density layer (one ground layer at a time with the heatmap). |

## Responsible design

| Risk | How we block it |
| --- | --- |
| Predicting or profiling people | Incidents are places and times only. No person fields (no persona, age, gender, name, agent id); tests assert it. No "who is likely to offend". |
| Graphic or sensational content | No violence shown, no blood, no weapons. A serious incident is "serious assault" with an ambulance and a cordon. A fight is two neutral figures standing apart with officers between them. Copy is checked against a banned-terms list (`BANNED_TERMS`). |
| Blaming a venue or a group | The licence review is an area-level, synthetic effect of the sim; it is labelled synthetic and never used to rank or score venues. Owners never see another venue's incidents. |
| Enforcement use | As for footfall data (BUILD_SPEC misuse table): councils get anonymised area totals only, never per-venue incident lists. |
| Real-world confusion | All incidents are synthetic. The UI says so (feed tooltips, the Safety chip, the store card note). XOYO is drawn at its real address but carries no incidents or data. |
