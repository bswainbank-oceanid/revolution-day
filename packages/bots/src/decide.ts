import {
  adjacentLocationIds,
  asCardInstance,
  candidateHandCards,
  candidateInPlayCards,
  getAbilities,
  getAbilityEffects,
  getPassive,
  isLegalEliminationTargetFiltered,
  knownFaction,
  presidentIsLegalTarget,
  presidentMatchesSelectorFiltered,
  presidentPseudoCard,
  PRESIDENT_TARGET_ID,
  winConditions,
} from "@rev-day/engine";
import type {
  Action,
  AbilityDefinition,
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  CardData,
  EffectNode,
  FilteredCardInstance,
  FilteredGameState,
  MotorcadeInterceptionWindowFrame,
  PlayerId,
  ProtectedTargetingWindowFrame,
  ReactivePassiveWindowFrame,
  RestrictedActionGrant,
  TargetCount,
} from "@rev-day/engine";
import type { PresidentObjective } from "./presidentObjective";
import { presidentObjectiveFor } from "./presidentObjective";
import type { Rng } from "./random";
import { coinFlip, pickN, pickRandom, pickWeighted } from "./random";

// The full "brain": one decision at a time, given the current (filtered —
// no hidden identities) state. Pure, no I/O, doesn't call applyAction
// itself — see takeBotTurn.ts for the retry/orchestration loop that
// actually drives a whole turn using this. Crude by design: trial and
// error rather than a legal-action enumerator (the engine has none built
// either), weighted-random top-level choices, and a soft preference for
// eliminating things and, per the acting leader's own win condition
// (derived from data, not a hardcoded leader list — see
// presidentObjective.ts), for the President specifically.
export function decideBotAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  rng: Rng = Math.random,
): Action {
  const objective = computeObjective(state, playerId);
  const frame = state.resolutionStack[state.resolutionStack.length - 1];
  if (!frame) {
    return decideTurnAction(state, playerId, cardData, objective, rng);
  }
  switch (frame.kind) {
    case "abilityResolution":
      return decideChooseTargets(state, playerId, cardData, frame, objective, rng);
    case "alarmResolution":
      return decideAlarmAction(state, playerId, cardData, frame, objective, rng);
    case "protectedTargetingWindow":
      return decideRevealAction(state, playerId, frame, rng);
    case "motorcadeInterceptionWindow":
      return decideInterceptAction(state, playerId, frame, rng);
    case "reactivePassiveWindow":
      return decideReactiveAction(state, playerId, cardData, frame, rng);
  }
}

function computeObjective(state: FilteredGameState, playerId: PlayerId): PresidentObjective {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  if (!leader || leader.defRef === null) return "neutral";
  return presidentObjectiveFor(leader.defRef, winConditions);
}

function abilityTargetsPresident(def: AbilityDefinition): boolean {
  return def.effects.some((e) => e.verb === "eliminate" && e.target.ref === "filter" && e.target.kind === "president");
}

function abilityHasEliminateEffect(def: AbilityDefinition): boolean {
  return def.effects.some((e) => e.verb === "eliminate");
}

// The candidate pool for an eliminate effect — real matching cards, plus
// the President when the selector's own conditions admit him (per
// card_data.json's additional_rulings: "The President's faction counts as
// Regime for all faction-based counting and protection rules" — *any*
// unfiltered or Regime-faction eliminate selector can target him, subject
// to the normal location and Protected-immunity rules, not just Wife's
// dedicated kind:"president" selector). Mirrors the client's identically-
// named helper (packages/client/src/targetDecision.ts) and reducer.ts's
// declareEliminateTargets, so bots never consider a target the server
// would actually reject, or miss one it would accept.
// `forceBypassProtection` — set when this is a re-choice after a
// Protected-targeting reveal window (frame.reselectingAfterReveal) —
// mirrors reducer.ts's declareEliminateTargets, which is called with
// bypassProtectionOverride:true for that exact case ("that re-choice is
// final by design, not a fresh declaration"). Without it, this pool could
// wrongly exclude a candidate a freshly-revealed card now appears to
// protect, even though the server accepts it unconditionally on a
// re-choice — stranding the bot the same way an empty pool would.
function eliminateCandidatePool(
  state: FilteredGameState,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
  forceBypassProtection = false,
): FilteredCardInstance[] {
  if (effect.target.ref !== "filter") return [];
  const bypassProtection = (effect.ignoreProtected ?? false) || forceBypassProtection;
  const realCards = candidateInPlayCards(state, cardData, effect.target, sourceCard).filter(
    (c) => bypassProtection || isLegalEliminationTargetFiltered(state, cardData, c, actingPlayerId),
  );
  const presidentEligible =
    presidentMatchesSelectorFiltered(state, effect.target, sourceCard) &&
    presidentIsLegalTarget(state, cardData, actingPlayerId, bypassProtection, true);
  return presidentEligible ? [...realCards, presidentPseudoCard(state)] : realCards;
}

