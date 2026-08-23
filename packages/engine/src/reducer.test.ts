import { describe, expect, it } from "vitest";
import { cardData } from "./data/cardData";
import { applyAction } from "./reducer";
import type { Action } from "./actions";
import type { GameState, PlayerId } from "./state/game";
import type { AlarmResolutionFrame } from "./state/resolution";
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

  it("rejects an alarm-triggering ability (not yet implemented)", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const deathSquad = state.cards.find((c) => c.kind === "nonLeader" && c.defRef === "Death Squad")!;
    state = placeInPlay(state, deathSquad.id, state.board[0]!.id, player);
    state = act(state, player, { type: "draw" });

    expect(() =>
      act(state, player, { type: "activateAbility", cardId: deathSquad.id, abilityIndex: 0 }),
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
    const target = state.cards.find((c) => c.kind === "nonLeader" && c.id !== gunman.id)!;
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
    });
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
