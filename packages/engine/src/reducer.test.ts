import { describe, expect, it } from "vitest";
import { cardData } from "./data/cardData";
import { applyAction } from "./reducer";
import type { Action } from "./actions";
import type { CardInstance } from "./state/cards";
import type { GameState, PlayerId } from "./state/game";
import type {
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  MotorcadeInterceptionWindowFrame,
  ProtectedTargetingWindowFrame,
  ReactivePassiveWindowFrame,
} from "./state/resolution";
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

  it("the mandatory draw is a no-op on an empty deck when nobody holds a Motorcade", () => {
    const state = freshGame();
    const emptyDeck = { ...state, cards: state.cards.filter((c) => c.zone !== "deck") };
    const before = emptyDeck.cards.filter((c) => c.zone === "hand" && c.controller === state.turn.currentPlayerId).length;

    const resolved = act(emptyDeck, state.turn.currentPlayerId, { type: "draw" });

    expect(resolved.turn.phase).toBe("action");
    expect(
      resolved.cards.filter((c) => c.zone === "hand" && c.controller === state.turn.currentPlayerId).length,
    ).toBe(before);
  });

  it("throws on a budgeted (non-mandatory) draw once the deck is empty", () => {
    let state = freshGame();
    state = { ...state, cards: state.cards.filter((c) => c.zone !== "deck") };
    const player = state.turn.currentPlayerId;
    state = act(state, player, { type: "draw" }); // mandatory draw — no-ops, reaches the action phase

    expect(() => act(state, player, { type: "draw" })).toThrow();
  });

  it("forces an immediately-held Motorcade to be played on an empty deck, not counting as an action", () => {
    let state = freshGame();
    for (let i = 0; i < state.players.length; i++) state = playFullTurn(state);
    const player = state.turn.currentPlayerId;
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, motorcade.id, player);
    state = { ...state, cards: state.cards.filter((c) => c.zone !== "deck") };
    const actionsBefore = state.turn.actionsRemaining;

    const resolved = act(state, player, { type: "draw" });

    expect(resolved.turn.phase).toBe("action");
    expect(resolved.turn.actionsRemaining).toBe(actionsBefore); // did not spend an action
    expect(resolved.cards.find((c) => c.id === motorcade.id)!.zone).toBe("discard");
    expect(resolved.president.status).toBe("alive"); // entered the board — the forced play happened
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
    // Already in play — otherwise the new "leader stuck in hand" rule
    // blocks every other action once the President is eliminated.
    const ownLeader = state.cards.find((c) => c.kind === "leader" && c.controller === player)!;
    state = placeInPlay(state, ownLeader.id, origin.id, player);
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

// Cycles everyone through their first turn, then has the current player
// play a Motorcade to bring the President onto the board.
function enterPresident(state: GameState): GameState {
  for (let i = 0; i < state.players.length; i++) state = playFullTurn(state);
  const player = state.turn.currentPlayerId;
  const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
  state = placeInHand(state, motorcade.id, player);
  state = act(state, player, { type: "draw" });
  return act(state, player, { type: "playMotorcade", cardId: motorcade.id });
}

describe("applyAction: forced leader play", () => {
  it("blocks any other action while the current player's leader sits in hand after the President's elimination", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    state = { ...state, president: { status: "eliminated", locationId: null } };
    state = act(state, player, { type: "draw" }); // the mandatory draw itself is exempt

    expect(() => act(state, player, { type: "endTurn" })).toThrow();
    const someCard = state.cards.find((c) => c.kind === "nonLeader" && c.zone === "hand" && c.controller === player);
    if (someCard) {
      expect(() => act(state, player, { type: "playCard", cardId: someCard.id, locationId: state.board[0]!.id })).toThrow();
    }
  });

  it("allows playing the stuck leader itself, and lifts the restriction once it's played", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    state = { ...state, president: { status: "eliminated", locationId: null } };
    state = act(state, player, { type: "draw" });
    const leader = state.cards.find((c) => c.kind === "leader" && c.controller === player)!;
    const loc = state.board.find((l) => l.type === getAllowedLocationTypesFor(leader))!.id;

    const played = act(state, player, { type: "playCard", cardId: leader.id, locationId: loc });
    expect(played.cards.find((c) => c.id === leader.id)!.zone).toBe("inPlay");

    // No longer stuck — a normal action now goes through.
    expect(() => act(played, player, { type: "endTurn" })).not.toThrow();
  });

  it("does not block a different player's own turn", () => {
    let state = freshGame(["a", "b", "c"]);
    const player = state.turn.currentPlayerId;
    state = { ...state, president: { status: "eliminated", locationId: null } };
    // player's own leader is played already; this restriction only ever
    // looks at the *current* player's own leader, on their own turn.
    const leader = state.cards.find((c) => c.kind === "leader" && c.controller === player)!;
    const loc = state.board.find((l) => l.type === getAllowedLocationTypesFor(leader))!.id;
    state = placeInPlay(state, leader.id, loc, player);
    state = act(state, player, { type: "draw" });

    expect(() => act(state, player, { type: "endTurn" })).not.toThrow();
  });
});

// Test-only helper: finds an allowed location type for a card, so
// placeInPlay/playCard scenarios always use a legal one.
function getAllowedLocationTypesFor(card: CardInstance): "Public" | "Street" | "Secure" {
  const defs = card.kind === "leader" ? cardData.leaders : cardData.non_leader_cards;
  const def = defs.find((d) => d.name === card.defRef)!;
  return def.locations[0]!;
}

describe("applyAction: Motorcade interception window", () => {
  it("applies the move immediately when nobody can intercept", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const player = state.turn.currentPlayerId;
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    // enterPresident already spent the mandatory draw and one action;
    // this uses the remaining one directly.
    state = placeInHand(state, motorcade.id, player);

    const next = act(state, player, { type: "playMotorcade", cardId: motorcade.id });

    expect(next.resolutionStack).toHaveLength(0);
    expect(next.president.locationId).not.toBe(presidentLoc);
  });

  it("opens a window when an eligible interceptor is present, and cancels the move if used", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const player = state.turn.currentPlayerId;
    const interceptor = state.cards.find((c) => c.defRef === "Throng of Admirers")!;
    state = placeInPlay(state, interceptor.id, presidentLoc, player);
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, motorcade.id, player);

    const activated = act(state, player, { type: "playMotorcade", cardId: motorcade.id });
    expect(activated.resolutionStack).toHaveLength(1);
    expect(activated.president.locationId).toBe(presidentLoc); // not yet moved
    // Spent regardless of what happens next — only the movement is in question.
    expect(activated.cards.find((c) => c.id === motorcade.id)!.zone).toBe("discard");

    const window = activated.resolutionStack[0] as MotorcadeInterceptionWindowFrame;
    expect(window.order).toEqual([player]); // self-interception, the only eligible one

    const cancelled = act(activated, player, { type: "interceptMotorcade", cardId: interceptor.id });
    expect(cancelled.resolutionStack).toHaveLength(0);
    expect(cancelled.president.locationId).toBe(presidentLoc); // move cancelled
    expect(cancelled.cards.find((c) => c.id === interceptor.id)!.zone).toBe("eliminated");
  });

  it("applies the move as normal if the eligible interceptor passes", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const player = state.turn.currentPlayerId;
    const interceptor = state.cards.find((c) => c.defRef === "Angry Mob")!;
    state = placeInPlay(state, interceptor.id, presidentLoc, player);
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, motorcade.id, player);
    const activated = act(state, player, { type: "playMotorcade", cardId: motorcade.id });

    const resolved = act(activated, player, { type: "passIntercept" });

    expect(resolved.resolutionStack).toHaveLength(0);
    expect(resolved.president.locationId).not.toBe(presidentLoc);
    expect(resolved.cards.find((c) => c.id === interceptor.id)!.zone).toBe("inPlay");
  });

  it("stops at the first 'yes' and never asks anyone else", () => {
    let state = freshGame(["a", "b", "c"]);
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const player = state.turn.currentPlayerId;
    const others = state.players.filter((p) => p.id !== player).map((p) => p.id);
    const [mob1, mob2] = state.cards.filter((c) => c.defRef === "Angry Mob");
    state = placeInPlay(state, mob1!.id, presidentLoc, others[0]!);
    state = placeInPlay(state, mob2!.id, presidentLoc, others[1]!);
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, motorcade.id, player);

    const activated = act(state, player, { type: "playMotorcade", cardId: motorcade.id });
    const window = activated.resolutionStack[0] as MotorcadeInterceptionWindowFrame;
    expect(window.order).toHaveLength(2);

    const firstResponder = window.order[0]!;
    const firstMob = firstResponder === others[0] ? mob1! : mob2!;
    const secondMob = firstMob.id === mob1!.id ? mob2! : mob1!;

    const resolved = act(activated, firstResponder, {
      type: "interceptMotorcade",
      cardId: firstMob.id,
    });

    expect(resolved.resolutionStack).toHaveLength(0); // second responder never asked
    expect(resolved.cards.find((c) => c.id === firstMob.id)!.zone).toBe("eliminated");
    expect(resolved.cards.find((c) => c.id === secondMob.id)!.zone).toBe("inPlay");
  });

  it("prevents the President from surviving if intercepted while advancing past the last location", () => {
    let state = freshGame();
    for (let i = 0; i < state.players.length; i++) state = playFullTurn(state);
    const player = state.turn.currentPlayerId;
    const lastLoc = state.board.at(-1)!.id;
    state = { ...state, president: { status: "alive", locationId: lastLoc } };
    const interceptor = state.cards.find((c) => c.defRef === "Angry Mob")!;
    state = placeInPlay(state, interceptor.id, lastLoc, player);
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, motorcade.id, player);
    state = act(state, player, { type: "draw" });
    const activated = act(state, player, { type: "playMotorcade", cardId: motorcade.id });

    const cancelled = act(activated, player, { type: "interceptMotorcade", cardId: interceptor.id });

    expect(cancelled.president).toEqual({ status: "alive", locationId: lastLoc });
  });
});