// Exact/range-minimum eliminate/reveal/peek/activateRemote/play effects
// have no legal "decline" once the ability is already committed to —
// unlike every resolution-stack window (which always has a pass/decline
// option), an activateAbility/useResponse choice with zero available
// candidates for its first effect is a dead end the bot can never
// recover from (a real, pre-existing engine gap: there's no "cancel a
// chosen ability with nothing to target" action). So this checks
// *before* committing, not after — only the ability's first effect, not
// the whole sequence (a later effect running dry is rarer and harder to
// predict up front; the retry/fallback mechanism absorbs that instead).
// `deciderId` is whoever is actually making this choice — the same
// player decideEliminateTargetIds filters "opposing" against — which is
// NOT always sourceCard.controller: under remote activation, sourceCard
// is someone else's card, but the player deciding whether to activate it
// (and, later, who its targets are chosen relative to) is the original
// acting player. Passing sourceCard.controller here for that case was a
// real bug — this check would approve a remote ability whose only
// "opposing to the card's own controller" target turned out to be the
// decider's own card, which decideEliminateTargetIds would then correctly
// refuse, leaving nothing submittable and the bot stuck.
function abilityHasAvailableFirstTarget(
  state: FilteredGameState,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  def: AbilityDefinition,
  deciderId: PlayerId,
): boolean {
  const effect = def.effects[0];
  if (!effect) return false;
  switch (effect.verb) {
    case "eliminate": {
      if (effect.target.ref !== "filter") return true; // self/binding — nothing to run out of
      if (effect.target.selection === "random") return true; // engine draws automatically
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      const pool = eliminateCandidatePool(state, cardData, sourceCard, deciderId, effect);
      // The bot never player-chooses to eliminate its own cards (a hard
      // exclusion, not just a preference — see decideEliminateTargetIds),
      // so an eliminate ability with no *opposing* target is just as much
      // a dead end as one with no target at all, unless the selector
      // already hard-constrains controller itself. The President (never
      // "your own" — see eliminateCandidatePool) always passes this filter.
      const relevantPool =
        effect.target.controller === "self" || effect.target.controller === "other"
          ? pool
          : pool.filter((c) => c.controller !== deciderId);
      return relevantPool.length >= minNeeded;
    }
    case "reveal":
    case "peek":
    case "activateRemote": {
      if (effect.target.ref !== "filter") return true; // self/binding — nothing to run out of
      // Neither verb can reach the President in current data — every
      // selector using them requires blendState:"faceDown", which he can
      // never satisfy (no Blend attribute) — so no special-casing needed.
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard);
      return pool.length >= minNeeded;
    }
    case "play": {
      if (effect.target.ref !== "filter") return true;
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      return candidateHandCards(state, cardData, effect.target, sourceCard.controller!).length >= minNeeded;
    }
    case "move": {
      // Only a president-targeted, forwardOrBackward move is interpreted
      // (Traffic Cop) — the same real dead end as the cases above: once
      // activated, there's no legal "decline" if the President isn't
      // actually at this card's location, or has nowhere to go.
      if (effect.target.ref !== "filter" || effect.target.kind !== "president") return true;
      if (state.president.status !== "alive" || !state.president.locationId) return false;
      if (effect.target.location?.mode === "self" && state.president.locationId !== sourceCard.locationId) return false;
      if (effect.destination.mode === "forwardOrBackward") {
        return adjacentLocationIds(state.board, state.president.locationId).length > 0;
      }
      return true;
    }
    default:
      return true; // triggerAlarm/gainActions/draw/returnToHand/blend/gainControl/if always have some submission
  }
}

