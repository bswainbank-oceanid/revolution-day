import {
  adjacentLocationIds,
  asCardInstance,
  candidateHandCards,
  candidateInPlayCards,
  getAbilities,
  getAbilityEffects,
  getAllowedLocationTypes,
  getFaction,
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
  Faction,
  FilteredCardInstance,
  FilteredGameState,
  LocationInstance,
  LocationType,
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
import {
  computeProtectionTargets,
  leaderLocationObjectiveFor,
  shouldDeployLocationLeaderNow,
  stagingLocationId,
  stepToward,
} from "./leaderObjective";
import { isEscortedLocation, leaderNeedsEscort } from "./survivalObjective";
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
  const objective = computeMasterAssassinEffectiveObjective(
    state,
    cardData,
    playerId,
    effectivePresidentObjective(state, computeObjective(state, playerId), locationObjective),
  );
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
      return decideInterceptAction(state, playerId, frame, locationObjective, rng);
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

// Master Assassin's win condition needs the President eliminated
// specifically *by a card he controls* (or, failing that, 2 leaders he
// controls) — presidentObjectiveFor still reads this as a location-blind
// "eliminate" (same collapse Wife's own predicate suffered from), which
// would happily have his other cards snipe the President the moment
// anyone gets a legal shot, even when Master Assassin himself isn't the
// one taking it — attribution wouldn't go to him, and the game's only
// shot at his first win branch is gone for good. Overridden to "protect"
// (routes Regime cards to shield the President from *other* players —
// see desiredCardLocations, and note this needs the President's own
// Regime-for-rules faction, not Master Assassin's actual Rebel one) until
// this player has an eliminate-capable card of their own already at his
// location, ready to take the shot themselves.
function computeMasterAssassinMode(state: FilteredGameState, playerId: PlayerId): boolean {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  return leader?.defRef === "Master Assassin";
}

function computeMasterAssassinEffectiveObjective(
  state: FilteredGameState,
  cardData: CardData,
  playerId: PlayerId,
  objective: PresidentObjective,
): PresidentObjective {
  if (!computeMasterAssassinMode(state, playerId)) return objective;
  if (state.president.status !== "alive" || !state.president.locationId) return objective;
  return hasEliminateReadyCardAt(state, cardData, playerId, state.president.locationId) ? "eliminate" : "protect";
}

// Whether the CURRENT player's turn (this is only ever meaningful called
// for whoever's own turn it actually is — decideActivateAbility is only
// reached with no resolution frame active, i.e. playerId === state.turn.
// currentPlayerId) is their last one before the game ends —
// endgameTurnsRemaining decrements by 1 every time *any* player ends a
// turn (reducer.ts's applyEndTurn), so with N players it only cycles back
// to any one of them every N decrements. If what's left now wouldn't
// survive N-1 other players' turns plus this player's own, the game ends
// before it ever comes back around to them.
function isFinalTurnForCurrentPlayer(state: FilteredGameState): boolean {
  const remaining = state.turn.endgameTurnsRemaining;
  if (remaining === null) return false;
  return remaining <= state.players.length;
}

// The first board location (in board order — no particular significance
// beyond determinism) with an opposing, currently-hidden (Blend,
// face-down) card in play — Master Assassin's own hunting-for-other-
// leaders heuristic (point 4/5 of his strategy) has no way to know which
// hidden card is actually a leader without finding out, so "any hidden
// opposing card at all" is the closest observable proxy.
function findBlendRichLocation(state: FilteredGameState, playerId: PlayerId): LocationInstance | undefined {
  return state.board.find((l) =>
    state.cards.some((c) => c.zone === "inPlay" && c.locationId === l.id && c.faceUp === false && c.controller !== playerId),
  );
}

// Whether Master Assassin's controller still actually needs the backup
// win branch (2 leaders eliminated by cards they control) — false once
// the President was eliminated by a card of their own (the first branch
// is a permanent, already-satisfied fact — state.president.
// eliminatedByPlayerId never changes after the fact — so hunting for
// leaders is pure unnecessary risk against his own "survives"
// requirement) or once they've already reached 2. Backs every piece of
// his own "hunt other leaders" behavior (deploying/moving toward hidden
// cards, preferring his own return-to-hand ability) — without this,
// he'd keep restlessly relocating turn after turn with nothing left to
// gain from it, purely adding exposure.
function masterAssassinNeedsBackupLeaderKills(state: FilteredGameState, playerId: PlayerId): boolean {
  if (state.president.status !== "eliminated") return false;
  if (state.president.eliminatedByPlayerId === playerId) return false;
  const leadersKilled = state.cards.filter(
    (c) => c.kind === "leader" && c.zone === "eliminated" && c.eliminatedByPlayerId === playerId,
  ).length;
  return leadersKilled < 2;
}

// Point 5 of Master Assassin's own strategy ("pounce on an unprotected
// President once he reaches [board position 4]") combined with point 4
// ("once he's eliminated, hunt for other leaders among hidden cards") —
// mutually exclusive on the President's status, so one function covers
// both: whichever applies right now names where he should actually be.
const MASTER_ASSASSIN_DEPLOY_POSITION_INDEX = 3; // 0-indexed — "position 4" (1-indexed)

function findMasterAssassinDeployTarget(state: FilteredGameState, cardData: CardData, playerId: PlayerId): string | undefined {
  if (state.president.status === "eliminated") {
    return masterAssassinNeedsBackupLeaderKills(state, playerId) ? findBlendRichLocation(state, playerId)?.id : undefined;
  }
  if (state.president.status !== "alive" || !state.president.locationId) return undefined;
  const index = state.board.findIndex((l) => l.id === state.president.locationId);
  if (index < MASTER_ASSASSIN_DEPLOY_POSITION_INDEX) return undefined;
  return presidentIsLegalTarget(state, cardData, playerId, false, true) ? state.president.locationId : undefined;
}

// Head of Security's whole kit (a location-unrestricted "activate any
// Regime non-leader card" plus a reactive local eliminate) is idiosyncratic
// enough — wanting the game to end quickly via the President surviving,
// specifically preferring to remote-activate eliminate/reveal-blended
// abilities — that it isn't derivable from win-condition data the same way
// PresidentObjective/LeaderLocationObjective are. Identified by defRef,
// like leaderLocationObjectiveFor's own board lookup is identified by
// leader name, just with no generic predicate to key off here.
function computeHeadOfSecurityMode(state: FilteredGameState, playerId: PlayerId): boolean {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  return leader?.defRef === "Head of Security";
}

// Whether this player's own leader needs an escort to survive (Protected
// + a `survives` win condition — see survivalObjective.ts), and that
// leader's own faction (needed to know which of this player's other cards
// would actually count as an escort). Recomputed fresh per decision, same
// as computeObjective/computeLocationObjective — cheap, and simpler than
// threading a leader-identity object through every call site that only
// needs one or two of these functions.
function computeEscortNeed(
  state: FilteredGameState,
  cardData: CardData,
  playerId: PlayerId,
): { needsEscort: boolean; faction: Faction | undefined } {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  if (!leader || leader.defRef === null) return { needsEscort: false, faction: undefined };
  return {
    needsEscort: leaderNeedsEscort(cardData, winConditions, leader.defRef),
    faction: getFaction(cardData, asCardInstance(leader)!),
  };
}

// Two independent triggers for Head of Security to stop sitting in hand,
// mirroring shouldDeployLocationLeaderNow's own shape but for a leader
// with no target location at all — he can be played anytime, but
// `survives` is checked as `zone === "inPlay"` at game end, so he must be
// in play before the game can end: once the deck is getting low (the
// same forced-empty-deck unpredictability Wife's own trigger guards
// against) or the President's gotten far enough along that the game
// could plausibly end soon, waiting any longer risks him still being in
// hand when it does.
const HOS_DECK_LOW_THRESHOLD = 8;
const HOS_DEPLOY_POSITION_INDEX = 2; // 0-indexed — "the President reaches 3" (1-indexed)

function shouldDeployHeadOfSecurityNow(state: FilteredGameState): boolean {
  const deckSize = state.cards.filter((c) => c.zone === "deck").length;
  if (deckSize <= HOS_DECK_LOW_THRESHOLD) return true;
  if (state.president.status !== "alive" || !state.president.locationId) return false;
  const index = state.board.findIndex((l) => l.id === state.president.locationId);
  return index >= HOS_DEPLOY_POSITION_INDEX;
}

// Commander General's kit (two location:"self" gainActions grants plus a
// reveal-all-blended, all tied to wherever he personally sits, and a
// factionMajority-at-HQ win condition on top of PresidentObjective's
// generic "eliminate") is idiosyncratic the same way Head of Security's
// is — identified by defRef, not derivable from win-condition data alone.
function computeCommanderGeneralMode(state: FilteredGameState, playerId: PlayerId): boolean {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  return leader?.defRef === "Commander General";
}

function findLocationByName(board: BoardLayout, name: string): LocationInstance | undefined {
  return board.find((l) => l.name === name);
}

// Where to deploy a leader that needs an escort (see survivalObjective.ts)
// — prefer a legal location this player already has an escort at, falling
// back to any legal location when none exists (never fully bricks a
// forced play: the stuck-leader rule and Head of Security's own deploy
// trigger both need to deploy regardless). A no-op — plain random among
// legal locations — for a leader that doesn't need one. `preferredLocationId`
// (Commander General's HQ, once the President is eliminated) is tried
// first among the escorted set, then — if nothing's escorted there
// either — ahead of a fully random pick: getting him established at HQ
// specifically still matters more than an arbitrary escorted spot
// elsewhere, since that's where his own win condition is decided.
function chooseLeaderDeployLocation(
  state: FilteredGameState,
  cardData: CardData,
  playerId: PlayerId,
  needsEscort: boolean,
  leaderFaction: Faction | undefined,
  allowedTypes: readonly LocationType[],
  rng: Rng,
  preferredLocationId?: string,
): LocationInstance | undefined {
  const legal = state.board.filter((l) => allowedTypes.includes(l.type));
  if (needsEscort && leaderFaction) {
    const escorted = legal.filter((l) => isEscortedLocation(state, cardData, playerId, leaderFaction, l.id));
    if (preferredLocationId) {
      const preferredEscorted = escorted.find((l) => l.id === preferredLocationId);
      if (preferredEscorted) return preferredEscorted;
    }
    if (escorted.length > 0) return pickRandom(rng, escorted);
  }
  if (preferredLocationId) {
    const preferred = legal.find((l) => l.id === preferredLocationId);
    if (preferred) return preferred;
  }
  return pickRandom(rng, legal);
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
      const { needsEscort, faction: leaderFaction } = computeEscortNeed(state, cardData, playerId);
      // stuckLeader only ever applies once the President is already
      // eliminated, so Commander General's own "play at HQ" preference
      // (point 2 of his strategy) always applies here. Master Assassin's
      // "hunt other leaders among hidden cards" preference (point 4) only
      // applies while he still needs that backup win branch — see
      // masterAssassinNeedsBackupLeaderKills's own comment; once secured
      // (or unreachable, having killed the President himself) he has
      // nothing left to gain by seeking one out, so this correctly falls
      // through to an ordinary escort/random pick instead.
      const preferredLocationId = computeCommanderGeneralMode(state, playerId)
        ? findLocationByName(state.board, "HQ")?.id
        : computeMasterAssassinMode(state, playerId) && masterAssassinNeedsBackupLeaderKills(state, playerId)
          ? findBlendRichLocation(state, playerId)?.id
          : undefined;
      const location = chooseLeaderDeployLocation(
        state,
        cardData,
        playerId,
        needsEscort,
        leaderFaction,
        allowedTypes,
        rng,
        preferredLocationId,
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

  // "Protect the President/Wife/yourself: when you have a useful card,
  // play it (routed to wherever protection is needed — see
  // decidePlayCardOrMotorcade); when you don't, drawing can make sense" —
  // two independently-gated reasons, each wanting a *different* faction
  // in hand: protecting the President (Wife's own location-gated need, or
  // this leader's own win condition wanting him alive — Head of
  // Security's "protect" objective, or Master Assassin's while he isn't
  // ready to strike himself) always needs a Regime card specifically —
  // he counts as Regime for protection purposes regardless of who's doing
  // the protecting (same fix as desiredCardLocations's own protect
  // clause) — while self-escort (survivalObjective.ts) needs a card
  // matching *this leader's own* faction instead. Every other leader
  // keeps the plain coinflip chain below untouched.
  const { needsEscort, faction: leaderFaction } = computeEscortNeed(state, cardData, playerId);
  const locationProtectionNeeded =
    locationObjective.eliminateAtLocationId !== null &&
    computeProtectionTargets(state, playerId, true).locationIds.length > 0;
  const hasHandCardOfFaction = (faction: Faction): boolean =>
    state.cards.some((c) => c.zone === "hand" && c.controller === playerId && knownFaction(cardData, c) === faction);
  const wantsRegimeCard = (locationProtectionNeeded || objective === "protect") && !hasHandCardOfFaction("Regime");
  const wantsOwnFactionCard = needsEscort && leaderFaction !== undefined && !hasHandCardOfFaction(leaderFaction);
  if ((wantsRegimeCard || wantsOwnFactionCard) && canSpendNormal && deckHasCards(state)) {
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
  const { needsEscort, faction: leaderFaction } = computeEscortNeed(state, cardData, playerId);
  const isHeadOfSecurity = computeHeadOfSecurityMode(state, playerId);

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

  // Head of Security "can be played anytime... but needs to be in play
  // before the game ends" — deploy once his own trigger fires, same
  // priority reasoning as Wife's above, just with no fixed target
  // location: prefer an escorted one (see chooseLeaderDeployLocation),
  // falling back to any legal spot since getting into play at all is
  // what actually matters here.
  if (isHeadOfSecurity && shouldDeployHeadOfSecurityNow(state)) {
    const ownLeader = hand.find((c) => c.kind === "leader");
    if (ownLeader) {
      const instance = asCardInstance(ownLeader)!;
      const allowedTypes = getAllowedLocationTypes(cardData, instance);
      const location = chooseLeaderDeployLocation(state, cardData, playerId, needsEscort, leaderFaction, allowedTypes, rng);
      if (location) return { type: "playCard", cardId: ownLeader.id, locationId: location.id };
    }
  }

  // Head of Security wants the President through quickly — the game
  // ending via "survived" locks in his win, and every turn spent
  // otherwise is a turn something could still go wrong. Once he's
  // actually deployed (per the ordering above — rushing before that
  // risks the game ending with his own leader still stuck in hand,
  // failing his own `survives` requirement), prefer a Motorcade card
  // over anything else in hand; the existing motorcade-handling logic
  // below is untouched, this only changes which card gets picked.
  const isHeadOfSecurityRushing =
    isHeadOfSecurity && state.cards.some((c) => c.kind === "leader" && c.controller === playerId && c.zone === "inPlay");

  // Master Assassin "wants to stay in hand" until one of two specific
  // windows opens — pounce directly on the President once he's vulnerable
  // (point 5), or, once he's already eliminated, hunt for other leaders
  // among hidden cards (point 4). Neither is a timing threshold he waits
  // out passively like Wife's/Head of Security's own deploy triggers —
  // both name an exact destination, so both are handled as one combined
  // priority branch: deploy directly there the instant either applies.
  const isMasterAssassin = computeMasterAssassinMode(state, playerId);
  const masterAssassinTarget = isMasterAssassin ? findMasterAssassinDeployTarget(state, cardData, playerId) : undefined;
  if (masterAssassinTarget) {
    const ownLeader = hand.find((c) => c.kind === "leader");
    if (ownLeader) {
      const target = playableTargetLocation(cardData, state.board, ownLeader, [masterAssassinTarget]);
      if (target) return { type: "playCard", cardId: ownLeader.id, locationId: target.id };
    }
  }

  // A leader whose win condition just wants the President dead somewhere
  // (not a specific location like Wife's) shouldn't blindly play a
  // Motorcade card either — that's a step closer to him running off the
  // far end and "surviving", which forecloses this win condition for
  // good. Only worth it once the next step is already a trap (see
  // decideMoveEffectTargets's own Traffic Cop logic for the same idea);
  // otherwise hold it and do something else this turn.
  const objective = computeObjective(state, playerId);
  const isGenericEliminator = !locationObjective.eliminateAtLocationId && objective === "eliminate";

  // Wife's own relationship with Motorcade cards is the opposite of the
  // above, not a variant of it: she actively *wants* the President to
  // advance (he has to reach the Palace at all before her win condition
  // can even apply), and someone else eliminating him anywhere else
  // first is what loses her the game — there's no "trap" concept for her
  // to wait on. What she does need to avoid is being the one who pushes
  // him forward while exposed, since advancing an unprotected President
  // just delivers him to whoever's waiting at the next stop instead of
  // her. So she plays Motorcades early and freely, but only while he's
  // currently protected at his own location (see isPresidentCurrentlyProtected).
  const isWife = locationObjective.eliminateAtLocationId !== null;

  // A leader needing an escort (see survivalObjective.ts) shouldn't be
  // opportunistically deployed into an unescorted spot just because it
  // happened to be the random pick below — excluded here rather than
  // filtered out of `hand` entirely, since the two priority branches
  // above (which both know how to fall back to an unescorted location
  // when actually forced to deploy) still need to see it. Master
  // Assassin gets the same treatment for a different reason: no escort
  // need of his own (Blend, not Protected), but he'd rather stay hidden
  // in hand than commit to some arbitrary spot outside his own two
  // windows above — reached this filter, neither currently applies.
  const playableHand = hand.filter((c) => {
    if (c.kind === "motorcade" && isGenericEliminator && !shouldPlayMotorcadeForElimination(state, cardData, playerId)) {
      return false;
    }
    if (c.kind === "motorcade" && isWife && !isPresidentCurrentlyProtected(state, cardData, playerId)) {
      return false;
    }
    if (c.kind === "leader" && isMasterAssassin) return false;
    if (c.kind !== "leader" || !needsEscort || !leaderFaction) return true;
    const instance = asCardInstance(c);
    if (!instance) return true;
    const allowedTypes = getAllowedLocationTypes(cardData, instance);
    return state.board.some(
      (l) => allowedTypes.includes(l.type) && isEscortedLocation(state, cardData, playerId, leaderFaction, l.id),
    );
  });

  // Otherwise prefer a hand card that currently has somewhere purposeful
  // to go — protection coverage for a same-faction card, Palace-stacking
  // redundancy for an eliminate-capable card once the deploy window is
  // open, or a mob heading for the Palace — over a blind random pick. See
  // desiredCardLocations.
  const purposefulPlays = playableHand
    .filter((c) => c.kind !== "motorcade")
    .map((card) => {
      const desired = desiredCardLocations(state, playerId, cardData, card, locationObjective, needsEscort, leaderFaction, objective);
      const location = playableTargetLocation(cardData, state.board, card, desired);
      return location ? { card, location } : undefined;
    })
    .filter((p): p is { card: FilteredCardInstance; location: LocationInstance } => p !== undefined);
  if (purposefulPlays.length > 0) {
    const chosen = pickRandom(rng, purposefulPlays)!;
    return { type: "playCard", cardId: chosen.card.id, locationId: chosen.location.id };
  }

  const rushCard = isHeadOfSecurityRushing ? playableHand.find((c) => c.kind === "motorcade") : undefined;
  const card = rushCard ?? pickRandom(rng, playableHand);
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

  // If this is a needs-escort leader (reached only via the branches
  // above finding no purposeful/priority play — i.e. it's not urgent
  // enough yet to force), route it the same way chooseLeaderDeployLocation
  // does rather than a blind board-wide random pick. Commander General
  // specifically prefers HQ once the President is eliminated (point 2 of
  // his own strategy).
  if (card.kind === "leader" && needsEscort) {
    const instance = asCardInstance(card)!;
    const allowedTypes = getAllowedLocationTypes(cardData, instance);
    const preferredLocationId =
      computeCommanderGeneralMode(state, playerId) && state.president.status === "eliminated"
        ? findLocationByName(state.board, "HQ")?.id
        : undefined;
    const location = chooseLeaderDeployLocation(
      state,
      cardData,
      playerId,
      needsEscort,
      leaderFaction,
      allowedTypes,
      rng,
      preferredLocationId,
    );
    if (location) return { type: "playCard", cardId: card.id, locationId: location.id };
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

// Where `card` should currently be routed. Two independent groups of
// clauses, each a no-op unless its own gating condition applies to this
// player's own leader, so any mix of leaders' needs combines safely:
//
// Wife-style, gated on locationObjective.eliminateAtLocationId (currently
// only Wife has one): the win location (and its staging spot as a
// fallback), unconditionally, for a Motorcade interceptor; then the win
// location itself, for an eliminate-capable card once the deploy window
// is open (Palace-stacking redundancy — the win condition doesn't
// require this player's own leader to land the kill).
//
// General, gated on this player's own leader needing an escort to
// survive (survivalObjective.ts) or wanting the President protected
// (PresidentObjective "protect", e.g. Head of Security): a same-faction
// card gets routed to wherever this leader itself is (self-escort) and/or
// the President's current/predicted-next location (see
// computeProtectionTargets).
//
// A card matching none of the above gets an empty list and falls through
// to the existing random placement, unchanged from before this feature.
function desiredCardLocations(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  card: FilteredCardInstance,
  locationObjective: LeaderLocationObjective,
  needsEscort: boolean,
  leaderFaction: Faction | undefined,
  objective: PresidentObjective,
): readonly string[] {
  const ids: string[] = [];

  if (locationObjective.eliminateAtLocationId) {
    // Motorcade interceptors ("mobs" — Throng of Admirers / Angry Mob) are
    // the actual defense against the President just sailing past the win
    // location once he arrives (see decideInterceptAction's own comment) —
    // get one positioned early, well before the deploy window below
    // opens, since holding the line is anticipatory, not last-minute.
    // Neither card's own allowed location types include the win location
    // itself (it's "Secure"; they're "Public"/"Street" only), so this
    // lists the win location first and the staging spot right before it
    // second: playableTargetLocation's first-legal-match scan naturally
    // falls through to staging for an initial hand play (the win location
    // fails its own type check), while stepToward's nearest-of-all-desired
    // scan naturally walks an already-staged mob the rest of the way in,
    // since "already there" drops out of its own candidate set.
    if (cardHasMotorcadeInterceptionPassive(card)) {
      ids.push(locationObjective.eliminateAtLocationId);
      const staging = stagingLocationId(state.board, locationObjective.eliminateAtLocationId);
      if (staging) ids.push(staging);
    }

    if (shouldDeployLocationLeaderNow(state, locationObjective) && cardHasAnyEliminateAbility(cardData, card)) {
      if (!ids.includes(locationObjective.eliminateAtLocationId)) ids.push(locationObjective.eliminateAtLocationId);
    }
    if (knownFaction(cardData, card) === "Regime") {
      for (const id of computeProtectionTargets(state, playerId, true).locationIds) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }

  // Self-escort: matches the LEADER's own faction (a same-faction card is
  // what shields the leader specifically).
  if (leaderFaction && needsEscort && knownFaction(cardData, card) === leaderFaction) {
    const leaderCard = state.cards.find((c) => c.zone === "inPlay" && c.controller === playerId && c.kind === "leader");
    if (leaderCard?.locationId && !ids.includes(leaderCard.locationId)) ids.push(leaderCard.locationId);
  }

  // Protect the President: independent of the leader's own faction — the
  // President always counts as Regime for protection purposes (card_data
  // .json's additional_rulings; see presidentIsLegalTarget's own hardcoded
  // "Regime" check), so a Rebel leader wanting him shielded (Master
  // Assassin, while he isn't ready to take the shot himself — see
  // computeMasterAssassinEffectiveObjective) still needs Regime cards
  // specifically, not cards matching their own faction. Head of
  // Security's own faction happens to already be Regime, so this reads
  // as a no-op change for him.
  if (objective === "protect" && knownFaction(cardData, card) === "Regime") {
    for (const id of computeProtectionTargets(state, playerId, false).locationIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }

  // A generic "eliminate the President" leader routes an eliminate-
  // capable card of their own toward his current or predicted-next
  // location — the same computeProtectionTargets query used to protect
  // him above, repurposed as a waiting trap instead of an escort.
  // Commander General restricts this to his own Regime cards (matches
  // his flavor and his separate Rebel-preference on the target side);
  // Master Assassin's win condition only cares who *controls* the
  // eliminating card, not its faction, so no such restriction applies to
  // him.
  const isCommanderGeneral = computeCommanderGeneralMode(state, playerId);
  const isMasterAssassin = computeMasterAssassinMode(state, playerId);
  if ((isCommanderGeneral || isMasterAssassin) && cardHasAnyEliminateAbility(cardData, card)) {
    const factionOk = isMasterAssassin || knownFaction(cardData, card) === "Regime";
    if (factionOk) {
      for (const id of computeProtectionTargets(state, playerId, false).locationIds) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }

  return ids;
}

function cardHasMotorcadeInterceptionPassive(card: FilteredCardInstance): boolean {
  return card.defRef !== null && getPassive(card.defRef)?.kind === "motorcadeInterception";
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

  const { needsEscort, faction: leaderFaction } = computeEscortNeed(state, cardData, playerId);
  const objective = computeObjective(state, playerId);
  const isCommanderGeneral = computeCommanderGeneralMode(state, playerId);
  const isMasterAssassin = computeMasterAssassinMode(state, playerId);
  const hq = findLocationByName(state.board, "HQ");
  const blendRichLocation =
    isMasterAssassin && masterAssassinNeedsBackupLeaderKills(state, playerId) ? findBlendRichLocation(state, playerId) : undefined;

  // One pass per card computing both (a) which of its adjacent locations
  // are actually safe to move to — unrestricted, except a needs-escort
  // leader (survivalObjective.ts) is narrowed to escorted ones only, same
  // as chooseLeaderDeployLocation's own reasoning — and (b) whether a
  // purposeful destination (protection coverage, self-escort, Palace-
  // stacking, Commander General's own march to HQ once the President is
  // eliminated) exists *among those safe destinations specifically*.
  // Doing this in one pass (rather than trying purposeful moves first and
  // only checking safety in a separate fallback) matters here: Commander
  // General's own leader card is exactly the case where a purposeful
  // desired location (HQ) can differ from its current one, and without
  // folding the escort check into the same computation, that move could
  // bypass it entirely.
  const candidates = movable
    .map((card) => {
      const isOwnLeader = card.kind === "leader"; // movable is already controller-scoped
      const allDestinations = adjacentLocationIds(state.board, card.locationId!);
      const destinations =
        isOwnLeader && needsEscort && leaderFaction
          ? allDestinations.filter((id) => isEscortedLocation(state, cardData, playerId, leaderFaction, id))
          : allDestinations;
      if (destinations.length === 0) return undefined;

      let desired = desiredCardLocations(state, playerId, cardData, card, locationObjective, needsEscort, leaderFaction, objective);
      if (isOwnLeader && isCommanderGeneral && state.president.status === "eliminated" && hq) {
        desired = [...desired, hq.id];
      }
      if (isOwnLeader && blendRichLocation) {
        desired = [...desired, blendRichLocation.id];
      }
      const toLocationId = desired.length > 0 ? stepToward(state.board, card.locationId!, desired) : undefined;
      const purposeful = toLocationId && destinations.includes(toLocationId) ? toLocationId : undefined;

      return { card, destinations, purposeful };
    })
    .filter((c): c is { card: FilteredCardInstance; destinations: string[]; purposeful: string | undefined } => c !== undefined);
  if (candidates.length === 0) return { type: "endTurn" };

  const purposefulMoves = candidates.filter(
    (c): c is { card: FilteredCardInstance; destinations: string[]; purposeful: string } => c.purposeful !== undefined,
  );
  if (purposefulMoves.length > 0) {
    const chosen = pickRandom(rng, purposefulMoves)!;
    return { type: "moveCard", cardId: chosen.card.id, toLocationId: chosen.purposeful };
  }

  const chosen = pickRandom(rng, candidates)!;
  const toLocationId = pickRandom(rng, chosen.destinations)!;
  return { type: "moveCard", cardId: chosen.card.id, toLocationId };
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
  if (eliminateCapable.length > 0) {
    const chosen = pickRandom(rng, eliminateCapable)!;
    return { type: "activateAbility", cardId: chosen.card.id, abilityIndex: chosen.abilityIndex };
  }

  // Commander General, once at HQ, prefers using his own three abilities
  // (reveal blended threats, then keep the play/activate grants flowing —
  // points 3-5 of his strategy) over anything else usable but unrelated.
  // Reusing `usable` means each is already confirmed affordable and
  // legally available (e.g. the reveal only shows up here when there's
  // actually a blended card at HQ to reveal); the eliminate-capable tier
  // above still wins outright when something's directly killable, since
  // that's a better move than building up for later.
  if (computeCommanderGeneralMode(state, playerId)) {
    const ownLeader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
    const hq = findLocationByName(state.board, "HQ");
    if (ownLeader?.locationId && hq && ownLeader.locationId === hq.id) {
      const ownAbilities = usable.filter(({ card }) => card.id === ownLeader.id);
      if (ownAbilities.length > 0) {
        const chosen = pickRandom(rng, ownAbilities)!;
        return { type: "activateAbility", cardId: chosen.card.id, abilityIndex: chosen.abilityIndex };
      }
    }
  }

  // Master Assassin, once actually hunting other leaders — still needs
  // the backup win branch (see masterAssassinNeedsBackupLeaderKills: the
  // President's death wasn't his own doing, and he hasn't reached 2 leader
  // kills yet) — prefers his own "return to hand and play" ability over
  // anything else usable but unrelated: it's what lets him relocate
  // toward a fresh blend-rich area (see findBlendRichLocation, threaded
  // through decidePlayCardOrMotorcade's own deploy priority and
  // decideMoveCard's routing) rather than sitting still. Without that
  // gate he'd keep restlessly bouncing in and out of hand turn after
  // turn even once his win is already secure (or unreachable via this
  // branch) — pure unnecessary exposure against his own `survives`
  // requirement, for nothing left to gain. Skipped on his own final
  // turn too — see isFinalTurnForCurrentPlayer's own comment — since
  // spending it there would just strand him back in hand with no further
  // turn to redeploy on.
  if (computeMasterAssassinMode(state, playerId) && masterAssassinNeedsBackupLeaderKills(state, playerId) && !isFinalTurnForCurrentPlayer(state)) {
    const ownLeader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
    const returnAbility = usable.find(({ card, abilityIndex }) => card.id === ownLeader?.id && abilityIndex === 0);
    if (returnAbility) {
      return { type: "activateAbility", cardId: returnAbility.card.id, abilityIndex: returnAbility.abilityIndex };
    }
  }

  const chosen = pickRandom(rng, usable)!;
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
      return decideMoveEffectTargets(state, playerId, cardData, objective, rng);
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

  // Commander General's win condition needs Regime cards to outnumber
  // Rebels at HQ, so his controller prefers a Rebel-faction target over
  // some other opposing card that wouldn't move that ratio at all
  // (targeting.ts's factionMajority check only cares about faction, not
  // controller). Keeps the President in the narrowed set explicitly —
  // he counts as Regime for faction rules (card_data.json's additional_
  // rulings), so a naive Rebel-only filter would otherwise silently
  // drop him and break the "prefer the President" swap-in just below.
  if (computeCommanderGeneralMode(state, playerId)) {
    const minNeeded = requiredMinCount(effect.target.count);
    const rebelOrPresident = finalPool.filter(
      (c) => c.id === PRESIDENT_TARGET_ID || knownFaction(cardData, c) === "Rebel",
    );
    if (rebelOrPresident.length >= minNeeded) {
      finalPool = rebelOrPresident;
    }
  }

  // Master Assassin's backup win branch, once the President is gone and
  // (per computeMasterAssassinEffectiveObjective) it clearly wasn't by a
  // card of his — eliminate 2 leaders with cards he controls instead.
  // The President himself is never in `finalPool` any more at this point
  // (eliminateCandidatePool only ever includes him while still "alive"),
  // so there's no equivalent swap-in concern to preserve here.
  if (computeMasterAssassinMode(state, playerId) && state.president.status === "eliminated") {
    const minNeeded = requiredMinCount(effect.target.count);
    const leadersOnly = finalPool.filter((c) => c.kind === "leader");
    if (leadersOnly.length >= minNeeded) {
      finalPool = leadersOnly;
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
  if (pool.length === 0) return { type: "chooseTargets", targetIds: [] };

  // Head of Security's whole kit is built around this ability ("eliminate
  // blended cards and threats") — prefer a candidate+ability that can
  // actually do one of those over the plain random pick every other
  // remote-activator (Guerrilla Commander, Puppet-Master) still gets
  // below.
  if (computeHeadOfSecurityMode(state, playerId)) {
    const preferred = pickPreferredRemoteActivation(state, cardData, playerId, pool, rng);
    if (preferred) {
      return { type: "chooseTargets", targetIds: [preferred.card.id], remoteAbilityIndex: preferred.abilityIndex };
    }
  }

  const chosenCard = pickRandom(rng, pool)!;
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

// Across every candidate in `pool`, prefer an Activate ability that can
// eliminate something over one that can merely reveal a blended card
// (still useful — uncovers a hidden threat for later — but less directly
// so), falling back to whatever's usable at all. Mirrors
// decideActivateAbility's own eliminate-capable preference, just applied
// across remote candidates instead of this player's own in-play cards.
function pickPreferredRemoteActivation(
  state: FilteredGameState,
  cardData: CardData,
  playerId: PlayerId,
  pool: readonly FilteredCardInstance[],
  rng: Rng,
): { card: FilteredCardInstance; abilityIndex: number } | undefined {
  const options: { card: FilteredCardInstance; abilityIndex: number; hasEliminate: boolean; hasRevealBlended: boolean }[] = [];
  for (const card of pool) {
    const instance = asCardInstance(card)!;
    for (const [abilityIndex, ability] of getAbilities(cardData, instance).entries()) {
      if (ability.type !== "Activate") continue;
      if (state.turn.usedAbilities.includes(`${card.id}#${abilityIndex}`)) continue;
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      if (!def) continue;
      if (!abilityHasAvailableFirstTarget(state, cardData, card, def, playerId)) continue;
      options.push({
        card,
        abilityIndex,
        hasEliminate: abilityHasEliminateEffect(def),
        hasRevealBlended: def.effects.some((e) => e.verb === "reveal"),
      });
    }
  }
  const eliminateOptions = options.filter((o) => o.hasEliminate);
  if (eliminateOptions.length > 0) return pickRandom(rng, eliminateOptions);
  const revealOptions = options.filter((o) => o.hasRevealBlended);
  if (revealOptions.length > 0) return pickRandom(rng, revealOptions);
  return pickRandom(rng, options);
}

function decideMoveEffectTargets(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  if (state.president.status !== "alive" || !state.president.locationId) {
    return { type: "chooseTargets", targetIds: [] };
  }
  // The deciding player here is whoever's actually choosing — the
  // original activator under a remote activation too
  // (AbilityResolutionFrame.actingPlayerId, not the card's controller),
  // so both computeHeadOfSecurityMode and the "eliminate" branch below
  // correctly cover Traffic Cop being either this player's own card or
  // one they remotely activated.
  const currentIndex = state.board.findIndex((l) => l.id === state.president.locationId);
  const forwardId = state.board[currentIndex + 1]?.id;
  if (forwardId && computeHeadOfSecurityMode(state, playerId)) {
    return { type: "chooseTargets", targetIds: [], locationIds: [forwardId] };
  }

  // An "eliminate" leader uses Traffic Cop tactically rather than
  // randomly: push forward only when that specific next location is
  // already a trap (this player has an eliminate-capable card waiting
  // there); otherwise pull back, keeping him on the board longer —
  // buying time to actually set one up — rather than risk him running
  // out the far end and "surviving", which forecloses this win condition
  // for good.
  if (objective === "eliminate") {
    if (forwardId && hasEliminateReadyCardAt(state, cardData, playerId, forwardId)) {
      return { type: "chooseTargets", targetIds: [], locationIds: [forwardId] };
    }
    const backwardId = currentIndex > 0 ? state.board[currentIndex - 1]?.id : undefined;
    if (backwardId) {
      return { type: "chooseTargets", targetIds: [], locationIds: [backwardId] };
    }
  }

  const adjacent = adjacentLocationIds(state.board, state.president.locationId);
  const chosen = pickRandom(rng, adjacent);
  if (!chosen) return { type: "chooseTargets", targetIds: [] };
  return { type: "chooseTargets", targetIds: [], locationIds: [chosen] };
}

// Whether `playerId` already controls an in-play card at `locationId`
// with an eliminate-capable ability — a "trap" ready to spring, whether
// or not a specific legal target currently sits there too (targeting
// itself is decided separately, once the President actually arrives).
function hasEliminateReadyCardAt(
  state: FilteredGameState,
  cardData: CardData,
  playerId: PlayerId,
  locationId: string,
): boolean {
  return state.cards.some(
    (c) => c.zone === "inPlay" && c.controller === playerId && c.locationId === locationId && cardHasAnyEliminateAbility(cardData, c),
  );
}

// Whether a generic "eliminate the President" leader should voluntarily
// play a Motorcade card at all — only when doing so delivers him onto a
// location this player already has a trap waiting at (see
// hasEliminateReadyCardAt), same reasoning as decideMoveEffectTargets's
// Traffic Cop logic. Not entered yet: always fine, since getting him
// onto the board at all is a prerequisite for ever eliminating him.
// Already eliminated: irrelevant — a Motorcade card does something
// entirely different once he's gone (repositioning this player's own
// cards), so no restriction applies.
function shouldPlayMotorcadeForElimination(state: FilteredGameState, cardData: CardData, playerId: PlayerId): boolean {
  if (state.president.status !== "alive" || !state.president.locationId) return true;
  const currentIndex = state.board.findIndex((l) => l.id === state.president.locationId);
  const nextLocation = state.board[currentIndex + 1];
  if (!nextLocation) return false; // the last location — playing this would make him "survive"
  return hasEliminateReadyCardAt(state, cardData, playerId, nextLocation.id);
}

// Whether the President is currently shielded at his own location — the
// same check isLegalEliminationTarget/findProtectorCards would make for
// an actual elimination attempt against him right now (presidentIsLegal
// Target with ignoreProtection:false), reused here for a completely
// different purpose: Wife wants to know it's currently *safe* to advance
// him via a Motorcade card, not whether he's a legal target for her own
// ability (unrelated — hers requires ignoreProtected regardless).
function isPresidentCurrentlyProtected(state: FilteredGameState, cardData: CardData, playerId: PlayerId): boolean {
  if (state.president.status !== "alive" || !state.president.locationId) return false;
  return !presidentIsLegalTarget(state, cardData, playerId, false, true);
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
  locationObjective: LeaderLocationObjective,
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
  if (eligible.length === 0) return { type: "passIntercept" };

  if (locationObjective.eliminateAtLocationId) {
    if (frame.presidentLocationId === locationObjective.eliminateAtLocationId) {
      // He's AT the win location right now — never let this move apply,
      // no exceptions. Every other outcome here costs nothing but a
      // turn; letting him leave the win location (eventually "surviving"
      // off the board) forecloses this player's win condition for good.
      return { type: "interceptMotorcade", cardId: pickRandom(rng, eligible)!.id };
    }
    const staging = stagingLocationId(state.board, locationObjective.eliminateAtLocationId);
    if (frame.presidentLocationId === staging) {
      // The staging spot right before it: hold him here by default — if
      // this player isn't set up to capitalize yet, letting him through
      // now just burns the "always stop" rule above with nobody ready to
      // act on it. But if it's already this player's own turn, nothing
      // else gets to move before they do, so there's nothing to lose by
      // letting him through immediately instead of stalling for no
      // reason.
      if (state.turn.currentPlayerId !== playerId) {
        return { type: "interceptMotorcade", cardId: pickRandom(rng, eligible)!.id };
      }
      return { type: "passIntercept" };
    }
  }

  if (!coinFlip(rng, 0.5)) return { type: "passIntercept" };
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
