import type { Action } from "./actions";
import { adjacentLocationIds } from "./state/board";
import { hasAttribute } from "./state/cardLookup";
import type { GameState, PlayerId } from "./state/game";
import type { CardData } from "./types";

// The reducer: (state, action) -> newState. Pure — no I/O, no hidden
// randomness (the RNG lives in and is advanced through GameState itself).
// cardData is passed explicitly (not imported as a singleton) so a future
// variant's card set works unmodified, same as setupGame. Only "draw",
// "endTurn", and "moveCard" are implemented so far; everything else is an
// explicit "not yet implemented" until the resolution stack and effect
// interpreter are built out.
export function applyAction(
  state: GameState,
  actingPlayerId: PlayerId,
  action: Action,
  cardData: CardData,
): GameState {
  if (state.resolutionStack.length > 0) {
    throw new Error(
      `Resolution-stack actions are not yet implemented (top frame pending, action: ${action.type})`,
    );
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
    default:
      throw new Error(`Action not yet implemented: ${action.type}`);
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

  const currentSeat = state.players.find((p) => p.id === state.turn.currentPlayerId)!.seatIndex;
  const nextSeat = (currentSeat + 1) % state.players.length;
  const nextPlayerId = state.players.find((p) => p.seatIndex === nextSeat)!.id;

  // Provisional: decrements once per completed turn, once non-null.
  // "Every player (including the current player) gets three more turns"
  // could mean per-round or per-individual-turn — nothing can set this
  // non-null yet (President elimination isn't implemented), so the exact
  // semantics aren't testable yet either. Revisit alongside that work.
  const endgameTurnsRemaining =
    state.turn.endgameTurnsRemaining === null ? null : Math.max(0, state.turn.endgameTurnsRemaining - 1);

  return {
    ...state,
    turn: {
      currentPlayerId: nextPlayerId,
      phase: "draw",
      actionsRemaining: 2,
      endgameTurnsRemaining,
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
