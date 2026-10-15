// UI state for the nightlife + public-safety layer: the Safety heat layer toggle and which building's interior is
// open ("Look inside"). Separate from state/store.ts so the layer stays self-contained.
import { create } from "zustand";

interface SafetyState {
  /** Show the incident-density layer on the ground. */
  heat: boolean;
  /** Store whose interior cutaway is open, or null. */
  insideId: string | null;
  setHeat: (on: boolean) => void;
  setInside: (id: string | null) => void;
}

export const useSafety = create<SafetyState>((set) => ({
  heat: false,
  insideId: null,
  setHeat: (heat) => set({ heat }),
  setInside: (insideId) => set({ insideId }),
}));
