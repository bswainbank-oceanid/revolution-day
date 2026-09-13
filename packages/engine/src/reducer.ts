import type { Action } from "./actions";
import { getAbilityEffects } from "./data/abilityEffects";
import { getPassive } from "./data/passives";
import type { Condition, ConditionOperand, EffectNode, TargetCount, TargetSelector } from "./effects/dsl";
import {
  hasRevealOpportunity,
  isLegalEliminationTarget,
  isLegalPresidentTarget,
  isProtectedActive,
  partitionByProtection,
  presidentMatchesSelector,
  resolveEligibleHandCards,
  resolveEligibleTargets,
} from "./effects/targeting";
import { adjacentLocationIds } from "./state/board";
import type { BoardLayout } from "./state/board";
import { getAbilities, getAllowedLocationTypes, getFaction, hasAttribute } from "./state/cardLookup";
import type { CardInstance } from "./state/cards";
import type { GameState, PlayerId, PresidentState, RestrictedActionGrant, TurnState } from "./state/game";
import { shuffle } from "./state/rng";
import type { RngState } from "./state/rng";
import type {
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  MotorcadeInterceptionWindowFrame,
  PendingPassiveTrigger,
  ProtectedTargetingWindowFrame,
  ReactivePassiveWindowFrame,
  ResolutionFrame,
} from "./state/resolution";
import type { CardData } from "./types";

// The reducer: (state, action) -> newState. Pure — no I/O, no hidden
// randomness (the RNG lives in and is advanced through GameState itself).
// cardData is passed explicitly (not imported as a singleton) so a future
// variant's card set works unmodified, same as setupGame. "draw" (including
// the forced-immediate-Motorcade-play substitution on an empty deck),
// "endTurn", "moveCard", "playCard", "playMotorcade" (including the
// Motorcade interception window), "activateAbility"/"chooseTargets"
// (alarm-triggering abilities, remote-activation including Commander
// General's "any number" queue, multi-effect sequencing, multi-target
// `eliminate`, `reveal`/`play`/`gainControl` effects, and `if`/binding
// conditionals), and "useResponse"/"passResponse" (including a nested
// protected-targeting reveal window during an alarm's response pass) are
// all implemented; everything else is an explicit "not yet implemented".
// A player whose leader is stuck in hand once the President is eliminated
// is blocked from any other action until they play it (requireLeaderPlayedIfStuck)
// — a legality restriction, not something the engine does for them, unlike
// the Motorcade case above.
//
// Remaining known gaps, all noted inline where relevant: `if`/`else`
// branches are limited to a single effect each (see applyIfEffect) — no
// arbitrary sub-sequence. Multi-target `eliminate` effects check
// Protected-immunity per-candidate against the current board, not the full
// simultaneously-declared batch (see declareEliminateTargets) — a narrower
// case than the original design intended, not needed by any encoded
// ability yet. See rev_day_engine_design memory for the full design this
// is incrementally building toward.
// Action types that can pop or advance some *other* resolution-stack
// frame (an alarm pass, a nested reveal/intercept/reactive window) and so
// might be the moment control returns to an eliminate effect that hasn't
// had its targets declared yet — see autoResolveTrivialEliminate. Deliberately
// excludes "chooseTargets" itself and the plain turn actions: a fresh
// activateAbility, or a multi-effect ability's own chooseTargets advancing
// to its next effect, should still surface a real (if only formally
// required) decision the normal way — this only short-circuits the
// specific "something else happened first and may have changed what's
// still legally targetable" moment.
const RESOLUTION_CONTINUING_ACTIONS = new Set<Action["type"]>([
  "passResponse",
  "useResponse",
  "revealBlended",
  "passReveal",
  "interceptMotorcade",
  "passIntercept",
  "playReactive",
  "passReactive",
]);

export function applyAction(
  state: GameState,
  actingPlayerId: PlayerId,
  action: Action,
  cardData: CardData,
): GameState {
  let next = applyActionInner(state, actingPlayerId, action, cardData);
  if (RESOLUTION_CONTINUING_ACTIONS.has(action.type)) {
    next = autoResolveTrivialEliminate(next, cardData);
  }
  // drainPendingPassives wraps every path: a card being eliminated queues
  // a PendingPassiveTrigger (Celebrity/Martyr) rather than opening a
  // window immediately, and that queue only starts draining once the
  // *entire* top-level action (including any alarm/window sub-resolution)
  // has fully completed and the stack is genuinely empty again.
  return drainPendingPassives(next);
}

// A Response (or any other resolution-stack action) can eliminate, defect,
// or otherwise remove the very candidate an already-activated eliminate
// effect was counting on — see validateTargets' own comment on the same
// race. Once whatever just happened resolves, chooseTargets shouldn't
// still be required as a formality: with 0 truly-eligible candidates left
// there's nothing to eliminate, so the effect simply completes; with
// exactly 1, that's the only legal submission there ever was, so it's
// applied automatically rather than asked for. Uses the engine's own
// full-information candidate pool (declareEliminateTargets' own
// resolveEligibleTargets/presidentMatchesSelector) rather than a filtered
// one, since this is also the only place that can correctly resolve a
// still-blended card being the sole remaining true candidate — something
// neither a human's own client-side view nor a bot could ever safely
// guess at. Scoped to filter-based, non-random "exact"/"range" eliminate
// effects only (matches validateTargets' own scope) and only once —
// finishEffectStep/applyEffect naturally re-exposes another frame needing
// the same treatment, so this loops rather than resolving just one step.
function autoResolveTrivialEliminate(state: GameState, cardData: CardData): GameState {
  for (let i = 0; i < 50; i++) {
    const frame = state.resolutionStack[state.resolutionStack.length - 1];
    if (frame?.kind !== "abilityResolution" || frame.targetIds !== null) return state;
    const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId);
    if (!sourceCard) return state;
    const definition = getAbilityEffects(sourceCard.defRef, frame.abilityIndex);
    const effect = definition?.effects[frame.effectIndex ?? 0];
    if (!effect || effect.verb !== "eliminate") return state;
    if (effect.target.ref !== "filter" || effect.target.selection === "random") return state;
    if (effect.target.count.mode !== "exact" && effect.target.count.mode !== "range") return state;

    const eligibleCards = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
    const eligibleIds = eligibleCards.map((c) => c.id);
    if (presidentMatchesSelector(state, effect.target, sourceCard)) eligibleIds.push(PRESIDENT_TARGET_ID);
    // Protection-aware, like validateTargets' own reachableIds (see
    // protectionReachableIds) — a candidate that's Protected no matter
    // what else gets submitted alongside it (most often shielded only by
    // the ability's own source card, never itself a candidate) shouldn't
    // count toward "is this still a real choice" either.
    const reachableIds = protectionReachableIds(
      state,
      cardData,
      frame.actingPlayerId,
      eligibleIds,
      effect.ignoreProtected ?? false,
    );

    const requiredMin = effect.target.count.mode === "exact" ? effect.target.count.value : effect.target.count.min;
    if (reachableIds.length > requiredMin) return state; // a real choice remains

    // Falling back to the normal explicit chooseTargets flow on failure
    // here (rather than throwing) is just a defensive backstop — with
    // reachableIds already protection-aware, this submission should
    // always be legal in practice.
    let next: GameState;
    try {
      next = applyEffect(state, cardData, frame, sourceCard, frame.actingPlayerId, effect, reachableIds);
    } catch {
      return state;
    }
    state = next;
  }
  return state;
}

