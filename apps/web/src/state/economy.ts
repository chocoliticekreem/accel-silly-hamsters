// UI state and data hooks for the people + economy layer (docs/PEOPLE_ECONOMY.md): the picked person, the
// heatmap layer and the intervention compare pair. Kept apart from state/store.ts so the two can evolve separately.
import { create } from "zustand";
import { economyApi, type CitizenDiary, type CitizenIndex, type Headline, type OwnerPerson, type PersonStory, type RunIntervention } from "../api/economy";
import { useResource } from "./data";

export type HeatmapLayer = null | "wealth" | "footfall" | "missed";

export interface ComparePair {
  base: number;
  other: number;
  label: string;
}

interface EconomyState {
  /** The person whose life card is open (base id: regulars' trips r12, r12~lunch share "r12"). */
  personId: string | null;
  heatmap: HeatmapLayer;
  /** Compare mode shows this pair (an intervention vs its baseline) instead of baseline vs best. */
  comparePair: ComparePair | null;
  selectPerson: (id: string | null) => void;
  setHeatmap: (h: HeatmapLayer) => void;
  setComparePair: (p: ComparePair | null) => void;
}

export const useEconomy = create<EconomyState>((set) => ({
  personId: null,
  heatmap: null,
  comparePair: null,
  selectPerson: (personId) => set({ personId }),
  setHeatmap: (heatmap) => set({ heatmap }),
  setComparePair: (comparePair) => set({ comparePair }),
}));

/** A trip id → the person it belongs to. */
export const personOf = (agentId: string) => agentId.split("~")[0];

export const useOwners = (run: number | null) => useResource<OwnerPerson[]>(run == null ? null : `econ:owners:${run}`, () => economyApi.owners(run!));
export const usePersonStory = (run: number, personId: string | null) =>
  useResource<PersonStory | null>(personId ? `econ:person:${run}:${personId}` : null, () => economyApi.person(run, personId!));
export const useHeadlines = (run: number | null) => useResource<Headline[]>(run == null ? null : `econ:headlines:${run}`, () => economyApi.headlines(run!));
export const useCitizens = (run: number | null) => useResource<CitizenIndex | null>(run == null ? null : `econ:citizens:${run}`, () => economyApi.citizens(run!));
export const useDiary = (run: number, id: string | null) =>
  useResource<CitizenDiary | null>(id ? `econ:diary:${run}:${id}` : null, () => economyApi.diary(run, id!));
export const useInterventions =() => useResource<Record<number, RunIntervention>>("runs:econ:interventions", () => economyApi.interventions());
