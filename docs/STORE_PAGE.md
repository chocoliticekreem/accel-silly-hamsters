# Store page and overview (product spec, v1)

Decided 2026-10-15. Two pages, scoped by URL:

| URL | Who it is for | What it shows |
| --- | --- | --- |
| `/` | Us, BIDs, later councils ("government" view) | The whole area: the 3D city, area energy, CO2, peak demand, footfall, training history. Anonymised area totals. |
| `/store/:storeId` | One shop owner (the paying customer) | A plain-English weekly report for that shop: headline, three numbers, 1–3 pieces of advice with Apply, the run history. Granular analytics only behind "Details". |

## The owner's loop

1. Every run produces a report for the shop.
2. The owner (or "Optimise for me") applies the advice. The sim reruns the same 14 days with the change (about 2 s) and stores the run.
3. The next report says whether it worked: customers, energy cost and profit against the shop's original settings and against the previous run.
4. Over-optimisation is expected: a later run can be worse, or the advice can drift back toward the original settings. When gains stop (below the threshold for the patience window) or a run would revisit settings already tried, the loop stops and marks the best run for that shop. Every run is kept so any two can be compared.

## Writing for owners

- Lead with one sentence of advice, not a metric. "Stay open until 03:30 on Thu–Sat: about 70 more customers a week."
- Three numbers only on the main view: customers a week, energy cost a week (£), electricity a week (kWh). Each shows the change vs the shop's original settings.
- Advice items are plain sentences with a £/week figure and how sure we are ("likely", "worth testing", "uncertain"). No jargon beyond kWh. No percentiles, funnels or hourly charts on the main view; those live under "Details".
- Always say "simulated, not guaranteed".
- No emoji anywhere in the UI.

## API: `GET /api/stores/{storeId}/overview?run=`

One call renders the store page. `run` defaults to the shop's best run, else the latest run.

```json
{
  "storeId": "s13",
  "name": "Dumbo Shoreditch",
  "type": "takeaway",
  "run": 7,
  "baselineRun": 1,
  "bestRun": 6,
  "status": "best_found",
  "headline": "Stay open until 03:30 on club nights: about 70 more customers a week.",
  "numbers": {
    "customersPerWeek": { "value": 134, "change": 0.33 },
    "energyCostPerWeekGbp": { "value": 48.0, "change": 0.12 },
    "kwhPerWeek": { "value": 160.0, "change": 0.12 },
    "profitChangePerWeekGbp": 93.0
  },
  "advice": [
    {
      "text": "Stay open until 03:30. About 70 people a week find you shut after 22:30, most of them leaving the club next door.",
      "gbpPerWeek": 93.0,
      "certainty": "worth testing",
      "status": "new",
      "suggestion": { "storeId": "s13", "field": "close", "from": "22:30", "to": "03:30", "expectedDelta": { "visits": 0.33, "kwh": 0.31 } }
    }
  ],
  "history": [
    { "run": 1, "label": "Your current settings", "customersPerWeek": 100, "kwhPerWeek": 143.0, "profitChangePerWeekGbp": 0.0, "changes": [], "best": false },
    { "run": 6, "label": "Open till 03:30", "customersPerWeek": 134, "kwhPerWeek": 160.0, "profitChangePerWeekGbp": 93.0, "changes": ["Close 22:30 → 03:30"], "best": true }
  ],
  "note": "Simulated, not guaranteed."
}
```

- `status`: `not_started` (only the baseline exists), `improving` (the last run beat the best before it), `best_found` (the loop stopped; `bestRun` is the pick).
- `numbers.*.change` is a fraction vs the baseline run (0.33 = +33%); `profitChangePerWeekGbp` is margin on extra customers minus extra energy cost vs the baseline (`backend/economics.py`).
- `advice[].status`: `new`, `applied` (in this run's settings), `tested_better`, `tested_worse` (an earlier run tried it).
- `advice[].certainty`: plain words mapped from confidence: high → "likely", medium → "worth testing", low → "uncertain".
- `history`: every run that changed this shop's settings, plus the baseline, oldest first, with a short human label.
- Data firewall: only this shop's numbers; no other shop's id, name or figures.

## API: optimise one shop

- `POST /api/stores/{storeId}/optimize` body `{ "maxRuns"?: 6 }` → starts a training session scoped to this shop (only its settings change; the objective is this shop's profit change per week); returns the analyst status. 409 while a session runs; 403 on the hosted read-only demo.
- `POST /api/apply` (existing) with `scope: "store"` applies the current advice and reruns.

## Frontend

- Routing: `/` and `/store/:storeId` (deep-linkable; the store card's "Open report" goes to `/store/:id`).
- Built with the component library (shadcn/ui on Radix, Lucide icons), the new type and colour tokens, and no emoji.
- The 3D city stays on `/`; the store page may show a small view of the shop's block but is mostly cards.
