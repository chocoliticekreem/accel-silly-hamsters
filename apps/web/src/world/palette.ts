// One place for every colour the 3D scene and the UI legend share.
import type { BuildingKind, LightLevel, StoreType } from "../api/contract";

export const PERSONA_COLORS: Record<string, string> = {
  commuter: "#3987e5",
  resident: "#199e70",
  student: "#c98500",
  shopper: "#d55181",
  "night-owl": "#9085e9",
  tourist: "#008300",
  foodie: "#e66767",
  "passer-by": "#7d8aa0",
};
export const PERSONA_FALLBACK = "#b8c1d1";
/** Backend persona ids (data/processed/personas.json) folded into the colour families above. */
export const PERSONA_ALIASES: Record<string, string> = {
  "morning-commuter": "commuter",
  "office-worker": "commuter",
  "local-resident": "resident",
  "remote-worker": "student",
  "student-creative": "student",
  "weekend-shopper": "shopper",
  "evening-diner": "foodie",
  "after-work-drinker": "foodie",
  "late-shift-worker": "passer-by",
};
export const personaColor = (p: string) => PERSONA_COLORS[p] ?? PERSONA_COLORS[PERSONA_ALIASES[p]] ?? PERSONA_FALLBACK;

/** Soft pastel store bodies; awnings use the stronger accent. */
export const STORE_COLORS: Record<StoreType, { body: string; awning: string }> = {
  cafe: { body: "#e9d8c4", awning: "#c9784a" },
  restaurant: { body: "#e7cfcf", awning: "#b5525a" },
  takeaway: { body: "#efe0b8", awning: "#d99a2b" },
  bar: { body: "#cfd6e8", awning: "#4f6bb0" },
  shop: { body: "#d6e6dc", awning: "#4f9a78" },
  offlicence: { body: "#e3d9ec", awning: "#7d5aa6" },
  club: { body: "#3a3150", awning: "#e04fd0" },
};

export const BUILDING_COLORS: Record<BuildingKind, string> = {
  residential: "#9a5b45",
  office: "#9fb0c4",
  station: "#c9ced6",
  store: "#e0d6c8",
  club: "#3a3150",
};

export const LAMP = "#ff9a3d"; // warm sodium shop light, also the UI accent (--lamp in styles.css)
export const LIGHT_INTENSITY: Record<LightLevel, number> = { off: 0, low: 0.55, high: 1 };

export const GROUND = { grass: "#7d917a", pavement: "#b9bec6", asphalt: "#5b6270", marking: "#e8e2cf" };
