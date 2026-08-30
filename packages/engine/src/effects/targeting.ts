import { adjacentLocationIds } from "../state/board";
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
// The President is deliberately excluded here — he isn't a CardInstance
// (tracked separately via GameState.president), so a selector that could
// legally include him is resolved separately by presidentMatchesSelector
// below and merged in by the caller (reducer.ts's declareEliminateTargets)
// alongside this function's real-card pool.
//
// Deliberately incomplete for now, a documented gap rather than an
// oversight (see rev_day_engine_design memory): the base filters here
// don't distinguish random vs. player-chosen selection — for `selection:
// "random"` (Suicide Bomber), the candidates this returns still need
// partitioning by partitionByProtection below before drawing, since that
// pool/fallback split is a per-ability override of the standard Protected
// check, not a reuse of it. The President is not yet included in that
// random-draw pool — a known, narrower gap than the playerChoice case
// below, flagged separately since touching the RNG-consumption sequence
// needs more care.
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
    // mode: "any" (Opposition Leader's "reveal a blended target at any
    // location") needs no check at all — falling through unfiltered here
    // already is "any location". "specific" isn't needed by any encoded
    // ability yet — extend when one requires it.
    if (selector.location?.mode === "adjacent") {
      const adjacent = adjacentLocationIds(state.board, sourceCard.locationId!);
      if (!card.locationId || !adjacent.includes(card.locationId)) return false;
    }
    if (selector.location?.mode === "selfOrAdjacent") {
      const allowed = new Set([sourceCard.locationId, ...adjacentLocationIds(state.board, sourceCard.locationId!)]);
      if (!card.locationId || !allowed.has(card.locationId)) return false;
    }

    if (selector.blendState === "faceDown" && card.faceUp !== false) return false;
    if (selector.blendState === "faceUp" && card.faceUp !== true) return false;

    // Raw attribute check, not isProtectedActive's "active" gate — Suicide
    // Bomber's forced reveal specifically targets face-down Protected+Blend
    // characters (that's the whole point: they're hidden, so their
    // Protected status isn't active yet), not just currently-active ones.
    if (selector.hasAttribute && !hasAttribute(cardData, card, selector.hasAttribute)) return false;

    return true;
  });
}

// Whether a filter-based selector's non-Protected-related conditions
// (kind/faction/controller/location/blendState) admit the President as a
// candidate — mirrors resolveEligibleTargets' own filter checks, since
// per card_data.json's additional_rulings ("The President's faction
// counts as Regime for all faction-based counting and protection rules")
// he's meant to be targetable by *any* ability whose selector would
// otherwise match an unfiltered or Regime-faction card at his location —
// not just Wife's dedicated kind:"president" selector, which this also
// still matches (a selector explicitly restricted to "president" admits
// only him; one explicitly restricted to a real CardKind, or to Rebel
// faction, never does). Protected-immunity itself is handled separately —
// see isLegalPresidentTarget, applied at the call site alongside this.
export function presidentMatchesSelector(
  state: GameState,
  selector: Extract<TargetSelector, { ref: "filter" }>,
  sourceCard: CardInstance,
): boolean {
  if (state.president.status !== "alive" || state.president.locationId === null) return false;
  if (selector.kind && selector.kind !== "president") return false;
  if (selector.faction && selector.faction !== "Regime") return false;
  if (selector.controller === "self") return false; // never "your own" — he has no controller

  const presidentLocationId = state.president.locationId;
  if (selector.location?.mode === "self" && presidentLocationId !== sourceCard.locationId) return false;
  if (selector.location?.mode === "adjacent") {
    const adjacent = adjacentLocationIds(state.board, sourceCard.locationId!);
    if (!adjacent.includes(presidentLocationId)) return false;
  }
  if (selector.location?.mode === "selfOrAdjacent") {
    const allowed = new Set([sourceCard.locationId, ...adjacentLocationIds(state.board, sourceCard.locationId!)]);
    if (!allowed.has(presidentLocationId)) return false;
  }

  if (selector.blendState === "faceDown") return false; // he has no Blend attribute, never face-down
  // blendState === "faceUp", and hasAttribute (only ever "Protected", which
  // he always has) both admit him unconditionally — nothing left to check.
  return true;
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
  excludedCardIds: readonly string[] = [],
): CardInstance[] {
  return state.cards.filter(
    (c) =>
      !excludedCardIds.includes(c.id) &&
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
// `additionalExcludedIds` — every OTHER id in the same simultaneously-
// declared targetIds batch (Heir Apparent/Death Squad/Rebel Soldier's
// "eliminate one or two targets" et al.) — also doesn't count toward
// protection, on top of the acting player's own cards: a card being
// eliminated in the very same action can't still be shielding another
// target in it. Defaults to none, so every existing single-target call
// site is unaffected.
export function isLegalEliminationTarget(
  state: GameState,
  cardData: CardData,
  target: CardInstance,
  actingPlayerId: string | null,
  additionalExcludedIds: readonly string[] = [],
): boolean {
  if (!isProtectedActive(cardData, target)) return true;
  const targetFaction = getFaction(cardData, target);
  if (!targetFaction) return true;
  return (
    findProtectorCards(state, cardData, target.locationId!, targetFaction, actingPlayerId, [
      target.id,
      ...additionalExcludedIds,
    ]).length === 0
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
// Suicide Bomber's bespoke random-target pool split: "Protected cards are
// eliminated only if there are no other targets" — location-wide across
// both factions, not the standard per-faction protector check (which
// isLegalEliminationTarget/findProtectorCards implement instead) — a
// deliberate per-ability override, per rev_day_engine_design memory.
// Protected+Blend cards still face-down count as ordinary (primary-pool)
// candidates, same "no protection while blended" rule as everywhere else.
export function partitionByProtection(
  cardData: CardData,
  candidates: readonly CardInstance[],
): { readonly primary: CardInstance[]; readonly fallback: CardInstance[] } {
  const primary: CardInstance[] = [];
  const fallback: CardInstance[] = [];
  for (const card of candidates) {
    (isProtectedActive(cardData, card) ? fallback : primary).push(card);
  }
  return { primary, fallback };
}

// `additionalExcludedIds` — see isLegalEliminationTarget's comment; same
// simultaneous-batch exclusion, since the President can be one of several
// targets in the same "eliminate one or two targets" declaration.
export function isLegalPresidentTarget(
  state: GameState,
  cardData: CardData,
  actingPlayerId: string | null,
  ignoreProtection: boolean,
  additionalExcludedIds: readonly string[] = [],
): boolean {
  if (state.president.status !== "alive" || state.president.locationId === null) return false;

  if (state.players.length === 2) {
    const positionIndex = state.board.findIndex((l) => l.id === state.president.locationId);
    if (positionIndex < 2) return false; // "not eliminable until past HQ" — position 3, 1-based
  }

  if (ignoreProtection) return true;

  return (
    findProtectorCards(state, cardData, state.president.locationId, "Regime", actingPlayerId, additionalExcludedIds)
      .length === 0
  );
}
