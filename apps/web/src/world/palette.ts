// One place for every colour the 3D scene and the UI legend share.
import type { BuildingKind, LightLevel, StoreType } from "../api/contract";

export const PERSONA_COLORS: Record<string, string> = {
  commuter: "#7fb2ff",
  resident: "#9be0b4",
  student: "#ffb37a",
  shopper: "#f7a1c4",
  "night-owl": "#c79bff",
  tourist: "#ffe08a",
  foodie: "#ff8f8f",
};
export const PERSONA_FALLBACK = "#d8dee9";
export const personaColor = (p: string) => PERSONA_COLORS[p] ?? PERSONA_FALLBACK;

/** Soft pastel store bodies; awnings use the stronger accent. */
export const STORE_COLORS: Record<StoreType, { body: string; awning: string; icon: string }> = {
  cafe: { body: "#e9d8c4", awning: "#c9784a", icon: "☕" },
  restaurant: { body: "#e7cfcf", awning: "#b5525a", icon: "🍽" },
  takeaway: { body: "#efe0b8", awning: "#d99a2b", icon: "🥙" },
  bar: { body: "#cfd6e8", awning: "#4f6bb0", icon: "🍺" },
  shop: { body: "#d6e6dc", awning: "#4f9a78", icon: "🛍" },
  offlicence: { body: "#e3d9ec", awning: "#7d5aa6", icon: "🍾" },
  club: { body: "#3a3150", awning: "#e04fd0", icon: "🎧" },
};

export const BUILDING_COLORS: Record<BuildingKind, string> = {
  residential: "#b9a79a",
  office: "#9fb0c4",
  station: "#c9ced6",
  store: "#e0d6c8",
  club: "#3a3150",
};

export const LAMP = "#ffc857"; // the warm lit-window yellow, also the UI accent
export const LIGHT_INTENSITY: Record<LightLevel, number> = { off: 0, low: 0.55, high: 1 };

export const GROUND = { grass: "#7d917a", pavement: "#b9bec6", asphalt: "#5b6270", marking: "#e8e2cf" };
