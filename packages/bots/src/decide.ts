import {
  adjacentLocationIds,
  asCardInstance,
  candidateHandCards,
  candidateInPlayCards,
  getAbilities,
  getAbilityEffects,
  getAllowedLocationTypes,
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
  BoardLayout,
  CardData,
  EffectNode,
  FilteredCardInstance,
  FilteredGameState,
  LocationInstance,
  MotorcadeInterceptionWindowFrame,
  PlayerId,
  ProtectedTargetingWindowFrame,
  ReactivePassiveWindowFrame,
  RestrictedActionGrant,
  TargetCount,
} from "@rev-day/engine";
import type { PresidentObjective } from "./presidentObjective";
import { presidentObjectiveFor } from "./presidentObjective";
import type { LeaderLocationObjective } from "./leaderObjective";
import { computeProtectionTargets, leaderLocationObjectiveFor, shouldDeployLocationLeaderNow, stepToward } from "./leaderObjective";
import type { Rng } from "./random";
import { coinFlip, pickN, pickRandom } from "./random";

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
  const locationObjective = computeLocationObjective(state, playerId);
  const objective = effectivePresidentObjective(state, computeObjective(state, playerId), locationObjective);
  const frame = state.resolutionStack[state.resolutionStack.length - 1];
  if (!frame) {
    return decideTurnAction(state, playerId, cardData, objective, locationObjective, rng);
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

function computeLocationObjective(state: FilteredGameState, playerId: PlayerId): LeaderLocationObjective {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  if (!leader || leader.defRef === null) return { eliminateAtLocationId: null };
  return leaderLocationObjectiveFor(leader.defRef, winConditions, state.board);
}

// presidentObjectiveFor collapses Wife's presidentEliminatedAt predicate
// down to a location-blind "eliminate" — every other one of this
// player's cards then inherits a blanket "kill the President whenever
// you can" preference (usableActivateAbilities, decideEliminateTargetIds,
// decideAlarmAction all key off PresidentObjective), which actively
// sabotages her actual win condition: a Regime card snipes him at, say,
// HQ, and the game's only shot at "eliminated at the Palace" is gone for
// good. Overridden here to "protect" (the same passive-avoidance +
// reactive-defense behavior Head of Security already gets) whenever the
// President isn't currently at the win location, and left as "eliminate"
// once he is — which both re-enables Wife's own dedicated ability and
// encourages her other cards to pile on (the Palace-stacking redundancy
// from desiredCardLocations). A no-op for every leader without a location
// objective, so this changes nothing for the rest of the roster.
function effectivePresidentObjective(
  state: FilteredGameState,
  objective: PresidentObjective,
  locationObjective: LeaderLocationObjective,
): PresidentObjective {
  if (!locationObjective.eliminateAtLocationId) return objective;
  const presidentAtObjectiveLocation =
    state.president.status === "alive" && state.president.locationId === locationObjective.eliminateAtLocationId;
  return presidentAtObjectiveLocation ? "eliminate" : "protect";
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
  // Activating sourceCard — whether directly or (one level up the call
  // stack) as someone else's remote target — unconditionally reveals it
  // *before* its own targets are chosen (see reducer.ts's
  // applyActivateAbility/applyActivateRemote). Checking against its
  // current, possibly-still-blended state can wrongly read this ability
  // as usable/unusable relative to what it'll actually be once activated
  // — not just for its own selector, but for any *other* card's own
  // ability that happens to be scanning for blended cards at this
  // location (Journalist's "reveal a blended target here"), where
  // sourceCard being the very card about to lose its blend is exactly
  // what makes that other candidate's own usability flip out from under
  // it mid-decision. A real, reproducible deadlock this was causing.
  const workingState: FilteredGameState = sourceCard.faceUp
    ? state
    : { ...state, cards: state.cards.map((c) => (c.id === sourceCard.id ? { ...c, faceUp: true } : c)) };
  switch (effect.verb) {
    case "eliminate": {
      if (effect.target.ref !== "filter") return true; // self/binding — nothing to run out of
      if (effect.target.selection === "random") return true; // engine draws automatically
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      const pool = eliminateCandidatePool(workingState, cardData, sourceCard, deciderId, effect);
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
    case "peek": {
      if (effect.target.ref !== "filter") return true; // self/binding — nothing to run out of
      // Neither verb can reach the President in current data — every
      // selector using them requires blendState:"faceDown", which he can
      // never satisfy (no Blend attribute) — so no special-casing needed.
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      const pool = candidateInPlayCards(workingState, cardData, effect.target, sourceCard);
      return pool.length >= minNeeded;
    }
    case "activateRemote": {
      if (effect.target.ref !== "filter") return true; // self/binding — nothing to run out of
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      const pool = candidateInPlayCards(workingState, cardData, effect.target, sourceCard);
      // A card being a legal *target* (right kind/faction/location) isn't
      // enough — remotely activating it still needs an Activate ability
      // that's both unused this turn and itself has a first target
      // available (same real-dead-end problem as every other case here,
      // one level deeper). Without this, a bot could commit to remote
      // activation with every candidate's abilities already exhausted:
      // there's no legal "cancel" once committed (the engine gap this
      // whole function exists to route around), decideActivateRemoteTargets
      // can't submit anything legal either (this effect is exact-count,
      // not unbounded, so an empty declaration isn't a valid "decline"),
      // and the bot deadlocks — which the caller (takeBotTurn) detects
      // as "stuck" within its own call, but the *client* has no such
      // bound: it just keeps calling bot-turn forever since the decider
      // never changes. A real freeze this surfaced, not hypothetical.
      const withUsableAbility = pool.filter((c) => cardHasUsableActivateAbility(workingState, cardData, c, deciderId));
      return withUsableAbility.length >= minNeeded;
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

// Whether `card` has at least one Activate ability that's both unused
// this turn and itself has an available first target — i.e. whether it's
// actually a legal thing to remotely activate, not just a legal *target*
// for the selector (kind/faction/location). Shared between
// abilityHasAvailableFirstTarget's activateRemote pre-check and
// decideActivateRemoteTargets's real candidate-narrowing so the two can
// never drift apart. (abilityHasAvailableFirstTarget itself accounts for
// `card` being revealed by its own activation before evaluating its
// targets — see that function's own comment — so this doesn't need to.)
function cardHasUsableActivateAbility(
  state: FilteredGameState,
  cardData: CardData,
  card: FilteredCardInstance,
  deciderId: PlayerId,
): boolean {
  const instance = asCardInstance(card);
  if (!instance) return false;
  return getAbilities(cardData, instance).some((ability, abilityIndex) => {
    if (ability.type !== "Activate") return false;
    if (state.turn.usedAbilities.includes(`${card.id}#${abilityIndex}`)) return false;
    const def = getAbilityEffects(instance.defRef, abilityIndex);
    return def ? abilityHasAvailableFirstTarget(state, cardData, card, def, deciderId) : false;
  });
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

function findOwnLeaderInHand(state: FilteredGameState, playerId: PlayerId): FilteredCardInstance | undefined {
  return state.cards.find((c) => c.kind === "leader" && c.zone === "hand" && c.controller === playerId);
}

function decideTurnAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  objective: PresidentObjective,
  locationObjective: LeaderLocationObjective,
  rng: Rng,
): Action {
  if (state.turn.phase === "draw") return { type: "draw" };

  // "Once the President is eliminated, the current player's own leader,
  // if still in hand, must be played before anything else once you have
  // an action to spend on it — but once you're out of actions, you're
  // free to end your turn like normal, and the obligation just carries
  // over to your next turn" (see reducer.ts's requireLeaderPlayedIfStuck).
  // Re-checked fresh every call, not just once at turn start: an ability
  // can put a leader back in hand mid-turn (Master Assassin's own
  // "return this card to its controller's hand and play a card"), so if
  // that happens to be the bot's last action, this correctly finds the
  // leader stuck again immediately and — since actionsRemaining is now
  // 0 — falls through to ending the turn, leaving it stuck until next
  // turn, exactly as the rule intends.
  const stuckLeader = state.president.status === "eliminated" ? findOwnLeaderInHand(state, playerId) : undefined;
  if (stuckLeader) {
    if (state.turn.actionsRemaining > 0) {
      const instance = asCardInstance(stuckLeader)!;
      const allowedTypes = getAllowedLocationTypes(cardData, instance);
      const location = pickRandom(
        rng,
        state.board.filter((l) => allowedTypes.includes(l.type)),
      );
      if (location) return { type: "playCard", cardId: stuckLeader.id, locationId: location.id };
    }
    // Out of actions (or, in a scenario the real card data shouldn't ever
    // produce, nowhere legal to play it) — requireLeaderPlayedIfStuck
    // allows nothing else right now, so this is the only move left.
    return { type: "endTurn" };
  }

  // The actual win-clinching move for a location-gated leader (Wife): the
  // President is right here, right now. This can't be left to the normal
  // play/activate coinflip below — missing this turn risks him being
  // moved past this location by the next Motorcade play (by anyone),
  // which ends the game via "survived" with nothing left to eliminate.
  // usableActivateAbilities already filters to affordable, currently-legal
  // abilities, so finding one here guarantees the budget is there too.
  if (
    locationObjective.eliminateAtLocationId &&
    state.president.status === "alive" &&
    state.president.locationId === locationObjective.eliminateAtLocationId
  ) {
    const winningMove = usableActivateAbilities(state, playerId, cardData, objective).find(({ card, abilityIndex }) =>
      abilityTargetsPresident(getAbilityEffects(card.defRef!, abilityIndex)!),
    );
    if (winningMove) {
      return { type: "activateAbility", cardId: winningMove.card.id, abilityIndex: winningMove.abilityIndex };
    }
  }

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

  // "Protect the President/Wife: when you have a Regime card, play it
  // (routed to wherever protection is needed — see
  // decidePlayCardOrMotorcade); when you don't, drawing can make sense" —
  // only for a leader whose win condition actually depends on this
  // (locationObjective set); other leaders keep the plain coinflip chain
  // below untouched. Skipped once there's nothing left to protect.
  if (
    locationObjective.eliminateAtLocationId &&
    canSpendNormal &&
    deckHasCards(state) &&
    computeProtectionTargets(state, playerId, locationObjective).locationIds.length > 0 &&
    !state.cards.some((c) => c.zone === "hand" && c.controller === playerId && knownFaction(cardData, c) === "Regime")
  ) {
    return { type: "draw" };
  }

  // Priority chain: roll once for which of play/activate to attempt as
  // the primary action (65%/35%), then fall through to draw, then move,
  // whenever the attempted option has no legal targets — never back to
  // the other of play/activate, and never a second roll.
  if (coinFlip(rng, 0.65)) {
    if (hasPlayableHandCard(state, playerId, cardData))
      return decidePlayCardOrMotorcade(state, playerId, cardData, locationObjective, rng);
  } else if (usableActivateAbilities(state, playerId, cardData, objective).length > 0) {
    return decideActivateAbility(state, playerId, cardData, objective, rng);
  }
  if (canSpendNormal && deckHasCards(state)) return { type: "draw" };
  if (canSpendNormal && hasMovableOwnCard(state, playerId))
    return decideMoveCard(state, playerId, cardData, locationObjective, rng);

  // Nothing in the chain was legal — the only real reason left to end
  // the turn early (every step above is gated on the exact same
  // viability check its own decide* function uses, so once attempted
  // it's guaranteed not to bail to endTurn on its own).
  return { type: "endTurn" };
}

function decidePlayCardOrMotorcade(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  locationObjective: LeaderLocationObjective,
  rng: Rng,
): Action {
  const hand = state.cards.filter(
    (c) =>
      c.zone === "hand" &&
      c.controller === playerId &&
      isHandCardPlayable(state, playerId, c) &&
      canAffordPlayingHandCard(state, cardData, c),
  );

  // Deploy a location-gated leader (Wife) straight to her win location
  // once the deploy window is open — see shouldDeployLocationLeaderNow.
  // Takes priority over everything below: getting her into play at all
  // matters more than any other play this turn.
  if (locationObjective.eliminateAtLocationId && shouldDeployLocationLeaderNow(state, locationObjective)) {
    const ownLeader = hand.find((c) => c.kind === "leader");
    if (ownLeader) {
      const target = playableTargetLocation(cardData, state.board, ownLeader, [locationObjective.eliminateAtLocationId]);
      if (target) return { type: "playCard", cardId: ownLeader.id, locationId: target.id };
    }
  }

  // Otherwise prefer a hand card that currently has somewhere purposeful
  // to go — protection coverage for a Regime card, or Palace-stacking
  // redundancy for an eliminate-capable card once the deploy window is
  // open — over a blind random pick. See desiredCardLocations.
  const purposefulPlays = hand
    .filter((c) => c.kind !== "motorcade")
    .map((card) => {
      const desired = desiredCardLocations(state, playerId, cardData, card, locationObjective);
      const location = playableTargetLocation(cardData, state.board, card, desired);
      return location ? { card, location } : undefined;
    })
    .filter((p): p is { card: FilteredCardInstance; location: LocationInstance } => p !== undefined);
  if (purposefulPlays.length > 0) {
    const chosen = pickRandom(rng, purposefulPlays)!;
    return { type: "playCard", cardId: chosen.card.id, locationId: chosen.location.id };
  }

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

// The first of `desiredLocationIds` (in priority order) that `card` is
// actually legal to play at (its own allowed location types include that
// location's type) — shared by the leader-deploy priority above and the
// purposeful-play scan below, so "desired" and "legally playable" can
// never drift apart.
function playableTargetLocation(
  cardData: CardData,
  board: BoardLayout,
  card: FilteredCardInstance,
  desiredLocationIds: readonly string[],
): LocationInstance | undefined {
  const instance = asCardInstance(card);
  if (!instance) return undefined;
  const allowedTypes = getAllowedLocationTypes(cardData, instance);
  for (const id of desiredLocationIds) {
    const location = board.find((l) => l.id === id);
    if (location && allowedTypes.includes(location.type)) return location;
  }
  return undefined;
}

// Where `card` should currently be routed, in priority order: the win
// location itself, for an eliminate-capable card once the deploy window
// is open (Palace-stacking redundancy — the win condition doesn't require
// this player's own leader to land the kill, see WinPredicate's
// presidentEliminatedAt); then wherever Regime protection is currently
// needed (see computeProtectionTargets). A non-Regime, non-eliminate-
// capable card gets an empty list and falls through to the existing
// random placement, unchanged from before this feature.
function desiredCardLocations(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  card: FilteredCardInstance,
  locationObjective: LeaderLocationObjective,
): readonly string[] {
  // Gated on locationObjective.eliminateAtLocationId throughout, not just
  // for the stacking clause below — this whole routing behavior is scoped
  // to this player controlling a location-gated leader (currently: Wife).
  // Every other leader's bot keeps the fully random play/move behavior
  // this feature started from.
  if (!locationObjective.eliminateAtLocationId) return [];

  const ids: string[] = [];
  if (shouldDeployLocationLeaderNow(state, locationObjective) && cardHasAnyEliminateAbility(cardData, card)) {
    ids.push(locationObjective.eliminateAtLocationId);
  }
  if (knownFaction(cardData, card) === "Regime") {
    for (const id of computeProtectionTargets(state, playerId, locationObjective).locationIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// Whether `card` has any ability (Activate or Response) with an eliminate
// effect at all — used to decide *where* an eliminate-capable card should
// be routed once played, not whether any specific target is currently
// legal (candidateInPlayCards/eliminateCandidatePool answer that once the
// card is actually in play).
function cardHasAnyEliminateAbility(cardData: CardData, card: FilteredCardInstance): boolean {
  const instance = asCardInstance(card);
  if (!instance) return false;
  return getAbilities(cardData, instance).some((ability, abilityIndex) => {
    const def = getAbilityEffects(instance.defRef, abilityIndex);
    return def ? abilityHasEliminateEffect(def) : false;
  });
}

function decideMoveCard(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  locationObjective: LeaderLocationObjective,
  rng: Rng,
): Action {
  const movable = state.cards.filter(
    (c) =>
      c.zone === "inPlay" &&
      c.controller === playerId &&
      c.locationId &&
      adjacentLocationIds(state.board, c.locationId).length > 0,
  );
  if (movable.length === 0) return { type: "endTurn" };

  // Prefer stepping a card toward wherever it's currently needed
  // (protection coverage, or Palace-stacking once the deploy window is
  // open) over a blind random adjacent move — same desiredCardLocations
  // priority as the play side above.
  const purposefulMoves = movable
    .map((card) => {
      const desired = desiredCardLocations(state, playerId, cardData, card, locationObjective);
      const toLocationId = desired.length > 0 ? stepToward(state.board, card.locationId!, desired) : undefined;
      return toLocationId ? { card, toLocationId } : undefined;
    })
    .filter((m): m is { card: FilteredCardInstance; toLocationId: string } => m !== undefined);
  if (purposefulMoves.length > 0) {
    const chosen = pickRandom(rng, purposefulMoves)!;
    return { type: "moveCard", cardId: chosen.card.id, toLocationId: chosen.toLocationId };
  }

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
  // own cards" — normally a hard exclusion, not just a preference:
  // abilityHasAvailableFirstTarget already refuses to activate an eliminate
  // ability with no opposing candidate, so this shouldn't usually need to
  // fall back to `pool`. But that pre-check only runs once, at activation
  // time — an alarm response in between (a Response ability that eliminates,
  // moves, or defects the pre-checked candidate; see gainControl effects)
  // can leave `pool` non-empty but entirely self-controlled by the time
  // this actually runs. The selector itself doesn't forbid self-targeting
  // in that case (only this heuristic does), so falling back to it here is
  // strictly better than the alternative: an exact/range-min effect has no
  // legal decline once committed (the same real, pre-existing engine gap
  // abilityHasAvailableFirstTarget's own comment describes), so an empty
  // submission would just throw and strand the bot.
  const opposingOnly =
    effect.target.controller === "self" || effect.target.controller === "other"
      ? pool // already hard-constrained by the selector itself
      : pool.filter((c) => c.controller !== playerId);
  // Not just "any opposing candidates at all" — enough of them to actually
  // satisfy this effect's own minimum count. A multi-target effect
  // (Master Assassin's "eliminate exactly 2") can have one genuine
  // opposing candidate and still need to fall back to the full pool to
  // make up the rest, the same as having zero.
  let finalPool = opposingOnly.length >= requiredMinCount(effect.target.count) ? opposingOnly : pool;

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
  // Also narrowed to cards with an actually-usable Activate ability (see
  // cardHasUsableActivateAbility) — same "no legal decline once
  // committed" dead end as a normal activateAbility choice, and the
  // reason abilityHasAvailableFirstTarget's own activateRemote case now
  // applies this identical filter *before* the bot ever commits to this
  // ability at all (a real bug otherwise: Head of Security remotely
  // activating Death Squad with nothing left at its location, or Puppet-
  // Master finding every remaining candidate's abilities already used
  // this turn, both got the bot stuck the same way).
  const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard).filter(
    (c) => c.defRef !== null && cardHasUsableActivateAbility(state, cardData, c, playerId),
  );
  const chosenCard = pickRandom(rng, pool);
  if (!chosenCard) return { type: "chooseTargets", targetIds: [] }; // "no more" for an unbounded queue, or just fails/retries

  const instance = asCardInstance(chosenCard)!;
  const activatable = getAbilities(cardData, instance)
    .map((ability, abilityIndex) => ({ ability, abilityIndex }))
    .filter(({ ability, abilityIndex }) => {
      if (ability.type !== "Activate") return false;
      if (state.turn.usedAbilities.includes(`${chosenCard.id}#${abilityIndex}`)) return false;
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