describe("applyAction: activateAbility / chooseTargets", () => {
  it("activates a simple ability, pushes a resolution frame, and resolves it on chooseTargets", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const target = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen" && c.id !== guard.id,
    )!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, target.id, loc, other);
    state = act(state, player, { type: "draw" });

    const activated = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });
    expect(activated.resolutionStack).toHaveLength(1);
    expect(activated.turn.actionsRemaining).toBe(1);
    expect(activated.turn.usedAbilities).toContain(`${guard.id}#0`);

    const resolved = act(activated, player, { type: "chooseTargets", targetIds: [target.id] });
    expect(resolved.resolutionStack).toHaveLength(0);
    const eliminated = resolved.cards.find((c) => c.id === target.id)!;
    expect(eliminated.zone).toBe("eliminated");
    expect(eliminated.locationId).toBeUndefined();
  });

  it("only the activating player may choose targets, even mid-resolution", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const target = state.cards.find((c) => c.kind === "nonLeader" && c.id !== guard.id)!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, target.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });

    expect(() => act(state, other, { type: "chooseTargets", targetIds: [target.id] })).toThrow();
  });

  it("rejects targeting a card at a different location", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const farTarget = state.cards.find((c) => c.kind === "nonLeader" && c.id !== guard.id)!;
    state = placeInPlay(state, guard.id, state.board[0]!.id, player);
    state = placeInPlay(state, farTarget.id, state.board[1]!.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });

    expect(() => act(state, player, { type: "chooseTargets", targetIds: [farTarget.id] })).toThrow();
  });

  it("rejects using the same ability twice in one turn", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const t1 = state.cards.find((c) => c.kind === "nonLeader" && c.id !== guard.id)!;
    const t2 = state.cards.find((c) => c.kind === "nonLeader" && c.id !== guard.id && c.id !== t1.id)!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, t1.id, loc, player);
    state = placeInPlay(state, t2.id, loc, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });
    state = act(state, player, { type: "chooseTargets", targetIds: [t1.id] });

    expect(() =>
      act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 }),
    ).toThrow();
  });

  it("rejects self-activating a Response-type ability", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const bodyguard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Bodyguard")!;
    state = placeInPlay(state, bodyguard.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "activateAbility", cardId: bodyguard.id, abilityIndex: 0 }),
    ).toThrow();
  });

  it("rejects activating an ability index a card doesn't have", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    // Prominent Citizen has no abilities at all — every card with a real
    // ability now has structured content encoded (see abilityEffects.ts).
    const prominentCitizen = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen")!;
    state = placeInPlay(state, prominentCitizen.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "activateAbility", cardId: prominentCitizen.id, abilityIndex: 0 }),
    ).toThrow();
  });

  it("rejects activating a card you don't control", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    state = placeInPlay(state, guard.id, state.board[0]!.id, other);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 }),
    ).toThrow();
  });
});

describe("applyAction: alarm resolution", () => {
  it("reveals the source on activation, runs the full response pass, then resolves via chooseTargets", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    // Republican Guard specifically — no passive, so this stays focused on
    // alarm resolution rather than also exercising the reactive-passive
    // queue (see the dedicated passives describe block for that).
    const target = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, gunman.id, loc, player, false); // starts face-down
    state = placeInPlay(state, target.id, loc, other);
    state = act(state, player, { type: "draw" });

    const activated = act(state, player, { type: "activateAbility", cardId: gunman.id, abilityIndex: 0 });
    expect(activated.resolutionStack).toHaveLength(2);
    expect(activated.cards.find((c) => c.id === gunman.id)!.faceUp).toBe(true);

    const frame = activated.resolutionStack[1] as AlarmResolutionFrame;
    let s = activated;
    for (const respondingPlayer of frame.order) {
      s = act(s, respondingPlayer, { type: "passResponse" });
    }
    expect(s.resolutionStack).toHaveLength(1);

    const resolved = act(s, player, { type: "chooseTargets", targetIds: [target.id] });
    expect(resolved.resolutionStack).toHaveLength(0);
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });

  it("cancels the underlying ability entirely if a response eliminates the triggering character", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const currentSeat = state.players.find((p) => p.id === player)!.seatIndex;
    const firstResponder = state.players.find(
      (p) => p.seatIndex === (currentSeat + 1) % state.players.length,
    )!.id;

    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const bodyguard = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Bodyguard" && c.id !== gunman.id,
    )!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, gunman.id, loc, player, true);
    state = placeInPlay(state, bodyguard.id, loc, firstResponder, false); // face-down
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: gunman.id, abilityIndex: 0 });

    let s = act(state, firstResponder, {
      type: "useResponse",
      cardId: bodyguard.id,
      abilityIndex: 0,
      targetIds: [gunman.id],
    });
    expect(s.cards.find((c) => c.id === gunman.id)!.zone).toBe("eliminated");
    expect(s.cards.find((c) => c.id === bodyguard.id)!.faceUp).toBe(true); // forced to reveal to respond

    const frame = s.resolutionStack[1] as AlarmResolutionFrame;
    for (let i = frame.nextIndex; i < frame.order.length; i++) {
      s = act(s, frame.order[i]!, { type: "passResponse" });
    }

    expect(s.resolutionStack).toHaveLength(0);
  });

  it("rejects a response from anyone other than whoever's turn it is in the pass", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    state = placeInPlay(state, gunman.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: gunman.id, abilityIndex: 0 });

    const frame = state.resolutionStack[1] as AlarmResolutionFrame;
    const outOfTurnPlayer = frame.order[frame.order.length - 1]!; // triggering player goes last, not first
    expect(() => act(state, outOfTurnPlayer, { type: "passResponse" })).toThrow();
  });

  it("rejects the triggering character responding to its own alarm, even by its own controller", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    state = placeInPlay(state, gunman.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: gunman.id, abilityIndex: 0 });

    const frame = state.resolutionStack[1] as AlarmResolutionFrame;
    // Fast-forward to the triggering player's own turn in the pass (last).
    let s = state;
    for (let i = 0; i < frame.order.length - 1; i++) {
      s = act(s, frame.order[i]!, { type: "passResponse" });
    }
    expect(() =>
      act(s, player, { type: "useResponse", cardId: gunman.id, abilityIndex: 1, targetIds: [] }),
    ).toThrow();
  });
});

describe("applyAction: Protected immunity (integration)", () => {
  it("rejects eliminating a Protected leader while another same-faction card protects it", () => {
    // 8 players so all 8 leaders are dealt — guarantees Head of Security exists.
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const target = state.cards.find((c) => c.kind === "leader" && c.defRef === "Head of Security")!;
    const protector = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen" && c.id !== guard.id,
    )!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, target.id, loc, other);
    state = placeInPlay(state, protector.id, loc, other); // Regime, non-Protected — shields the leader
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });

    expect(() => act(state, player, { type: "chooseTargets", targetIds: [target.id] })).toThrow();
  });

  it("allows eliminating a Protected leader once no protector remains", () => {
    // 8 players so all 8 leaders are dealt — guarantees Head of Security exists.
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const target = state.cards.find((c) => c.kind === "leader" && c.defRef === "Head of Security")!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, target.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [target.id] });
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });
});

describe("applyAction: President targeting (Wife)", () => {
  it("eliminates the President, ignoring protection, when he's alive and reachable", () => {
    // 8 players so Wife is guaranteed to be dealt (to whichever player,
    // reassigned to the current player below via placeInPlay).
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const wife = state.cards.find((c) => c.defRef === "Wife")!;
    const loc = state.board[0]!.id;
    // A Regime guard is present too — Wife's ability ignores protection.
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    state = placeInPlay(state, wife.id, loc, player);
    state = placeInPlay(state, guard.id, loc, state.players.find((p) => p.id !== player)!.id);
    state = { ...state, president: { status: "alive", locationId: loc } };
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: wife.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: ["president"] });
    expect(resolved.president).toEqual({
      status: "eliminated",
      locationId: null,
      eliminatedAtLocationId: loc,
      eliminatedByPlayerId: player,
    });
  });

  it("rejects targeting the President when Wife isn't at his location", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const wife = state.cards.find((c) => c.defRef === "Wife")!;
    const wifeLoc = state.board[0]!.id;
    const presidentLoc = state.board[1]!.id;
    state = placeInPlay(state, wife.id, wifeLoc, player);
    state = { ...state, president: { status: "alive", locationId: presidentLoc } };
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: wife.id, abilityIndex: 0 });

    expect(() => act(state, player, { type: "chooseTargets", targetIds: ["president"] })).toThrow();
  });

  it("rejects targeting the President before he's entered the board", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const wife = state.cards.find((c) => c.defRef === "Wife")!;
    state = placeInPlay(state, wife.id, state.board[0]!.id, player);
    // president.status stays "notEntered" — never placed.
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: wife.id, abilityIndex: 0 });

    expect(() => act(state, player, { type: "chooseTargets", targetIds: ["president"] })).toThrow();
  });
});