function applyActionInner(
  state: GameState,
  actingPlayerId: PlayerId,
  action: Action,
  cardData: CardData,
): GameState {
  if (state.resolutionStack.length > 0) {
    return applyResolutionAction(state, actingPlayerId, action, cardData);
  }

  if (actingPlayerId !== state.turn.currentPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn (current player is ${state.turn.currentPlayerId})`);
  }

  if (action.type !== "draw") {
    requireLeaderPlayedIfStuck(state, action);
  }

  switch (action.type) {
    case "draw":
      return applyDraw(state);
    case "endTurn":
      return applyEndTurn(state);
    case "moveCard":
      return applyMoveCard(state, cardData, action);
    case "playCard":
      return applyPlayCard(state, cardData, action);
    case "playMotorcade":
      return applyPlayMotorcade(state, cardData, action);
    case "activateAbility":
      return applyActivateAbility(state, cardData, action);
    default:
      throw new Error(`Action not yet implemented: ${action.type}`);
  }
}

// Once the entire top-level action (including any alarm/window
// sub-resolution) has fully completed and the stack is genuinely empty
// again, activates the next queued PendingPassiveTrigger (if any) into a
// real ReactivePassiveWindowFrame — one at a time; a later applyAction
// call re-checks once that window itself finishes, cascading through the
// rest of the queue across however many further actions it takes.
function drainPendingPassives(state: GameState): GameState {
  if (state.resolutionStack.length > 0 || state.pendingPassiveQueue.length === 0) {
    return state;
  }
  const [trigger, ...rest] = state.pendingPassiveQueue;
  const order =
    trigger!.scope === "controller"
      ? [trigger!.controllerPlayerId]
      : buildReactivePassiveOrder(state, trigger!.triggeredByPlayerId);
  const windowFrame: ReactivePassiveWindowFrame = {
    kind: "reactivePassiveWindow",
    sourceCardId: trigger!.cardId,
    locationId: trigger!.locationId,
    faction: trigger!.faction,
    order,
    nextIndex: 0,
  };
  return { ...state, pendingPassiveQueue: rest, resolutionStack: [windowFrame] };
}

// "All players" order (Celebrity): table order starting after whoever
// controlled the eliminating card, wrapping fully around including them
// last — same shape as the alarm-response pass, everyone gets a turn,
// nobody skipped. "Controller only" (Martyr) doesn't need this at all —
// see drainPendingPassives.
function buildReactivePassiveOrder(state: GameState, triggeredByPlayerId: PlayerId): PlayerId[] {
  const seats = state.players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
  const anchorSeat = seats.find((p) => p.id === triggeredByPlayerId)!.seatIndex;
  const n = seats.length;
  return Array.from({ length: n }, (_, i) => seats.find((p) => p.seatIndex === (anchorSeat + i + 1) % n)!.id);
}

// Dispatches to whatever the top resolution-stack frame expects next.
// "abilityResolution" and "alarmResolution" are handled — the other two
// frame kinds (protected-targeting reveal, Motorcade interception) have no
// dispatch logic yet, since nothing can push them onto the stack yet
// either.
function applyResolutionAction(
  state: GameState,
  actingPlayerId: PlayerId,
  action: Action,
  cardData: CardData,
): GameState {
  const frame = state.resolutionStack[state.resolutionStack.length - 1]!;
  switch (frame.kind) {
    case "abilityResolution": {
      if (action.type !== "chooseTargets") {
        throw new Error(`Expected chooseTargets while an ability awaits targets, got: ${action.type}`);
      }
      // If the ability's own source card has since been eliminated — e.g.
      // one of Commander General's remote activations triggered an alarm,
      // and a response during that alarm's pass eliminated Commander
      // General himself (a different card than the alarm's own triggering
      // character, which is already handled by advanceAlarmPass) — the
      // rest of the ability does not resolve. For a multi-activation queue
      // (activateRemote's "unbounded" case) this is what makes "the
      // ability ends": the loop frame reappears here on the next dispatch
      // and is cancelled outright rather than re-offering another choice.
      // Same cancellation principle as the alarm-triggering-character
      // rule, generalized to ability resolution as a whole.
      const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId);
      if (!sourceCard || sourceCard.zone === "eliminated") {
        return popCurrentFrame(state);
      }
      return applyChooseTargets(state, cardData, frame, actingPlayerId, action);
    }
    case "alarmResolution":
      return applyAlarmAction(state, cardData, frame, actingPlayerId, action);
    case "protectedTargetingWindow":
      return applyProtectedTargetingWindowAction(state, frame, actingPlayerId, action);
    case "motorcadeInterceptionWindow":
      return applyMotorcadeInterceptionWindowAction(state, frame, actingPlayerId, action);
    case "reactivePassiveWindow":
      return applyReactivePassiveWindowAction(state, cardData, frame, actingPlayerId, action);
    default:
      // All five ResolutionFrame kinds are handled above — this is
      // unreachable given the current type, kept only as a defensive
      // fallback if a new frame kind is ever added without updating this
      // switch.
      throw new Error("Unrecognized resolution frame kind");
  }
}

// Shared guard for the budgeted (non-mandatory-draw) actions: must be in
// the action phase with at least one action left.
function requireBudgetedAction(state: GameState): void {
  if (state.turn.phase !== "action") {
    throw new Error("Cannot take an action outside the action phase");
  }
  if (state.turn.actionsRemaining <= 0) {
    throw new Error("No actions remaining this turn");
  }
}

// "A leader stuck in hand must be played as your first action once the
// President is eliminated" — a restriction on which actions are legal,
// not something the engine does for the player (contrast the forced
// Motorcade play above, which *is* automatic — the user drew this
// distinction explicitly). Blocks every action-phase action except the
// one specific playCard that plays the leader itself, until it's played;
// the mandatory draw is exempt, matching "first ACTION" and the same
// draw-doesn't-count-as-an-action framing used elsewhere.
// The current player's own leader, if the President is eliminated and it's
// still stuck in their hand — see requireLeaderPlayedIfStuck. Re-derived
// fresh from current state on every call (never cached), which matters:
// an ability can put a leader back in hand mid-turn (Master Assassin's own
// "return this card to its controller's hand and play a card"), and the
// very next top-level action must immediately see it as stuck, not just
// however things looked when the turn started.
function stuckLeaderCard(state: GameState): CardInstance | undefined {
  if (state.president.status !== "eliminated") return undefined;
  return state.cards.find(
    (c) => c.kind === "leader" && c.zone === "hand" && c.controller === state.turn.currentPlayerId,
  );
}

function requireLeaderPlayedIfStuck(state: GameState, action: Action): void {
  const stuckLeader = stuckLeaderCard(state);
  if (!stuckLeader) return;
  if (action.type === "playCard" && action.cardId === stuckLeader.id) return;
  // Whenever you have an action to spend, it must go toward playing your
  // leader — but once you're out, you're free to end your turn like
  // normal rather than being stranded; the obligation simply carries over
  // to your next turn's first action.
  if (action.type === "endTurn" && state.turn.actionsRemaining <= 0) return;
  throw new Error(
    `${state.turn.currentPlayerId} must play their leader (${stuckLeader.defRef}) before taking any other action`,
  );
}

function spendAction(state: GameState): GameState["turn"] {
  return { ...state.turn, actionsRemaining: state.turn.actionsRemaining - 1 };
}

// playCard/playMotorcade/activateAbility can each also be paid for out of
// TurnState.restrictedAction (Puppet-Master's "Play 2 cards", Master
// Assassin's "return and play a card", Commander General's "any
// number... at this location" — both its play and activate abilities,
// Opposition Leader's "place 2 rebels at any locations") on top of the
// normal budget. Returns the grant only when it's the right kind and not
// already exhausted — the caller still has to separately confirm the
// SPECIFIC card/location it's about to pay for actually falls under the
// grant's own faction/locationId narrowing before treating it as usable;
// a grant that doesn't cover this particular use just isn't applicable,
// falling back to the normal budget (or failing if that's empty too),
// never a hard rejection on its own.
function activeRestrictedGrant(state: GameState, kind: "play" | "activate"): RestrictedActionGrant | null {
  const grant = state.turn.restrictedAction;
  if (!grant || grant.kind !== kind) return null;
  if (grant.amount !== "unbounded" && grant.amount <= 0) return null;
  return grant;
}

function spendRestrictedAction(state: GameState): GameState["turn"] {
  const grant = state.turn.restrictedAction!;
  if (grant.amount === "unbounded") return state.turn;
  const remaining = grant.amount - 1;
  return { ...state.turn, restrictedAction: remaining > 0 ? { ...grant, amount: remaining } : null };
}

function applyDraw(state: GameState): GameState {
  const deckIndex = state.cards.findIndex((c) => c.zone === "deck");
  if (deckIndex === -1) {
    if (state.turn.phase !== "draw") {
      throw new Error("Cannot draw: deck is empty");
    }
    return applyForcedMotorcadeOrEmptyDraw(state);
  }

  const currentPlayerId = state.turn.currentPlayerId;
  const cards = state.cards.map((card, i) =>
    i === deckIndex ? { ...card, zone: "hand" as const, controller: currentPlayerId } : card,
  );

  if (state.turn.phase === "draw") {
    // The mandatory start-of-turn draw — not budgeted, transitions to the
    // action phase. Still a submitted action (not auto-applied inside
    // endTurn) so it stays a uniform, loggable decision point even though
    // there's no real choice involved.
    return { ...state, cards, turn: { ...state.turn, phase: "action" } };
  }

  // A voluntary "draw a card" during the action phase — one of the two
  // budgeted actions.
  requireBudgetedAction(state);
  return { ...state, cards, turn: spendAction(state) };
}

// "If the deck is empty, the President has not been eliminated, and a
// player holds a Motorcade card, it must be played immediately (does not
// count as an action)" — substitutes for the mandatory draw itself, with
// no player decision involved (which Motorcade, if the player somehow
// holds more than one, is picked arbitrarily — first in hand order).
// Otherwise (no Motorcade held, or the President's already eliminated —
// that "must be played" clause has its own explicit precondition) the
// mandatory draw is simply a no-op: nothing to draw, straight to the
// action phase.
function applyForcedMotorcadeOrEmptyDraw(state: GameState): GameState {
  const currentPlayerId = state.turn.currentPlayerId;
  const motorcade =
    state.president.status !== "eliminated"
      ? state.cards.find((c) => c.kind === "motorcade" && c.zone === "hand" && c.controller === currentPlayerId)
      : undefined;

  const turn: TurnState = { ...state.turn, phase: "action" };
  if (!motorcade) {
    return { ...state, turn };
  }

  const { cards, president, resolutionStack } = resolveMotorcadePlay(
    state,
    currentPlayerId,
    motorcade.id,
    undefined,
    undefined,
  );
  return { ...state, cards, president, resolutionStack, turn };
}

function applyEndTurn(state: GameState): GameState {
  if (state.turn.phase === "draw") {
    throw new Error("Cannot end turn before taking the mandatory draw");
  }

  const currentPlayerId = state.turn.currentPlayerId;
  const currentSeat = state.players.find((p) => p.id === currentPlayerId)!.seatIndex;
  const nextSeat = (currentSeat + 1) % state.players.length;
  const nextPlayerId = state.players.find((p) => p.seatIndex === nextSeat)!.id;
  const players = state.players.map((p) =>
    p.id === currentPlayerId ? { ...p, hasTakenFirstTurn: true } : p,
  );

  // Set to 3*players.length+1 the moment the President is eliminated
  // (eliminateSingleTarget) and decrements once per completed turn from
  // there, unconditionally — see that function's comment for why the "+1"
  // gives every player, including whoever's turn is already in progress
  // at the moment he dies, exactly 3 full turns following his elimination.
  // A caller checking win conditions (effects/winConditions.ts's
  // isGameOver) should do so once this reaches 0, or once the President
  // survives past the last location — the engine itself doesn't force the
  // game to end.
  const endgameTurnsRemaining =
    state.turn.endgameTurnsRemaining === null ? null : Math.max(0, state.turn.endgameTurnsRemaining - 1);

  return {
    ...state,
    players,
    turn: {
      currentPlayerId: nextPlayerId,
      phase: "draw",
      actionsRemaining: 2,
      restrictedAction: null,
      endgameTurnsRemaining,
      usedAbilities: [],
    },
  };
}

function applyMoveCard(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "moveCard" }>,
): GameState {
  requireBudgetedAction(state);

  const cardIndex = state.cards.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  const card = state.cards[cardIndex]!;

  if (card.zone !== "inPlay" || card.locationId === undefined) {
    throw new Error(`Card ${action.cardId} is not in play`);
  }
  if (card.controller !== state.turn.currentPlayerId) {
    throw new Error(`Card ${action.cardId} is not controlled by ${state.turn.currentPlayerId}`);
  }

  const adjacent = adjacentLocationIds(state.board, card.locationId);
  if (!adjacent.includes(action.toLocationId)) {
    throw new Error(`${action.toLocationId} is not adjacent to ${card.locationId}`);
  }

  // A revealed Blend character automatically re-blends on arrival — not a
  // player choice. Reveals only ever happen via an ability, a response, the
  // protected-targeting window, or being forced by another card's effect;
  // moving never asks.
  const faceUp = card.faceUp === true && hasAttribute(cardData, card, "Blend") ? false : card.faceUp;

  const cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, locationId: action.toLocationId, faceUp } : c,
  );

  return { ...state, cards, turn: spendAction(state) };
}

function applyPlayCard(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "playCard" }>,
): GameState {
  if (state.turn.phase !== "action") {
    throw new Error("Cannot take an action outside the action phase");
  }

  const cardIndex = state.cards.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  const card = state.cards[cardIndex]!;

  if (card.zone !== "hand" || card.controller !== state.turn.currentPlayerId) {
    throw new Error(`Card ${action.cardId} is not in ${state.turn.currentPlayerId}'s hand`);
  }
  if (card.kind === "motorcade") {
    throw new Error("Motorcade cards are played with playMotorcade, not playCard");
  }

  const location = state.board.find((loc) => loc.id === action.locationId);
  if (!location) {
    throw new Error(`Unknown location: ${action.locationId}`);
  }

  // A restricted "play" grant (Puppet-Master, Master Assassin, Commander
  // General, Opposition Leader) only actually covers THIS play once its
  // own faction/locationId narrowing (if any) is satisfied — otherwise
  // it just isn't applicable here and this falls back to the normal
  // budget, same as if no grant existed at all.
  const grant = activeRestrictedGrant(state, "play");
  const grantCoversThis =
    grant !== null &&
    (grant.faction === null || getFaction(cardData, card) === grant.faction) &&
    (grant.locationId === null || action.locationId === grant.locationId);

  if (!grantCoversThis && state.turn.actionsRemaining <= 0) {
    throw new Error("No actions remaining this turn");
  }

  if (!(grantCoversThis && grant!.ignoreLocationRestrictions)) {
    const allowedTypes = getAllowedLocationTypes(cardData, card);
    if (!allowedTypes.includes(location.type)) {
      throw new Error(
        `${card.defRef} cannot be played at a ${location.type} location (allowed: ${allowedTypes.join(", ")})`,
      );
    }
  }

  // Blend-attribute cards always enter play face-down automatically —
  // never a player choice, same principle as moveCard's auto-reblend.
  const faceUp = !hasAttribute(cardData, card, "Blend");

  const cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, zone: "inPlay" as const, locationId: action.locationId, faceUp } : c,
  );

  const turn = grantCoversThis ? spendRestrictedAction(state) : spendAction(state);
  return { ...state, cards, turn };
}

