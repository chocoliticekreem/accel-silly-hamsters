// Store type icons (Lucide). The spec bans emoji in the UI; every type gets a line icon instead.
import { Beer, Coffee, Music, Sandwich, ShoppingBag, UtensilsCrossed, Wine, type LucideIcon } from "lucide-react";
import type { StoreType } from "../api/contract";

export const TYPE_ICON: Record<StoreType, LucideIcon> = {
  cafe: Coffee,
  restaurant: UtensilsCrossed,
  takeaway: Sandwich,
  bar: Beer,
  shop: ShoppingBag,
  offlicence: Wine,
  club: Music,
};

export function TypeIcon({ type, size = 18 }: { type: StoreType; size?: number }) {
  const I = TYPE_ICON[type];
  return <I size={size} strokeWidth={1.8} aria-hidden />;
}