describe("applyAction: remote activation", () => {
  it("remotely activates another player's card and resolves its effect as the original acting player", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const hos = state.cards.find((c) => c.defRef === "Head of Security")!;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const target = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen" && c.id !== guard.id,
    )!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, hos.id, loc, player);
    state = placeInPlay(state, guard.id, loc, other); // controlled by someone else entirely
    state = placeInPlay(state, target.id, loc, other, false);
    state = act(state, player, { type: "draw" });

    const activated = act(state, player, { type: "activateAbility", cardId: hos.id, abilityIndex: 0 });
    const remoted = act(activated, player, {
      type: "chooseTargets",
      targetIds: [guard.id],
      remoteAbilityIndex: 0,
    });
    // Guard's own once-per-turn usage is marked (not Head of Security's).
    expect(remoted.turn.usedAbilities).toContain(`${guard.id}#0`);
    expect(remoted.resolutionStack).toHaveLength(1);

    // The original player, not Republican Guard's controller, resolves it.
    const resolved = act(remoted, player, { type: "chooseTargets", targetIds: [target.id] });
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });

  it("rejects a faction-filtered remote card outside the ability's faction", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const hos = state.cards.find((c) => c.defRef === "Head of Security")!; // Regime-only
    const rebelCard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Assassin")!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, hos.id, loc, player);
    state = placeInPlay(state, rebelCard.id, loc, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: hos.id, abilityIndex: 0 });

    expect(() =>
      act(state, player, { type: "chooseTargets", targetIds: [rebelCard.id], remoteAbilityIndex: 0 }),
    ).toThrow();
  });

  it("Puppet-Master's remote-activate has no faction filter", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const puppetMaster = state.cards.find((c) => c.defRef === "Puppet-Master")!;
    const rebelCard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Assassin")!;
    const target = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen" && c.id !== rebelCard.id,
    )!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, puppetMaster.id, loc, player);
    state = placeInPlay(state, rebelCard.id, loc, player);
    state = placeInPlay(state, target.id, loc, player);
    state = act(state, player, { type: "draw" });
    // Ability index 1 — Puppet-Master's first ability ("Play 2 cards") isn't encoded.
    state = act(state, player, { type: "activateAbility", cardId: puppetMaster.id, abilityIndex: 1 });
    state = act(state, player, {
      type: "chooseTargets",
      targetIds: [rebelCard.id],
      remoteAbilityIndex: 0,
    });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [target.id] });
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });

  it("remotely activating an alarm-triggering ability makes the original acting player the triggering player", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    // Guerrilla Commander's remote-activate is Rebel-only, matching Gunman.
    const guerrillaCommander = state.cards.find((c) => c.defRef === "Guerrilla Commander")!;
    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guerrillaCommander.id, loc, player);
    state = placeInPlay(state, gunman.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guerrillaCommander.id, abilityIndex: 0 });
    state = act(state, player, { type: "chooseTargets", targetIds: [gunman.id], remoteAbilityIndex: 0 });

    expect(state.resolutionStack).toHaveLength(2);
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    expect(alarmFrame.triggeringPlayerId).toBe(player); // not gunman's controller (other)
    expect(alarmFrame.order.at(-1)).toBe(player); // triggering player still responds last
  });

  it("rejects remotely activating a card whose ability was already used this turn", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const hos = state.cards.find((c) => c.defRef === "Head of Security")!;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const t1 = state.cards.find((c) => c.kind === "nonLeader" && c.id !== guard.id)!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, hos.id, loc, player);
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, t1.id, loc, player);
    state = act(state, player, { type: "draw" });
    // Guard activates directly first, using up its once-per-turn ability.
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });
    state = act(state, player, { type: "chooseTargets", targetIds: [t1.id] });

    const activated = act(state, player, { type: "activateAbility", cardId: hos.id, abilityIndex: 0 });
    expect(() =>
      act(activated, player, { type: "chooseTargets", targetIds: [guard.id], remoteAbilityIndex: 0 }),
    ).toThrow();
  });
});

describe("applyAction: protected-targeting reveal window", () => {
  function setupWindowScenario() {
    // 8 players so Head of Security is guaranteed to be dealt.
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const declarer = state.turn.currentPlayerId;
    const [otherA, otherB] = state.players.filter((p) => p.id !== declarer).map((p) => p.id) as [string, string];
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const target = state.cards.find((c) => c.defRef === "Head of Security")!;
    const hiddenProtector = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Secret Police" && c.id !== guard.id,
    )!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guard.id, loc, declarer);
    state = placeInPlay(state, target.id, loc, otherA); // no reveal opportunity of its own
    state = placeInPlay(state, hiddenProtector.id, loc, otherB, false); // face-down
    state = act(state, declarer, { type: "draw" });
    state = act(state, declarer, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });
    return { state, declarer, otherA, otherB, guard, target, hiddenProtector, loc };
  }

  it("opens a window and skips straight to the only player with a blended card there", () => {
    const { state, declarer, target, otherB } = setupWindowScenario();
    const activated = act(state, declarer, { type: "chooseTargets", targetIds: [target.id] });

    expect(activated.resolutionStack).toHaveLength(2);
    const window = activated.resolutionStack[1] as ProtectedTargetingWindowFrame;
    expect(window.order).toEqual([otherB]);
  });

  it("after any reveal, hands control back to the declaring player to freely re-choose", () => {
    const { state, declarer, otherB, target, hiddenProtector } = setupWindowScenario();
    const activated = act(state, declarer, { type: "chooseTargets", targetIds: [target.id] });

    const returned = act(activated, otherB, { type: "revealBlended", cardIds: [hiddenProtector.id] });

    expect(returned.resolutionStack).toHaveLength(1);
    const reselectFrame = returned.resolutionStack[0] as AbilityResolutionFrame;
    expect(reselectFrame.reselectingAfterReveal).toBe(true);
    expect(reselectFrame.targetIds).toBeNull();

    // The declaring player can now pick the newly revealed card...
    const resolved = act(returned, declarer, { type: "chooseTargets", targetIds: [hiddenProtector.id] });
    expect(resolved.resolutionStack).toHaveLength(0);
    expect(resolved.cards.find((c) => c.id === hiddenProtector.id)!.zone).toBe("eliminated");
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("inPlay");
  });

  it("lets the re-choice target the same (still Protected) character with no new window", () => {
    const { state, declarer, otherB, target, hiddenProtector } = setupWindowScenario();
    const activated = act(state, declarer, { type: "chooseTargets", targetIds: [target.id] });
    const returned = act(activated, otherB, { type: "revealBlended", cardIds: [hiddenProtector.id] });

    // Head of Security is *still* Protected (hiddenProtector, now revealed,
    // would normally shield it) — but this re-choice bypasses that check
    // entirely and does not reopen a window.
    const resolved = act(returned, declarer, { type: "chooseTargets", targetIds: [target.id] });

    expect(resolved.resolutionStack).toHaveLength(0);
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });

  it("triggers the same hand-back even from a reveal of an unrelated faction", () => {
    const { state, declarer, otherB, target, hiddenProtector } = setupWindowScenario();
    // Give otherB a second blended card that's the wrong faction — per the
    // corrected rule, *any* reveal hands control back, regardless of
    // whether it would have protected the original target.
    const wrongFactionCard = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Gunman" && c.zone === "deck",
    )!;
    const withExtra = placeInPlay(state, wrongFactionCard.id, state.board[0]!.id, otherB, false);
    const activated = act(withExtra, declarer, { type: "chooseTargets", targetIds: [target.id] });

    const returned = act(activated, otherB, { type: "revealBlended", cardIds: [wrongFactionCard.id] });

    expect(returned.resolutionStack).toHaveLength(1);
    expect((returned.resolutionStack[0] as AbilityResolutionFrame).reselectingAfterReveal).toBe(true);
    // hiddenProtector is still face-down — the *other* card was revealed.
    expect(returned.cards.find((c) => c.id === hiddenProtector.id)!.faceUp).toBe(false);

    const resolved = act(returned, declarer, { type: "chooseTargets", targetIds: [target.id] });
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });

  it("eliminates the originally declared target directly if nobody reveals anything", () => {
    const { state, declarer, otherB, target, hiddenProtector } = setupWindowScenario();
    const activated = act(state, declarer, { type: "chooseTargets", targetIds: [target.id] });

    const resolved = act(activated, otherB, { type: "passReveal" });

    expect(resolved.resolutionStack).toHaveLength(0);
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
    expect(resolved.cards.find((c) => c.id === hiddenProtector.id)!.zone).toBe("inPlay");
    expect(resolved.cards.find((c) => c.id === hiddenProtector.id)!.faceUp).toBe(false);
  });

  it("rejects a reveal or pass out of turn in the pass", () => {
    const { state, declarer, target } = setupWindowScenario();
    const activated = act(state, declarer, { type: "chooseTargets", targetIds: [target.id] });

    expect(() => act(activated, declarer, { type: "passReveal" })).toThrow();
  });

  it("rejects revealing a card you don't control at that location", () => {
    const { state, declarer, otherB, target, hiddenProtector } = setupWindowScenario();
    const activated = act(state, declarer, { type: "chooseTargets", targetIds: [target.id] });

    expect(() =>
      act(activated, otherB, { type: "revealBlended", cardIds: [target.id] }), // not otherB's card
    ).toThrow();
    // sanity: hiddenProtector itself is a legal reveal for comparison
    expect(() =>
      act(activated, otherB, { type: "revealBlended", cardIds: [hiddenProtector.id] }),
    ).not.toThrow();
  });

  it("does not open a window at all when nobody has anything to reveal", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const target = state.cards.find((c) => c.defRef === "Head of Security")!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, target.id, loc, other); // alone, nothing else at this location
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [target.id] });
    expect(resolved.resolutionStack).toHaveLength(0);
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });
});

