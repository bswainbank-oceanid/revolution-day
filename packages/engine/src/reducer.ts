import type { Action } from "./actions";
import { getAbilityEffects } from "./data/abilityEffects";
import type { EffectNode, TargetCount } from "./effects/dsl";
import {
  hasRevealOpportunity,
  isLegalEliminationTarget,
  isLegalPresidentTarget,
  isProtectedActive,
  resolveEligibleHandCards,
  resolveEligibleTargets,
} from "./effects/targeting";
import { adjacentLocationIds } from "./state/board";
import type { BoardLayout } from "./state/board";
import { getAbilities, getAllowedLocationTypes, hasAttribute } from "./state/cardLookup";
import type { CardInstance } from "./state/cards";
import type { GameState, PlayerId, PresidentState } from "./state/game";
import type {
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  MotorcadeInterceptionWindowFrame,
  ProtectedTargetingWindowFrame,
  ResolutionFrame,
} from "./state/resolution";
import type { CardData } from "./types";

// The reducer: (state, action) -> newState. Pure — no I/O, no hidden
// randomness (the RNG lives in and is advanced through GameState itself).
// cardData is passed explicitly (not imported as a singleton) so a future
// variant's card set works unmodified, same as setupGame. "draw", "endTurn",
// "moveCard", "playCard", "playMotorcade" (including the Motorcade
// interception window), "activateAbility"/"chooseTargets" (alarm-triggering
// abilities, remote-activation including Commander General's "any number"
// queue, `eliminate`/`reveal`/`play` effects), and "useResponse"/
// "passResponse" (including a nested protected-targeting reveal window
// during an alarm's response pass) are all implemented; everything else is
// an explicit "not yet implemented".
//
// Remaining known gaps, all noted inline where relevant: playMotorcade
// doesn't implement the forced "must play immediately" trigger on an empty
// deck (same gap noted in applyDraw). chooseTargets only interprets a
// single top-level effect per ability — no general multi-effect/
// conditional interpreter (`if`/bindings) yet — and no random target
// selection (Suicide Bomber's pool/fallback). See rev_day_engine_design
// memory for the full design this is incrementally building toward.
export function applyAction(
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
      return applyPlayMotorcade(state, action);
    case "activateAbility":
      return applyActivateAbility(state, cardData, action);
    default:
      throw new Error(`Action not yet implemented: ${action.type}`);
  }
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
    default:
      // All four ResolutionFrame kinds are handled above — this is
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

function spendAction(state: GameState): GameState["turn"] {
  return { ...state.turn, actionsRemaining: state.turn.actionsRemaining - 1 };
}