function requiredMinCount(count: TargetCount): number {
  switch (count.mode) {
    case "exact":
      return count.value;
    case "range":
      return count.min;
    case "all":
    case "unbounded":
      return 0;
  }
}

// --- Top-level turn actions (resolution stack empty) ---

// The currently-active restricted grant (Puppet-Master's "Play 2 cards",
// Master Assassin's "return and play a card", Commander General's "any
// number... at this location" — both play and activate abilities,
// Opposition Leader's "place 2 rebels at any locations"), filtered to the
// given kind and not yet exhausted — mirrors reducer.ts's own
// activeRestrictedGrant exactly, so bots never consider a budget the
// server would actually reject.
function activeRestrictedGrant(state: FilteredGameState, kind: "play" | "activate"): RestrictedActionGrant | null {
  const grant = state.turn.restrictedAction;
  if (!grant || grant.kind !== kind) return null;
  if (grant.amount !== "unbounded" && grant.amount <= 0) return null;
  return grant;
}

// A hand card only actually qualifies for a "play" grant once its own
// faction narrowing (if any) is satisfied — Commander General/Opposition
// Leader restrict to one faction, Puppet-Master/Master Assassin don't
// restrict at all, so those also cover a Motorcade (no faction of its
// own) — the whole point of the redesign.
function handCardQualifiesForPlayGrant(
  cardData: CardData,
  grant: RestrictedActionGrant,
  card: FilteredCardInstance,
): boolean {
  return grant.faction === null || knownFaction(cardData, card) === grant.faction;
}

function inPlayCardQualifiesForActivateGrant(
  cardData: CardData,
  grant: RestrictedActionGrant,
  card: FilteredCardInstance,
): boolean {
  return (
    (grant.faction === null || knownFaction(cardData, card) === grant.faction) &&
    (grant.locationId === null || card.locationId === grant.locationId)
  );
}

// Whether the current budget (normal actionsRemaining, or a qualifying
// restricted "play" grant) can actually pay for playing this specific
// hand card — separate from isHandCardPlayable's own structural check
// below (which doesn't know about budgets at all).
function canAffordPlayingHandCard(state: FilteredGameState, cardData: CardData, card: FilteredCardInstance): boolean {
  if (state.turn.actionsRemaining > 0) return true;
  const grant = activeRestrictedGrant(state, "play");
  return grant !== null && handCardQualifiesForPlayGrant(cardData, grant, card);
}

// Whether decidePlayCardOrMotorcade could actually play this specific hand
// card right now — the one real dead end being a Motorcade once the
// President is already eliminated, which additionally needs an own
// in-play card to relocate. Shared between the viability check below and
// the real decision so the two can never drift apart (a mismatch there
// previously caused bots to end their turn early: decideTurnAction would
// weight-pick "playCard" whenever the hand was non-empty, but
// decidePlayCardOrMotorcade could still independently bail to endTurn on
// an unplayable card it happened to randomly land on, even with other
// actions still available and other, playable cards still in hand).
function isHandCardPlayable(state: FilteredGameState, playerId: PlayerId, card: FilteredCardInstance): boolean {
  if (state.board.length === 0) return false;
  if (card.kind !== "motorcade") return true;
  if (state.president.status !== "eliminated") return true;
  return state.cards.some((c) => c.zone === "inPlay" && c.controller === playerId);
}

function hasPlayableHandCard(state: FilteredGameState, playerId: PlayerId, cardData: CardData): boolean {
  return state.cards.some(
    (c) =>
      c.zone === "hand" &&
      c.controller === playerId &&
      isHandCardPlayable(state, playerId, c) &&
      canAffordPlayingHandCard(state, cardData, c),
  );
}

