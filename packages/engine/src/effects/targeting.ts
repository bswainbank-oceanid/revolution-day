import { getFaction, hasAttribute } from "../state/cardLookup";
import type { CardInstance } from "../state/cards";
import type { GameState, PlayerId } from "../state/game";
import type { CardData, Faction } from "../types";
import type { TargetSelector } from "./dsl";

// Resolves which card instances a filter-based TargetSelector could
// legally pick from, given the source card doing the choosing. Only
// filter-based selectors are handled here — "self"/"binding" refs resolve
// directly, not through eligibility filtering. This is the *general*
// selector filter (kind/faction/controller/location/blend-state) — it does
// NOT apply Protected-immunity, since that's specific to the `eliminate`
// verb ("cannot be targeted *for elimination*"), not to targeting in
// general; see isLegalEliminationTarget below, applied at the call site in
// reducer.ts's declareEliminateTarget instead. Only for *in-play* cards —
// see resolveEligibleHandCards below for selecting from a hand instead.
//
// Deliberately incomplete for now, a documented gap rather than an
// oversight (see rev_day_engine_design memory): does NOT support
// `selection: "random"` (needs Suicide Bomber-style pool/fallback logic).
// `kind: "president"` is deliberately excluded here too — the President
// isn't a CardInstance, so ability targeting him is handled as a separate
// path in applySingleEliminateEffect using isLegalPresidentTarget below,
// not through this function.
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

// Resolves which of `actingPlayerId`'s *hand* cards a filter-based
// TargetSelector could pick from — for the `play` verb (Commander
// General's "play any number of regime cards"), a genuinely different
// pool from resolveEligibleTargets' in-play cards. "Play a card" always
// means from your own hand, even when the ability text doesn't say so
// explicitly — you can't play a card from someone else's hand.
export function resolveEligibleHandCards(
  state: GameState,
  cardData: CardData,
  selector: Extract<TargetSelector, { ref: "filter" }>,
  actingPlayerId: PlayerId,
): CardInstance[] {
  return state.cards.filter((card) => {
    if (card.zone !== "hand" || card.controller !== actingPlayerId) return false;
    if (selector.kind && card.kind !== selector.kind) return false;
    if (selector.faction && getFaction(cardData, card) !== selector.faction) return false;
    return true;
  });
}

// "Protected + Blend characters get no Protection benefit while blended" —
// a card only actually shields (or is shielded) while its Protected status
// is active. This same "active" notion governs both whether a card is
// itself immune, and whether it counts as a valid protector for others
// (see findProtectorCards) — a face-down Protected+Blend card acts as an
// ordinary card for both purposes while hidden.
export function isProtectedActive(cardData: CardData, card: CardInstance): boolean {
  if (!hasAttribute(cardData, card, "Protected")) return false;
  return !hasAttribute(cardData, card, "Blend") || card.faceUp === true;
}

// "Face-down cards do not count as regime or rebel for targeting
// purposes" — a card's faction is only usable in a legality check while
// it's visible (not Blend, or Blend and revealed). This is what makes the
// protected-targeting reveal window meaningful: a hidden same-faction card
// does NOT yet count as a protector, only as a *potential* one once
// revealed.
function isFactionVisible(cardData: CardData, card: CardInstance): boolean {
  return !hasAttribute(cardData, card, "Blend") || card.faceUp === true;
}

// Cards that would currently shield `faction` at `locationId` from
// `excludedControllerId` (the acting/declaring player — "cards you
// control do not count toward this protection"): other active, visible,
// same-faction, non-Protected cards. Shared by isLegalEliminationTarget,
// isLegalPresidentTarget, and the reveal window's reassignment logic
// (finding a newly-revealed protector is the same query as finding an
// already-visible one).
export function findProtectorCards(
  state: GameState,
  cardData: CardData,
  locationId: string,
  faction: Faction,
  excludedControllerId: string | null,
  excludedCardId?: string,
): CardInstance[] {
  return state.cards.filter(
    (c) =>
      c.id !== excludedCardId &&
      c.zone === "inPlay" &&
      c.locationId === locationId &&
      c.controller !== excludedControllerId &&
      isFactionVisible(cardData, c) &&
      getFaction(cardData, c) === faction &&
      !isProtectedActive(cardData, c),
  );
}

// Whether any player other than the declaring player controls a currently
// face-down (Blend) card at the location — if not, no reveal could change
// the outcome, so the reveal window shouldn't open at all (an instant,
// no-op pass isn't meaningfully different from skipping it).
export function hasRevealOpportunity(
  state: GameState,
  locationId: string,
  declaringPlayerId: PlayerId,
): boolean {
  return state.cards.some(
    (c) =>
      c.zone === "inPlay" &&
      c.locationId === locationId &&
      c.controller !== declaringPlayerId &&
      c.faceUp === false,
  );
}

// "Cannot be targeted for elimination while there are other cards in the
// same faction at the location." Two carve-outs from card_data.json's
// additional_rulings: cards the acting player controls never count toward
// this protection ("cards you control do not count"), and Protected
// characters are not protected by other Protected characters — only an
// *active*, non-Protected same-faction card at the location counts as a
// valid protector ("if only protected targets remain, either may be
// eliminated"). This is a declaration-time check using only currently
// *visible* information — see the protected-targeting reveal window
// (ProtectedTargetingWindowFrame, dispatched in reducer.ts) for what
// happens when a hidden card could still change the outcome.
export function isLegalEliminationTarget(
  state: GameState,
  cardData: CardData,
  target: CardInstance,
  actingPlayerId: string | null,
): boolean {
  if (!isProtectedActive(cardData, target)) return true;
  const targetFaction = getFaction(cardData, target);
  if (!targetFaction) return true;
  return (
    findProtectorCards(state, cardData, target.locationId!, targetFaction, actingPlayerId, target.id)
      .length === 0
  );
}

// The President's own targeting legality. His card_data.json text
// ("can only be targeted once all other regime cards at his location are
// eliminated") reads like a special case, but per the ruling that his
// faction counts as Regime for all these purposes, it's the same
// mechanic as isLegalEliminationTarget above — just against
// GameState.president instead of a CardInstance, since he isn't one.
//
// ignoreProtection (Wife's "ignores protected") bypasses only the
// guard-protection check, not the two-player rule below — that's a
// separate procedural restriction ("hasn't reached a vulnerable position
// yet"), not a form of being shielded by guards, so nothing should bypass
// it. This reading isn't spelled out explicitly in the rules text; flag if
// wrong.
export function isLegalPresidentTarget(
  state: GameState,
  cardData: CardData,
  actingPlayerId: string | null,
  ignoreProtection: boolean,
): boolean {
  if (state.president.status !== "alive" || state.president.locationId === null) return false;

  if (state.players.length === 2) {
    const positionIndex = state.board.findIndex((l) => l.id === state.president.locationId);
    if (positionIndex < 2) return false; // "not eliminable until past HQ" — position 3, 1-based
  }

  if (ignoreProtection) return true;

  return (
    findProtectorCards(state, cardData, state.president.locationId, "Regime", actingPlayerId).length === 0
  );
}
