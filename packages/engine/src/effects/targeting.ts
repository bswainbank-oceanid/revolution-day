import { getFaction } from "../state/cardLookup";
import type { CardInstance } from "../state/cards";
import type { GameState } from "../state/game";
import type { CardData } from "../types";
import type { TargetSelector } from "./dsl";

// Resolves which card instances a filter-based TargetSelector could
// legally pick from, given the source card doing the choosing. Only
// filter-based selectors are handled here — "self"/"binding" refs resolve
// directly, not through eligibility filtering.
//
// Deliberately incomplete for now, both documented gaps rather than
// oversights (see rev_day_engine_design memory): does NOT enforce
// Protected-immunity (needs the protected-targeting reveal window, not
// built yet), does NOT support `selection: "random"` (needs Suicide
// Bomber-style pool/fallback logic), and can't resolve `kind: "president"`
// (the President isn't a CardInstance in `state.cards`, so no ability
// targeting him specifically can be encoded yet).
export function resolveEligibleTargets(
  state: GameState,
  cardData: CardData,
  selector: Extract<TargetSelector, { ref: "filter" }>,
  sourceCard: CardInstance,
): CardInstance[] {
  return state.cards.filter((card) => {
    if (card.id === sourceCard.id) return false; // characters cannot target themselves
    if (card.zone !== "inPlay") return false;

    if (selector.kind) {
      if (selector.kind === "president" || card.kind !== selector.kind) return false;
    }
    if (selector.faction && getFaction(cardData, card) !== selector.faction) return false;
    if (selector.controller === "self" && card.controller !== sourceCard.controller) return false;
    if (selector.controller === "other" && card.controller === sourceCard.controller) return false;

    if (selector.location?.mode === "self" && card.locationId !== sourceCard.locationId) {
      return false;
    }
    // "adjacent" / "selfOrAdjacent" / "any" / "specific" aren't needed by
    // any encoded ability yet — extend when one requires it.

    if (selector.blendState === "faceDown" && card.faceUp !== false) return false;
    if (selector.blendState === "faceUp" && card.faceUp !== true) return false;

    return true;
  });
}