describe("applyAction: nested reveal window during an alarm response", () => {
  function setupNestedScenario() {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const activator = state.turn.currentPlayerId;
    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, gunman.id, loc, activator);
    state = act(state, activator, { type: "draw" });
    state = act(state, activator, { type: "activateAbility", cardId: gunman.id, abilityIndex: 0 });

    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    const responder = alarmFrame.order[0]!;
    const otherPlayer = state.players.find((p) => p.id !== activator && p.id !== responder)!.id;

    const assassin = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Assassin")!;
    const target = state.cards.find((c) => c.defRef === "Head of Security")!;
    const hiddenProtector = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Secret Police" && c.id !== assassin.id,
    )!;
    state = placeInPlay(state, assassin.id, loc, responder);
    state = placeInPlay(state, target.id, loc, otherPlayer);
    state = placeInPlay(state, hiddenProtector.id, loc, otherPlayer, false);

    return { state, activator, responder, otherPlayer, gunman, assassin, target, hiddenProtector, loc };
  }

  it("pauses the alarm pass and opens a nested window when the response declares a Protected target", () => {
    const { state, responder, assassin, target } = setupNestedScenario();

    const responded = act(state, responder, {
      type: "useResponse",
      cardId: assassin.id,
      abilityIndex: 1,
      targetIds: [target.id],
    });

    expect(responded.resolutionStack).toHaveLength(4);
    expect(responded.resolutionStack[1]).toMatchObject({ kind: "alarmResolution", nextIndex: 0 });
    expect(responded.resolutionStack[2]).toMatchObject({
      kind: "abilityResolution",
      actingPlayerId: responder,
      sourceCardId: assassin.id,
    });
    expect(responded.resolutionStack[3]).toMatchObject({ kind: "protectedTargetingWindow" });
  });

  it("resumes the alarm pass once the nested window resolves with no reveal", () => {
    const { state, responder, otherPlayer, assassin, target, hiddenProtector } = setupNestedScenario();
    const responded = act(state, responder, {
      type: "useResponse",
      cardId: assassin.id,
      abilityIndex: 1,
      targetIds: [target.id],
    });
    const window = responded.resolutionStack[3] as ProtectedTargetingWindowFrame;
    expect(window.order).toEqual([otherPlayer]);

    const resumed = act(responded, otherPlayer, { type: "passReveal" });

    // Back down to just [AbilityResolutionFrame(gunman), AlarmResolutionFrame]
    // — the response fully resolved and the pass advanced past it.
    expect(resumed.resolutionStack).toHaveLength(2);
    expect((resumed.resolutionStack[1] as AlarmResolutionFrame).nextIndex).toBe(1);
    expect(resumed.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
    expect(resumed.cards.find((c) => c.id === hiddenProtector.id)!.faceUp).toBe(false);
  });

  it("resumes the alarm pass after a reveal hands control back to the responder for a final re-choice", () => {
    const { state, responder, otherPlayer, assassin, target, hiddenProtector } = setupNestedScenario();
    const responded = act(state, responder, {
      type: "useResponse",
      cardId: assassin.id,
      abilityIndex: 1,
      targetIds: [target.id],
    });

    const returned = act(responded, otherPlayer, {
      type: "revealBlended",
      cardIds: [hiddenProtector.id],
    });

    // Window popped, pending frame reset for the *responder* to re-choose —
    // still nested above the paused alarm frame.
    expect(returned.resolutionStack).toHaveLength(3);
    const reselectFrame = returned.resolutionStack[2] as AbilityResolutionFrame;
    expect(reselectFrame.actingPlayerId).toBe(responder);
    expect(reselectFrame.reselectingAfterReveal).toBe(true);

    const resolved = act(returned, responder, { type: "chooseTargets", targetIds: [hiddenProtector.id] });

    expect(resolved.resolutionStack).toHaveLength(2); // back to [ability, alarm]
    expect((resolved.resolutionStack[1] as AlarmResolutionFrame).nextIndex).toBe(1);
    expect(resolved.cards.find((c) => c.id === hiddenProtector.id)!.zone).toBe("eliminated");
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("inPlay");
  });
});

describe("applyAction: Commander General", () => {
  function freshCommanderGeneralGame() {
    // 8 players so Commander General is guaranteed to be dealt.
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const player = state.turn.currentPlayerId;
    const cg = state.cards.find((c) => c.defRef === "Commander General")!;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, cg.id, loc, player);
    state = act(state, player, { type: "draw" });
    return { state, player, cg, loc };
  }

  it("reveals every blended character at the location, any faction, with no choice to make", () => {
    let { state, player, cg, loc } = freshCommanderGeneralGame();
    const other = state.players.find((p) => p.id !== player)!.id;
    const regimeBlend = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Secret Police")!;
    const rebelBlend = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Gunman" && c.id !== regimeBlend.id,
    )!;
    const alreadyUp = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Republican Guard" && c.id !== regimeBlend.id,
    )!;
    state = placeInPlay(state, regimeBlend.id, loc, other, false);
    state = placeInPlay(state, rebelBlend.id, loc, other, false);
    state = placeInPlay(state, alreadyUp.id, loc, other, true);
    state = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 2 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [] });

    expect(resolved.resolutionStack).toHaveLength(0);
    expect(resolved.cards.find((c) => c.id === regimeBlend.id)!.faceUp).toBe(true);
    expect(resolved.cards.find((c) => c.id === rebelBlend.id)!.faceUp).toBe(true);
    expect(resolved.cards.find((c) => c.id === alreadyUp.id)!.faceUp).toBe(true);
  });

  it("rejects passing targets to a 'reveal all' effect — there's nothing to choose", () => {
    const { state, player, cg } = freshCommanderGeneralGame();
    const activated = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 2 });
    const someCard = activated.cards.find((c) => c.zone === "deck")!;

    expect(() => act(activated, player, { type: "chooseTargets", targetIds: [someCard.id] })).toThrow();
  });

  it("plays any number (including zero) of Regime cards from hand at its location", () => {
    let { state, player, cg, loc } = freshCommanderGeneralGame();
    const regime1 = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const regime2 = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Secret Police" && c.id !== regime1.id,
    )!; // Secret Police has Blend — confirms auto-face-down on play
    const rebelCard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Assassin")!;
    state = placeInHand(state, regime1.id, player);
    state = placeInHand(state, regime2.id, player);
    state = placeInHand(state, rebelCard.id, player);
    state = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 0 });

    // The Rebel card isn't a legal choice at all.
    expect(() =>
      act(state, player, { type: "chooseTargets", targetIds: [regime1.id, rebelCard.id] }),
    ).toThrow();

    const resolved = act(state, player, {
      type: "chooseTargets",
      targetIds: [regime1.id, regime2.id],
    });

    expect(resolved.resolutionStack).toHaveLength(0);
    const played1 = resolved.cards.find((c) => c.id === regime1.id)!;
    const played2 = resolved.cards.find((c) => c.id === regime2.id)!;
    expect(played1.zone).toBe("inPlay");
    expect(played1.locationId).toBe(loc);
    expect(played1.faceUp).toBe(true); // Republican Guard has no Blend
    expect(played2.faceUp).toBe(false); // Secret Police has Blend — auto face-down
    expect(resolved.cards.find((c) => c.id === rebelCard.id)!.zone).toBe("hand");
  });

  it("allows choosing zero cards to play", () => {
    const { state, player, cg } = freshCommanderGeneralGame();
    const activated = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 0 });

    const resolved = act(activated, player, { type: "chooseTargets", targetIds: [] });
    expect(resolved.resolutionStack).toHaveLength(0);
  });

  it("remotely activates any number of your own Regime cards at its location, one at a time", () => {
    let { state, player, cg, loc } = freshCommanderGeneralGame();
    const other = state.players.find((p) => p.id !== player)!.id;
    const [guard1, guard2] = state.cards.filter((c) => c.defRef === "Republican Guard");
    const t1 = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen")!;
    const t2 = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen" && c.id !== t1.id,
    )!;
    state = placeInPlay(state, guard1!.id, loc, player);
    state = placeInPlay(state, guard2!.id, loc, player);
    state = placeInPlay(state, t1.id, loc, other);
    state = placeInPlay(state, t2.id, loc, other);
    state = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 1 });
    expect(state.resolutionStack).toHaveLength(1);

    // Round 1: activate guard1, resolve its own eliminate ability.
    state = act(state, player, {
      type: "chooseTargets",
      targetIds: [guard1!.id],
      remoteAbilityIndex: 0,
    });
    expect(state.resolutionStack).toHaveLength(2); // [CG loop frame, guard1's frame]
    state = act(state, player, { type: "chooseTargets", targetIds: [t1.id] });
    expect(state.resolutionStack).toHaveLength(1); // back to just the CG loop frame
    expect(state.cards.find((c) => c.id === t1.id)!.zone).toBe("eliminated");

    // Round 2: activate guard2 the same way.
    state = act(state, player, {
      type: "chooseTargets",
      targetIds: [guard2!.id],
      remoteAbilityIndex: 0,
    });
    state = act(state, player, { type: "chooseTargets", targetIds: [t2.id] });
    expect(state.resolutionStack).toHaveLength(1);
    expect(state.cards.find((c) => c.id === t2.id)!.zone).toBe("eliminated");

    // Done — submit no more targets to close the queue for good.
    const finished = act(state, player, { type: "chooseTargets", targetIds: [] });
    expect(finished.resolutionStack).toHaveLength(0);
    expect(finished.turn.usedAbilities).toContain(`${guard1!.id}#0`);
    expect(finished.turn.usedAbilities).toContain(`${guard2!.id}#0`);
    expect(finished.turn.usedAbilities).toContain(`${cg.id}#1`);
  });

  it("rejects remotely activating the same card+ability twice in the same queue", () => {
    let { state, player, cg, loc } = freshCommanderGeneralGame();
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    const t1 = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen")!;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, t1.id, loc, other);
    state = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 1 });
    state = act(state, player, { type: "chooseTargets", targetIds: [guard.id], remoteAbilityIndex: 0 });
    state = act(state, player, { type: "chooseTargets", targetIds: [t1.id] });

    expect(() =>
      act(state, player, { type: "chooseTargets", targetIds: [guard.id], remoteAbilityIndex: 0 }),
    ).toThrow();
  });

  it("cancels a pending ability outright once its own source card is eliminated", () => {
    // Direct check of the cancellation rule itself, independent of how the
    // source card came to be eliminated.
    const { state, player, cg } = freshCommanderGeneralGame();
    let s = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 1 });
    expect(s.resolutionStack).toHaveLength(1);

    s = {
      ...s,
      cards: s.cards.map((c) =>
        c.id === cg.id ? { ...c, zone: "eliminated" as const, locationId: undefined, faceUp: undefined } : c,
      ),
    };

    // Whatever is submitted is irrelevant — the ability is simply over.
    const resolved = act(s, player, { type: "chooseTargets", targetIds: [] });
    expect(resolved.resolutionStack).toHaveLength(0);
  });

  it("ends the 'activate any number' queue if Commander General dies during a nested alarm, without disturbing the in-flight activation", () => {
    let { state, player, cg, loc } = freshCommanderGeneralGame();
    const deathSquad = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Death Squad")!;
    const assassin = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Assassin")!;
    const deathSquadTarget = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen",
    )!;
    state = placeInPlay(state, deathSquad.id, loc, player);
    state = placeInPlay(state, assassin.id, loc, player); // the activator's own responding card
    state = placeInPlay(state, deathSquadTarget.id, loc, player);
    state = act(state, player, { type: "activateAbility", cardId: cg.id, abilityIndex: 1 });

    // Remotely activate Death Squad's alarm ability.
    state = act(state, player, {
      type: "chooseTargets",
      targetIds: [deathSquad.id],
      remoteAbilityIndex: 0,
    });
    expect(state.resolutionStack).toHaveLength(3); // [CG loop, Death Squad, alarm]

    const alarmFrame = state.resolutionStack[2] as AlarmResolutionFrame;
    expect(alarmFrame.triggeringPlayerId).toBe(player); // the activator, not Death Squad's controller (same here, but by rule)
    expect(alarmFrame.order.at(-1)).toBe(player); // activator (triggering player) responds last

    // Everyone else passes.
    for (const responder of alarmFrame.order.slice(0, -1)) {
      state = act(state, responder, { type: "passResponse" });
    }

    // The activator, responding last, uses their OWN Assassin (not Death
    // Squad, and not controlled by anyone else, so it doesn't shield
    // Commander General) to eliminate Commander General himself.
    state = act(state, player, {
      type: "useResponse",
      cardId: assassin.id,
      abilityIndex: 1,
      targetIds: [cg.id],
    });
    expect(state.cards.find((c) => c.id === cg.id)!.zone).toBe("eliminated");

    // Death Squad — the alarm's actual triggering character — survived,
    // so its own ability still resolves normally: back to
    // [CG loop, Death Squad], awaiting Death Squad's own targets.
    expect(state.resolutionStack).toHaveLength(2);
    state = act(state, player, { type: "chooseTargets", targetIds: [deathSquadTarget.id] });
    expect(state.cards.find((c) => c.id === deathSquadTarget.id)!.zone).toBe("eliminated");

    // Only now, with Commander General's own loop frame back on top, does
    // the ability actually end — the queue does not re-offer another card.
    expect(state.resolutionStack).toHaveLength(1);
    const closed = act(state, player, { type: "chooseTargets", targetIds: [] });
    expect(closed.resolutionStack).toHaveLength(0);
  });
});

