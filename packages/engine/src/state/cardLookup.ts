import type { Ability, CardData, Faction, LocationType } from "../types";
import type { CardInstance } from "./cards";

// CardInstance carries only defRef/kind, not the static definition — these
// helpers resolve it from CardData on demand, keeping the reducer
// data-driven (a future variant's card_data.json works unmodified) rather
// than baking any specific card set into the engine.
export function hasAttribute(
  cardData: CardData,
  card: CardInstance,
  attribute: "Protected" | "Blend",
): boolean {
  if (card.kind === "motorcade") return false;
  const defs = card.kind === "leader" ? cardData.leaders : cardData.non_leader_cards;
  const def = defs.find((d) => d.name === card.defRef);
  return def?.attributes.includes(attribute) ?? false;
}

export function getAllowedLocationTypes(cardData: CardData, card: CardInstance): readonly LocationType[] {
  if (card.kind === "motorcade") return [];
  const defs = card.kind === "leader" ? cardData.leaders : cardData.non_leader_cards;
  const def = defs.find((d) => d.name === card.defRef);
  return def?.locations ?? [];
}

// Motorcade has no faction of its own (it's not a character); returns
// undefined for it rather than a placeholder value.
export function getFaction(cardData: CardData, card: CardInstance): Faction | undefined {
  if (card.kind === "motorcade") return undefined;
  const defs = card.kind === "leader" ? cardData.leaders : cardData.non_leader_cards;
  return defs.find((d) => d.name === card.defRef)?.faction;
}

// The raw (free-text) ability list from card_data.json — used to validate
// e.g. "is this actually an Activate ability" before looking up its
// structured effects in abilityEffects.ts.
export function getAbilities(cardData: CardData, card: CardInstance): readonly Ability[] {
  if (card.kind === "motorcade") return [];
  const defs = card.kind === "leader" ? cardData.leaders : cardData.non_leader_cards;
  const def = defs.find((d) => d.name === card.defRef);
  return def?.abilities ?? [];
}