function applyPlayMotorcade(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "playMotorcade" }>,
): GameState {
  if (state.turn.phase !== "action") {
    throw new Error("Cannot take an action outside the action phase");
  }

  const currentPlayerId = state.turn.currentPlayerId;
  const player = state.players.find((p) => p.id === currentPlayerId)!;
  if (!player.hasTakenFirstTurn) {
    throw new Error("Motorcade cannot be played on a player's first turn");
  }

  // Motorcades have no destination location of their own, so a grant's
  // locationId restriction (Commander General's "at this location") can
  // never be satisfied by one — moot in practice anyway, since a
  // Motorcade has no faction and so never matches a faction-restricted
  // grant (Commander General, Opposition Leader) either, exactly as
  // under the old encoding.
  const card = state.cards.find((c) => c.id === action.cardId);
  const grant = activeRestrictedGrant(state, "play");
  const grantCoversThis =
    grant !== null && card !== undefined && (grant.faction === null || getFaction(cardData, card) === grant.faction);

  if (!grantCoversThis && state.turn.actionsRemaining <= 0) {
    throw new Error("No actions remaining this turn");
  }

  const { cards, president, resolutionStack } = resolveMotorcadePlay(
    state,
    currentPlayerId,
    action.cardId,
    action.moveOwnCardId,
    action.moveToLocationId,
  );
  const turn = grantCoversThis ? spendRestrictedAction(state) : spendAction(state);
  return { ...state, cards, president, resolutionStack, turn };
}

// The actual "play a Motorcade" mechanic — discard it, then move the
// President (opening an interception window first if anyone's eligible),
// move a controlled card instead (post-elimination), or enter him onto
// the board for the first time. Shared by the voluntary playMotorcade
// action and the forced-immediate-play path (applyDraw, when the deck is
// empty) — everything except the turn-budget/first-turn gating, which
// only the voluntary path needs: forced play "does not count as an
// action" (same as the mandatory draw it substitutes for) and isn't
// gated by hasTakenFirstTurn either — "must be played immediately" has no
// stated exception, a deliberate reading since a *forced* effect
// overriding a restriction on *voluntary* play is the more sensible one.
function resolveMotorcadePlay(
  state: GameState,
  currentPlayerId: PlayerId,
  cardId: string,
  moveOwnCardId: string | undefined,
  moveToLocationId: string | undefined,
): Pick<GameState, "cards" | "president" | "resolutionStack"> {
  const cardIndex = state.cards.findIndex((c) => c.id === cardId);
  if (cardIndex === -1) {
    throw new Error(`Unknown card: ${cardId}`);
  }
  const card = state.cards[cardIndex]!;
  if (card.kind !== "motorcade" || card.zone !== "hand" || card.controller !== currentPlayerId) {
    throw new Error(`Card ${cardId} is not a Motorcade in ${currentPlayerId}'s hand`);
  }

  let cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, zone: "discard" as const, controller: null } : c,
  );
  let president = state.president;

  if (president.status === "alive") {
    // Throng of Admirers / Angry Mob's shared passive: before the forward
    // move applies, anyone controlling one of those cards at the
    // President's *pre-move* location may eliminate it to cancel the
    // move. If nobody can (no eligible card there at all), the move just
    // applies immediately — no window needed. The Motorcade card is
    // already discarded above either way; only the *movement* is ever in
    // question.
    const presidentLocationId = president.locationId!; // status "alive" always has a real locationId
    const interceptors = findMotorcadeInterceptors(cards, presidentLocationId);
    if (interceptors.length > 0) {
      const windowFrame: MotorcadeInterceptionWindowFrame = {
        kind: "motorcadeInterceptionWindow",
        actingPlayerId: currentPlayerId,
        presidentLocationId,
        order: buildMotorcadeInterceptionOrder(state, currentPlayerId, interceptors),
        nextIndex: 0,
      };
      return { cards, president, resolutionStack: [windowFrame] };
    }
    const newPresident = computeForwardMove(state.board, president);
    cards = applyFollowPresidentPassive(cards, presidentLocationId, newPresident);
    president = newPresident;
  } else if (president.status === "eliminated") {
    // "After the President has been eliminated, move a card you control to
    // any location" — ignores location-type restrictions, per the general
    // ruling that effects specifying a location for placement do so.
    if (!moveOwnCardId || !moveToLocationId) {
      throw new Error("Must specify a card and destination to move after the President's elimination");
    }
    const moveIndex = cards.findIndex((c) => c.id === moveOwnCardId);
    if (moveIndex === -1) {
      throw new Error(`Unknown card: ${moveOwnCardId}`);
    }
    const moving = cards[moveIndex]!;
    if (moving.zone !== "inPlay" || moving.controller !== currentPlayerId) {
      throw new Error(`Card ${moveOwnCardId} is not controlled by ${currentPlayerId}`);
    }
    if (!state.board.some((l) => l.id === moveToLocationId)) {
      throw new Error(`Unknown location: ${moveToLocationId}`);
    }
    cards = cards.map((c, i) => (i === moveIndex ? { ...c, locationId: moveToLocationId } : c));
  } else if (president.status === "notEntered") {
    // The first Motorcade played in the game — enters at the first Street
    // location, found by type rather than assuming index 0 (board is
    // data-driven, see boardLayoutFromCardData).
    const firstStreet = state.board.find((l) => l.type === "Street");
    if (!firstStreet) {
      throw new Error("Board has no Street location for the President to enter at");
    }
    president = { status: "alive", locationId: firstStreet.id };
  }
  // status === "survived": Motorcade text has nothing left to do; the card
  // still gets discarded either way.

  return { cards, president, resolutionStack: state.resolutionStack };
}

// Advances the President one location, or — if he's already at the last
// one — he survives and the game ends immediately (nothing yet enforces
// "no further actions once the game has ended"; deferred to the
// win-condition evaluator, not built yet).
function computeForwardMove(board: BoardLayout, president: PresidentState): PresidentState {
  const currentIndex = board.findIndex((l) => l.id === president.locationId);
  const nextIndex = currentIndex + 1;
  if (nextIndex >= board.length) {
    return { status: "survived", locationId: null };
  }
  return { status: "alive", locationId: board[nextIndex]!.id };
}

// Bodyguard's unconditional, immediate passive: "if the President moves
// from this location, move this card to the same location" — every
// Bodyguard-passive card at the President's *old* location follows him to
// wherever he actually ends up. Skipped if he instead survives off the
// board (no "same location" to follow to) — not spelled out explicitly in
// the rules text, the most sensible reading; flag if wrong. Any future
// president-move implementation (Traffic Cop's ability isn't encoded yet)
// needs this same hook.
function applyFollowPresidentPassive(
  cards: readonly CardInstance[],
  fromLocationId: string,
  newPresident: PresidentState,
): CardInstance[] {
  if (newPresident.status !== "alive" || !newPresident.locationId) return [...cards];
  const toLocationId = newPresident.locationId;
  return cards.map((c) =>
    c.zone === "inPlay" && c.locationId === fromLocationId && getPassive(c.defRef)?.kind === "followPresident"
      ? { ...c, locationId: toLocationId }
      : c,
  );
}

function findMotorcadeInterceptors(cards: readonly CardInstance[], presidentLocationId: string): CardInstance[] {
  return cards.filter(
    (c) =>
      c.zone === "inPlay" &&
      c.locationId === presidentLocationId &&
      getPassive(c.defRef)?.kind === "motorcadeInterception",
  );
}

// Table order starting after whoever played the Motorcade, wrapping fully
// around (including back to that player, last — self-interception is
// explicitly allowed), filtered to only players who actually control an
// eligible interceptor card.
function buildMotorcadeInterceptionOrder(
  state: GameState,
  actingPlayerId: PlayerId,
  interceptors: readonly CardInstance[],
): PlayerId[] {
  const seats = state.players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
  const actorSeat = seats.find((p) => p.id === actingPlayerId)!.seatIndex;
  const n = seats.length;
  const rotated = Array.from(
    { length: n },
    (_, i) => seats.find((p) => p.seatIndex === (actorSeat + i + 1) % n)!.id,
  );
  const eligibleControllers = new Set(interceptors.map((c) => c.controller));
  return rotated.filter((playerId) => eligibleControllers.has(playerId));
}

// First "yes" wins and stops the pass immediately, unlike the fixed-length
// protected-targeting pass — this mirrors card_data.json's
// motorcade_interception_rules directly.
function applyMotorcadeInterceptionWindowAction(
  state: GameState,
  frame: MotorcadeInterceptionWindowFrame,
  actingPlayerId: PlayerId,
  action: Action,
): GameState {
  const expectedPlayerId = frame.order[frame.nextIndex]!;
  if (actingPlayerId !== expectedPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn in this Motorcade interception window`);
  }

  if (action.type === "interceptMotorcade") {
    const card = state.cards.find((c) => c.id === action.cardId);
    if (
      !card ||
      card.zone !== "inPlay" ||
      card.controller !== actingPlayerId ||
      card.locationId !== frame.presidentLocationId ||
      getPassive(card.defRef)?.kind !== "motorcadeInterception"
    ) {
      throw new Error(`${action.cardId} cannot intercept this Motorcade`);
    }
    // Self-sacrifice — the controller eliminates their own card, so
    // they're the attributed eliminator too (matters if a future card
    // combines this shape with a reactive passive).
    const { card: updated, trigger } = eliminateCard(card, actingPlayerId);
    const cards = state.cards.map((c) => (c.id === card.id ? updated : c));
    const pendingPassiveQueue = trigger ? [...state.pendingPassiveQueue, trigger] : state.pendingPassiveQueue;
    // The move is cancelled — the President's status/location are simply
    // left unchanged.
    return { ...state, cards, pendingPassiveQueue, resolutionStack: state.resolutionStack.slice(0, -1) };
  }
  if (action.type !== "passIntercept") {
    throw new Error(`Expected interceptMotorcade or passIntercept, got: ${action.type}`);
  }

  const nextIndex = frame.nextIndex + 1;
  if (nextIndex < frame.order.length) {
    const updatedFrame: MotorcadeInterceptionWindowFrame = { ...frame, nextIndex };
    return { ...state, resolutionStack: [...state.resolutionStack.slice(0, -1), updatedFrame] };
  }

  // Everyone passed — the move applies as normal.
  const president = computeForwardMove(state.board, state.president);
  const cards = applyFollowPresidentPassive(state.cards, frame.presidentLocationId, president);
  return { ...state, president, cards, resolutionStack: state.resolutionStack.slice(0, -1) };
}

// Celebrity/Martyr's reactive queue, once activated (see
// drainPendingPassives): each player in `order` may play any number of
// matching cards from their hand at the captured location (ignoring
// location-type restrictions, same principle as Commander General's
// "play" effect — reuses the same eligibility/validation helpers), or
// decline. Unlike the Motorcade interception window, there's no "first
// yes wins" here — every player in order gets their own independent turn
// to play (or not), since the ability text has no such exclusivity.
function applyReactivePassiveWindowAction(
  state: GameState,
  cardData: CardData,
  frame: ReactivePassiveWindowFrame,
  actingPlayerId: PlayerId,
  action: Action,
): GameState {
  const expectedPlayerId = frame.order[frame.nextIndex]!;
  if (actingPlayerId !== expectedPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn in this reactive-passive window`);
  }

  let cards = state.cards;
  if (action.type === "playReactive") {
    const selector: Extract<TargetSelector, { ref: "filter" }> = {
      ref: "filter",
      ...(frame.faction ? { faction: frame.faction } : {}),
      count: { mode: "unbounded" },
      selection: "playerChoice",
    };
    const eligible = resolveEligibleHandCards(state, cardData, selector, actingPlayerId);
    validateTargets(selector.count, action.cardIds, eligible.map((c) => c.id));

    const targetSet = new Set(action.cardIds);
    cards = state.cards.map((c) => {
      if (!targetSet.has(c.id)) return c;
      const faceUp = !hasAttribute(cardData, c, "Blend");
      return { ...c, zone: "inPlay" as const, locationId: frame.locationId, faceUp };
    });
  } else if (action.type !== "passReactive") {
    throw new Error(`Expected playReactive or passReactive, got: ${action.type}`);
  }

  const nextIndex = frame.nextIndex + 1;
  if (nextIndex < frame.order.length) {
    const updatedFrame: ReactivePassiveWindowFrame = { ...frame, nextIndex };
    return { ...state, cards, resolutionStack: [...state.resolutionStack.slice(0, -1), updatedFrame] };
  }
  return { ...state, cards, resolutionStack: state.resolutionStack.slice(0, -1) };
}