// Suicide Bomber's alarm ability requires everyone in the response order
// to explicitly pass (unlike the reveal window, the alarm pass doesn't
// skip anyone) before chooseTargets can resolve the random draw.
function passWholeAlarm(state: GameState, alarmFrame: AlarmResolutionFrame) {
  for (const responder of alarmFrame.order) {
    state = act(state, responder, { type: "passResponse" });
  }
  return state;
}

describe("applyAction: multi-target eliminate", () => {
  it("eliminates every submitted target, not just the first (Death Squad, up to two)", () => {
    let state = freshGame(["a", "b", "c"]);
    const deathSquad = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Death Squad")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const [targetA, targetB] = state.cards.filter((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard");
    state = placeInPlay(state, deathSquad.id, loc, player);
    state = placeInPlay(state, targetA!.id, loc, other);
    state = placeInPlay(state, targetB!.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: deathSquad.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [targetA!.id, targetB!.id] });

    expect(resolved.cards.find((c) => c.id === targetA!.id)!.zone).toBe("eliminated");
    expect(resolved.cards.find((c) => c.id === targetB!.id)!.zone).toBe("eliminated");
    expect(resolved.resolutionStack).toHaveLength(0);
  });

  it("also eliminates every submitted target for a multi-target Response ability", () => {
    let state = freshGame(["a", "b", "c"]);
    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const deathSquad = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Death Squad")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, gunman.id, loc, player, false);
    state = act(state, player, { type: "draw" });
    const activated = act(state, player, { type: "activateAbility", cardId: gunman.id, abilityIndex: 0 });

    // Death Squad responds first in the alarm order, controlled by
    // whoever that turns out to be, so this doesn't assume table order.
    const alarmFrame = activated.resolutionStack[1] as AlarmResolutionFrame;
    const responder = alarmFrame.order[0]!;
    let s = placeInPlay(activated, deathSquad.id, loc, responder);
    const [targetA, targetB] = s.cards.filter((c) => c.defRef === "Republican Guard");
    s = placeInPlay(s, targetA!.id, loc, responder);
    s = placeInPlay(s, targetB!.id, loc, responder);

    const resolved = act(s, responder, {
      type: "useResponse",
      cardId: deathSquad.id,
      abilityIndex: 1,
      targetIds: [targetA!.id, targetB!.id],
    });

    expect(resolved.cards.find((c) => c.id === targetA!.id)!.zone).toBe("eliminated");
    expect(resolved.cards.find((c) => c.id === targetB!.id)!.zone).toBe("eliminated");
  });
});

// Walks all 3 steps of Suicide Bomber's sequenced ability (forced reveal,
// random eliminate, eliminate self) with empty targetIds, once the alarm
// has fully passed — for tests that only care about the end state.
function resolveSuicideBomberAbility(state: GameState, player: PlayerId): GameState {
  state = act(state, player, { type: "chooseTargets", targetIds: [] }); // forced reveal
  state = act(state, player, { type: "chooseTargets", targetIds: [] }); // random eliminate
  state = act(state, player, { type: "chooseTargets", targetIds: [] }); // eliminate self
  return state;
}