function applyDraw(state: GameState): GameState {
  const deckIndex = state.cards.findIndex((c) => c.zone === "deck");
  if (deckIndex === -1) {
    throw new Error("Cannot draw: deck is empty (forced Motorcade-play handling not yet implemented)");
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

  // Provisional: decrements once per completed turn, once non-null.
  // "Every player (including the current player) gets three more turns"
  // could mean per-round or per-individual-turn — nothing can set this
  // non-null yet (President elimination isn't implemented), so the exact
  // semantics aren't testable yet either. Revisit alongside that work.
  const endgameTurnsRemaining =
    state.turn.endgameTurnsRemaining === null ? null : Math.max(0, state.turn.endgameTurnsRemaining - 1);

  return {
    ...state,
    players,
    turn: {
      currentPlayerId: nextPlayerId,
      phase: "draw",
      actionsRemaining: 2,
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
  requireBudgetedAction(state);

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
  const allowedTypes = getAllowedLocationTypes(cardData, card);
  if (!allowedTypes.includes(location.type)) {
    throw new Error(
      `${card.defRef} cannot be played at a ${location.type} location (allowed: ${allowedTypes.join(", ")})`,
    );
  }

  // Blend-attribute cards always enter play face-down automatically —
  // never a player choice, same principle as moveCard's auto-reblend.
  const faceUp = !hasAttribute(cardData, card, "Blend");

  const cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, zone: "inPlay" as const, locationId: action.locationId, faceUp } : c,
  );

  return { ...state, cards, turn: spendAction(state) };
}

function applyPlayMotorcade(
  state: GameState,
  action: Extract<Action, { type: "playMotorcade" }>,
): GameState {
  requireBudgetedAction(state);

  const currentPlayerId = state.turn.currentPlayerId;
  const player = state.players.find((p) => p.id === currentPlayerId)!;
  if (!player.hasTakenFirstTurn) {
    throw new Error("Motorcade cannot be played on a player's first turn");
  }

  const cardIndex = state.cards.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  const card = state.cards[cardIndex]!;
  if (card.kind !== "motorcade" || card.zone !== "hand" || card.controller !== currentPlayerId) {
    throw new Error(`Card ${action.cardId} is not a Motorcade in ${currentPlayerId}'s hand`);
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
      return { ...state, cards, resolutionStack: [windowFrame], turn: spendAction(state) };
    }
    president = computeForwardMove(state.board, president);
  } else if (president.status === "eliminated") {
    // "After the President has been eliminated, move a card you control to
    // any location" — ignores location-type restrictions, per the general
    // ruling that effects specifying a location for placement do so.
    if (!action.moveOwnCardId || !action.moveToLocationId) {
      throw new Error("Must specify a card and destination to move after the President's elimination");
    }
    const moveIndex = cards.findIndex((c) => c.id === action.moveOwnCardId);
    if (moveIndex === -1) {
      throw new Error(`Unknown card: ${action.moveOwnCardId}`);
    }
    const moving = cards[moveIndex]!;
    if (moving.zone !== "inPlay" || moving.controller !== currentPlayerId) {
      throw new Error(`Card ${action.moveOwnCardId} is not controlled by ${currentPlayerId}`);
    }
    if (!state.board.some((l) => l.id === action.moveToLocationId)) {
      throw new Error(`Unknown location: ${action.moveToLocationId}`);
    }
    cards = cards.map((c, i) => (i === moveIndex ? { ...c, locationId: action.moveToLocationId } : c));
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
  // still gets discarded and the action still gets spent above.

  return { ...state, cards, president, turn: spendAction(state) };
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

// Throng of Admirers and Angry Mob are the only two cards with this
// passive — matched by name rather than a structured passive DSL, since
// passives (unlike abilities and win conditions) don't have one yet; see
// rev_day_engine_design memory.
const MOTORCADE_INTERCEPTOR_DEFREFS = new Set(["Throng of Admirers", "Angry Mob"]);

function findMotorcadeInterceptors(cards: readonly CardInstance[], presidentLocationId: string): CardInstance[] {
  return cards.filter(
    (c) =>
      c.zone === "inPlay" && c.locationId === presidentLocationId && MOTORCADE_INTERCEPTOR_DEFREFS.has(c.defRef),
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
      !MOTORCADE_INTERCEPTOR_DEFREFS.has(card.defRef)
    ) {
      throw new Error(`${action.cardId} cannot intercept this Motorcade`);
    }
    const cards = state.cards.map((c) =>
      c.id === card.id ? { ...c, zone: "eliminated" as const, locationId: undefined, faceUp: undefined } : c,
    );
    // The move is cancelled — the President's status/location are simply
    // left unchanged.
    return { ...state, cards, resolutionStack: state.resolutionStack.slice(0, -1) };
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
  return { ...state, president, resolutionStack: state.resolutionStack.slice(0, -1) };
}

function applyActivateAbility(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "activateAbility" }>,
): GameState {
  requireBudgetedAction(state);

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
  const resolutionStack: ResolutionFrame[] = rawAbility.alarm
    ? [abilityFrame, buildAlarmFrame(state, card.id, currentPlayerId, card.locationId)]
    : [abilityFrame];

  return {
    ...state,
    cards,
    resolutionStack,
    turn: { ...spendAction(state), usedAbilities: [...state.turn.usedAbilities, usageKey] },
  };
}

// Seating order for an alarm's response pass: starts with the player after
// the triggering (acting) player, wraps around, ends with the triggering
// player — everyone gets a turn, no skipping (contrast the
// protected-targeting reveal window, not built yet, which does skip).
function buildAlarmFrame(
  state: GameState,
  triggeringCardId: string,
  triggeringPlayerId: PlayerId,
  locationId: string,
): AlarmResolutionFrame {
  const seats = state.players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
  const triggerSeat = seats.find((p) => p.id === triggeringPlayerId)!.seatIndex;
  const n = seats.length;
  const order = Array.from({ length: n }, (_, i) => {
    const seat = (triggerSeat + i + 1) % n;
    return seats.find((p) => p.seatIndex === seat)!.id;
  });
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
  const effect = definition.effects[0];
  if (!effect || definition.effects.length > 1) {
    throw new Error("Only single-effect abilities are interpreted so far");
  }

  if (effect.verb === "activateRemote") {
    return applyActivateRemote(
      state,
      cardData,
      frame,
      sourceCard,
      effect,
      actingPlayerId,
      action.targetIds,
      action.remoteAbilityIndex,
    );
  }
  if (effect.verb === "reveal") {
    return applyRevealEffect(state, cardData, sourceCard, effect, action.targetIds);
  }
  if (effect.verb === "play") {
    return applyPlayEffect(state, cardData, sourceCard, actingPlayerId, effect, action.targetIds);
  }
  if (effect.verb !== "eliminate") {
    throw new Error(`Effect verb not yet interpreted: ${effect.verb}`);
  }
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }

  // A target chosen after a reveal window already ran once this
  // resolution bypasses Protected-immunity entirely (no window, ever) —
  // that re-choice is final by design, not a fresh declaration.
  const declared = declareEliminateTarget(
    state,
    cardData,
    effect,
    sourceCard,
    actingPlayerId,
    action.targetIds,
    frame.reselectingAfterReveal ?? false,
  );

  if (declared.protectedActive && hasRevealOpportunity(state, declared.locationId, actingPlayerId)) {
    const updatedFrame: AbilityResolutionFrame = { ...frame, targetIds: [declared.targetId] };
    const windowFrame = buildProtectedTargetingWindowFrame(
      state,
      declared.locationId,
      actingPlayerId,
      declared.targetId,
    );
    return {
      ...state,
      resolutionStack: [...state.resolutionStack.slice(0, -1), updatedFrame, windowFrame],
    };
  }

  return finalizeEliminateEffect(state, declared.targetId);
}