function deckHasCards(state: FilteredGameState): boolean {
  return state.cards.some((c) => c.zone === "deck");
}

function hasMovableOwnCard(state: FilteredGameState, playerId: PlayerId): boolean {
  return state.cards.some(
    (c) =>
      c.zone === "inPlay" &&
      c.controller === playerId &&
      c.locationId &&
      adjacentLocationIds(state.board, c.locationId).length > 0,
  );
}

// Whether the current budget (normal actionsRemaining, or a qualifying
// restricted "activate" grant) can actually pay for activating an
// ability on this specific in-play card — mirrors
// canAffordPlayingHandCard for the "play" side.
function canAffordActivating(state: FilteredGameState, cardData: CardData, card: FilteredCardInstance): boolean {
  if (state.turn.actionsRemaining > 0) return true;
  const grant = activeRestrictedGrant(state, "activate");
  return grant !== null && inPlayCardQualifiesForActivateGrant(cardData, grant, card);
}

// Every currently-usable Activate ability across ALL of this player's
// in-play cards — shared between the viability check and the real
// decision for the same reason as isHandCardPlayable above.
// decideActivateAbility previously picked one random own card and gave up
// entirely if *that* card had nothing usable, even when a different own
// card did.
function usableActivateAbilities(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  objective: PresidentObjective,
): { card: FilteredCardInstance; abilityIndex: number }[] {
  const ownInPlay = state.cards.filter((c) => c.zone === "inPlay" && c.controller === playerId && c.defRef !== null);
  const result: { card: FilteredCardInstance; abilityIndex: number }[] = [];
  for (const card of ownInPlay) {
    if (!canAffordActivating(state, cardData, card)) continue;
    const instance = asCardInstance(card)!;
    for (const [abilityIndex, ability] of getAbilities(cardData, instance).entries()) {
      if (ability.type !== "Activate") continue;
      if (state.turn.usedAbilities.includes(`${card.id}#${abilityIndex}`)) continue;
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      if (!def) continue;
      if (objective === "protect" && abilityTargetsPresident(def)) continue;
      if (!abilityHasAvailableFirstTarget(state, cardData, card, def, playerId)) continue;
      result.push({ card, abilityIndex });
    }
  }
  return result;
}

function decideTurnAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  if (state.turn.phase === "draw") return { type: "draw" };
  if (
    state.turn.actionsRemaining <= 0 &&
    activeRestrictedGrant(state, "play") === null &&
    activeRestrictedGrant(state, "activate") === null
  ) {
    return { type: "endTurn" };
  }

  // A restricted grant (Puppet-Master, Master Assassin, Commander
  // General, Opposition Leader — see RestrictedActionGrant) can leave
  // actionsRemaining at 0 while playCard/activateAbility (whichever kind
  // it names) is still viable — draw/moveCard can only ever draw from
  // the normal budget, so once that's empty they're gone regardless.
  // hasPlayableHandCard/usableActivateAbilities already account for
  // their own grant internally, so no extra gating is needed for them
  // here.
  const canSpendNormal = state.turn.actionsRemaining > 0;

  const categories: ["playCard" | "draw" | "activateAbility" | "moveCard", number][] = [];
  if (hasPlayableHandCard(state, playerId, cardData)) categories.push(["playCard", 40]);
  if (canSpendNormal && deckHasCards(state)) categories.push(["draw", 30]);
  if (usableActivateAbilities(state, playerId, cardData, objective).length > 0) {
    categories.push(["activateAbility", 20]);
  }
  if (canSpendNormal && hasMovableOwnCard(state, playerId)) categories.push(["moveCard", 10]);

  // Every category above is gated on the exact same viability check its
  // own decide* function uses, so once offered here it's guaranteed not
  // to bail to endTurn on its own — nothing viable at all (empty hand,
  // empty deck, no usable ability, no movable card) is the only real
  // reason left to end the turn early.
  if (categories.length === 0) return { type: "endTurn" };

  const category = pickWeighted(rng, categories);
  switch (category) {
    case "draw":
      return { type: "draw" };
    case "playCard":
      return decidePlayCardOrMotorcade(state, playerId, cardData, rng);
    case "activateAbility":
      return decideActivateAbility(state, playerId, cardData, objective, rng);
    case "moveCard":
      return decideMoveCard(state, playerId, rng);
  }
}