function applyActivateAbility(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "activateAbility" }>,
): GameState {
  if (state.turn.phase !== "action") {
    throw new Error("Cannot take an action outside the action phase");
  }

  const currentPlayerId = state.turn.currentPlayerId;
  const card = state.cards.find((c) => c.id === action.cardId);
  if (!card) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  // No remote-activation yet (Head of Security etc.) — only the card's own
  // controller can activate it, on their own turn.
  if (card.zone !== "inPlay" || card.controller !== currentPlayerId || card.locationId === undefined) {
    throw new Error(`Card ${action.cardId} is not an in-play card controlled by ${currentPlayerId}`);
  }

  // A restricted "activate" grant (Commander General's "activate any
  // number of your regime cards at this location") only actually covers
  // THIS activation once its own faction/locationId narrowing is
  // satisfied — otherwise it falls back to the normal budget, same as
  // playCard/playMotorcade.
  const grant = activeRestrictedGrant(state, "activate");
  const grantCoversThis =
    grant !== null &&
    (grant.faction === null || getFaction(cardData, card) === grant.faction) &&
    (grant.locationId === null || card.locationId === grant.locationId);

  if (!grantCoversThis && state.turn.actionsRemaining <= 0) {
    throw new Error("No actions remaining this turn");
  }

  const usageKey = `${card.id}#${action.abilityIndex}`;
  if (state.turn.usedAbilities.includes(usageKey)) {
    throw new Error(`Ability ${action.abilityIndex} on ${card.defRef} has already been used this turn`);
  }

  const rawAbility = getAbilities(cardData, card)[action.abilityIndex];
  if (!rawAbility) {
    throw new Error(`${card.defRef} has no ability at index ${action.abilityIndex}`);
  }
  if (rawAbility.type !== "Activate") {
    throw new Error(`${card.defRef}'s ability ${action.abilityIndex} is a Response, not self-activatable`);
  }

  const effects = getAbilityEffects(card.defRef, action.abilityIndex);
  if (!effects) {
    throw new Error(`${card.defRef}'s ability ${action.abilityIndex} has no encoded effects yet`);
  }

  // Must reveal to use an Activate ability — unconditional, not a choice
  // (same principle as "must reveal to respond" below).
  const cards = state.cards.map((c) => (c.id === card.id ? { ...c, faceUp: true } : c));

  const abilityFrame: AbilityResolutionFrame = {
    kind: "abilityResolution",
    sourceCardId: card.id,
    actingPlayerId: currentPlayerId,
    abilityIndex: action.abilityIndex,
    locationId: card.locationId,
    targetIds: null,
  };
  const alarmFrame = effects.alarm ? buildAlarmFrame(state, cardData, card.id, currentPlayerId, card.locationId) : null;
  const resolutionStack: ResolutionFrame[] = alarmFrame ? [abilityFrame, alarmFrame] : [abilityFrame];

  return {
    ...state,
    cards,
    resolutionStack,
    turn: {
      ...(grantCoversThis ? spendRestrictedAction(state) : spendAction(state)),
      usedAbilities: [...state.turn.usedAbilities, usageKey],
    },
  };
}

// Whether `playerId` has any reason to be asked to respond to this
// alarm, scoped to their own cards at the alarm's own location (never
// anywhere else) and excluding the triggering card itself (it can't
// respond to its own alarm — applyAlarmAction enforces the same rule):
// either a face-up card with a real Response ability ("visible
// responses"), or a blended card there at all. A blended card counts
// unconditionally, whether or not it happens to have a Response ability
// — the point isn't that it CAN respond, it's that whether it can is
// itself hidden information; skipping only when a blended card's own
// ability rules it out would leak that ability through the skip/no-skip
// signal alone. Only a player with neither kind of card here — nothing
// visible, nothing hidden — contributes nothing to the decision and can
// be safely skipped.
function playerMightRespondToAlarm(
  state: GameState,
  cardData: CardData,
  playerId: PlayerId,
  locationId: string,
  triggeringCardId: string,
): boolean {
  const ownCardsHere = state.cards.filter(
    (c) => c.zone === "inPlay" && c.controller === playerId && c.locationId === locationId && c.id !== triggeringCardId,
  );
  return ownCardsHere.some((c) => c.faceUp === false || getAbilities(cardData, c).some((a) => a.type === "Response"));
}

// Seating order for an alarm's response pass: starts with the player after
// the triggering (acting) player, wraps around, ends with the triggering
// player — filtered to only players who might actually respond (see
// playerMightRespondToAlarm); a player with nothing possible at this
// specific location is skipped rather than given an empty formality.
// Returns null when nobody at all qualifies (including the triggering
// player) — callers should skip pushing an alarm frame entirely in that
// case, the same as if the ability weren't alarm-tagged.
function buildAlarmFrame(
  state: GameState,
  cardData: CardData,
  triggeringCardId: string,
  triggeringPlayerId: PlayerId,
  locationId: string,
): AlarmResolutionFrame | null {
  const seats = state.players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
  const triggerSeat = seats.find((p) => p.id === triggeringPlayerId)!.seatIndex;
  const n = seats.length;
  const fullOrder = Array.from({ length: n }, (_, i) => {
    const seat = (triggerSeat + i + 1) % n;
    return seats.find((p) => p.seatIndex === seat)!.id;
  });
  const order = fullOrder.filter((playerId) => playerMightRespondToAlarm(state, cardData, playerId, locationId, triggeringCardId));
  if (order.length === 0) return null;
  return { kind: "alarmResolution", triggeringCardId, triggeringPlayerId, locationId, order, nextIndex: 0 };
}

function applyChooseTargets(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  actingPlayerId: PlayerId,
  action: Extract<Action, { type: "chooseTargets" }>,
): GameState {
  if (actingPlayerId !== frame.actingPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn to choose targets for this ability`);
  }

  const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId)!;
  const definition = getAbilityEffects(sourceCard.defRef, frame.abilityIndex)!;
  const effect = definition.effects[frame.effectIndex ?? 0];
  if (!effect) {
    throw new Error(`${sourceCard.defRef}'s ability ${frame.abilityIndex} has no effect at this step`);
  }

  return applyEffect(
    state,
    cardData,
    frame,
    sourceCard,
    actingPlayerId,
    effect,
    action.targetIds,
    action.remoteAbilityIndex,
    action.locationIds,
  );
}

// Dispatches a single EffectNode by verb. Shared by applyChooseTargets (a
// top-level effect awaiting the player's action) and applyIfEffect (an
// if/else branch's single effect, resolved inline as part of the same
// player action that evaluated the condition — see applyIfEffect).
function applyEffect(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  sourceCard: CardInstance,
  actingPlayerId: PlayerId,
  effect: EffectNode,
  targetIds: readonly string[],
  remoteAbilityIndex?: number,
  locationIds?: readonly string[],
): GameState {
  if (effect.verb === "activateRemote") {
    return applyActivateRemote(state, cardData, frame, sourceCard, effect, actingPlayerId, targetIds, remoteAbilityIndex);
  }
  if (effect.verb === "reveal") {
    return applyRevealEffect(state, frame, cardData, sourceCard, effect, targetIds);
  }
  if (effect.verb === "peek") {
    return applyPeekEffect(state, frame, cardData, sourceCard, effect, targetIds);
  }
  if (effect.verb === "play") {
    return applyPlayEffect(state, frame, cardData, actingPlayerId, effect, targetIds, locationIds);
  }
  if (effect.verb === "gainControl") {
    return applyGainControlEffect(state, frame, actingPlayerId, effect, targetIds);
  }
  if (effect.verb === "gainActions") {
    return applyGainActionsEffect(state, frame, effect, targetIds);
  }
  if (effect.verb === "draw") {
    return applyDrawAbilityEffect(state, frame, actingPlayerId, effect, targetIds);
  }
  if (effect.verb === "returnToHand") {
    return applyReturnToHandEffect(state, frame, sourceCard, effect, targetIds);
  }
  if (effect.verb === "blend") {
    return applyBlendEffect(state, frame, sourceCard, effect, targetIds);
  }
  if (effect.verb === "move") {
    return applyMoveEffect(state, frame, effect, targetIds, locationIds);
  }
  if (effect.verb === "triggerAlarm") {
    return applyTriggerAlarmEffect(state, cardData, frame, sourceCard, actingPlayerId, effect, targetIds, locationIds);
  }
  if (effect.verb === "if") {
    return applyIfEffect(state, cardData, frame, sourceCard, actingPlayerId, effect, targetIds);
  }
  if (effect.verb !== "eliminate") {
    // Every other verb is handled above — this is unreachable given the
    // current EffectNode union, kept only as a defensive fallback.
    throw new Error("Unrecognized effect verb");
  }
  if (effect.target.ref === "self") {
    // "Eliminate this card" (Suicide Bomber's final step) — no choice to
    // submit, and Protected-immunity/reveal windows don't apply to
    // self-destruction, so this bypasses declareEliminateTarget entirely.
    if (targetIds.length > 0) {
      throw new Error("This effect targets its own source card automatically — no targets to choose");
    }
    return finalizeEliminateEffect(state, frame, [sourceCard.id]);
  }
  if (effect.target.ref === "binding") {
    // "Eliminate it" (Secret Police/Guerrilla Commander, the target named
    // by an earlier reveal's `bind`) — the card's identity was already
    // conclusively fixed and publicly revealed by that step, so like the
    // self case above this deliberately bypasses Protected-immunity/the
    // reveal window entirely: there's no live "declare a target" moment
    // here for another player's hidden card to interject on, and the
    // ability text names a specific already-known card ("it"), not an
    // open pool the window's reselection concept could apply to.
    if (targetIds.length > 0) {
      throw new Error("This target was already determined by an earlier reveal — no targets to choose");
    }
    const boundId = frame.bindings?.[effect.target.binding];
    if (!boundId) {
      throw new Error(`No binding named "${effect.target.binding}" is available yet`);
    }
    return finalizeEliminateEffect(state, frame, [boundId]);
  }
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based, self, and binding targeting is interpreted so far");
  }

  if (effect.target.selection === "random") {
    return applyRandomEliminateEffect(state, frame, cardData, sourceCard, effect, targetIds);
  }

  const declared = declareEliminateTargets(state, cardData, effect, sourceCard, actingPlayerId, targetIds);

  // Once the protected-targeting reveal pass has already run once for this
  // declaration (frame.reselectingAfterReveal), it never reopens — "once
  // the pass completes, it is not repeated" (card_data.json's
  // protected_targeting_rules). The re-choice above still had to be a
  // currently *legal* target (declareEliminateTargets doesn't bypass
  // protection for a reselect, only for the DSL's own ignoreProtected) —
  // this only stops a second window, not a second chance to dodge
  // protection. A legal re-choice can still carry the Protected attribute
  // (e.g. no protector actually present, so it was legal despite that) and
  // would otherwise satisfy `declared.protectedActive` on its own.
  if (declared.protectedActive && !(frame.reselectingAfterReveal ?? false) && hasRevealOpportunity(state, declared.locationId, actingPlayerId)) {
    const updatedFrame: AbilityResolutionFrame = { ...frame, targetIds: declared.targetIds };
    const windowFrame = buildProtectedTargetingWindowFrame(
      state,
      declared.locationId,
      actingPlayerId,
      declared.targetIds,
    );
    return {
      ...state,
      resolutionStack: [...state.resolutionStack.slice(0, -1), updatedFrame, windowFrame],
    };
  }

  return finalizeEliminateEffect(state, frame, declared.targetIds);
}

