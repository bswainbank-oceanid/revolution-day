import { getFaction, hasAttribute } from "../state/cardLookup";
import type { CardInstance } from "../state/cards";
import type { GameState } from "../state/game";
import type { CardData } from "../types";
import type { TargetSelector } from "./dsl";

// Resolves which card instances a filter-based TargetSelector could
// legally pick from, given the source card doing the choosing. Only
// filter-based selectors are handled here — "self"/"binding" refs resolve
// directly, not through eligibility filtering. This is the *general*
// selector filter (kind/faction/controller/location/blend-state) — it does
// NOT apply Protected-immunity, since that's specific to the `eliminate`
// verb ("cannot be targeted *for elimination*"), not to targeting in
// general; see isLegalEliminationTarget below, applied at the call site in
// applySingleEliminateEffect instead.
//
// Deliberately incomplete for now, documented gaps rather than oversights
// (see rev_day_engine_design memory): does NOT support `selection:
// "random"` (needs Suicide Bomber-style pool/fallback logic), and can't
// resolve `kind: "president"` (the President isn't a CardInstance in
// `state.cards`, so no ability targeting him specifically can be encoded
// yet — also means the President's own Protected rule and the two-player
// "not eliminable until past HQ" rule aren't implemented anywhere yet).
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

// "Protected + Blend characters get no Protection benefit while blended" —
// a card only actually shields (or is shielded) while its Protected status
// is active. This same "active" notion governs both whether a card is
// itself immune, and whether it counts as a valid protector for others
// (see isLegalEliminationTarget) — a face-down Protected+Blend card acts
// as an ordinary card for both purposes while hidden.
function isProtectedActive(cardData: CardData, card: CardInstance): boolean {
  if (!hasAttribute(cardData, card, "Protected")) return false;
  return !hasAttribute(cardData, card, "Blend") || card.faceUp === true;
}

// "Cannot be targeted for elimination while there are other cards in the
// same faction at the location." Two carve-outs from card_data.json's
// additional_rulings: cards the acting player controls never count toward
// this protection ("cards you control do not count"), and Protected
// characters are not protected by other Protected characters — only an
// *active*, non-Protected same-faction card at the location counts as a
// valid protector ("if only protected targets remain, either may be
// eliminated").
//
// Does NOT handle the President (not a CardInstance) or the two-player
// "not eliminable until past HQ" rule — both deferred until something
// actually targets him.
export function isLegalEliminationTarget(
  state: GameState,
  cardData: CardData,
  target: CardInstance,
  actingPlayerId: string | null,
): boolean {
  if (!isProtectedActive(cardData, target)) return true;
  const targetFaction = getFaction(cardData, target);
  const hasProtector = state.cards.some(
    (c) =>
      c.id !== target.id &&
      c.zone === "inPlay" &&
      c.locationId === target.locationId &&
      c.controller !== actingPlayerId &&
      getFaction(cardData, c) === targetFaction &&
      !isProtectedActive(cardData, c),
  );
  return !hasProtector;
}