function decidePlayCardOrMotorcade(state: FilteredGameState, playerId: PlayerId, cardData: CardData, rng: Rng): Action {
  const hand = state.cards.filter(
    (c) =>
      c.zone === "hand" &&
      c.controller === playerId &&
      isHandCardPlayable(state, playerId, c) &&
      canAffordPlayingHandCard(state, cardData, c),
  );
  const card = pickRandom(rng, hand);
  if (!card) return { type: "endTurn" };

  if (card.kind === "motorcade") {
    if (state.president.status === "eliminated") {
      const ownInPlay = state.cards.filter((c) => c.zone === "inPlay" && c.controller === playerId);
      const moving = pickRandom(rng, ownInPlay)!; // guaranteed non-empty by isHandCardPlayable
      const location = pickRandom(rng, state.board)!; // guaranteed non-empty by isHandCardPlayable
      return { type: "playMotorcade", cardId: card.id, moveOwnCardId: moving.id, moveToLocationId: location.id };
    }
    return { type: "playMotorcade", cardId: card.id };
  }

  // If only a restricted grant with a forced location (Commander
  // General's "at this location") can pay for this once the normal
  // budget is exhausted, use its exact location rather than a blind
  // random pick that would almost certainly be rejected.
  const forcedLocationId =
    state.turn.actionsRemaining > 0 ? undefined : activeRestrictedGrant(state, "play")?.locationId;
  const location = forcedLocationId
    ? state.board.find((l) => l.id === forcedLocationId)!
    : pickRandom(rng, state.board)!; // guaranteed non-empty by isHandCardPlayable
  return { type: "playCard", cardId: card.id, locationId: location.id };
}

function decideMoveCard(state: FilteredGameState, playerId: PlayerId, rng: Rng): Action {
  const movable = state.cards.filter(
    (c) =>
      c.zone === "inPlay" &&
      c.controller === playerId &&
      c.locationId &&
      adjacentLocationIds(state.board, c.locationId).length > 0,
  );
  const card = pickRandom(rng, movable);
  if (!card?.locationId) return { type: "endTurn" };
  const toLocationId = pickRandom(rng, adjacentLocationIds(state.board, card.locationId))!;
  return { type: "moveCard", cardId: card.id, toLocationId };
}

function decideActivateAbility(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  const usable = usableActivateAbilities(state, playerId, cardData, objective);
  if (usable.length === 0) return { type: "endTurn" };

  const eliminateCapable = usable.filter(({ card, abilityIndex }) =>
    abilityHasEliminateEffect(getAbilityEffects(card.defRef!, abilityIndex)!),
  );
  const chosen = pickRandom(rng, eliminateCapable.length > 0 ? eliminateCapable : usable)!;
  return { type: "activateAbility", cardId: chosen.card.id, abilityIndex: chosen.abilityIndex };
}

// --- AbilityResolutionFrame: chooseTargets ---

function decideChooseTargets(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  const empty = { type: "chooseTargets" as const, targetIds: [] as readonly string[] };
  const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId);
  if (!sourceCard || sourceCard.defRef === null) return empty;
  const definition = getAbilityEffects(sourceCard.defRef, frame.abilityIndex);
  const effect = definition?.effects[frame.effectIndex ?? 0];
  if (!effect) return empty;

  switch (effect.verb) {
    case "eliminate": {
      const targetIds = decideEliminateTargetIds(
        state,
        playerId,
        cardData,
        sourceCard,
        effect,
        objective,
        rng,
        frame.reselectingAfterReveal ?? false,
      );
      return { type: "chooseTargets", targetIds };
    }
    case "reveal":
    case "peek":
      return { type: "chooseTargets", targetIds: decideRevealOrPeekTargetIds(state, cardData, sourceCard, effect, rng) };
    case "play":
      return decidePlayTargets(state, playerId, cardData, effect, rng);
    case "activateRemote":
      return decideActivateRemoteTargets(state, playerId, cardData, sourceCard, effect, rng);
    case "move":
      return decideMoveEffectTargets(state, rng);
    case "triggerAlarm":
      return decideTriggerAlarmTargets(effect, state, rng);
    case "gainControl":
    case "returnToHand":
    case "blend":
    case "gainActions":
    case "draw":
    case "if":
      return empty; // always ref:"self"/"binding" or otherwise automatic — nothing to choose
  }
}

