// Quick travel + landmark interiors: which place the camera went to, whether its multi-floor cutaway is open, and
// which floor is shown. The 3D side (world/modules/Landmarks) and the "Go to" bar (ui/TravelBar) both read it.
// Opening a landmark that is also a sim store (XOYO) keeps the existing "Look inside" state (state/safety) in step,
// so the store card's "Back outside" button and the Interiors module agree with this slice.
import { create } from "zustand";
import { useSafety } from "./safety";

interface TravelState {
  /** Key of the place last travelled to (world/landmarks/places), or null. */
  focusPlace: string | null;
  /** The focus place's multi-floor interior is open. */
  interiorOpen: boolean;
  /** Selected floor index (0 = lowest level, e.g. XOYO's basement). */
  floor: number;
  /** Floors in the open interior (for clamping). */
  floorCount: number;
  /** Store backing the open interior, if the place is a sim store. */
  storeId: string | null;
  /** The "Go to" menu is open (number keys travel while it is). */
  menuOpen: boolean;

  go: (key: string) => void;
  enter: (key: string, opts: { floors: number; floor?: number; storeId?: string | null }) => void;
  exit: () => void;
  setFloor: (floor: number) => void;
  stepFloor: (delta: number) => void;
  setMenu: (open: boolean) => void;
}

export const useTravel = create<TravelState>((set, get) => ({
  focusPlace: null,
  interiorOpen: false,
  floor: 0,
  floorCount: 0,
  storeId: null,
  menuOpen: false,

  go: (focusPlace) => {
    if (get().interiorOpen && get().focusPlace !== focusPlace) get().exit();
    set({ focusPlace });
  },
  enter: (focusPlace, { floors, floor, storeId = null }) => {
    const f = Math.max(0, Math.min(floors - 1, floor ?? 0));
    set({ focusPlace, interiorOpen: true, floorCount: floors, floor: f, storeId });
    if (storeId && useSafety.getState().insideId !== storeId) useSafety.getState().setInside(storeId);
  },
  exit: () => {
    const { storeId, interiorOpen } = get();
    if (!interiorOpen) return;
    set({ interiorOpen: false, storeId: null });
    if (storeId && useSafety.getState().insideId === storeId) useSafety.getState().setInside(null);
  },
  setFloor: (floor) => set({ floor: Math.max(0, Math.min(get().floorCount - 1, floor)) }),
  stepFloor: (delta) => get().setFloor(get().floor + delta),
  setMenu: (menuOpen) => set({ menuOpen }),
}));
