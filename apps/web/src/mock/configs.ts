// Store configs per run. Run 1 = how owners run their shops today (habit). Each later run applies the
// analyst's next experiment batch on top. This is the mock's stand-in for the optimizer.
import type { CityMap, LightLevel, StoreType } from "../api/contract";
import { isOpenAt, parseHHMM } from "../sim/time";
import { demoRoles } from "./roles";
import { rng, seedOf } from "./rng";

export interface StoreConfig {
  open: string;
  close: string;
  lighting: LightLevel[];
}
export type RunConfig = Record<string, StoreConfig>;

/** Habitual hours and lighting by type: lights on long after close, closing before the club crowd. */
const DEFAULTS: Record<StoreType, { open: string; close: string; lightOn: number; lightOff: number }> = {
  cafe: { open: "07:00", close: "18:00", lightOn: 6, lightOff: 21 },
  restaurant: { open: "11:30", close: "23:00", lightOn: 11, lightOff: 24 },
  takeaway: { open: "11:00", close: "23:00", lightOn: 10, lightOff: 24 },
  bar: { open: "16:00", close: "00:00", lightOn: 15, lightOff: 25 },
  shop: { open: "10:00", close: "19:00", lightOn: 8, lightOff: 24 },
  offlicence: { open: "08:00", close: "22:00", lightOn: 7, lightOff: 24 },
  club: { open: "22:00", close: "03:00", lightOn: 21, lightOff: 28 },
};

/** Premises licence by type (hard rule): no run may open outside these hours. */
export const LICENCE: Record<StoreType, { open: string; close: string }> = {
  cafe: { open: "06:00", close: "23:00" },
  restaurant: { open: "10:00", close: "01:00" },
  takeaway: { open: "07:00", close: "04:00" },
  bar: { open: "11:00", close: "02:00" },
  shop: { open: "07:00", close: "23:00" },
  offlicence: { open: "06:00", close: "05:00" },
  club: { open: "21:00", close: "05:00" },
};

const lit = (from: number, to: number, level: LightLevel = "high"): LightLevel[] =>
  Array.from({ length: 24 }, (_, h) => (h >= from && h < to) || (to > 24 && h < to - 24) ? level : "off");

export function baseline(map: CityMap): RunConfig {
  const cfg: RunConfig = {};
  const lateClub = demoRoles(map).lateClub?.id;
  for (const s of map.stores) {
    const d = DEFAULTS[s.type];
    const r = rng(seedOf("base", s.id));
    const lighting = lit(d.lightOn, d.lightOff);
    // some owners leave the window lit all night
    if (s.type !== "club" && r() < 0.35) lighting.fill("high");
    cfg[s.id] = { open: d.open, close: s.id === lateClub ? "04:00" : d.close, lighting };
  }
  return cfg;
}

export interface Experiment {
  /** One-line lab notebook label, e.g. "Opened Kebab Co till 03:00" (store names from the map's demo roles). */
  label: string;
  apply: (cfg: RunConfig, map: CityMap) => void;
}

const ofType = (map: CityMap, ...types: StoreType[]) => map.stores.filter((s) => types.includes(s.type));

function setLights(c: StoreConfig, hours: number[], level: LightLevel) {
  for (const h of hours) c.lighting[h] = level;
}

function closedHours(c: StoreConfig) {
  return Array.from({ length: 24 }, (_, h) => h).filter((h) => !isOpenAt(c.open, c.close, h * 60 + 30));
}

/** Lights off while closed, except one hour either side (cleaning, window display). */
function lightsOffWhenClosed(c: StoreConfig) {
  const o = Math.floor(parseHHMM(c.open) / 60);
  const cl = Math.floor(parseHHMM(c.close) / 60);
  setLights(
    c,
    closedHours(c).filter((h) => h !== (o + 23) % 24 && h !== cl % 24),
    "off",
  );
}

/** The analyst's experiment plan, one batch per run after run 1. The last two barely move the KPI → plateau. */
export function experiments(map?: CityMap): Experiment[] {
  const roles = map ? demoRoles(map) : null;
  const takeaway = roles?.takeaway.name ?? "Kebab Co";
  const offie = roles?.offlicence.name ?? "Night Owl Offie";
  const cafe = roles?.cafe.name ?? "Arch Coffee";
  const late = roles ? roles.lateTakeaway?.name : "Late Pizza";
  return [
    {
      label: "Shop windows dark after close",
      apply: (cfg, map) => ofType(map, "shop").forEach((s) => lightsOffWhenClosed(cfg[s.id])),
    },
    {
      label: `Opened ${takeaway} till 03:00, low light 23–03`,
      apply: (cfg, map) => {
        const c = cfg[demoRoles(map).takeaway.id];
        c.close = "03:00";
        setLights(c, [23, 0, 1, 2], "low");
      },
    },
    {
      label: "Daytime lights high → low (cafes, restaurants)",
      apply: (cfg, map) =>
        ofType(map, "cafe", "restaurant").forEach((s) => setLights(cfg[s.id], [9, 10, 11, 12, 13, 14, 15, 16].filter((h) => cfg[s.id].lighting[h] === "high"), "low")),
    },
    {
      label: `${offie} till 04:30, ${cafe} opens 06:30`,
      apply: (cfg, map) => {
        const o = demoRoles(map).offlicence;
        cfg[o.id].close = "04:30";
        setLights(cfg[o.id], [0, 1, 2, 3, 4], "low");
        const a = demoRoles(map).cafe;
        cfg[a.id].open = "06:30";
      },
    },
    {
      label: "Everyone dark after close (except late takeaways)",
      apply: (cfg, map) => ofType(map, "cafe", "restaurant", "bar", "offlicence").forEach((s) => lightsOffWhenClosed(cfg[s.id])),
    },
    {
      label: late ? `${late} till 02:00, restaurants close 22:00` : "Restaurants close 22:00",
      apply: (cfg, map) => {
        const p = demoRoles(map).lateTakeaway;
        if (p) {
          cfg[p.id].close = "02:00";
          setLights(cfg[p.id], [22, 23, 0, 1], "low");
        }
        ofType(map, "restaurant").forEach((s) => {
          cfg[s.id].close = "22:00";
          lightsOffWhenClosed(cfg[s.id]);
        });
      },
    },
    {
      label: "Bars low light after 23:00",
      apply: (cfg, map) => ofType(map, "bar").forEach((s) => setLights(cfg[s.id], [23, 0].filter((h) => cfg[s.id].lighting[h] === "high"), "low")),
    },
  ];
}

export const MOCK_RUN_COUNT = experiments().length + 1; // 8

export function configForRun(map: CityMap, run: number): RunConfig {
  const cfg = structuredClone(baseline(map));
  experiments(map)
    .slice(0, Math.max(0, run - 1))
    .forEach((e) => e.apply(cfg, map));
  return cfg;
}

export function notebookLabel(run: number, map?: CityMap): string {
  return run <= 1 ? "Baseline: owners' current hours and lighting" : experiments(map)[run - 2].label;
}
