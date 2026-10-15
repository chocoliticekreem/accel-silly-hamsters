# Smart City Sim · Shoreditch

A team of Claude agents lives 14 days of Shoreditch overnight and tells independent shops when to open and how to light their store. This repo holds the **frontend**: a cartoon 3D city, the run HUD, store cards, the training history and the owner's weekly report.

- Product spec: [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md)
- Frontend brief and **data contract**: [docs/FRONTEND_PROMPT.md](docs/FRONTEND_PROMPT.md)
- Design decisions: [docs/superpowers/specs/2026-10-15-frontend-design.md](docs/superpowers/specs/2026-10-15-frontend-design.md)

## Quickstart

```bash
npm install
npm run dev        # http://localhost:5173, runs on built-in mock data
npm test           # vitest: time maths, interpolation, sky, mock contract
npm run build
```

To use the real backend, set `VITE_API_URL` in `apps/web/.env.local` (see `.env.example`). Leaving it unset uses the mock data.

## Demo flow

| Step | Do |
|---|---|
| 1 | Open `?t=7365&store=s1`: Saturday 02:45, run 1, Kebab Co is **closed and dark** next to the club |
| 2 | The store card shows the suggestions: `Close 23:00 → 03:00`, `Light 00–03: off → low` |
| 3 | **Weekly report** → Approve / Reject per change, £/week, confidence, evidence, PDF |
| 4 | **History**: visits/kWh climbs, then plateaus at the stop line. Click a run to replay it |
| 5 | **Run 1 vs best**: split screen on one clock and one camera |

Keys: `space` play/pause · `←/→` ±1 h (`shift` ±1 day) · `1 2 3` speed · `esc` close.
URL flags: `?run=` `?t=` `?store=` jump straight to a moment. `?only=Sky,Ground` / `?skip=Glow` toggle 3D modules.

## Layout (`apps/web/src`)

```
api/       contract.ts (every shape, one file) · http.ts (real backend) · client.ts (mock/real switch)
mock/      seeded map, persona sim, analyst experiments, mock API (same interface as http.ts)
sim/       pure helpers: time, path interpolation, sky palette, street frontage (unit tested)
state/     zustand store (run, t, selection, panels) · shared playback clock · cached data hooks
world/     World.tsx registry + modules/ (Sky, Ground, Streets, Buildings, Stores, StreetLights, Agents, CameraRig, Glow)
ui/        Hud, AnalystChip, PlaybackBar, StoreCard, HourStrip, SuggestionList, HistoryPanel, OwnerReport, CompareView
```

**Adding a 3D module:** create `world/modules/<Name>.tsx`. It default-exports a component that reads `useWorld()` (map, run, store results, live occupancy) and `useSim.getState().t` inside `useFrame`. Add it to `MODULES` in `World.tsx`. Each module runs inside its own error boundary, so a crash removes only that module.

**Per-frame rule:** never put per-frame data in React state. Read `t` with `useSim.getState()` in `useFrame` and share live facts through `useWorld().live`.

## Mock data

`mock/` builds the contract shapes from a deterministic simulation (seed 42), so the numbers in the HUD agree with what happens in 3D:

- **Map:** 500 m × 500 m street grid, 25 stores, 2 clubs, 1 station, 4 street entry points.
- **People:** about 200 regulars with memory across days (they avoid shops they found shut), plus one-off tourists, foodies, clubbers and passers-by. That is about 1–3.5k trips per day.
- **Runs:** run 1 is the owners' current habits. Each later run applies the analyst's next experiment. Visits/kWh goes 0.99 → 1.30 over 8 runs and then plateaus, so the analyst stops on `threshold`.
- **Suggestions / report:** the diff from the chosen run to the best run. Lighting kWh deltas come exactly from the energy model, and £/week is gross margin minus energy cost.

Coordinates follow the contract (x = east, z = north). The scene maps them with `toScene()` in `sim/geometry.ts`.
