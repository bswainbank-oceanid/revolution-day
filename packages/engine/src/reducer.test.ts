import { describe, expect, it } from "vitest";
import { cardData } from "./data/cardData";
import { applyAction } from "./reducer";
import type { Action } from "./actions";
import type { GameState, PlayerId } from "./state/game";
import { setupGame } from "./setup";

function freshGame(playerIds: readonly string[] = ["a", "b", "c"], seed = 1) {
  return setupGame({ playerIds, seed, cardData });
}

// Curries in cardData so individual tests don't have to repeat it.
function act(state: GameState, player: PlayerId, action: Action): GameState {
  return applyAction(state, player, action, cardData);
}

// Test-only helper: places a card directly in play, bypassing playCard
// (not implemented yet) so moveCard can be exercised in isolation.
function placeInPlay(
  state: GameState,
  cardId: string,
  locationId: string,
  controller: PlayerId,
  faceUp = true,
): GameState {
  return {
    ...state,
    cards: state.cards.map((c) =>
      c.id === cardId ? { ...c, zone: "inPlay" as const, locationId, controller, faceUp } : c,
    ),
  };
}

describe("applyAction: draw", () => {
  it("performs the mandatory draw-phase draw without spending a budgeted action", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const before = state.cards.filter((c) => c.zone === "hand" && c.controller === player).length;

    const next = act(state, player, { type: "draw" });

    expect(next.turn.phase).toBe("action");
    expect(next.turn.actionsRemaining).toBe(2);
    const after = next.cards.filter((c) => c.zone === "hand" && c.controller === player).length;
    expect(after).toBe(before + 1);
  });

  it("spends a budgeted action when drawing during the action phase", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const afterMandatory = act(state, player, { type: "draw" });

    const next = act(afterMandatory, player, { type: "draw" });

    expect(next.turn.phase).toBe("action");
    expect(next.turn.actionsRemaining).toBe(1);
  });

  it("rejects a draw from a player whose turn it isn't", () => {
    const state = freshGame();
    const other = state.players.find((p) => p.id !== state.turn.currentPlayerId)!.id;
    expect(() => act(state, other, { type: "draw" })).toThrow();
  });

  it("throws on an empty deck rather than silently no-op-ing", () => {
    const state = freshGame();
    const emptyDeck = { ...state, cards: state.cards.filter((c) => c.zone !== "deck") };
    expect(() => act(emptyDeck, state.turn.currentPlayerId, { type: "draw" })).toThrow();
  });
});

describe("applyAction: endTurn", () => {
  it("rejects ending the turn before the mandatory draw", () => {
    const state = freshGame();
    expect(() => act(state, state.turn.currentPlayerId, { type: "endTurn" })).toThrow();
  });

  it("rotates to the next seat, resets phase and budget", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const afterDraw = act(state, player, { type: "draw" });

    const next = act(afterDraw, player, { type: "endTurn" });

    const currentSeat = state.players.find((p) => p.id === player)!.seatIndex;
    const expectedNextPlayer = state.players.find(
      (p) => p.seatIndex === (currentSeat + 1) % state.players.length,
    )!.id;
    expect(next.turn.currentPlayerId).toBe(expectedNextPlayer);
    expect(next.turn.phase).toBe("draw");
    expect(next.turn.actionsRemaining).toBe(2);
  });

  it("wraps seating order back to the first player", () => {
    let state = freshGame(["a", "b", "c"]);
    for (let i = 0; i < 3; i++) {
      state = act(state, state.turn.currentPlayerId, { type: "draw" });
      state = act(state, state.turn.currentPlayerId, { type: "endTurn" });
    }
    expect(state.players.map((p) => p.id)).toContain(state.turn.currentPlayerId);
  });

  it("never lets a voluntary action-phase draw exceed the budget", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    let s = act(state, player, { type: "draw" }); // mandatory
    s = act(s, player, { type: "draw" }); // 1st budgeted
    s = act(s, player, { type: "draw" }); // 2nd budgeted
    expect(s.turn.actionsRemaining).toBe(0);
    expect(() => act(s, player, { type: "draw" })).toThrow();
  });
});

describe("applyAction: moveCard", () => {
  it("moves a controlled card to an adjacent location and spends an action", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const [origin, adjacent] = state.board;
    const card = state.cards.find((c) => c.zone === "deck")!;
    state = placeInPlay(state, card.id, origin!.id, player, false);
    state = act(state, player, { type: "draw" }); // enter action phase

    const next = act(state, player, { type: "moveCard", cardId: card.id, toLocationId: adjacent!.id });

    const moved = next.cards.find((c) => c.id === card.id)!;
    expect(moved.locationId).toBe(adjacent!.id);
    expect(next.turn.actionsRemaining).toBe(1);
  });

  it("rejects moving to a non-adjacent location", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const farLocation = state.board.at(-1)!;
    const card = state.cards.find((c) => c.zone === "deck")!;
    state = placeInPlay(state, card.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "moveCard", cardId: card.id, toLocationId: farLocation.id }),
    ).toThrow();
  });

  it("rejects moving a card you don't control", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const [origin, adjacent] = state.board;
    const card = state.cards.find((c) => c.zone === "deck")!;
    state = placeInPlay(state, card.id, origin!.id, other);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "moveCard", cardId: card.id, toLocationId: adjacent!.id }),
    ).toThrow();
  });

  it("automatically re-blends a revealed Blend character on arrival — never a choice", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const [origin, adjacent] = state.board;
    // Gunman has the Blend attribute.
    const card = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    state = placeInPlay(state, card.id, origin!.id, player, true);
    state = act(state, player, { type: "draw" });

    const next = act(state, player, { type: "moveCard", cardId: card.id, toLocationId: adjacent!.id });

    expect(next.cards.find((c) => c.id === card.id)!.faceUp).toBe(false);
  });

  it("leaves a card without the Blend attribute untouched by the auto-reblend logic", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const [origin, adjacent] = state.board;
    // Republican Guard has no attributes.
    const card = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    state = placeInPlay(state, card.id, origin!.id, player, true);
    state = act(state, player, { type: "draw" });

    const next = act(state, player, { type: "moveCard", cardId: card.id, toLocationId: adjacent!.id });

    expect(next.cards.find((c) => c.id === card.id)!.faceUp).toBe(true);
  });
});
