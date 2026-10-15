// Hero model loader for React: `useHeroModel(name)` returns the (cached) procedural model plus a fresh
// THREE.Group for it (geometry and materials shared, so many copies are cheap). The group's name is the model
// name (e.g. "landmark-xoyo"); animatable nodes are named children (wheels, lamps, doors, crane slew).
// Models are built in code (world/models), so there is nothing to download or preload.
import { useMemo } from "react";
import type { Group } from "three";
import { HERO_CATALOG, heroModel, type HeroModel } from "./models";
import { heroObject } from "./models/materials";

export interface HeroHandle {
  model: HeroModel;
  object: Group;
}

const objects = new Map<string, Group>();

/** A Group for the named hero model (cloned per call site; nodes keep their names). */
export function heroGroup(name: string): Group {
  let base = objects.get(name);
  if (!base) objects.set(name, (base = heroObject(heroModel(name))));
  const g = base.clone();
  g.name = name;
  return g;
}

export function useHeroModel(name: string): HeroHandle | null {
  return useMemo(() => {
    if (!HERO_CATALOG[name]) return null;
    return { model: heroModel(name), object: heroGroup(name) };
  }, [name]);
}
