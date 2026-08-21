import type { CardData } from "../types";
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
