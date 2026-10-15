# Frontend design — Smart City Sim v1

Source of truth for requirements: [../../FRONTEND_PROMPT.md](../../FRONTEND_PROMPT.md). Product context: [../../BUILD_SPEC.md](../../BUILD_SPEC.md).

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Location | `apps/web` (npm workspace) | Backend can sit in `apps/api` later |
| Stack | Vite + React 19 + TS, R3F + drei + postprocessing, zustand, Recharts, vitest | As specified; zustand for low-frequency UI state |
| 3D structure | Module registry like hamyway-city: `world/modules/<Name>.tsx`, each in a `ModuleBoundary`, `?only=` / `?skip=` URL flags | One broken module never kills the scene; teammates own modules independently |
| Contract | `src/api/contract.ts` is the only place shapes live | One file to diff against the backend |
| Mock vs real | `src/api/client.ts` picks `mockApi` or `httpApi` from `VITE_API_URL` | One switch, same interface |
| Mock data | Deterministic generator that actually simulates agents choosing open, lit stores; KPIs are computed from the generated visits | Numbers on screen agree with what you see in 3D |
| Mock runs | 8 runs improving then plateauing; analyst stopped on `threshold` | History chart needs a visible plateau (`MOCK_RUN_COUNT` is a constant) |
| Clock | One `t` in the store, driven by a rAF loop outside the canvas | Compare mode can render two canvases on one clock |
| Speed | 100× = 14 days in 60 s; 10× and 1× scale from that | Matches spec |
| Agents | One `InstancedMesh` of capsules, instance colour by persona, per-frame interpolation with cached segment index | 300–600 agents at 60 fps |
| Day data | Load day `d` and `d-1` (night spill-over), prefetch `d+1` | Spec: one day at a time + prefetch |
| Store glow | Emissive facade + additive ground glow, bloom post-processing | No per-store point lights (cheap) |

## Units

- `api/` — contract types, http client, client switch.
- `mock/` — rng, map generator, run configs (the analyst's experiments), day simulation, mock API.
- `sim/` — pure helpers: time formatting, opening-hours maths, path interpolation, sky palette. Unit tested.
- `state/` — zustand store, data hooks with cache + prefetch, playback clock.
- `world/` — `World.tsx` canvas + module registry; modules: Sky, Ground, Streets, Buildings, Stores, StreetLights, Agents, CameraRig.
- `ui/` — Hud, PlaybackBar, AnalystChip, StoreCard (HourStrip, Suggestions), HistoryPanel, OwnerReport, CompareView.

## Testing

vitest on `sim/*` and `mock/*` (shape + invariants: lighting has 24 values, paths are time-ordered, KPIs improve run 1 → best). Manual browser check of the demo flow.
