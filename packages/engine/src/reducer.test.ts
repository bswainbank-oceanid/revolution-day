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

// Test-only helper: places a card directly in play, so moveCard can be
// exercised in isolation without depending on playCard's own behavior.
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

// Test-only helper: places a card directly in a player's hand regardless
// of where setupGame's shuffle happened to deal it, for deterministic
// playCard tests.
function placeInHand(state: GameState, cardId: string, controller: PlayerId): GameState {
  return {
    ...state,
    cards: state.cards.map((c) => (c.id === cardId ? { ...c, zone: "hand" as const, controller } : c)),
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

describe("applyAction: playCard", () => {
  it("plays a non-Blend card face-up to an allowed location type", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    // Republican Guard: no attributes, locations: ["Secure"].
    const card = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const secureLocation = state.board.find((l) => l.type === "Secure")!;
    state = placeInHand(state, card.id, player);
    state = act(state, player, { type: "draw" });

    const next = act(state, player, {
      type: "playCard",
      cardId: card.id,
      locationId: secureLocation.id,
    });

    const played = next.cards.find((c) => c.id === card.id)!;
    expect(played.zone).toBe("inPlay");
    expect(played.locationId).toBe(secureLocation.id);
    expect(played.faceUp).toBe(true);
    expect(next.turn.actionsRemaining).toBe(1);
  });

  it("always plays a Blend-attribute card face-down automatically", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    // Gunman: Blend attribute, locations: ["Street"].
    const card = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const streetLocation = state.board.find((l) => l.type === "Street")!;
    state = placeInHand(state, card.id, player);
    state = act(state, player, { type: "draw" });

    const next = act(state, player, { type: "playCard", cardId: card.id, locationId: streetLocation.id });

    expect(next.cards.find((c) => c.id === card.id)!.faceUp).toBe(false);
  });

  it("rejects playing to a disallowed location type", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const card = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const streetLocation = state.board.find((l) => l.type === "Street")!;
    state = placeInHand(state, card.id, player);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "playCard", cardId: card.id, locationId: streetLocation.id }),
    ).toThrow();
  });

  it("rejects playing a card not in the acting player's hand", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const card = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const secureLocation = state.board.find((l) => l.type === "Secure")!;
    state = placeInHand(state, card.id, other);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "playCard", cardId: card.id, locationId: secureLocation.id }),
    ).toThrow();
  });

  it("rejects playing a Motorcade via playCard", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const card = state.cards.find((c) => c.kind === "motorcade")!;
    const anyLocation = state.board[0]!;
    state = placeInHand(state, card.id, player);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "playCard", cardId: card.id, locationId: anyLocation.id }),
    ).toThrow();
  });

  it("plays a leader the same way as any other character card", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const leader = state.cards.find((c) => c.kind === "leader" && c.controller === player)!;
    const allowedType = cardData.leaders.find((l) => l.name === leader.defRef)!.locations[0]!;
    const location = state.board.find((l) => l.type === allowedType)!;
    state = act(state, player, { type: "draw" });

    const next = act(state, player, { type: "playCard", cardId: leader.id, locationId: location.id });

    expect(next.cards.find((c) => c.id === leader.id)!.zone).toBe("inPlay");
  });
});

// Draws and ends the current player's turn — advances the game by exactly
// one full turn.
function playFullTurn(state: GameState): GameState {
  const player = state.turn.currentPlayerId;
  const drawn = act(state, player, { type: "draw" });
  return act(drawn, player, { type: "endTurn" });
}

describe("applyAction: playMotorcade", () => {
  it("rejects playing on a player's first turn", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    state = placeInHand(state, motorcade.id, player);
    state = act(state, player, { type: "draw" });

    expect(() => act(state, player, { type: "playMotorcade", cardId: motorcade.id })).toThrow();
  });

  it("enters the President at the first Street location on the first Motorcade played", () => {
    let state = freshGame();
    const startingPlayer = state.turn.currentPlayerId;
    // Cycle everyone through their first turn so it's legal to play one.
    for (let i = 0; i < state.players.length; i++) {
      state = playFullTurn(state);
    }
    expect(state.turn.currentPlayerId).toBe(startingPlayer);

    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    state = placeInHand(state, motorcade.id, startingPlayer);
    state = act(state, startingPlayer, { type: "draw" });

    const next = act(state, startingPlayer, { type: "playMotorcade", cardId: motorcade.id });

    const firstStreet = state.board.find((l) => l.type === "Street")!;
    expect(next.president).toEqual({ status: "alive", locationId: firstStreet.id });
    expect(next.cards.find((c) => c.id === motorcade.id)!.zone).toBe("discard");
    expect(next.turn.actionsRemaining).toBe(1);
  });

  it("advances the President one location forward on a subsequent Motorcade", () => {
    let state = freshGame();
    for (let i = 0; i < state.players.length; i++) state = playFullTurn(state);
    const player = state.turn.currentPlayerId;

    const firstMotorcade = state.cards.find((c) => c.kind === "motorcade")!;
    state = placeInHand(state, firstMotorcade.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "playMotorcade", cardId: firstMotorcade.id });
    const enteredAt = state.president.locationId!;
    state = act(state, player, { type: "endTurn" });
    for (let i = 0; i < state.players.length - 1; i++) state = playFullTurn(state);

    const secondMotorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, secondMotorcade.id, player);
    state = act(state, player, { type: "draw" });
    const next = act(state, player, { type: "playMotorcade", cardId: secondMotorcade.id });

    const expectedNext = state.board[state.board.findIndex((l) => l.id === enteredAt) + 1]!.id;
    expect(next.president).toEqual({ status: "alive", locationId: expectedNext });
  });

  it("ends the game with the President surviving when advanced past the last location", () => {
    let state = freshGame();
    for (let i = 0; i < state.players.length; i++) state = playFullTurn(state);
    const player = state.turn.currentPlayerId;
    state = { ...state, president: { status: "alive", locationId: state.board.at(-1)!.id } };

    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    state = placeInHand(state, motorcade.id, player);
    state = act(state, player, { type: "draw" });

    const next = act(state, player, { type: "playMotorcade", cardId: motorcade.id });

    expect(next.president).toEqual({ status: "survived", locationId: null });
  });

  it("moves a controlled card to any location after the President has been eliminated", () => {
    let state = freshGame();
    for (let i = 0; i < state.players.length; i++) state = playFullTurn(state);
    const player = state.turn.currentPlayerId;
    state = { ...state, president: { status: "eliminated", locationId: null } };

    const [origin, farLocation] = [state.board[0]!, state.board.at(-1)!];
    const ownCard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    state = placeInPlay(state, ownCard.id, origin.id, player);
    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    state = placeInHand(state, motorcade.id, player);
    state = act(state, player, { type: "draw" });

    const next = act(state, player, {
      type: "playMotorcade",
      cardId: motorcade.id,
      moveOwnCardId: ownCard.id,
      moveToLocationId: farLocation.id,
    });

    expect(next.cards.find((c) => c.id === ownCard.id)!.locationId).toBe(farLocation.id);
    expect(next.president.status).toBe("eliminated");
  });

  it("rejects playing a non-Motorcade card via playMotorcade", () => {
    let state = freshGame();
    for (let i = 0; i < state.players.length; i++) state = playFullTurn(state);
    const player = state.turn.currentPlayerId;
    const notMotorcade = state.cards.find((c) => c.kind === "nonLeader")!;
    state = placeInHand(state, notMotorcade.id, player);
    state = act(state, player, { type: "draw" });

    expect(() => act(state, player, { type: "playMotorcade", cardId: notMotorcade.id })).toThrow();
  });
});