// Evaluates an `if` node's condition against this ability's accumulated
// bindings and applies whichever branch matches (`then`/`else`), inline,
// as part of the same player action — no separate chooseTargets round trip
// for the branch, since every currently-encoded branch effect targets via
// `ref: "self"`/`"binding"` (already fully determined, nothing left for
// the player to choose). Scoped deliberately narrow: a branch may contain
// at most one effect (itself optionally another `if`, for "else if"
// chains — see Guerrilla Commander in abilityEffects.ts) rather than an
// arbitrary sub-sequence, since that's all any encoded ability needs.
function applyIfEffect(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  sourceCard: CardInstance,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "if" }>,
  targetIds: readonly string[],
): GameState {
  if (targetIds.length > 0) {
    throw new Error("This step branches automatically — no targets to choose");
  }
  const branch = evaluateCondition(state, cardData, frame, effect.condition) ? effect.then : (effect.else ?? []);
  if (branch.length === 0) {
    return finishEffectStep(state, frame);
  }
  if (branch.length > 1) {
    throw new Error("Only a single effect per if/else branch is interpreted so far");
  }
  return applyEffect(state, cardData, frame, sourceCard, actingPlayerId, branch[0]!, []);
}

function evaluateCondition(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  condition: Condition,
): boolean {
  if (condition.op === "and") {
    return condition.conditions.every((c) => evaluateCondition(state, cardData, frame, c));
  }
  if (condition.op === "or") {
    return condition.conditions.some((c) => evaluateCondition(state, cardData, frame, c));
  }
  return resolveConditionOperand(state, cardData, frame, condition.left) === condition.value;
}

function resolveConditionOperand(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  operand: ConditionOperand,
): string {
  if (operand.source === "presidentStatus") {
    return state.president.status;
  }
  const cardId = frame.bindings?.[operand.binding];
  if (!cardId) {
    throw new Error(`No binding named "${operand.binding}" is available yet`);
  }
  const card = state.cards.find((c) => c.id === cardId)!;
  return operand.field === "faction" ? (getFaction(cardData, card) ?? "") : card.kind;
}

function applyGainControlEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "gainControl" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "binding") {
    throw new Error("Only binding-ref targeting is interpreted for gainControl so far");
  }
  if (targetIds.length > 0) {
    throw new Error("This target was already determined by an earlier reveal — no targets to choose");
  }
  const boundId = frame.bindings?.[effect.target.binding];
  if (!boundId) {
    throw new Error(`No binding named "${effect.target.binding}" is available yet`);
  }
  const cards = state.cards.map((c) => (c.id === boundId ? { ...c, controller: actingPlayerId } : c));
  return finishEffectStep({ ...state, cards }, frame);
}

// Heir Apparent's "Gain 2 actions" — no target, confirm-only (same
// convention as reveal-all/self-eliminate: an explicit empty-targetIds
// chooseTargets call still required, even though there's no real choice).
function applyGainActionsEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  effect: Extract<EffectNode, { verb: "gainActions" }>,
  targetIds: readonly string[],
): GameState {
  if (targetIds.length > 0) {
    throw new Error("This effect has no targets to choose");
  }
  if (!effect.restriction) {
    if (effect.amount === "unbounded") {
      throw new Error("An unrestricted gainActions must have a numeric amount");
    }
    const turn = { ...state.turn, actionsRemaining: state.turn.actionsRemaining + effect.amount };
    return finishEffectStep({ ...state, turn }, frame);
  }
  const restrictedAction: RestrictedActionGrant = {
    kind: effect.restriction,
    amount: effect.amount,
    faction: effect.faction ?? null,
    locationId: effect.location === "self" ? frame.locationId : null,
    ignoreLocationRestrictions: effect.ignoreLocationRestrictions ?? false,
  };
  const turn = { ...state.turn, restrictedAction };
  return finishEffectStep({ ...state, turn }, frame);
}

// Opposition Leader's "Draw 3 cards" — an ability *effect*, distinct from
// the turn-level "draw" Action: no budget/phase interaction at all, just
// moves up to `amount` cards from the deck into the acting player's hand.
// Stops early (no error) if the deck runs out partway through — nothing
// in the rules suggests this should fail outright.
function applyDrawAbilityEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "draw" }>,
  targetIds: readonly string[],
): GameState {
  if (targetIds.length > 0) {
    throw new Error("This effect has no targets to choose");
  }
  let cards = state.cards;
  for (let i = 0; i < effect.amount; i++) {
    const deckIndex = cards.findIndex((c) => c.zone === "deck");
    if (deckIndex === -1) break;
    cards = cards.map((c, idx) => (idx === deckIndex ? { ...c, zone: "hand" as const, controller: actingPlayerId } : c));
  }
  return finishEffectStep({ ...state, cards }, frame);
}

// Master Assassin's "Return this card to its controller's hand and play a
// card" (step 1 of 2) — only `ref: "self"` is interpreted, matching every
// other self-targeting verb so far (eliminate, blend).
function applyReturnToHandEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "returnToHand" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "self") {
    throw new Error("Only self-ref targeting is interpreted for returnToHand so far");
  }
  if (targetIds.length > 0) {
    throw new Error("This effect targets its own source card automatically — no targets to choose");
  }
  const cards = state.cards.map((c) =>
    c.id === sourceCard.id ? { ...c, zone: "hand" as const, locationId: undefined, faceUp: undefined } : c,
  );
  return finishEffectStep({ ...state, cards }, frame);
}

// Master Assassin's "Eliminate a target and blend" (step 2 of 2) — blends
// itself back down after eliminating, not the target (an eliminated card
// has no faceUp state to speak of). Only `ref: "self"` is interpreted.
function applyBlendEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "blend" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "self") {
    throw new Error("Only self-ref targeting is interpreted for blend so far");
  }
  if (targetIds.length > 0) {
    throw new Error("This effect targets its own source card automatically — no targets to choose");
  }
  const cards = state.cards.map((c) => (c.id === sourceCard.id ? { ...c, faceUp: false } : c));
  return finishEffectStep({ ...state, cards }, frame);
}

// Traffic Cop's "Move the President from this location forward or
// backwards to an adjacent location" — only a president-targeted,
// forwardOrBackward move is interpreted (the only kind any encoded
// ability needs). The destination is the player's choice — submitted as
// the sole entry of `locationIds`, validated as one of the President's
// actual neighbors (so "backward from the first location" is simply not
// a legal choice, rather than a special-cased end-game trigger the way
// forward-past-the-last-location has one). Also runs Bodyguard's
// follow-the-President passive, same as every other president-move path.
function applyMoveEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  effect: Extract<EffectNode, { verb: "move" }>,
  targetIds: readonly string[],
  locationIds: readonly string[] | undefined,
): GameState {
  if (effect.target.ref !== "filter" || effect.target.kind !== "president") {
    throw new Error("Only a president-targeted move is interpreted so far");
  }
  if (targetIds.length > 0) {
    throw new Error("This effect has no card targets to choose — see locationIds");
  }
  if (effect.destination.mode !== "forwardOrBackward") {
    throw new Error("Only destination: forwardOrBackward is interpreted so far");
  }
  if (state.president.status !== "alive") {
    throw new Error("The President is not currently on the board");
  }
  // "Move the President from this location" (Traffic Cop) — the source
  // card must actually be co-located with him right now.
  if (effect.target.location?.mode === "self" && state.president.locationId !== frame.locationId) {
    throw new Error("The President is not at this card's location");
  }

  const fromLocationId = state.president.locationId!;
  const adjacent = adjacentLocationIds(state.board, fromLocationId);
  const toLocationId = locationIds?.[0];
  if (!toLocationId || locationIds!.length !== 1 || !adjacent.includes(toLocationId)) {
    throw new Error("Must choose exactly one adjacent location to move the President to");
  }

  const president: PresidentState = { status: "alive", locationId: toLocationId };
  const cards = applyFollowPresidentPassive(state.cards, fromLocationId, president);
  return finishEffectStep({ ...state, cards, president }, frame);
}

// Angry Mob's "Trigger an Alarm" (location: self) and Anarchist's
// "Trigger an Alarm at any location" (location: any, player-chosen via
// `locationIds`) — deliberately encoded as an effect, not by reusing the
// ability-level `alarm: true` flag those cards carry in card_data.json:
// that flag's mechanism (applyActivateAbility) always uses the activating
// card's *own* location, which can't express Anarchist's "any location"
// choice at all, and using two different mechanisms for what's otherwise
// the identical ability text on these two cards would be an odd
// asymmetry. A real, documented divergence from the raw data's `alarm`
// flag — flag if this reads wrong.
//
// Advances/closes out this effect step *first* (finishEffectStep, exactly
// as if nothing further needed to happen — true for both encoded cards,
// "trigger an alarm" is their only effect), then opens the new alarm's
// response window on top of whatever that leaves behind. The existing
// alarm-completion logic (advanceAlarmPass, resumeAlarmIfPaused) already
// knows how to reveal and resume whatever's underneath once the pass
// finishes, generically — including correctly cancelling a still-pending
// later effect in some future multi-effect ability if the triggering
// card is eliminated during the pass, with no special-casing needed here.
function applyTriggerAlarmEffect(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  sourceCard: CardInstance,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "triggerAlarm" }>,
  targetIds: readonly string[],
  locationIds: readonly string[] | undefined,
): GameState {
  if (targetIds.length > 0) {
    throw new Error("This effect has no card targets to choose — see locationIds");
  }
  let locationId: string;
  if (effect.location.mode === "self") {
    locationId = frame.locationId;
  } else if (effect.location.mode === "any") {
    const chosen = locationIds?.[0];
    if (!chosen || locationIds!.length !== 1 || !state.board.some((l) => l.id === chosen)) {
      throw new Error("Must choose exactly one location to trigger the alarm at");
    }
    locationId = chosen;
  } else {
    throw new Error("Only location: self or any is interpreted for triggerAlarm so far");
  }

  const afterEffect = finishEffectStep(state, frame);
  const alarmFrame = buildAlarmFrame(afterEffect, cardData, sourceCard.id, actingPlayerId, locationId);
  if (!alarmFrame) return afterEffect; // nobody at this location could possibly respond
  return { ...afterEffect, resolutionStack: [...afterEffect.resolutionStack, alarmFrame] };
}

// Journalist's "Look at a blended target at this location" — a private
// peek, unlike `reveal`'s public one, so it deliberately does *not* flip
// `faceUp`. GameState has no per-player privacy channel yet (no
// filterForPlayer projection is built — see rev_day_engine_design memory's
// known gaps), so nothing here actually *enforces* that only the acting
// player learns the identity; this just makes the ability legally
// activatable and captures the peeked card via `bind`, same as reveal,
// for a future condition to read. A deliberate, scoped simplification —
// real privacy enforcement is a separate, larger piece of work.
function applyPeekEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  cardData: CardData,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "peek" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  const eligible = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
  validateTargets(effect.target.count, targetIds, eligible.map((c) => c.id));
  const targetId = targetIds[0]!;
  const nextFrame = effect.bind ? { ...frame, bindings: { ...frame.bindings, [effect.bind]: targetId } } : frame;
  return finishEffectStep(state, nextFrame);
}