function decideEliminateTargetIds(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
  objective: PresidentObjective,
  rng: Rng,
  forceBypassProtection = false,
): readonly string[] {
  if (effect.target.ref === "self" || effect.target.ref === "binding") return [];
  if (effect.target.ref !== "filter") return [];
  if (effect.target.selection === "random") return []; // engine draws automatically

  const pool = eliminateCandidatePool(state, cardData, sourceCard, playerId, effect, forceBypassProtection);
  // "Targets are randomly chosen from opposing cards. Don't target your
  // own cards" — a hard exclusion, not a preference with an own-card
  // fallback: abilityHasAvailableFirstTarget already refuses to activate
  // an eliminate ability with no opposing candidate, so this should never
  // actually need to fall back to `pool`. The President (controller: null)
  // always passes this filter on his own.
  let finalPool =
    effect.target.controller === "self" || effect.target.controller === "other"
      ? pool // already hard-constrained by the selector itself
      : pool.filter((c) => c.controller !== playerId);

  // A "protect" leader never targets the President, even incidentally via
  // a generic ability that happens to include him as one of several
  // candidates now that eliminateCandidatePool can mix him in —
  // abilityTargetsPresident (decideActivateAbility's own gate) only
  // screens out abilities *dedicated* to him (Wife's kind:"president"), so
  // this exclusion is still needed here for a plain "eliminate 1 target"
  // that could otherwise go either way. But only when there's a real
  // alternative: once an ability is already committed (this function is
  // reached), there's no legal decline (see abilityHasAvailableFirstTarget's
  // comment) — for Wife's own dedicated selector, or a remote activation
  // that bypassed decideActivateAbility's gate, the President can be the
  // *only* candidate, and stranding the bot with zero legal targets is
  // worse than the incidental-avoidance this filter exists for.
  if (objective === "protect") {
    const minNeeded = requiredMinCount(effect.target.count);
    const withoutPresident = finalPool.filter((c) => c.id !== PRESIDENT_TARGET_ID);
    if (withoutPresident.length >= minNeeded) {
      finalPool = withoutPresident;
    }
  }

  const count = countToPick(rng, effect.target.count, finalPool.length);
  const chosen = pickN(rng, finalPool, count);

  // An "eliminate" leader prefers the President when he's a legal target
  // and there's room to include him — the natural extension, now that a
  // generic selector can offer a genuine mix, of the preference this
  // function's own comment already anticipated.
  if (objective === "eliminate" && count > 0 && !chosen.some((c) => c.id === PRESIDENT_TARGET_ID)) {
    const presidentCandidate = finalPool.find((c) => c.id === PRESIDENT_TARGET_ID);
    if (presidentCandidate) chosen[0] = presidentCandidate;
  }

  return chosen.map((c) => c.id);
}

function decideRevealOrPeekTargetIds(
  state: FilteredGameState,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  effect: Extract<EffectNode, { verb: "reveal" | "peek" }>,
  rng: Rng,
): readonly string[] {
  if (effect.target.ref !== "filter") return [];
  if (effect.target.count.mode === "all") return []; // forced, confirm-only
  const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard);
  const count = countToPick(rng, effect.target.count, pool.length);
  return pickN(rng, pool, count).map((c) => c.id);
}

