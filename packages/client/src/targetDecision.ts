// Step 6 of BUILD_PLAN.md: target selection. This file is the pure-logic
// layer — no React — that decides two things from the current game state:
// (1) whether the currently-pending ability effect needs a real player
// choice at all (many don't — see isTrivialSelection below), and (2) when
// it does, what the candidate pool and count constraints are, so the UI
// can render real highlighting instead of blind trial-and-error.
//
// Scope (deliberately not full DSL generality — see BUILD_PLAN.md):
// covered are eliminate/reveal/peek/gainControl/returnToHand/blend (all
// location/count modes), play with location "self", move/triggerAlarm's
// single-location-pick cases (Traffic Cop, Anarchist), and the always-
// simple-eliminate-at-self Response abilities. Explicitly unsupported:
// activateRemote (nested card+ability picking) and play with
// location:"any" for a multi-target ability (Opposition Leader's "place 2
// rebels at any locations" — per-target location pairing) — both are
// gated off at the ability-button level (see abilityIsUsable) so the
// human can never enter an unsupported resolution state through their own
// choice; bots are unaffected since they decide these independently.
import {
  asCardInstance,
  candidateHandCards,
  candidateInPlayCards,
  cardData,
  getAbilities,
  getAbilityEffects,
  isLegalEliminationTargetFiltered,
  presidentIsLegalTarget,
  presidentMatchesSelectorFiltered,
  presidentPseudoCard,
  PRESIDENT_TARGET_ID,
} from "@rev-day/engine";
import type {
  AbilityDefinition,
  EffectNode,
  FilteredCardInstance,
  FilteredGameState,
  LocationScope,
  PlayerId,
  TargetCount,
} from "@rev-day/engine";

// Resolves any card id that might appear in an action/log entry, including
// the President's sentinel id — the one place that needs to know about
// both "real" cards and the pseudo-card, so nothing else has to.
export function resolveCard(state: FilteredGameState, cardId: string): FilteredCardInstance | undefined {
  if (cardId === PRESIDENT_TARGET_ID) return presidentPseudoCard(state);
  return state.cards.find((c) => c.id === cardId);
}

// The candidate pool for an eliminate effect — real matching cards, plus
// the President when the selector's own conditions admit him (per
// card_data.json's additional_rulings: "The President's faction counts as
// Regime for all faction-based counting and protection rules" — *any*
// unfiltered or Regime-faction eliminate selector can target him, subject
// to the normal location and Protected-immunity rules, not just Wife's
// dedicated kind:"president" selector). Mirrors reducer.ts's
// declareEliminateTargets exactly, so the UI never shows/hides him
// differently than what the server would actually accept.
function eliminateCandidatePool(
  state: FilteredGameState,
  sourceCard: FilteredCardInstance,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
): FilteredCardInstance[] {
  if (effect.target.ref !== "filter") return [];
  const bypassProtection = effect.ignoreProtected ?? false;
  const realCards = candidateInPlayCards(state, cardData, effect.target, sourceCard).filter(
    (c) => bypassProtection || isLegalEliminationTargetFiltered(state, cardData, c, actingPlayerId),
  );
  const presidentEligible =
    presidentMatchesSelectorFiltered(state, effect.target, sourceCard) &&
    presidentIsLegalTarget(state, cardData, actingPlayerId, bypassProtection, true);
  return presidentEligible ? [...realCards, presidentPseudoCard(state)] : realCards;
}

function requiredMin(count: TargetCount): number {
  if (count.mode === "exact") return count.value;
  if (count.mode === "range") return count.min;
  return 0;
}

// No real branching left: "all" always selects the whole pool; "unbounded"
// only when there's nothing to choose from; "exact"/"range" only once the
// pool doesn't exceed what's required (nothing to leave out).
export function isTrivialSelection(count: TargetCount, poolSize: number): boolean {
  if (count.mode === "all") return true;
  if (count.mode === "unbounded") return poolSize === 0;
  return poolSize <= requiredMin(count);
}

export function trivialSelectionIds(count: TargetCount, pool: readonly FilteredCardInstance[]): string[] {
  if (count.mode === "unbounded") return [];
  return pool.map((c) => c.id);
}

interface TrivialResult {
  readonly targetIds: readonly string[];
  readonly locationIds?: readonly string[];
}