// Which of `eligibleIds` (a selector-matched pool, still protection-blind)
// could ever actually be legally submitted — i.e. isn't Protected even
// under the most favorable possible batch (every *other* eligible id
// simultaneously excluded/eliminated alongside it). Excluding more
// candidates as potential protectors can only ever help a check like this
// pass, never hurt it, so this is the most permissive protection check
// possible for a given id; the real, narrower per-submission check
// (declareEliminateTargets' own protection loop, against whatever batch
// was *actually* declared) still applies unchanged afterward. A candidate
// that fails even this maximal check is protected no matter what else
// gets submitted alongside it — most often shielded only by the ability's
// own source card, which structurally can never be a candidate for its
// own effect — and should count as unreachable for count/membership
// purposes the same as if it weren't a selector match at all, rather than
// silently demanding a submission nothing could ever satisfy.
function protectionReachableIds(
  state: GameState,
  cardData: CardData,
  actingPlayerId: PlayerId,
  eligibleIds: readonly string[],
  bypassProtection: boolean,
): string[] {
  if (bypassProtection) return [...eligibleIds];
  return eligibleIds.filter((id) => {
    const batchExcluded = eligibleIds.filter((otherId) => otherId !== id);
    return id === PRESIDENT_TARGET_ID
      ? isLegalPresidentTarget(state, cardData, actingPlayerId, false, batchExcluded)
      : isLegalEliminationTarget(state, cardData, state.cards.find((c) => c.id === id)!, actingPlayerId, batchExcluded);
  });
}

// Validates a declared target (either a card or the President sentinel)
// against the ability's selector, and reports whether Protected-immunity
// is currently active for it — shared by direct ability resolution
// (chooseTargets) and a Response's inline target declaration
// (useResponse), since both are "declare a target for an eliminate
// effect" at heart. The only thing that bypasses the guard-protection
// check entirely is the DSL's own `ignoreProtected` (Wife's "eliminate the
// President, ignores protected"). A post-reveal re-choice
// (reselectingAfterReveal) is NOT a bypass — the acting player picks among
// currently *legal* targets same as any fresh declaration (a reveal that
// reintroduces a protector makes the original Protected target illegal
// again, same as it would for a brand-new declaration); see the call site
// in applyChooseTargets for how the *window* (not the legality check)
// still correctly never reopens a second time for the same declaration.
// Handles multi-target declarations (Death Squad's "eliminate one or two
// targets") as well as the single-target case — every declared target
// shares one locationId (every currently-encoded multi-target ability is
// location:self) and the window, if one opens, covers the whole batch
// rather than any single member of it.
//
// Protected-immunity is evaluated per-candidate against the *current*,
// already-eligible-filtered board — not "batch-aware" (a
// simultaneously-declared, non-Protected target that happens to be the
// only thing shielding a Protected one in the same batch doesn't get
// excluded from that other target's own check). This is a deliberate,
// documented simplification of the fuller design-phase rule ("multi-target
// abilities check Protected-immunity against the full simultaneously-
// declared set") — `isLegalEliminationTarget`'s eligibility filter below
// already requires each candidate to be individually legal on its own, so
// a target that's *only* protected by another target in the same batch
// isn't reachable as a submittable combination at all yet. Not needed by
// any currently-encoded ability; flag if a future card requires it.
function declareEliminateTargets(
  state: GameState,
  cardData: CardData,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
  actingCard: CardInstance,
  actingPlayerId: PlayerId,
  targetIds: readonly string[],
): { targetIds: string[]; locationId: string; protectedActive: boolean } {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  const bypassProtection = effect.ignoreProtected ?? false;

  // The President is folded into the same eligible-id pool as real cards
  // rather than being a separate path — per card_data.json's
  // additional_rulings ("The President's faction counts as Regime for all
  // faction-based counting and protection rules"), *any* selector whose
  // kind/faction/location conditions would admit an unfiltered or
  // Regime-faction card at his location admits him too, not just Wife's
  // dedicated kind:"president" selector (which presidentMatchesSelector
  // also matches — a kind restricted to "president" excludes every real
  // card via resolveEligibleTargets, so eligibleCards is empty there and
  // he's the pool's only member, same net effect as the old special case).
  //
  // Selector-match (kind/faction/controller/location/blendState) is
  // validated separately from Protected-immunity here — count/membership
  // first against the *selector's* pool, protection second against the
  // full declared batch (below). Otherwise a target that's only protected
  // by another card in this same simultaneous declaration (e.g. Heir
  // Apparent's "eliminate one or two targets" naming both a protector and
  // what it's shielding) would wrongly appear ineligible: protection must
  // be evaluated treating every other id in this batch as already gone,
  // not just the acting player's own cards.
  const eligibleCards = resolveEligibleTargets(state, cardData, effect.target, actingCard);
  const presidentMatches = presidentMatchesSelector(state, effect.target, actingCard);
  const eligibleIds = eligibleCards.map((c) => c.id);
  if (presidentMatches) eligibleIds.push(PRESIDENT_TARGET_ID);

  // Membership/count are checked against only the *reachable* subset of
  // eligibleIds — see protectionReachableIds — not the raw selector-match
  // pool. Without this, a candidate that's Protected no matter what else
  // gets simultaneously eliminated (most often: shielded only by the
  // ability's own source card, which can never itself be a candidate)
  // still counts toward the required minimum, demanding a submission no
  // combination could ever satisfy — a real dead end, not just an
  // incidental exclusion.
  const reachableIds = protectionReachableIds(state, cardData, actingPlayerId, eligibleIds, bypassProtection);
  validateTargets(effect.target.count, targetIds, reachableIds);

  if (!bypassProtection) {
    for (const id of targetIds) {
      const batchExcluded = targetIds.filter((otherId) => otherId !== id);
      const legal =
        id === PRESIDENT_TARGET_ID
          ? isLegalPresidentTarget(state, cardData, actingPlayerId, false, batchExcluded)
          : isLegalEliminationTarget(state, cardData, state.cards.find((c) => c.id === id)!, actingPlayerId, batchExcluded);
      if (!legal) {
        throw new Error(`${id} is Protected and cannot be targeted for elimination while a protector remains`);
      }
    }
  }

  const firstId = targetIds[0]!;
  const locationId = (
    firstId === PRESIDENT_TARGET_ID ? state.president.locationId : state.cards.find((c) => c.id === firstId)?.locationId
  )!;
  const protectedActive =
    !bypassProtection &&
    targetIds.some((id) =>
      id === PRESIDENT_TARGET_ID
        ? state.president.status === "alive" // no Blend attribute, so always active while alive
        : isProtectedActive(cardData, state.cards.find((c) => c.id === id)!),
    );

  return { targetIds: [...targetIds], locationId, protectedActive };
}

// "Activate any [faction] card, controlled by any player, at any
// location" (Head of Security, Guerrilla Commander, Puppet-Master) —
// composes recursively rather than being a flat effect: pick another card
// + one of its unused Activate abilities, then push a *new*
// AbilityResolutionFrame for that ability (respecting its own alarm flag
// and once-per-turn-per-card usage), replacing this frame rather than
// nesting beneath it.
//
// Commander General's "activate any number of your regime cards" is the
// same effect with `count: "unbounded"` — handled as a queue, one card at
// a time: submitting one target+ability activates it and, once it (and any
// of its own alarm/window nesting) fully resolves, *re-offers* the same
// choice by leaving a fresh copy of this frame (targetIds reset to null)
// underneath rather than popping it — see the loopFrame branch below.
// Submitting zero targets means "no more" and pops for real. No special
// handling is needed for how the loop frame reappears — it's an ordinary
// AbilityResolutionFrame, dispatched the same generic way as any other.
function applyActivateRemote(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "activateRemote" }>,
  actingPlayerId: PlayerId,
  targetIds: readonly string[],
  remoteAbilityIndex: number | undefined,
): GameState {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  const isUnbounded = effect.count.mode === "unbounded";
  if (!isUnbounded && (effect.count.mode !== "exact" || effect.count.value !== 1)) {
    throw new Error("Only exact-one or unbounded remote activation is interpreted so far");
  }

  if (targetIds.length === 0) {
    if (!isUnbounded) {
      throw new Error("Remote activation requires exactly one target card");
    }
    return finishEffectStep(state, frame); // "no more" — done choosing.
  }
  if (targetIds.length !== 1) {
    throw new Error("Choose one card to remotely activate at a time");
  }
  if (remoteAbilityIndex === undefined) {
    throw new Error("Remote activation requires remoteAbilityIndex");
  }

  const eligible = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
  const remoteCard = eligible.find((c) => c.id === targetIds[0]);
  if (!remoteCard || remoteCard.locationId === undefined) {
    throw new Error(`${targetIds[0]} is not a legal card to remotely activate`);
  }

  const usageKey = `${remoteCard.id}#${remoteAbilityIndex}`;
  if (state.turn.usedAbilities.includes(usageKey)) {
    throw new Error(`Ability ${remoteAbilityIndex} on ${remoteCard.defRef} has already been used this turn`);
  }

  const rawAbility = getAbilities(cardData, remoteCard)[remoteAbilityIndex];
  if (!rawAbility) {
    throw new Error(`${remoteCard.defRef} has no ability at index ${remoteAbilityIndex}`);
  }
  if (rawAbility.type !== "Activate") {
    throw new Error(`${remoteCard.defRef}'s ability ${remoteAbilityIndex} is a Response, not activatable`);
  }
  const remoteEffects = getAbilityEffects(remoteCard.defRef, remoteAbilityIndex);
  if (!remoteEffects) {
    throw new Error(`${remoteCard.defRef}'s ability ${remoteAbilityIndex} has no encoded effects yet`);
  }

  // Must reveal to use an Activate ability — same rule as direct activation.
  const cards = state.cards.map((c) => (c.id === remoteCard.id ? { ...c, faceUp: true } : c));

  // The original acting player is the "triggering player" for any alarm
  // response ordering, not remoteCard's controller — see the
  // remote-activation ruling in card_data.json's alarm_response_rules.
  const newAbilityFrame: AbilityResolutionFrame = {
    kind: "abilityResolution",
    sourceCardId: remoteCard.id,
    actingPlayerId,
    abilityIndex: remoteAbilityIndex,
    locationId: remoteCard.locationId,
    targetIds: null,
  };
  const remoteAlarmFrame = remoteEffects.alarm
    ? buildAlarmFrame(state, cardData, remoteCard.id, actingPlayerId, remoteCard.locationId)
    : null;
  const newFrames: ResolutionFrame[] = remoteAlarmFrame ? [newAbilityFrame, remoteAlarmFrame] : [newAbilityFrame];
  const loopFrame: ResolutionFrame[] = isUnbounded ? [{ ...frame, targetIds: null }] : [];

  return {
    ...state,
    cards,
    resolutionStack: [...state.resolutionStack.slice(0, -1), ...loopFrame, ...newFrames],
    turn: { ...state.turn, usedAbilities: [...state.turn.usedAbilities, usageKey] },
  };
}

// "Reveal all blended characters at this location" (Commander General) —
// deterministic, no player choice, so targetIds is just a confirmation and
// must be empty. Only `count: "all"` is implemented; a player-chosen
// partial reveal isn't needed by any encoded ability yet.
function applyRevealEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  cardData: CardData,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "reveal" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }

  if (effect.target.count.mode === "all") {
    if (targetIds.length > 0) {
      throw new Error("This ability reveals everyone matching automatically — no targets to choose");
    }
    const toReveal = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
    const revealSet = new Set(toReveal.map((c) => c.id));
    const cards = state.cards.map((c) => (revealSet.has(c.id) ? { ...c, faceUp: true } : c));
    return finishEffectStep({ ...state, cards }, frame);
  }

  if (effect.target.count.mode === "exact" && effect.target.count.value === 1) {
    // A player-chosen single target to reveal (Secret Police/Guerrilla
    // Commander/Opposition Leader's "reveal a blended target"), as opposed
    // to the forced "reveal all matching" case above. `bind` names it for
    // a later `if` condition or `ref: "binding"` target in the same
    // ability's sequence.
    const eligible = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
    validateTargets(effect.target.count, targetIds, eligible.map((c) => c.id));
    const targetId = targetIds[0]!;
    const cards = state.cards.map((c) => (c.id === targetId ? { ...c, faceUp: true } : c));
    const nextFrame = effect.bind ? { ...frame, bindings: { ...frame.bindings, [effect.bind]: targetId } } : frame;
    return finishEffectStep({ ...state, cards }, nextFrame);
  }

  throw new Error("Only 'reveal all' or a single player-chosen reveal is interpreted so far");
}

