import { getFaction, hasAttribute } from "../state/cardLookup";
import { adjacentLocationIds } from "../state/board";
import type { CardInstance } from "../state/cards";
import type { Faction, CardData } from "../types";
import type { TargetSelector } from "./dsl";
import type { FilteredCardInstance, FilteredGameState } from "./filterForPlayer";

// A filtered-state-aware mirror of the engine's own targeting/eligibility
// logic (resolveEligibleTargets, resolveEligibleHandCards,
// isLegalPresidentTarget in effects/targeting.ts) — those all expect a
// full GameState with guaranteed-non-null defRefs, which a viewer's
// filterForPlayer'd view doesn't have for hidden cards. Originally built
// for the bots package (packages/bots/src/targetPool.ts); promoted here
// so bots and the client both consume one implementation instead of two
// copies that can quietly drift apart — this logic already had a real,
// live bug found and fixed once (see rev_day_engine_design memory), and
// a second independent copy in the client would double that risk.

// Safe once defRef is confirmed non-null — FilteredCardInstance and
// CardInstance are otherwise structurally identical, so this is a plain
// narrowing, not a real cast.
export function asCardInstance(card: FilteredCardInstance): CardInstance | undefined {
  if (card.defRef === null) return undefined;
  return { ...card, defRef: card.defRef };
}

// A card's faction can only be known if its identity is known — a
// face-down card the viewer doesn't control has neither, matching
// "face-down cards do not count as regime or rebel for targeting
// purposes".
export function knownFaction(cardData: CardData, card: FilteredCardInstance): Faction | undefined {
  const instance = asCardInstance(card);
  return instance ? getFaction(cardData, instance) : undefined;
}

// A simplified, filtered-state-aware mirror of the engine's own
// resolveEligibleTargets (effects/targeting.ts) — can't reuse that
// directly since it expects full CardInstance[] with guaranteed defRef.
// A selector needing `faction`/`hasAttribute` excludes any candidate
// whose identity isn't currently known to this viewer (can't confirm a
// match either way, so it's excluded rather than guessed) — kind,
// location, and blend-state are all still knowable regardless of hidden
// identity, so those filter normally.
export function candidateInPlayCards(
  state: FilteredGameState,
  cardData: CardData,
  selector: Extract<TargetSelector, { ref: "filter" }>,
  sourceCard: FilteredCardInstance,
): FilteredCardInstance[] {
  return state.cards.filter((card) => {
    if (card.id === sourceCard.id) return false;
    if (card.zone !== "inPlay") return false;

    if (selector.kind && (selector.kind === "president" || card.kind !== selector.kind)) return false;
    if (selector.controller === "self" && card.controller !== sourceCard.controller) return false;
    if (selector.controller === "other" && card.controller === sourceCard.controller) return false;

    if (selector.location?.mode === "self" && card.locationId !== sourceCard.locationId) return false;
    if (selector.location?.mode === "adjacent") {
      const adjacent = sourceCard.locationId ? adjacentLocationIds(state.board, sourceCard.locationId) : [];
      if (!card.locationId || !adjacent.includes(card.locationId)) return false;
    }
    if (selector.location?.mode === "selfOrAdjacent") {
      const adjacent = sourceCard.locationId ? adjacentLocationIds(state.board, sourceCard.locationId) : [];
      const allowed = new Set([sourceCard.locationId, ...adjacent]);
      if (!card.locationId || !allowed.has(card.locationId)) return false;
    }

    if (selector.blendState === "faceDown" && card.faceUp !== false) return false;
    if (selector.blendState === "faceUp" && card.faceUp !== true) return false;

    if (selector.faction && knownFaction(cardData, card) !== selector.faction) return false;
    if (selector.hasAttribute) {
      const instance = asCardInstance(card);
      if (!instance || !hasAttribute(cardData, instance, selector.hasAttribute)) return false;
    }

    return true;
  });
}

function isProtectedActiveFiltered(cardData: CardData, card: FilteredCardInstance): boolean {
  const instance = asCardInstance(card);
  if (!instance || !hasAttribute(cardData, instance, "Protected")) return false;
  return !hasAttribute(cardData, instance, "Blend") || card.faceUp === true;
}

// A filtered-state-aware mirror of the engine's own isLegalPresidentTarget
// (effects/targeting.ts) — needed because a naive "the President sentinel
// is always a legal candidate" assumption is wrong whenever his status
// isn't "alive" (eliminated, not yet entered, or "survived", the endgame
// state once he's outlasted the board): a real regression, see
// rev_day_engine_design memory. `coLocated` mirrors the engine's own
// separate co-location gate in declareEliminateTargets (Wife needs to
// actually be with the President; isLegalPresidentTarget itself has no
// notion of a source card) — the caller computes it since only it knows
// the effect's target.location mode and the source card's own location.
export function presidentIsLegalTarget(
  state: FilteredGameState,
  cardData: CardData,
  actingPlayerId: string | null,
  ignoreProtection: boolean,
  coLocated: boolean,
): boolean {
  if (!coLocated) return false;
  if (state.president.status !== "alive" || state.president.locationId === null) return false;

  if (state.players.length === 2) {
    const positionIndex = state.board.findIndex((l) => l.id === state.president.locationId);
    if (positionIndex < 2) return false;
  }

  if (ignoreProtection) return true;

  return !state.cards.some(
    (c) =>
      c.zone === "inPlay" &&
      c.locationId === state.president.locationId &&
      c.controller !== actingPlayerId &&
      knownFaction(cardData, c) === "Regime" &&
      !isProtectedActiveFiltered(cardData, c),
  );
}

// "Play" always selects from the acting player's own hand — always fully
// visible to them, so no identity-uncertainty concerns here at all.
export function candidateHandCards(
  state: FilteredGameState,
  cardData: CardData,
  selector: Extract<TargetSelector, { ref: "filter" }>,
  viewerId: string,
): FilteredCardInstance[] {
  return state.cards.filter((card) => {
    if (card.zone !== "hand" || card.controller !== viewerId) return false;
    if (selector.kind && card.kind !== selector.kind) return false;
    if (selector.faction && knownFaction(cardData, card) !== selector.faction) return false;
    return true;
  });
}
