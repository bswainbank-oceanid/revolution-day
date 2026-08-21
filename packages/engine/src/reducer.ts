import type { Action } from "./actions";
import { getAbilityEffects } from "./data/abilityEffects";
import { resolveEligibleTargets } from "./effects/targeting";
import { adjacentLocationIds } from "./state/board";
import { getAbilities, getAllowedLocationTypes, hasAttribute } from "./state/cardLookup";
import type { CardInstance } from "./state/cards";
import type { GameState, PlayerId } from "./state/game";
import type { AbilityResolutionFrame } from "./state/resolution";
import type { CardData } from "./types";

// The reducer: (state, action) -> newState. Pure — no I/O, no hidden
// randomness (the RNG lives in and is advanced through GameState itself).
// cardData is passed explicitly (not imported as a singleton) so a future
// variant's card set works unmodified, same as setupGame. "draw", "endTurn",
// "moveCard", "playCard", "playMotorcade", and a first slice of
// "activateAbility"/"chooseTargets" are implemented so far; everything
// else is an explicit "not yet implemented".
//
// playMotorcade is deliberately incomplete in two ways, both noted inline:
// it doesn't yet check for a Throng of Admirers/Angry Mob interception
// (needs resolution-stack frame dispatch), and it doesn't implement the
// forced "must play immediately" trigger on an empty deck (same gap
// already noted in applyDraw). activateAbility only handles non-alarm,
// single-target `eliminate` abilities that have been encoded in
// abilityEffects.ts (currently just Republican Guard and Assassin) — no
// alarm resolution, no remote-activation, no Protected-immunity
// enforcement yet. See rev_day_engine_design memory for the full design
// this is incrementally building toward.
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

// Dispatches to whatever the top resolution-stack frame expects next. Only
// "abilityResolution" is handled so far — the other three frame kinds
// (alarm response, protected-targeting reveal, Motorcade interception)
// have no dispatch logic yet, since nothing can push them onto the stack
// yet either.
function applyResolutionAction(
  state: GameState,
  actingPlayerId: PlayerId,
  action: Action,
  cardData: CardData,
): GameState {
  const frame = state.resolutionStack[state.resolutionStack.length - 1]!;
  switch (frame.kind) {
    case "abilityResolution":
      if (action.type !== "chooseTargets") {
        throw new Error(`Expected chooseTargets while an ability awaits targets, got: ${action.type}`);
      }
      return applyChooseTargets(state, cardData, frame, actingPlayerId, action);
    default:
      throw new Error(`Resolution frame not yet implemented: ${frame.kind}`);
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

  // Does not yet check for a Throng of Admirers/Angry Mob interception —
  // that needs resolution-stack frame dispatch (MotorcadeInterceptionWindowFrame),
  // not built yet. See rev_day_engine_design memory for the full design.
  let cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, zone: "discard" as const, controller: null } : c,
  );
  let president = state.president;

  if (president.status === "eliminated") {
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
  } else if (president.status === "alive") {
    const currentIndex = state.board.findIndex((l) => l.id === president.locationId);
    const nextIndex = currentIndex + 1;
    if (nextIndex >= state.board.length) {
      // Advancing past the last location: the President survives and the
      // game ends immediately. Nothing yet enforces "no further actions
      // once the game has ended" — that's deferred to the win-condition
      // evaluator, not built yet.
      president = { status: "survived", locationId: null };
    } else {
      president = { status: "alive", locationId: state.board[nextIndex]!.id };
    }
  }
  // status === "survived": Motorcade text has nothing left to do; the card
  // still gets discarded and the action still gets spent above.

  return { ...state, cards, president, turn: spendAction(state) };
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
  if (rawAbility.alarm) {
    throw new Error("Alarm-triggering abilities are not yet implemented (needs AlarmResolutionFrame)");
  }

  const effects = getAbilityEffects(card.defRef, action.abilityIndex);
  if (!effects) {
    throw new Error(`${card.defRef}'s ability ${action.abilityIndex} has no encoded effects yet`);
  }

  const frame: AbilityResolutionFrame = {
    kind: "abilityResolution",
    sourceCardId: card.id,
    actingPlayerId: currentPlayerId,
    abilityIndex: action.abilityIndex,
    locationId: card.locationId,
    targetIds: null,
  };

  return {
    ...state,
    resolutionStack: [frame],
    turn: { ...spendAction(state), usedAbilities: [...state.turn.usedAbilities, usageKey] },
  };
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
  // This first slice only interprets a single top-level `eliminate` effect
  // — not the general recursive interpreter (conditionals, bindings,
  // sequencing) the DSL is designed for. Extend when an encoded ability
  // needs more than that.
  const effect = definition.effects[0];
  if (!effect || effect.verb !== "eliminate" || definition.effects.length > 1) {
    throw new Error("Only single-effect eliminate abilities are interpreted so far");
  }
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }

  const eligible = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
  const eligibleIds = new Set(eligible.map((c) => c.id));
  const requiredCount = effect.target.count.mode === "exact" ? effect.target.count.value : undefined;
  if (requiredCount !== undefined && action.targetIds.length !== requiredCount) {
    throw new Error(`This ability requires exactly ${requiredCount} target(s)`);
  }
  for (const targetId of action.targetIds) {
    if (!eligibleIds.has(targetId)) {
      throw new Error(`${targetId} is not a legal target for this ability`);
    }
  }

  const targetSet = new Set(action.targetIds);
  const cards: readonly CardInstance[] = state.cards.map((c) =>
    targetSet.has(c.id) ? { ...c, zone: "eliminated" as const, locationId: undefined, faceUp: undefined } : c,
  );

  return { ...state, cards, resolutionStack: [] };
}