// "Play any number of regime cards at this location" (Commander General,
// location: self — shares frame.locationId, not sourceCard.locationId!,
// since a preceding effect in the same sequence could have already moved
// the source card off its own location entirely, e.g. Master Assassin's
// "return this card to hand and play a card") or "Place 2 rebels at any
// locations" (Opposition Leader, location: any — each declared target
// gets its own destination via the parallel `locationIds` array, one per
// targetId in the same order). Unlike activateRemote's unbounded variant,
// this needs no per-card follow-up decision, so the whole chosen set (and
// destinations) is submitted and applied in one chooseTargets call rather
// than a queue. Selects from the acting player's *hand*
// (resolveEligibleHandCards), not state.cards' in-play pool.
// Blend-attribute cards still always enter play face-down automatically,
// same principle as the playCard action. Location-type restrictions are
// enforced per destination unless `ignoreLocationRestrictions` is set —
// "effects that specify a location for placing characters let you ignore
// normal location-type restrictions" only actually applies when the
// effect data says so explicitly (Puppet-Master's unqualified "Play 2
// cards" does not, so normal restrictions apply there).
function applyPlayEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  cardData: CardData,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "play" }>,
  targetIds: readonly string[],
  locationIds: readonly string[] | undefined,
): GameState {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }

  const eligible = resolveEligibleHandCards(state, cardData, effect.target, actingPlayerId);
  validateTargets(
    effect.target.count,
    targetIds,
    eligible.map((c) => c.id),
  );

  let destinations: ReadonlyMap<string, string>;
  if (effect.location.mode === "self") {
    const locationId = frame.locationId;
    destinations = new Map(targetIds.map((id) => [id, locationId]));
  } else if (effect.location.mode === "any") {
    if (!locationIds || locationIds.length !== targetIds.length) {
      throw new Error("Each target needs its own destination location");
    }
    for (const locId of locationIds) {
      if (!state.board.some((l) => l.id === locId)) {
        throw new Error(`Unknown location: ${locId}`);
      }
    }
    destinations = new Map(targetIds.map((id, i) => [id, locationIds[i]!]));
  } else {
    throw new Error("Only location: self or any is interpreted so far");
  }

  if (!effect.ignoreLocationRestrictions) {
    for (const id of targetIds) {
      const card = state.cards.find((c) => c.id === id)!;
      const locationType = state.board.find((l) => l.id === destinations.get(id)!)!.type;
      if (!getAllowedLocationTypes(cardData, card).includes(locationType)) {
        throw new Error(`${card.defRef} cannot be played at this location`);
      }
    }
  }

  const cards = state.cards.map((c) => {
    const locationId = destinations.get(c.id);
    if (locationId === undefined) return c;
    const faceUp = !hasAttribute(cardData, c, "Blend");
    return { ...c, zone: "inPlay" as const, locationId, faceUp };
  });
  return finishEffectStep({ ...state, cards }, frame);
}

// Suicide Bomber's "eliminate 4 random targets... protected cards are
// eliminated only if there are no other targets": no player choice, so
// targetIds must be empty (same confirm-only convention as
// applyRevealEffect). Draws via the seeded RNG in GameState, advancing it,
// so the outcome stays deterministic and replayable per seed — never
// Math.random(). Only `count.mode === "exact"` with a `randomPool` set is
// interpreted; a future card using plain uniform random with no
// pool/fallback tiering would need a small extension here.
//
// The President is merged into the fallback (Protected) pool here — he's
// always "Protected" while alive (see partitionByProtection's own
// comment) and, per additional_rulings, targetable by the same
// unfiltered/Regime-faction selectors any other card is — previously a
// documented gap (see resolveEligibleTargets' own comment): with nobody
// else at the location, the random draw found zero candidates at all and
// silently ate the 4-target effect, so a Suicide Bomber left alone with
// the President only ever eliminated itself via the ability's separate
// "eliminate this card" step, never him.
function applyRandomEliminateEffect(
  state: GameState,
  frame: AbilityResolutionFrame,
  cardData: CardData,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "filter" || effect.target.selection !== "random") {
    throw new Error("Expected a random-selection eliminate effect");
  }
  if (targetIds.length > 0) {
    throw new Error("Random targets are chosen automatically — nothing to submit");
  }
  if (effect.target.count.mode !== "exact") {
    throw new Error("Only exact-count random selection is interpreted so far");
  }
  if (!effect.target.randomPool) {
    throw new Error("Random selection requires a randomPool");
  }

  const candidates = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
  const { primary, fallback } = partitionByProtection(cardData, candidates);
  const primaryIds = primary.map((c) => c.id);
  const fallbackIds = fallback.map((c) => c.id);
  if (presidentMatchesSelector(state, effect.target, sourceCard)) fallbackIds.push(PRESIDENT_TARGET_ID);
  const { targetIds: drawnIds, rng } = drawRandomTargets(state.rng, primaryIds, fallbackIds, effect.target.count.value);

  let cards = state.cards;
  let president = state.president;
  let turn = state.turn;
  let pendingPassiveQueue = state.pendingPassiveQueue;
  for (const id of drawnIds) {
    const result = eliminateSingleTarget({ ...state, cards, president, turn, pendingPassiveQueue }, id, sourceCard.controller);
    cards = result.cards;
    president = result.president;
    turn = result.turn;
    pendingPassiveQueue = result.pendingPassiveQueue;
  }
  return finishEffectStep({ ...state, cards, president, turn, rng, pendingPassiveQueue }, frame);
}

// Exhausts `primary` fully before touching `fallback` at all — "protected
// cards are eliminated only if there are no other targets" — but *which*
// primary cards get hit is still random when there are more of them than
// needed. Reuses the same seeded shuffle setupGame uses for dealing, so
// this is just as deterministic/replayable per seed. Works over plain ids
// (not CardInstance) so the President's own sentinel id can sit in
// `fallback` alongside real card ids — see applyRandomEliminateEffect.
function drawRandomTargets(
  rng: RngState,
  primary: readonly string[],
  fallback: readonly string[],
  count: number,
): { targetIds: string[]; rng: RngState } {
  if (primary.length >= count) {
    const shuffled = shuffle(rng, primary);
    return { targetIds: shuffled.items.slice(0, count), rng: shuffled.rng };
  }
  const remaining = count - primary.length;
  const shuffledFallback = shuffle(rng, fallback);
  const targetIds = [...primary, ...shuffledFallback.items.slice(0, remaining)];
  return { targetIds, rng: shuffledFallback.rng };
}

// The President isn't a CardInstance, so he can't appear in `state.cards`
// — this sentinel represents him within the same targetIds/eligible-set
// mechanism used for ordinary card targets, rather than needing a second
// parallel target-selection type. Exported so consumers (e.g. the bot
// package) can submit/recognize it without re-hardcoding the literal.
export const PRESIDENT_TARGET_ID = "president";

// Applies elimination to a single in-play card, honoring passive
// interception — the one place this actually happens, shared by every
// elimination path (a direct/random/self/binding eliminate effect, or a
// player-chosen Motorcade interception) so a passive can't be missed by
// forgetting to check it at some particular call site.
// - A replacement passive (Mr. Lucky) swaps the event for "return to
//   hand" entirely — the card never actually reaches the eliminated zone,
//   so no attribution/trigger applies either.
// - Otherwise the card is eliminated normally, attributed to
//   `eliminatedByPlayerId` (backing Master Assassin's win condition), and
//   a reactive passive (Celebrity/Martyr) additionally queues a
//   PendingPassiveTrigger — drained only once the whole top-level action
//   fully completes, see drainPendingPassives.
function eliminateCard(
  card: CardInstance,
  eliminatedByPlayerId: PlayerId | null,
): { card: CardInstance; trigger?: PendingPassiveTrigger } {
  const passive = getPassive(card.defRef);
  if (passive?.kind === "replacementOnElimination") {
    return { card: { ...card, zone: "hand" as const, locationId: undefined, faceUp: undefined } };
  }

  const attributedTo = eliminatedByPlayerId ?? card.controller!;
  const eliminated: CardInstance = {
    ...card,
    zone: "eliminated" as const,
    locationId: undefined,
    faceUp: undefined,
    eliminatedByPlayerId: attributedTo,
  };
  if (passive?.kind !== "reactiveOnElimination") {
    return { card: eliminated };
  }
  return {
    card: eliminated,
    trigger: {
      event: "eliminated",
      cardId: card.id,
      locationId: card.locationId!,
      scope: passive.scope,
      faction: passive.playFaction,
      triggeredByPlayerId: attributedTo,
      controllerPlayerId: card.controller!,
    },
  };
}

// Applies a single, already-finalized elimination target — either a card
// or the President sentinel. Every currently-encoded ability is
// count-exact-1, so "single" isn't a limitation in practice yet.
// `eliminatedByPlayerId` is whoever controls the *eliminating* card (not
// necessarily the acting player, under remote activation) — stamped once,
// backing Master Assassin's win condition (see CardInstance.eliminatedByPlayerId).
// Newly eliminating the President also starts the endgame countdown here,
// the one place his status actually transitions to "eliminated".
function eliminateSingleTarget(
  state: GameState,
  targetId: string,
  eliminatedByPlayerId: PlayerId | null,
): Pick<GameState, "cards" | "president" | "turn" | "pendingPassiveQueue"> {
  if (targetId === PRESIDENT_TARGET_ID) {
    return {
      cards: state.cards,
      president: {
        status: "eliminated",
        locationId: null,
        eliminatedAtLocationId: state.president.locationId ?? undefined,
        eliminatedByPlayerId: eliminatedByPlayerId ?? undefined,
      },
      // "Everyone, including whoever's turn is already in progress right
      // now, gets 3 more full turns" — the in-progress turn isn't cut
      // short and finishes normally, but doesn't itself count toward
      // anyone's 3 (a turn already underway when he dies isn't "following"
      // his elimination). Its own eventual endTurn still decrements this
      // counter once (applyEndTurn below, unconditionally, whenever
      // non-null) — the "+1" here exists purely to absorb that one free
      // decrement, so the 3*players.length turns that follow are exactly
      // 3 full turns for every player. See isGameOver in
      // effects/winConditions.ts, which reads this reaching 0.
      turn: { ...state.turn, endgameTurnsRemaining: 3 * state.players.length + 1 },
      pendingPassiveQueue: state.pendingPassiveQueue,
    };
  }
  const target = state.cards.find((c) => c.id === targetId)!;
  const { card: updated, trigger } = eliminateCard(target, eliminatedByPlayerId);
  return {
    president: state.president,
    turn: state.turn,
    cards: state.cards.map((c) => (c.id === targetId ? updated : c)),
    pendingPassiveQueue: trigger ? [...state.pendingPassiveQueue, trigger] : state.pendingPassiveQueue,
  };
}

// Applies a fully-resolved eliminate effect (target already finalized —
// either as originally declared, or reassigned by a protected-targeting
// window) and advances past the effect step that was awaiting it.
function finalizeEliminateEffect(state: GameState, frame: AbilityResolutionFrame, targetIds: readonly string[]): GameState {
  const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId)!;
  let next = state;
  for (const targetId of targetIds) {
    const { cards, president, turn, pendingPassiveQueue } = eliminateSingleTarget(next, targetId, sourceCard.controller);
    next = { ...next, cards, president, turn, pendingPassiveQueue };
  }
  return finishEffectStep(next, frame);
}

