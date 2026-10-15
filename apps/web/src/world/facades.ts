// Where each shop's street facade really is: RealBuildings measures it on the store's matched OpenStreetMap polygon
// (metres from the map box centre along its frontage normal) and publishes it here, so ClubLife puts signs, doors,
// queues and door staff on the real wall instead of on the map box (which can sit inside a bigger real building or
// reach into the road). Without the real city, the box's own face is used.
import { create } from "zustand";

interface Facades {
  /** storeId → facade offset (m) from the box centre toward the street. */
  front: Record<string, number>;
}

export const useFacades = create<Facades>(() => ({ front: {} }));