// Validates a declared target (either a card or the President sentinel)
// against the ability's selector, and reports whether Protected-immunity
// is currently active for it — shared by direct ability resolution
// (chooseTargets) and a Response's inline target declaration
// (useResponse), since both are "declare a target for an eliminate
// effect" at heart. bypassProtectionOverride covers both a post-reveal
// re-choice (reselectingAfterReveal) and the DSL's own ignoreProtected —
// either way, the guard-protection check (not the two-player rule, for
// president targets) is skipped entirely.
function declareEliminateTarget(
  state: GameState,
  cardData: CardData,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
  actingCard: CardInstance,
  actingPlayerId: PlayerId,
  targetIds: readonly string[],
  bypassProtectionOverride: boolean,
): { targetId: string; locationId: string; protectedActive: boolean } {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  const bypassProtection = (effect.ignoreProtected ?? false) || bypassProtectionOverride;

  if (effect.target.kind === "president") {
    const legal = isLegalPresidentTarget(state, cardData, actingPlayerId, bypassProtection);
    validateTargets(effect.target.count, targetIds, legal ? [PRESIDENT_TARGET_ID] : []);
    return {
      targetId: PRESIDENT_TARGET_ID,
      locationId: state.president.locationId!,
      // The President has no Blend attribute, so his Protected status is
      // always active while alive.
      protectedActive: !bypassProtection && state.president.status === "alive",
    };
  }

  const eligible = resolveEligibleTargets(state, cardData, effect.target, actingCard).filter(
    (c) => bypassProtection || isLegalEliminationTarget(state, cardData, c, actingPlayerId),
  );
  validateTargets(
    effect.target.count,
    targetIds,
    eligible.map((c) => c.id),
  );
  const targetId = targetIds[0]!;
  const declaredCard = state.cards.find((c) => c.id === targetId)!;
  return {
    targetId,
    locationId: declaredCard.locationId!,
    protectedActive: !bypassProtection && isProtectedActive(cardData, declaredCard),
  };
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
    return popCurrentFrame(state); // "no more" — done choosing.
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
  if (!getAbilityEffects(remoteCard.defRef, remoteAbilityIndex)) {
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
  const newFrames: ResolutionFrame[] = rawAbility.alarm
    ? [newAbilityFrame, buildAlarmFrame(state, remoteCard.id, actingPlayerId, remoteCard.locationId)]
    : [newAbilityFrame];
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
  cardData: CardData,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "reveal" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  if (effect.target.count.mode !== "all") {
    throw new Error("Only 'reveal all' is interpreted so far");
  }
  if (targetIds.length > 0) {
    throw new Error("This ability reveals everyone matching automatically — no targets to choose");
  }

  const toReveal = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
  const revealSet = new Set(toReveal.map((c) => c.id));
  const cards = state.cards.map((c) => (revealSet.has(c.id) ? { ...c, faceUp: true } : c));
  return popCurrentFrame({ ...state, cards });
}

// "Play any number of regime cards at this location" (Commander General)
// — unlike activateRemote's unbounded variant, this needs no per-card
// follow-up decision, so the whole chosen set is submitted and applied in
// one chooseTargets call rather than a queue. Selects from the acting
// player's *hand* (resolveEligibleHandCards), not state.cards' in-play
// pool. Blend-attribute cards still always enter play face-down
// automatically, same principle as the playCard action.
function applyPlayEffect(
  state: GameState,
  cardData: CardData,
  sourceCard: CardInstance,
  actingPlayerId: PlayerId,
  effect: Extract<EffectNode, { verb: "play" }>,
  targetIds: readonly string[],
): GameState {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  if (effect.location.mode !== "self") {
    throw new Error("Only location: self is interpreted so far");
  }
  const locationId = sourceCard.locationId!;

  const eligible = resolveEligibleHandCards(state, cardData, effect.target, actingPlayerId);
  validateTargets(
    effect.target.count,
    targetIds,
    eligible.map((c) => c.id),
  );

  const targetSet = new Set(targetIds);
  const cards = state.cards.map((c) => {
    if (!targetSet.has(c.id)) return c;
    const faceUp = !hasAttribute(cardData, c, "Blend");
    return { ...c, zone: "inPlay" as const, locationId, faceUp };
  });
  return popCurrentFrame({ ...state, cards });
}

// The President isn't a CardInstance, so he can't appear in `state.cards`
// — this sentinel represents him within the same targetIds/eligible-set
// mechanism used for ordinary card targets, rather than needing a second
// parallel target-selection type.
const PRESIDENT_TARGET_ID = "president";

// Applies a single, already-finalized elimination target — either a card
// or the President sentinel. Every currently-encoded ability is
// count-exact-1, so "single" isn't a limitation in practice yet.
function eliminateSingleTarget(state: GameState, targetId: string): Pick<GameState, "cards" | "president"> {
  if (targetId === PRESIDENT_TARGET_ID) {
    return {
      cards: state.cards,
      president: {
        status: "eliminated",
        locationId: null,
        eliminatedAtLocationId: state.president.locationId ?? undefined,
      },
    };
  }
  return {
    president: state.president,
    cards: state.cards.map((c) =>
      c.id === targetId ? { ...c, zone: "eliminated" as const, locationId: undefined, faceUp: undefined } : c,
    ),
  };
}

// Applies a fully-resolved eliminate effect (target already finalized —
// either as originally declared, or reassigned by a protected-targeting
// window) and pops the AbilityResolutionFrame that was awaiting it.
function finalizeEliminateEffect(state: GameState, targetId: string): GameState {
  const { cards, president } = eliminateSingleTarget(state, targetId);
  return popCurrentFrame({ ...state, cards, president });
}

// Pops the current top resolution frame and, if that leaves a paused
// AlarmResolutionFrame as the new top, resumes it — see the comment below.
// Shared by every effect-finalization path (eliminate, reveal, play, the
// "no more" end of an activateRemote queue, ...), since any of them could
// in principle be reached via a nested Response resolution.
function popCurrentFrame(state: GameState): GameState {
  return resumeAlarmIfPaused({ ...state, resolutionStack: state.resolutionStack.slice(0, -1) });
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
  declaredTargetId: string,
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
    declaredTargetId,
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
    return finalizeEliminateEffect(withoutWindow, frame.declaredTargetId);
  }

  const reselectFrame: AbilityResolutionFrame = {
    ...abilityFrame,
    targetIds: null,
    reselectingAfterReveal: true,
  };
  return { ...withCards, resolutionStack: [...withCards.resolutionStack.slice(0, -2), reselectFrame] };
}

function validateTargets(count: TargetCount, targetIds: readonly string[], eligibleIds: readonly string[]): void {
  const eligibleSet = new Set(eligibleIds);
  if (count.mode === "exact" && targetIds.length !== count.value) {
    throw new Error(`This ability requires exactly ${count.value} target(s)`);
  }
  if (count.mode === "range" && (targetIds.length < count.min || targetIds.length > count.max)) {
    throw new Error(`This ability requires between ${count.min} and ${count.max} target(s)`);
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

  const declared = declareEliminateTarget(
    withReveal,
    cardData,
    effect,
    card,
    actingPlayerId,
    action.targetIds,
    false,
  );

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
      targetIds: [declared.targetId],
    };
    const windowFrame = buildProtectedTargetingWindowFrame(
      withReveal,
      declared.locationId,
      actingPlayerId,
      declared.targetId,
    );
    return { ...withReveal, resolutionStack: [...withReveal.resolutionStack, pendingFrame, windowFrame] };
  }

  const { cards, president } = eliminateSingleTarget(withReveal, declared.targetId);
  return advanceAlarmPass({ ...withReveal, cards, president }, frame);
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