describe("applyAction: random target selection (Suicide Bomber)", () => {
  it("is deterministic — the same seed draws the same targets", () => {
    let stateA = freshGame(["a", "b", "c"], 42);
    const bomberA = stateA.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Suicide Bomber")!;
    const loc = stateA.board[0]!.id;
    const targetsA = stateA.cards
      .filter((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")
      .concat(stateA.cards.filter((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen"));
    const player = stateA.turn.currentPlayerId;
    const other = stateA.players.find((p) => p.id !== player)!.id;
    stateA = placeInPlay(stateA, bomberA.id, loc, player);
    for (const t of targetsA) stateA = placeInPlay(stateA, t.id, loc, other);
    stateA = act(stateA, player, { type: "draw" });
    stateA = act(stateA, player, { type: "activateAbility", cardId: bomberA.id, abilityIndex: 0 });
    let alarmFrame = stateA.resolutionStack[1] as AlarmResolutionFrame;
    stateA = passWholeAlarm(stateA, alarmFrame);
    const resolvedA = resolveSuicideBomberAbility(stateA, player);
    const eliminatedA = resolvedA.cards.filter((c) => c.zone === "eliminated").map((c) => c.id).sort();

    // Rebuild the identical scenario from scratch with the same seed.
    let stateB = freshGame(["a", "b", "c"], 42);
    const bomberB = stateB.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Suicide Bomber")!;
    const targetsB = stateB.cards
      .filter((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")
      .concat(stateB.cards.filter((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen"));
    stateB = placeInPlay(stateB, bomberB.id, loc, player);
    for (const t of targetsB) stateB = placeInPlay(stateB, t.id, loc, other);
    stateB = act(stateB, player, { type: "draw" });
    stateB = act(stateB, player, { type: "activateAbility", cardId: bomberB.id, abilityIndex: 0 });
    alarmFrame = stateB.resolutionStack[1] as AlarmResolutionFrame;
    stateB = passWholeAlarm(stateB, alarmFrame);
    const resolvedB = resolveSuicideBomberAbility(stateB, player);
    const eliminatedB = resolvedB.cards.filter((c) => c.zone === "eliminated").map((c) => c.id).sort();

    expect(eliminatedA).toEqual(eliminatedB);
  });

  it("never touches the Protected fallback pool when the primary pool already has enough", () => {
    let state = freshGame(["a", "b", "c"]);
    const bomber = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Suicide Bomber")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const unprotected = state.cards
      .filter((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")
      .concat(state.cards.filter((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen"));
    expect(unprotected).toHaveLength(4); // exactly enough — no need to dip into fallback
    const protectedLeader = state.cards.find((c) => c.kind === "leader" && c.defRef === "Head of Security");
    state = placeInPlay(state, bomber.id, loc, player);
    for (const t of unprotected) state = placeInPlay(state, t.id, loc, other);
    if (protectedLeader) state = placeInPlay(state, protectedLeader.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: bomber.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    const resolved = resolveSuicideBomberAbility(state, player);

    const eliminatedIds = new Set(resolved.cards.filter((c) => c.zone === "eliminated").map((c) => c.id));
    expect(eliminatedIds).toEqual(new Set([...unprotected.map((c) => c.id), bomber.id]));
    if (protectedLeader) expect(eliminatedIds.has(protectedLeader.id)).toBe(false);
  });

  it("falls back to Protected candidates once the primary pool runs out", () => {
    // 8 players so both leaders needed here are guaranteed to be dealt.
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const bomber = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Suicide Bomber")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const primary = [
      state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!,
      state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen")!,
    ];
    const fallback = [
      state.cards.find((c) => c.defRef === "Head of Security")!,
      state.cards.find((c) => c.defRef === "Commander General")!,
    ];
    state = placeInPlay(state, bomber.id, loc, player);
    for (const t of [...primary, ...fallback]) state = placeInPlay(state, t.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: bomber.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    const resolved = resolveSuicideBomberAbility(state, player);

    // Only 4 candidates exist total (2 primary + 2 fallback) and 4 are
    // needed — everyone gets eliminated, Protected included, plus the
    // Bomber itself in the final step.
    const eliminatedIds = new Set(resolved.cards.filter((c) => c.zone === "eliminated").map((c) => c.id));
    for (const t of [...primary, ...fallback]) expect(eliminatedIds.has(t.id)).toBe(true);
    expect(eliminatedIds.has(bomber.id)).toBe(true);
  });

  it("rejects submitting explicit targets for the random-draw step — they're drawn automatically", () => {
    let state = freshGame(["a", "b", "c"]);
    const bomber = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Suicide Bomber")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const someCard = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")!;
    state = placeInPlay(state, bomber.id, loc, player);
    state = placeInPlay(state, someCard.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: bomber.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);
    state = act(state, player, { type: "chooseTargets", targetIds: [] }); // forced reveal step

    expect(() =>
      act(state, player, { type: "chooseTargets", targetIds: [someCard.id] }),
    ).toThrow();
  });

  it("walks the full sequence: forced reveal, then random eliminate, then eliminate itself", () => {
    let state = freshGame(["a", "b", "c"]);
    const bomber = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Suicide Bomber")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const unprotected = state.cards
      .filter((c) => c.kind === "nonLeader" && c.defRef === "Republican Guard")
      .concat(state.cards.filter((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen"));
    const hiddenWife = state.cards.find((c) => c.defRef === "Wife");
    state = placeInPlay(state, bomber.id, loc, player);
    for (const t of unprotected) state = placeInPlay(state, t.id, loc, other);
    if (hiddenWife) state = placeInPlay(state, hiddenWife.id, loc, other, false); // face-down
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: bomber.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    // Step 1: forced reveal — the hidden Protected+Blend character gets
    // flipped face-up automatically, no player choice.
    state = act(state, player, { type: "chooseTargets", targetIds: [] });
    if (hiddenWife) expect(state.cards.find((c) => c.id === hiddenWife.id)!.faceUp).toBe(true);
    expect(state.resolutionStack).toHaveLength(1); // still mid-ability

    // Step 2: random eliminate — 4 targets drawn automatically.
    state = act(state, player, { type: "chooseTargets", targetIds: [] });
    expect(state.cards.filter((c) => c.zone === "eliminated")).toHaveLength(4);
    expect(state.resolutionStack).toHaveLength(1); // self-elimination step still pending

    // Step 3: eliminate itself — only now does the ability actually end.
    state = act(state, player, { type: "chooseTargets", targetIds: [] });
    expect(state.cards.find((c) => c.id === bomber.id)!.zone).toBe("eliminated");
    expect(state.resolutionStack).toHaveLength(0);
  });
});

describe("applyAction: conditionals (if/bindings)", () => {
  it("Secret Police: revealed rebel target is eliminated", () => {
    let state = freshGame(["a", "b", "c"]);
    const police = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Secret Police")!;
    const rebelTarget = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, police.id, loc, player);
    state = placeInPlay(state, rebelTarget.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: police.id, abilityIndex: 0 });

    // Step 1: reveal — the player chooses which blended card to reveal.
    state = act(state, player, { type: "chooseTargets", targetIds: [rebelTarget.id] });
    expect(state.cards.find((c) => c.id === rebelTarget.id)!.faceUp).toBe(true);
    expect(state.resolutionStack).toHaveLength(1); // the if-branch is still pending

    // Step 2: the branch (rebel -> eliminate it) resolves automatically.
    state = act(state, player, { type: "chooseTargets", targetIds: [] });
    expect(state.cards.find((c) => c.id === rebelTarget.id)!.zone).toBe("eliminated");
    expect(state.cards.find((c) => c.id === police.id)!.zone).toBe("inPlay");
    expect(state.resolutionStack).toHaveLength(0);
  });

  it("Secret Police: revealed regime target eliminates the Police instead", () => {
    let state = freshGame(["a", "b", "c"]);
    const police = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Secret Police")!;
    const regimeTarget = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, police.id, loc, player);
    state = placeInPlay(state, regimeTarget.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: police.id, abilityIndex: 0 });

    state = act(state, player, { type: "chooseTargets", targetIds: [regimeTarget.id] });
    state = act(state, player, { type: "chooseTargets", targetIds: [] });

    expect(state.cards.find((c) => c.id === police.id)!.zone).toBe("eliminated");
    expect(state.cards.find((c) => c.id === regimeTarget.id)!.zone).toBe("inPlay");
    expect(state.resolutionStack).toHaveLength(0);
  });

  it("Guerrilla Commander: revealed regime target is eliminated", () => {
    // 8 players so Guerrilla Commander is guaranteed to be dealt (leaders
    // are dealt one per player from a pool of 8, not always all present).
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const gc = state.cards.find((c) => c.kind === "leader" && c.defRef === "Guerrilla Commander")!;
    const regimeTarget = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, gc.id, loc, player);
    state = placeInPlay(state, regimeTarget.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: gc.id, abilityIndex: 1 });

    state = act(state, player, { type: "chooseTargets", targetIds: [regimeTarget.id] });
    state = act(state, player, { type: "chooseTargets", targetIds: [] });

    expect(state.cards.find((c) => c.id === regimeTarget.id)!.zone).toBe("eliminated");
    expect(state.resolutionStack).toHaveLength(0);
  });

  it("Guerrilla Commander: revealed non-leader rebel target is taken under control", () => {
    // 8 players so Guerrilla Commander is guaranteed to be dealt (leaders
    // are dealt one per player from a pool of 8, not always all present).
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const gc = state.cards.find((c) => c.kind === "leader" && c.defRef === "Guerrilla Commander")!;
    const rebelTarget = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, gc.id, loc, player);
    state = placeInPlay(state, rebelTarget.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: gc.id, abilityIndex: 1 });

    state = act(state, player, { type: "chooseTargets", targetIds: [rebelTarget.id] });
    state = act(state, player, { type: "chooseTargets", targetIds: [] });

    const resolvedTarget = state.cards.find((c) => c.id === rebelTarget.id)!;
    expect(resolvedTarget.zone).toBe("inPlay");
    expect(resolvedTarget.controller).toBe(player);
    expect(state.resolutionStack).toHaveLength(0);
  });

  it("Guerrilla Commander: a revealed rebel leader matches neither branch — nothing happens", () => {
    // 8 players so Guerrilla Commander is guaranteed to be dealt (leaders
    // are dealt one per player from a pool of 8, not always all present).
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const gc = state.cards.find((c) => c.kind === "leader" && c.defRef === "Guerrilla Commander")!;
    const rebelLeaderTarget = state.cards.find((c) => c.kind === "leader" && c.defRef === "Puppet-Master")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, gc.id, loc, player);
    state = placeInPlay(state, rebelLeaderTarget.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: gc.id, abilityIndex: 1 });

    state = act(state, player, { type: "chooseTargets", targetIds: [rebelLeaderTarget.id] });
    state = act(state, player, { type: "chooseTargets", targetIds: [] });

    const resolvedTarget = state.cards.find((c) => c.id === rebelLeaderTarget.id)!;
    expect(resolvedTarget.zone).toBe("inPlay");
    expect(resolvedTarget.controller).toBe(other); // no gainControl — didn't qualify
    expect(state.resolutionStack).toHaveLength(0);
  });

  it("Opposition Leader: reveals at any location, not just its own", () => {
    // 8 players so Opposition Leader is guaranteed to be dealt.
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppLeader = state.cards.find((c) => c.kind === "leader" && c.defRef === "Opposition Leader")!;
    const rebelTarget = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const ownLoc = state.board[0]!.id;
    const otherLoc = state.board[1]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, oppLeader.id, ownLoc, player);
    state = placeInPlay(state, rebelTarget.id, otherLoc, other, false); // a different location entirely
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: oppLeader.id, abilityIndex: 2 });

    state = act(state, player, { type: "chooseTargets", targetIds: [rebelTarget.id] });
    state = act(state, player, { type: "chooseTargets", targetIds: [] });

    const resolvedTarget = state.cards.find((c) => c.id === rebelTarget.id)!;
    expect(resolvedTarget.controller).toBe(player);
    expect(state.resolutionStack).toHaveLength(0);
  });
});

describe("applyAction: passives", () => {
  it("Mr. Lucky's replacement passive returns him to hand instead of eliminating him", () => {
    let state = freshGame(["a", "b", "c"]);
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const mrLucky = state.cards.find((c) => c.defRef === "Mr. Lucky")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, mrLucky.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [mrLucky.id] });

    const resolvedLucky = resolved.cards.find((c) => c.id === mrLucky.id)!;
    expect(resolvedLucky.zone).toBe("hand");
    expect(resolvedLucky.controller).toBe(other);
    expect(resolved.resolutionStack).toHaveLength(0); // a replacement, not a real elimination — no reactive trigger
  });

  it("Celebrity's reactive passive opens an all-players window once the eliminating action fully resolves", () => {
    let state = freshGame(["a", "b", "c"]);
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const celebrity = state.cards.find((c) => c.defRef === "Celebrity")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, celebrity.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [celebrity.id] });

    expect(resolved.cards.find((c) => c.id === celebrity.id)!.zone).toBe("eliminated");
    expect(resolved.resolutionStack).toHaveLength(1);
    const frame = resolved.resolutionStack[0] as ReactivePassiveWindowFrame;
    expect(frame.kind).toBe("reactivePassiveWindow");
    expect(frame.locationId).toBe(loc);
    expect(frame.faction).toBeUndefined(); // no faction restriction, unlike Martyr
    expect(frame.order).toHaveLength(3); // every player, not just the controller
    expect(frame.order.at(-1)).toBe(player); // the eliminating player's turn comes last, same alarm-pass convention

    let s = resolved;
    for (const p of frame.order) s = act(s, p, { type: "passReactive" });
    expect(s.resolutionStack).toHaveLength(0);
  });

  it("lets a player actually play a card during Celebrity's window, ignoring location restrictions", () => {
    let state = freshGame(["a", "b", "c"]);
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const celebrity = state.cards.find((c) => c.defRef === "Celebrity")!;
    // Republican Guard is Secure-only — playing it at a Street location
    // during the window only works if location restrictions are ignored.
    const secondGuard = state.cards.filter((c) => c.defRef === "Republican Guard")[1]!;
    const streetLoc = state.board.find((l) => l.type === "Street")!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, guard.id, streetLoc, player);
    state = placeInPlay(state, celebrity.id, streetLoc, other);
    state = placeInHand(state, secondGuard.id, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });
    state = act(state, player, { type: "chooseTargets", targetIds: [celebrity.id] });

    const frame = state.resolutionStack[0] as ReactivePassiveWindowFrame;
    for (const p of frame.order) {
      if (p === other) {
        state = act(state, p, { type: "playReactive", cardIds: [secondGuard.id] });
      } else {
        state = act(state, p, { type: "passReactive" });
      }
    }

    const played = state.cards.find((c) => c.id === secondGuard.id)!;
    expect(played.zone).toBe("inPlay");
    expect(played.locationId).toBe(streetLoc); // normally illegal for a Secure-only card
    expect(state.resolutionStack).toHaveLength(0);
  });

  it("Martyr's reactive passive is scoped to its controller only, and only rebel cards", () => {
    let state = freshGame(["a", "b", "c"]);
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const martyr = state.cards.find((c) => c.defRef === "Martyr")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = placeInPlay(state, guard.id, loc, player);
    state = placeInPlay(state, martyr.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: guard.id, abilityIndex: 0 });
    state = act(state, player, { type: "chooseTargets", targetIds: [martyr.id] });

    const frame = state.resolutionStack[0] as ReactivePassiveWindowFrame;
    expect(frame.order).toEqual([other]); // Martyr's own controller only
    expect(frame.faction).toBe("Rebel");

    const regimeCard = state.cards.filter((c) => c.defRef === "Republican Guard")[1]!;
    state = placeInHand(state, regimeCard.id, other);
    expect(() => act(state, other, { type: "playReactive", cardIds: [regimeCard.id] })).toThrow();

    const rebelCard = state.cards.find((c) => c.defRef === "Assassin")!;
    state = placeInHand(state, rebelCard.id, other);
    state = act(state, other, { type: "playReactive", cardIds: [rebelCard.id] });

    expect(state.cards.find((c) => c.id === rebelCard.id)!.zone).toBe("inPlay");
    expect(state.resolutionStack).toHaveLength(0); // only 1 player in order — now done
  });

  it("drains multiple queued reactive triggers one window at a time", () => {
    let state = freshGame(["a", "b", "c"]);
    const bomber = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Suicide Bomber")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const celebrity = state.cards.find((c) => c.defRef === "Celebrity")!;
    const martyr = state.cards.find((c) => c.defRef === "Martyr")!;
    const filler = state.cards.filter((c) => c.defRef === "Republican Guard"); // 2 copies
    state = placeInPlay(state, bomber.id, loc, player);
    state = placeInPlay(state, celebrity.id, loc, other);
    state = placeInPlay(state, martyr.id, loc, other);
    for (const f of filler) state = placeInPlay(state, f.id, loc, other);
    // Exactly 4 candidates (Celebrity, Martyr, 2x Republican Guard) for a
    // count-4 random draw — every one of them gets eliminated regardless
    // of shuffle order, so both reactive triggers fire deterministically.
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: bomber.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);
    state = act(state, player, { type: "chooseTargets", targetIds: [] }); // forced reveal
    state = act(state, player, { type: "chooseTargets", targetIds: [] }); // random eliminate
    state = act(state, player, { type: "chooseTargets", targetIds: [] }); // eliminate self

    expect(state.resolutionStack).toHaveLength(1);
    let frame = state.resolutionStack[0] as ReactivePassiveWindowFrame;
    const firstSource = frame.sourceCardId;
    for (const p of frame.order) state = act(state, p, { type: "passReactive" });

    // First window closed — the second queued trigger's window opens next.
    expect(state.resolutionStack).toHaveLength(1);
    frame = state.resolutionStack[0] as ReactivePassiveWindowFrame;
    expect(frame.sourceCardId).not.toBe(firstSource);
    expect([celebrity.id, martyr.id]).toContain(frame.sourceCardId);
    for (const p of frame.order) state = act(state, p, { type: "passReactive" });

    expect(state.resolutionStack).toHaveLength(0);
  });

  it("Bodyguard follows the President when he moves to a new location", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const bodyguard = state.cards.find((c) => c.defRef === "Bodyguard")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, bodyguard.id, presidentLoc, player);
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, motorcade.id, player);

    const moved = act(state, player, { type: "playMotorcade", cardId: motorcade.id });

    expect(moved.president.locationId).not.toBe(presidentLoc);
    expect(moved.cards.find((c) => c.id === bodyguard.id)!.locationId).toBe(moved.president.locationId);
  });

  it("does not move a Bodyguard that wasn't at the President's location", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const elsewhere = state.board.find((l) => l.id !== presidentLoc)!.id;
    const bodyguard = state.cards.find((c) => c.defRef === "Bodyguard")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, bodyguard.id, elsewhere, player);
    const motorcade = state.cards.find((c) => c.kind === "motorcade" && c.zone === "deck")!;
    state = placeInHand(state, motorcade.id, player);

    const moved = act(state, player, { type: "playMotorcade", cardId: motorcade.id });

    expect(moved.cards.find((c) => c.id === bodyguard.id)!.locationId).toBe(elsewhere);
  });
});