function decidePlayTargets(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  effect: Extract<EffectNode, { verb: "play" }>,
  rng: Rng,
): Action {
  if (effect.target.ref !== "filter") return { type: "chooseTargets", targetIds: [] };
  const pool = candidateHandCards(state, cardData, effect.target, playerId);
  const count = countToPick(rng, effect.target.count, pool.length);
  const chosen = pickN(rng, pool, count);
  const targetIds = chosen.map((c) => c.id);

  if (effect.location.mode === "any") {
    const locationIds = targetIds.map(() => pickRandom(rng, state.board)?.id).filter((id): id is string => id !== undefined);
    return { type: "chooseTargets", targetIds, locationIds };
  }
  return { type: "chooseTargets", targetIds };
}

function decideActivateRemoteTargets(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  effect: Extract<EffectNode, { verb: "activateRemote" }>,
  rng: Rng,
): Action {
  if (effect.target.ref !== "filter") return { type: "chooseTargets", targetIds: [] };
  // Must know the candidate's own identity to pick one of its abilities —
  // a hidden card can't be remotely activated by a bot that can't see it.
  const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard).filter((c) => c.defRef !== null);
  const chosenCard = pickRandom(rng, pool);
  if (!chosenCard) return { type: "chooseTargets", targetIds: [] }; // "no more" for an unbounded queue, or just fails/retries

  const instance = asCardInstance(chosenCard)!;
  const activatable = getAbilities(cardData, instance)
    .map((ability, abilityIndex) => ({ ability, abilityIndex }))
    .filter(({ ability, abilityIndex }) => {
      if (ability.type !== "Activate") return false;
      if (state.turn.usedAbilities.includes(`${chosenCard.id}#${abilityIndex}`)) return false;
      // Same "no legal decline once committed" dead end as a normal
      // activateAbility choice — remote activation pushes this ability's
      // own AbilityResolutionFrame, so an empty candidate pool for it is
      // just as fatal (a real bug: Head of Security remotely activated
      // Death Squad's eliminate-1-or-2 ability with nothing left at its
      // location, and got stuck the same way).
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      return def ? abilityHasAvailableFirstTarget(state, cardData, chosenCard, def, playerId) : false;
    });
  const chosenAbility = pickRandom(rng, activatable);
  if (!chosenAbility) return { type: "chooseTargets", targetIds: [] };

  return { type: "chooseTargets", targetIds: [chosenCard.id], remoteAbilityIndex: chosenAbility.abilityIndex };
}

function decideMoveEffectTargets(state: FilteredGameState, rng: Rng): Action {
  if (state.president.status !== "alive" || !state.president.locationId) {
    return { type: "chooseTargets", targetIds: [] };
  }
  const adjacent = adjacentLocationIds(state.board, state.president.locationId);
  const chosen = pickRandom(rng, adjacent);
  if (!chosen) return { type: "chooseTargets", targetIds: [] };
  return { type: "chooseTargets", targetIds: [], locationIds: [chosen] };
}

function decideTriggerAlarmTargets(
  effect: Extract<EffectNode, { verb: "triggerAlarm" }>,
  state: FilteredGameState,
  rng: Rng,
): Action {
  if (effect.location.mode !== "any") return { type: "chooseTargets", targetIds: [] };
  const chosen = pickRandom(rng, state.board);
  if (!chosen) return { type: "chooseTargets", targetIds: [] };
  return { type: "chooseTargets", targetIds: [], locationIds: [chosen.id] };
}

function countToPick(rng: Rng, count: TargetCount, poolSize: number): number {
  switch (count.mode) {
    case "exact":
      return Math.min(count.value, poolSize);
    case "range": {
      const max = Math.min(count.max, poolSize);
      const min = Math.min(count.min, max);
      if (max <= 0) return 0;
      return min + Math.floor(rng() * (max - min + 1));
    }
    case "all":
      return poolSize;
    case "unbounded":
      return Math.floor(rng() * (poolSize + 1));
  }
}

// --- AlarmResolutionFrame: useResponse / passResponse ---

function decideAlarmAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  frame: AlarmResolutionFrame,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  const candidates = state.cards.filter(
    (c) =>
      c.zone === "inPlay" &&
      c.controller === playerId &&
      c.locationId === frame.locationId &&
      c.id !== frame.triggeringCardId &&
      c.defRef !== null,
  );

  const options: { cardId: string; abilityIndex: number; hasEliminate: boolean }[] = [];
  for (const card of candidates) {
    const instance = asCardInstance(card)!;
    for (const [abilityIndex, ability] of getAbilities(cardData, instance).entries()) {
      if (ability.type !== "Response") continue;
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      if (!def) continue;
      if (objective === "protect" && abilityTargetsPresident(def)) continue;
      if (!abilityHasAvailableFirstTarget(state, cardData, card, def, playerId)) continue;
      options.push({ cardId: card.id, abilityIndex, hasEliminate: abilityHasEliminateEffect(def) });
    }
  }
  if (options.length === 0) return { type: "passResponse" };

  const eliminateOptions = options.filter((o) => o.hasEliminate);
  // "Tries to eliminate other cards when it can" — prefer acting with an
  // eliminate-capable Response over passing; otherwise mostly random.
  const shouldAct = eliminateOptions.length > 0 || coinFlip(rng, 0.5);
  if (!shouldAct) return { type: "passResponse" };

  const chosen = pickRandom(rng, eliminateOptions.length > 0 ? eliminateOptions : options)!;
  const sourceCard = state.cards.find((c) => c.id === chosen.cardId)!;
  const def = getAbilityEffects(sourceCard.defRef!, chosen.abilityIndex)!;
  const effect = def.effects[0];
  const targetIds =
    effect && effect.verb === "eliminate"
      ? decideEliminateTargetIds(state, playerId, cardData, sourceCard, effect, objective, rng)
      : [];
  return { type: "useResponse", cardId: chosen.cardId, abilityIndex: chosen.abilityIndex, targetIds };
}

// --- ProtectedTargetingWindowFrame: revealBlended / passReveal ---

function decideRevealAction(
  state: FilteredGameState,
  playerId: PlayerId,
  frame: ProtectedTargetingWindowFrame,
  rng: Rng,
): Action {
  const ownBlended = state.cards.filter(
    (c) => c.zone === "inPlay" && c.controller === playerId && c.locationId === frame.locationId && c.faceUp === false,
  );
  if (ownBlended.length === 0 || !coinFlip(rng, 0.5)) return { type: "passReveal" };
  const count = 1 + Math.floor(rng() * ownBlended.length);
  return { type: "revealBlended", cardIds: pickN(rng, ownBlended, count).map((c) => c.id) };
}

// --- MotorcadeInterceptionWindowFrame: interceptMotorcade / passIntercept ---

function decideInterceptAction(
  state: FilteredGameState,
  playerId: PlayerId,
  frame: MotorcadeInterceptionWindowFrame,
  rng: Rng,
): Action {
  const eligible = state.cards.filter(
    (c) =>
      c.zone === "inPlay" &&
      c.controller === playerId &&
      c.locationId === frame.presidentLocationId &&
      c.defRef !== null &&
      getPassive(c.defRef)?.kind === "motorcadeInterception",
  );
  if (eligible.length === 0 || !coinFlip(rng, 0.5)) return { type: "passIntercept" };
  const chosen = pickRandom(rng, eligible)!;
  return { type: "interceptMotorcade", cardId: chosen.id };
}

// --- ReactivePassiveWindowFrame: playReactive / passReactive ---

function decideReactiveAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  frame: ReactivePassiveWindowFrame,
  rng: Rng,
): Action {
  const pool = state.cards.filter((c) => {
    if (c.zone !== "hand" || c.controller !== playerId) return false;
    if (frame.faction && knownFaction(cardData, c) !== frame.faction) return false;
    return true;
  });
  if (pool.length === 0 || !coinFlip(rng, 0.5)) return { type: "passReactive" };
  const count = 1 + Math.floor(rng() * pool.length);
  return { type: "playReactive", cardIds: pickN(rng, pool, count).map((c) => c.id) };
}