// Pops the current top resolution frame and, if that leaves a paused
// AlarmResolutionFrame as the new top, resumes it — see the comment below.
// Shared by every path that ends an ability's resolution entirely (the last
// effect in `finishEffectStep`, or targeting/remote-activation cancellation),
// since any of them could in principle be reached via a nested Response
// resolution.
function popCurrentFrame(state: GameState): GameState {
  return resumeAlarmIfPaused({ ...state, resolutionStack: state.resolutionStack.slice(0, -1) });
}

// If there's a next effect in this ability's sequence (Suicide Bomber:
// forced reveal, then random eliminate, then eliminate self), advance to it
// — reusing the same frame, effectIndex+1, targetIds reset to null — rather
// than popping. A plain ordered walk, no conditionals/bindings. Otherwise
// the whole ability is done: pop for real (and resume a paused alarm, if
// this was reached via a nested Response resolution).
function finishEffectStep(state: GameState, frame: AbilityResolutionFrame): GameState {
  const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId)!;
  const definition = getAbilityEffects(sourceCard.defRef, frame.abilityIndex)!;
  const nextIndex = (frame.effectIndex ?? 0) + 1;
  if (nextIndex < definition.effects.length) {
    const nextFrame: AbilityResolutionFrame = { ...frame, effectIndex: nextIndex, targetIds: null };
    return { ...state, resolutionStack: [...state.resolutionStack.slice(0, -1), nextFrame] };
  }
  return popCurrentFrame(state);
}

// If popping a frame leaves a paused AlarmResolutionFrame as the new top of
// the stack, this was a Response resolved via useResponse (not a top-level
// direct activation) — its target declaration pushed a pending
// AbilityResolutionFrame + reveal window *on top of* the still-paused
// alarm frame rather than advancing it. Now that the response (and any
// nested window/re-choice) is fully done, advance the pass — the response
// consumed its turn. A direct activation never has an AlarmResolutionFrame
// beneath its own frame at this point (its own alarm, if any, already
// resolved and popped *before* targets were chosen), so this is a no-op
// there.
function resumeAlarmIfPaused(state: GameState): GameState {
  const top = state.resolutionStack[state.resolutionStack.length - 1];
  if (top && top.kind === "alarmResolution") {
    return advanceAlarmPass(state, top);
  }
  return state;
}

// Single, non-repeating pass: starts after the declaring player, skips
// them and any player with no blended character at the location — see
// card_data.json's protected_targeting_rules.
function buildProtectedTargetingWindowFrame(
  state: GameState,
  locationId: string,
  declaringPlayerId: PlayerId,
  declaredTargetIds: readonly string[],
): ProtectedTargetingWindowFrame {
  const seats = state.players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
  const declarerSeat = seats.find((p) => p.id === declaringPlayerId)!.seatIndex;
  const n = seats.length;
  const rotated = Array.from(
    { length: n - 1 },
    (_, i) => seats.find((p) => p.seatIndex === (declarerSeat + i + 1) % n)!.id,
  );
  const order = rotated.filter((playerId) =>
    state.cards.some(
      (c) =>
        c.zone === "inPlay" && c.locationId === locationId && c.controller === playerId && c.faceUp === false,
    ),
  );
  return {
    kind: "protectedTargetingWindow",
    declaringPlayerId,
    declaredTargetIds,
    locationId,
    order,
    nextIndex: 0,
    anyRevealed: false,
  };
}

// If nobody reveals anything during the pass, the originally declared
// target stands. If *anyone* reveals *anything* — regardless of whether it
// would actually have protected the original target — the target is not
// automatically reassigned; instead control returns to the declaring
// player (AbilityResolutionFrame.reselectingAfterReveal) to freely
// re-choose from the now-current board, Protected and still-blended
// characters included, and that choice is final.
function applyProtectedTargetingWindowAction(
  state: GameState,
  frame: ProtectedTargetingWindowFrame,
  actingPlayerId: PlayerId,
  action: Action,
): GameState {
  const expectedPlayerId = frame.order[frame.nextIndex]!;
  if (actingPlayerId !== expectedPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn in this protected-targeting reveal pass`);
  }

  let cards = state.cards;
  let revealedThisTurn = false;
  if (action.type === "revealBlended") {
    for (const cardId of action.cardIds) {
      const card = state.cards.find((c) => c.id === cardId);
      if (
        !card ||
        card.zone !== "inPlay" ||
        card.controller !== actingPlayerId ||
        card.locationId !== frame.locationId ||
        card.faceUp !== false
      ) {
        throw new Error(`${cardId} is not a blended card ${actingPlayerId} controls at this location`);
      }
    }
    const revealSet = new Set(action.cardIds);
    cards = state.cards.map((c) => (revealSet.has(c.id) ? { ...c, faceUp: true } : c));
    revealedThisTurn = action.cardIds.length > 0;
  } else if (action.type !== "passReveal") {
    throw new Error(`Expected revealBlended or passReveal, got: ${action.type}`);
  }

  const anyRevealed = frame.anyRevealed || revealedThisTurn;
  const withCards = { ...state, cards };
  const nextIndex = frame.nextIndex + 1;
  if (nextIndex < frame.order.length) {
    const updatedFrame: ProtectedTargetingWindowFrame = { ...frame, nextIndex, anyRevealed };
    return { ...withCards, resolutionStack: [...withCards.resolutionStack.slice(0, -1), updatedFrame] };
  }

  const abilityFrame = withCards.resolutionStack[withCards.resolutionStack.length - 2] as AbilityResolutionFrame;
  if (!anyRevealed) {
    const withoutWindow = { ...withCards, resolutionStack: [...withCards.resolutionStack.slice(0, -2), abilityFrame] };
    return finalizeEliminateEffect(withoutWindow, abilityFrame, frame.declaredTargetIds);
  }

  const reselectFrame: AbilityResolutionFrame = {
    ...abilityFrame,
    targetIds: null,
    reselectingAfterReveal: true,
  };
  return { ...withCards, resolutionStack: [...withCards.resolutionStack.slice(0, -2), reselectFrame] };
}

// "exact"/"range" counts are clamped to however many candidates are
// *actually* eligible right now, not the card text's nominal number —
// matching countToPick (bots/decide.ts) and isTrivialSelection
// (client/targetDecision.ts), which already assume this leniency. Without
// it, an alarm-tagged multi-target ability (Master Assassin's "eliminate
// exactly 2", say) has a real gap: abilityHasAvailableFirstTarget can only
// verify the pool size *at activation*, but the actual chooseTargets
// submission happens only after the alarm-response window fully resolves
// — and a Response during that window can eliminate one of the very
// candidates being counted on, shrinking the pool by the time targets are
// finally chosen. A bot's own countToPick already degrades gracefully to
// whatever's left; the engine's own validation should accept that, not
// reject it as if the original (now-impossible) count were still owed.
function validateTargets(count: TargetCount, targetIds: readonly string[], eligibleIds: readonly string[]): void {
  const eligibleSet = new Set(eligibleIds);
  if (count.mode === "exact") {
    const required = Math.min(count.value, eligibleIds.length);
    if (targetIds.length !== required) {
      throw new Error(`This ability requires exactly ${required} target(s)`);
    }
  }
  if (count.mode === "range") {
    const max = Math.min(count.max, eligibleIds.length);
    const min = Math.min(count.min, max);
    if (targetIds.length < min || targetIds.length > max) {
      throw new Error(`This ability requires between ${min} and ${max} target(s)`);
    }
  }
  if (count.mode === "all" && targetIds.length !== eligibleIds.length) {
    throw new Error("This ability requires selecting every eligible target");
  }
  // "unbounded": any subset, including none, is fine — no count check.
  for (const targetId of targetIds) {
    if (!eligibleSet.has(targetId)) {
      throw new Error(`${targetId} is not a legal target for this ability`);
    }
  }
}

function applyAlarmAction(
  state: GameState,
  cardData: CardData,
  frame: AlarmResolutionFrame,
  actingPlayerId: PlayerId,
  action: Action,
): GameState {
  const expectedPlayerId = frame.order[frame.nextIndex]!;
  if (actingPlayerId !== expectedPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn to respond to this alarm`);
  }

  if (action.type === "passResponse") {
    return advanceAlarmPass(state, frame);
  }
  if (action.type !== "useResponse") {
    throw new Error(`Expected useResponse or passResponse during an alarm, got: ${action.type}`);
  }

  const card = state.cards.find((c) => c.id === action.cardId);
  if (!card) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  if (card.id === frame.triggeringCardId) {
    throw new Error("The character that triggered the alarm cannot itself respond");
  }
  if (card.zone !== "inPlay" || card.controller !== actingPlayerId || card.locationId !== frame.locationId) {
    throw new Error(`${action.cardId} is not a card ${actingPlayerId} controls at this alarm's location`);
  }

  const rawAbility = getAbilities(cardData, card)[action.abilityIndex];
  if (!rawAbility || rawAbility.type !== "Response") {
    throw new Error(`${card.defRef} has no Response ability at index ${action.abilityIndex}`);
  }
  const effects = getAbilityEffects(card.defRef, action.abilityIndex);
  if (!effects) {
    throw new Error(`${card.defRef}'s Response ability has no encoded effects yet`);
  }
  const effect = effects.effects[0];
  if (!effect || effect.verb !== "eliminate" || effects.effects.length > 1) {
    throw new Error("Only single-effect eliminate Responses are interpreted so far");
  }

  // Must reveal to respond — unconditional, same principle as activating.
  const revealedCards = state.cards.map((c) => (c.id === card.id ? { ...c, faceUp: true } : c));
  const withReveal = { ...state, cards: revealedCards };

  const declared = declareEliminateTargets(withReveal, cardData, effect, card, actingPlayerId, action.targetIds);

  if (declared.protectedActive && hasRevealOpportunity(withReveal, declared.locationId, actingPlayerId)) {
    // Pause the alarm pass — frame stays exactly as-is, nextIndex
    // unchanged — while a nested reveal window (and any resulting
    // re-choice) resolves on top of it. Resumed by resumeAlarmIfPaused
    // once the pending response finally finishes; see finalizeEliminateEffect.
    const pendingFrame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: card.id,
      actingPlayerId,
      abilityIndex: action.abilityIndex,
      locationId: declared.locationId,
      targetIds: declared.targetIds,
    };
    const windowFrame = buildProtectedTargetingWindowFrame(
      withReveal,
      declared.locationId,
      actingPlayerId,
      declared.targetIds,
    );
    return { ...withReveal, resolutionStack: [...withReveal.resolutionStack, pendingFrame, windowFrame] };
  }

  let resolvedState: GameState = withReveal;
  for (const targetId of declared.targetIds) {
    const { cards, president, turn, pendingPassiveQueue } = eliminateSingleTarget(
      resolvedState,
      targetId,
      card.controller,
    );
    resolvedState = { ...resolvedState, cards, president, turn, pendingPassiveQueue };
  }
  return advanceAlarmPass(resolvedState, frame);
}

function advanceAlarmPass(state: GameState, frame: AlarmResolutionFrame): GameState {
  const nextIndex = frame.nextIndex + 1;
  if (nextIndex < frame.order.length) {
    const updatedFrame: AlarmResolutionFrame = { ...frame, nextIndex };
    return { ...state, resolutionStack: [...state.resolutionStack.slice(0, -1), updatedFrame] };
  }

  // The pass is complete. "If the triggering character is eliminated by a
  // response, the rest of the original ability does not resolve" — cancel
  // the AbilityResolutionFrame beneath too in that case; otherwise leave it
  // for the next chooseTargets call now that the alarm has resolved.
  const triggeringCard = state.cards.find((c) => c.id === frame.triggeringCardId);
  const triggeringCardSurvived = triggeringCard !== undefined && triggeringCard.zone !== "eliminated";
  return { ...state, resolutionStack: triggeringCardSurvived ? state.resolutionStack.slice(0, -1) : [] };
}
