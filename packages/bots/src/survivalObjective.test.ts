import { cardData, setupGame, winConditions } from "@rev-day/engine";
import type { GameState } from "@rev-day/engine";
import { describe, expect, it } from "vitest";
import { isEscortedLocation, leaderNeedsEscort } from "./survivalObjective";

function freshGame(playerIds: readonly string[] = ["a", "b", "c"], seed = 1): GameState {
  return setupGame({ playerIds, seed, cardData });
}

function place(state: GameState, cardId: string, locationId: string, controller: string, faceUp = true): GameState {
  return {
    ...state,
    cards: state.cards.map((c) => (c.id === cardId ? { ...c, zone: "inPlay" as const, locationId, controller, faceUp } : c)),
  };
}

describe("leaderNeedsEscort", () => {
  it.each(["Head of Security", "Commander General", "Heir Apparent", "Opposition Leader", "Puppet-Master"])(
    "is true for %s (Protected + survives)",
    (defRef) => {
      expect(leaderNeedsEscort(cardData, winConditions, defRef)).toBe(true);
    },
  );

  it("is false for Master Assassin (survives, but Blend rather than Protected)", () => {
    expect(leaderNeedsEscort(cardData, winConditions, "Master Assassin")).toBe(false);
  });

  it("is false for Wife (Protected, but no survives predicate)", () => {
    expect(leaderNeedsEscort(cardData, winConditions, "Wife")).toBe(false);
  });

  it("is false for Guerrilla Commander (no survives predicate at all)", () => {
    expect(leaderNeedsEscort(cardData, winConditions, "Guerrilla Commander")).toBe(false);
  });

  it("is false for an unknown defRef", () => {
    expect(leaderNeedsEscort(cardData, winConditions, "Not A Real Leader")).toBe(false);
  });
});

describe("isEscortedLocation", () => {
  it("is true when this player controls a visible, non-Protected, same-faction card there", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!; // Regime, no attributes
    state = place(state, guard.id, loc, player);
    expect(isEscortedLocation(state, cardData, player, "Regime", loc)).toBe(true);
  });

  it("is false when nothing is there at all", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    expect(isEscortedLocation(state, cardData, player, "Regime", state.board[0]!.id)).toBe(false);
  });

  it("is false when the only card there is the wrong faction", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const soldier = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    state = place(state, soldier.id, loc, player);
    expect(isEscortedLocation(state, cardData, player, "Regime", loc)).toBe(false);
  });

  it("is false when the only same-faction card there is itself Protected", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const commanderGeneral = state.cards.find((c) => c.defRef === "Commander General")!; // Regime, Protected
    state = place(state, commanderGeneral.id, loc, player);
    expect(isEscortedLocation(state, cardData, player, "Regime", loc)).toBe(false);
  });

  it("is false when the only same-faction card there is hidden (Blend, face-down)", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const secretPolice = state.cards.find((c) => c.defRef === "Secret Police")!; // Regime, Blend
    state = place(state, secretPolice.id, loc, player, false);
    expect(isEscortedLocation(state, cardData, player, "Regime", loc)).toBe(false);
  });

  it("is true once that same hidden card is revealed (face-up)", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const secretPolice = state.cards.find((c) => c.defRef === "Secret Police")!;
    state = place(state, secretPolice.id, loc, player, true);
    expect(isEscortedLocation(state, cardData, player, "Regime", loc)).toBe(true);
  });

  it("is false when the matching card is controlled by a different player", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = place(state, guard.id, loc, other);
    expect(isEscortedLocation(state, cardData, player, "Regime", loc)).toBe(false);
  });

  it("excludes a specific card id when checking, e.g. so a leader can't count itself", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = place(state, guard.id, loc, player);
    expect(isEscortedLocation(state, cardData, player, "Regime", loc, guard.id)).toBe(false);
  });
});