describe("applyAction: remaining card content", () => {
  it("Head of Security's Response eliminates a target (reuses the standard pattern)", () => {
    // 8 players so Head of Security is guaranteed to be dealt.
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const gunman = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Gunman")!;
    const hos = state.cards.find((c) => c.kind === "leader" && c.defRef === "Head of Security")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, gunman.id, loc, player, false);
    state = act(state, player, { type: "draw" });
    const activated = act(state, player, { type: "activateAbility", cardId: gunman.id, abilityIndex: 0 });
    const alarmFrame = activated.resolutionStack[1] as AlarmResolutionFrame;
    const responder = alarmFrame.order[0]!;
    let s = placeInPlay(activated, hos.id, loc, responder);
    const target = s.cards.find((c) => c.defRef === "Republican Guard")!;
    s = placeInPlay(s, target.id, loc, responder);

    const resolved = act(s, responder, { type: "useResponse", cardId: hos.id, abilityIndex: 1, targetIds: [target.id] });
    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });

  it("Heir Apparent gains 2 actions", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const heir = state.cards.find((c) => c.kind === "leader" && c.defRef === "Heir Apparent")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, heir.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: heir.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [] });

    expect(resolved.turn.actionsRemaining).toBe(3); // 2 - 1 (spent activating) + 2 (gained)
  });

  it("Opposition Leader draws 3 cards", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppLeader = state.cards.find((c) => c.kind === "leader" && c.defRef === "Opposition Leader")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, oppLeader.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });
    const before = state.cards.filter((c) => c.zone === "hand" && c.controller === player).length;
    state = act(state, player, { type: "activateAbility", cardId: oppLeader.id, abilityIndex: 1 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [] });

    expect(resolved.cards.filter((c) => c.zone === "hand" && c.controller === player).length).toBe(before + 3);
  });

  it("Opposition Leader places 2 rebels, each at its own chosen location", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppLeader = state.cards.find((c) => c.kind === "leader" && c.defRef === "Opposition Leader")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, oppLeader.id, state.board[0]!.id, player);
    const [rebelA, rebelB] = state.cards.filter((c) => c.defRef === "Gunman");
    state = placeInHand(state, rebelA!.id, player);
    state = placeInHand(state, rebelB!.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: oppLeader.id, abilityIndex: 0 });
    const locX = state.board[1]!.id; // HQ (Secure) — Gunman is normally Street-only, ignored here
    const locY = state.board[3]!.id; // Arena (Public)

    const resolved = act(state, player, {
      type: "chooseTargets",
      targetIds: [rebelA!.id, rebelB!.id],
      locationIds: [locX, locY],
    });

    expect(resolved.cards.find((c) => c.id === rebelA!.id)!.locationId).toBe(locX);
    expect(resolved.cards.find((c) => c.id === rebelB!.id)!.locationId).toBe(locY);
  });

  it("Master Assassin returns to hand then plays a card, at its original location", () => {
    let state = freshGame(["a", "b", "c"]);
    const assassin = state.cards.find((c) => c.kind === "leader" && c.defRef === "Master Assassin")!;
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, assassin.id, loc, player);
    const otherCard = state.cards.find((c) => c.defRef === "Gunman")!;
    state = placeInHand(state, otherCard.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: assassin.id, abilityIndex: 0 });

    const afterReturn = act(state, player, { type: "chooseTargets", targetIds: [] });
    expect(afterReturn.cards.find((c) => c.id === assassin.id)!.zone).toBe("hand");

    const resolved = act(afterReturn, player, { type: "chooseTargets", targetIds: [otherCard.id] });
    expect(resolved.cards.find((c) => c.id === otherCard.id)!.zone).toBe("inPlay");
    expect(resolved.cards.find((c) => c.id === otherCard.id)!.locationId).toBe(loc);
    expect(resolved.resolutionStack).toHaveLength(0);
  });

  it("Master Assassin eliminates a target then blends itself back down", () => {
    let state = freshGame(["a", "b", "c"]);
    const assassin = state.cards.find((c) => c.kind === "leader" && c.defRef === "Master Assassin")!;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, assassin.id, loc, player);
    const target = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = placeInPlay(state, target.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: assassin.id, abilityIndex: 1 });

    const afterEliminate = act(state, player, { type: "chooseTargets", targetIds: [target.id] });
    expect(afterEliminate.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");

    const resolved = act(afterEliminate, player, { type: "chooseTargets", targetIds: [] });
    expect(resolved.cards.find((c) => c.id === assassin.id)!.faceUp).toBe(false);
    expect(resolved.resolutionStack).toHaveLength(0);
  });

  it("Master Assassin's alarm ability eliminates exactly 2 targets", () => {
    let state = freshGame(["a", "b", "c"]);
    const assassin = state.cards.find((c) => c.kind === "leader" && c.defRef === "Master Assassin")!;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, assassin.id, loc, player);
    const [targetA, targetB] = state.cards.filter((c) => c.defRef === "Republican Guard");
    state = placeInPlay(state, targetA!.id, loc, other);
    state = placeInPlay(state, targetB!.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: assassin.id, abilityIndex: 2 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [targetA!.id, targetB!.id] });

    expect(resolved.cards.find((c) => c.id === targetA!.id)!.zone).toBe("eliminated");
    expect(resolved.cards.find((c) => c.id === targetB!.id)!.zone).toBe("eliminated");
  });

  it("Traffic Cop moves the President to an adjacent location of the player's choice", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const idx = state.board.findIndex((l) => l.id === presidentLoc);
    const forward = state.board[idx + 1]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, trafficCop.id, presidentLoc, player);
    state = act(state, player, { type: "activateAbility", cardId: trafficCop.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [], locationIds: [forward] });

    expect(resolved.president.locationId).toBe(forward);
  });

  it("rejects a non-adjacent destination for Traffic Cop", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const idx = state.board.findIndex((l) => l.id === presidentLoc);
    const twoAway = state.board[idx + 2]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, trafficCop.id, presidentLoc, player);
    state = act(state, player, { type: "activateAbility", cardId: trafficCop.id, abilityIndex: 0 });

    expect(() => act(state, player, { type: "chooseTargets", targetIds: [], locationIds: [twoAway] })).toThrow();
  });

  it("rejects using Traffic Cop's ability from a different location than the President", () => {
    let state = freshGame();
    state = enterPresident(state);
    const presidentLoc = state.president.locationId!;
    const idx = state.board.findIndex((l) => l.id === presidentLoc);
    const elsewhere = state.board[idx + 1]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const player = state.turn.currentPlayerId;
    state = placeInPlay(state, trafficCop.id, elsewhere, player);
    state = act(state, player, { type: "activateAbility", cardId: trafficCop.id, abilityIndex: 0 });

    expect(() => act(state, player, { type: "chooseTargets", targetIds: [], locationIds: [presidentLoc] })).toThrow();
  });

  it("Army Sniper can eliminate a rebel target at its own or an adjacent location", () => {
    let state = freshGame(["a", "b", "c"]);
    const sniper = state.cards.find((c) => c.defRef === "Army Sniper")!;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[1]!.id; // HQ — adjacent to loc-0 and loc-2
    state = placeInPlay(state, sniper.id, loc, player);
    const adjTarget = state.cards.find((c) => c.defRef === "Gunman")!;
    state = placeInPlay(state, adjTarget.id, state.board[0]!.id, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: sniper.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [adjTarget.id] });

    expect(resolved.cards.find((c) => c.id === adjTarget.id)!.zone).toBe("eliminated");
  });

  it("Army Sniper cannot reach a non-adjacent location", () => {
    let state = freshGame(["a", "b", "c"]);
    const sniper = state.cards.find((c) => c.defRef === "Army Sniper")!;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[1]!.id;
    state = placeInPlay(state, sniper.id, loc, player);
    const farTarget = state.cards.find((c) => c.defRef === "Gunman")!;
    state = placeInPlay(state, farTarget.id, state.board[3]!.id, other); // not adjacent to loc-1
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: sniper.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    expect(() => act(state, player, { type: "chooseTargets", targetIds: [farTarget.id] })).toThrow();
  });

  it("Insurgent Sniper can only reach an adjacent location, not its own", () => {
    let state = freshGame(["a", "b", "c"]);
    const sniper = state.cards.find((c) => c.defRef === "Insurgent Sniper")!;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[1]!.id;
    state = placeInPlay(state, sniper.id, loc, player);
    const selfTarget = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = placeInPlay(state, selfTarget.id, loc, other); // at the sniper's OWN location — ineligible
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: sniper.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    expect(() => act(state, player, { type: "chooseTargets", targetIds: [selfTarget.id] })).toThrow();
  });

  it("Rebel Soldier's alarm ability eliminates one or two regime targets", () => {
    let state = freshGame(["a", "b", "c"]);
    const soldier = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    const loc = state.board[0]!.id;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const target = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = placeInPlay(state, soldier.id, loc, player);
    state = placeInPlay(state, target.id, loc, other);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: soldier.id, abilityIndex: 0 });
    const alarmFrame = state.resolutionStack[1] as AlarmResolutionFrame;
    state = passWholeAlarm(state, alarmFrame);

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [target.id] });

    expect(resolved.cards.find((c) => c.id === target.id)!.zone).toBe("eliminated");
  });

  it("Angry Mob triggers an alarm at its own location, no upfront ability-level alarm frame", () => {
    let state = freshGame(["a", "b", "c"]);
    const mob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, mob.id, loc, player);
    state = act(state, player, { type: "draw" });

    const activated = act(state, player, { type: "activateAbility", cardId: mob.id, abilityIndex: 0 });
    expect(activated.resolutionStack).toHaveLength(1); // just the ability frame — no alarm yet

    const resolved = act(activated, player, { type: "chooseTargets", targetIds: [] });
    expect(resolved.resolutionStack).toHaveLength(1);
    const alarmFrame = resolved.resolutionStack[0] as AlarmResolutionFrame;
    expect(alarmFrame.kind).toBe("alarmResolution");
    expect(alarmFrame.locationId).toBe(loc);

    const done = passWholeAlarm(resolved, alarmFrame);
    expect(done.resolutionStack).toHaveLength(0);
  });

  it("Anarchist triggers an alarm at a chosen location", () => {
    let state = freshGame(["a", "b", "c"]);
    const anarchist = state.cards.find((c) => c.defRef === "Anarchist")!;
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const chosen = state.board[3]!.id;
    state = placeInPlay(state, anarchist.id, loc, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: anarchist.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [], locationIds: [chosen] });

    const alarmFrame = resolved.resolutionStack[0] as AlarmResolutionFrame;
    expect(alarmFrame.locationId).toBe(chosen);
  });

  it("Puppet-Master's 'Play 2 cards' respects normal location-type restrictions", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const pm = state.cards.find((c) => c.kind === "leader" && c.defRef === "Puppet-Master")!;
    const player = state.turn.currentPlayerId;
    const secureLoc = state.board.find((l) => l.type === "Secure")!.id;
    state = placeInPlay(state, pm.id, secureLoc, player);
    const [guard1, guard2] = state.cards.filter((c) => c.defRef === "Republican Guard"); // Secure-only, legal here
    state = placeInHand(state, guard1!.id, player);
    state = placeInHand(state, guard2!.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: pm.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [guard1!.id, guard2!.id] });

    expect(resolved.cards.find((c) => c.id === guard1!.id)!.zone).toBe("inPlay");
    expect(resolved.cards.find((c) => c.id === guard2!.id)!.zone).toBe("inPlay");
  });

  it("rejects a Puppet-Master play whose location type doesn't allow the destination", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const pm = state.cards.find((c) => c.kind === "leader" && c.defRef === "Puppet-Master")!;
    const player = state.turn.currentPlayerId;
    const publicLoc = state.board.find((l) => l.type === "Public")!.id;
    state = placeInPlay(state, pm.id, publicLoc, player);
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!; // Secure-only
    const soldier = state.cards.find((c) => c.defRef === "Rebel Soldier")!; // Street-only
    state = placeInHand(state, guard.id, player);
    state = placeInHand(state, soldier.id, player);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: pm.id, abilityIndex: 0 });

    expect(() => act(state, player, { type: "chooseTargets", targetIds: [guard.id, soldier.id] })).toThrow();
  });

  it("Journalist peeks without publicly revealing the card", () => {
    let state = freshGame(["a", "b", "c"]);
    const journalist = state.cards.find((c) => c.defRef === "Journalist")!;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    state = placeInPlay(state, journalist.id, loc, player);
    const target = state.cards.find((c) => c.defRef === "Gunman")!;
    state = placeInPlay(state, target.id, loc, other, false);
    state = act(state, player, { type: "draw" });
    state = act(state, player, { type: "activateAbility", cardId: journalist.id, abilityIndex: 0 });

    const resolved = act(state, player, { type: "chooseTargets", targetIds: [target.id] });

    expect(resolved.cards.find((c) => c.id === target.id)!.faceUp).toBe(false); // stays hidden — a peek, not a reveal
    expect(resolved.resolutionStack).toHaveLength(0);
  });
});