// Returns the auto-submittable (targetIds, locationIds) when the current
// effect needs no real player choice, or null when a real UI decision is
// required (or the effect is out of scope — see the module doc).
export function computeTrivialChooseTargets(
  state: FilteredGameState,
  sourceCard: FilteredCardInstance,
  actingPlayerId: PlayerId,
  effect: EffectNode,
): TrivialResult | null {
  switch (effect.verb) {
    case "draw":
    case "gainActions":
    case "if":
      return { targetIds: [] };
    case "triggerAlarm":
      return effect.location.mode === "self" ? { targetIds: [] } : null;
    case "activateRemote":
      return null; // out of scope — the activating ability button is disabled instead
    case "move": {
      // Only a president-targeted, forwardOrBackward move exists in the
      // current data (Traffic Cop) — always a real location choice.
      return null;
    }
    case "eliminate": {
      if (effect.target.ref === "self" || effect.target.ref === "binding") return { targetIds: [] };
      if (effect.target.ref !== "filter") return null;
      if (effect.target.selection === "random") return { targetIds: [] };
      const pool = eliminateCandidatePool(state, sourceCard, actingPlayerId, effect);
      if (!isTrivialSelection(effect.target.count, pool.length)) return null;
      return { targetIds: trivialSelectionIds(effect.target.count, pool) };
    }
    case "reveal":
    case "peek":
    case "gainControl":
    case "returnToHand":
    case "blend": {
      // These verbs never reach the President — every current selector
      // using them requires blendState:"faceDown", which he can never
      // satisfy (no Blend attribute), so there's nothing to merge in.
      if (effect.target.ref === "self" || effect.target.ref === "binding") return { targetIds: [] };
      if (effect.target.ref !== "filter") return null;
      const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard);
      if (!isTrivialSelection(effect.target.count, pool.length)) return null;
      return { targetIds: trivialSelectionIds(effect.target.count, pool) };
    }
    case "play": {
      if (effect.target.ref !== "filter") return null;
      const pool = candidateHandCards(state, cardData, effect.target, actingPlayerId);
      if (!isTrivialSelection(effect.target.count, pool.length)) return null;
      const targetIds = trivialSelectionIds(effect.target.count, pool);
      // "any" location still needs a real per-target pick unless there's
      // nothing to place at all.
      if (effect.location.mode === "any") return targetIds.length === 0 ? { targetIds } : null;
      return { targetIds };
    }
  }
}

// --- What the UI shows when a real choice IS needed ---

export interface PendingCardPick {
  readonly kind: "cards";
  readonly candidates: readonly FilteredCardInstance[];
  readonly count: TargetCount;
  readonly locationScope: LocationScope | undefined;
  readonly poolSource: "inPlay" | "hand";
}

export interface PendingLocationPick {
  readonly kind: "location";
  readonly candidateLocationIds: readonly string[];
}

export type PendingRealChoice = PendingCardPick | PendingLocationPick;

// Called only once computeTrivialChooseTargets has already returned null —
// i.e. this effect genuinely needs player input. Returns null for the
// (rare, gated-off) unsupported cases so the caller can fall back to a
// clear "not supported" message instead of a broken picker.
export function computePendingRealChoice(
  state: FilteredGameState,
  sourceCard: FilteredCardInstance,
  actingPlayerId: PlayerId,
  effect: EffectNode,
): PendingRealChoice | null {
  switch (effect.verb) {
    case "eliminate": {
      if (effect.target.ref !== "filter") return null;
      const candidates = eliminateCandidatePool(state, sourceCard, actingPlayerId, effect);
      return { kind: "cards", candidates, count: effect.target.count, locationScope: effect.target.location, poolSource: "inPlay" };
    }
    case "reveal":
    case "peek":
    case "gainControl":
    case "returnToHand":
    case "blend": {
      if (effect.target.ref !== "filter") return null;
      const candidates = candidateInPlayCards(state, cardData, effect.target, sourceCard);
      return { kind: "cards", candidates, count: effect.target.count, locationScope: effect.target.location, poolSource: "inPlay" };
    }
    case "play": {
      if (effect.target.ref !== "filter" || effect.location.mode === "any") return null;
      const candidates = candidateHandCards(state, cardData, effect.target, actingPlayerId);
      return { kind: "cards", candidates, count: effect.target.count, locationScope: undefined, poolSource: "hand" };
    }
    case "move": {
      if (effect.target.ref !== "filter" || effect.target.kind !== "president") return null;
      if (state.president.status !== "alive" || !state.president.locationId) return null;
      const adjacent = state.board
        .filter((l) => l.id !== state.president.locationId)
        .map((l) => l.id)
        .filter((id) => isAdjacent(state, state.president.locationId!, id));
      return { kind: "location", candidateLocationIds: adjacent };
    }
    case "triggerAlarm":
      if (effect.location.mode !== "any") return null;
      return { kind: "location", candidateLocationIds: state.board.map((l) => l.id) };
    default:
      return null;
  }
}

function isAdjacent(state: FilteredGameState, fromId: string, toId: string): boolean {
  const index = state.board.findIndex((l) => l.id === fromId);
  const otherIndex = state.board.findIndex((l) => l.id === toId);
  if (index === -1 || otherIndex === -1) return false;
  return Math.abs(index - otherIndex) === 1;
}

// Response abilities are always a single, simple eliminate-at-self effect
// (the engine itself only interprets that shape — see applyAlarmAction),
// so this mirrors eliminateOneAtSelf's structure directly rather than
// going through getAbilityEffects's general EffectNode dispatch. Folds in
// the President the same way eliminateCandidatePool does, for the same
// reason (a Response is still just an "eliminate" effect underneath).
export function computeResponseCandidates(
  state: FilteredGameState,
  sourceCard: FilteredCardInstance,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
): readonly FilteredCardInstance[] {
  return eliminateCandidatePool(state, sourceCard, actingPlayerId, effect);
}

// A conservative pre-check so Activate/Response ability buttons don't lead
// into a guaranteed dead end (the engine has no "cancel a chosen ability
// with nothing to target" action — a real, pre-existing gap bots already
// work around the same way). Only checks the ability's *first* effect,
// same documented scope as bots/decide.ts's abilityHasAvailableFirstTarget
// — a later effect running dry is rarer and not guarded against here
// either.
export function abilityIsUsable(
  state: FilteredGameState,
  sourceCard: FilteredCardInstance,
  def: AbilityDefinition,
  actingPlayerId: PlayerId,
): boolean {
  const effect = def.effects[0];
  if (!effect) return false;
  if (effect.verb === "activateRemote") return false; // out of scope
  if (effect.verb === "play" && effect.target.ref === "filter" && effect.location.mode === "any") {
    return false; // out of scope (Opposition Leader's per-target location pairing)
  }
  if (effect.verb === "move") {
    if (effect.target.ref !== "filter" || effect.target.kind !== "president") return true;
    if (state.president.status !== "alive" || !state.president.locationId) return false;
    if (effect.target.location?.mode === "self" && state.president.locationId !== sourceCard.locationId) return false;
    return true;
  }
  if (effect.verb === "triggerAlarm" || effect.verb === "draw" || effect.verb === "gainActions" || effect.verb === "if") {
    return true;
  }
  if (effect.target.ref === "self" || effect.target.ref === "binding") return true;
  if (effect.target.ref !== "filter") return true;
  if (effect.verb === "eliminate" && effect.target.selection === "random") return true;
  if (effect.verb === "eliminate") {
    return eliminateCandidatePool(state, sourceCard, actingPlayerId, effect).length >= requiredMin(effect.target.count);
  }
  const pool =
    effect.verb === "play"
      ? candidateHandCards(state, cardData, effect.target, actingPlayerId)
      : candidateInPlayCards(state, cardData, effect.target, sourceCard);
  return pool.length >= requiredMin(effect.target.count);
}

// Every unused Activate ability on the human's own in-play card — used to
// render real ActivateAbilityBox buttons during a normal turn.
export function usableActivateAbilities(
  state: FilteredGameState,
  card: FilteredCardInstance,
  usedAbilities: readonly string[],
  actingPlayerId: PlayerId,
): { readonly abilityIndex: number; readonly text: string }[] {
  const instance = asCardInstance(card);
  if (!instance) return [];
  return getAbilities(cardData, instance)
    .map((ability, abilityIndex) => ({ ability, abilityIndex }))
    .filter(({ ability, abilityIndex }) => {
      if (ability.type !== "Activate") return false;
      if (usedAbilities.includes(`${card.id}#${abilityIndex}`)) return false;
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      if (!def) return false;
      return abilityIsUsable(state, card, def, actingPlayerId);
    })
    .map(({ ability, abilityIndex }) => ({ abilityIndex, text: ability.text }));
}

// Every available Response ability on one of the human's own in-play cards
// at the alarm's location (the triggering card itself excluded) — used
// during an AlarmResolutionFrame to render real "Respond" buttons. Unlike
// Activate abilities, Responses aren't tracked in turn.usedAbilities at
// all (see applyAlarmAction) — a player only ever gets one decision per
// alarm pass regardless, enforced by the frame's own order/nextIndex.
export function usableResponseAbilities(
  state: FilteredGameState,
  card: FilteredCardInstance,
  triggeringCardId: string,
  locationId: string,
  actingPlayerId: PlayerId,
): { readonly abilityIndex: number; readonly text: string }[] {
  if (card.id === triggeringCardId || card.locationId !== locationId) return [];
  const instance = asCardInstance(card);
  if (!instance) return [];
  return getAbilities(cardData, instance)
    .map((ability, abilityIndex) => ({ ability, abilityIndex }))
    .filter(({ ability, abilityIndex }) => {
      if (ability.type !== "Response") return false;
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      if (!def) return false;
      return abilityIsUsable(state, card, def, actingPlayerId);
    })
    .map(({ ability, abilityIndex }) => ({ abilityIndex, text: ability.text }));
}
