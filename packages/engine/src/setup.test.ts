import { describe, expect, it } from "vitest";
import { cardData } from "./data/cardData";
import { setupGame } from "./setup";

const deckEligibleTotal =
  cardData.non_leader_cards.reduce((sum, c) => sum + c.copies, 0) + cardData.motorcade.count_in_deck;

describe("setupGame", () => {
  it("deals one leader per player and sets the rest aside entirely", () => {
    const state = setupGame({ playerIds: ["a", "b", "c"], seed: 1, cardData });
    const leaders = state.cards.filter((c) => c.kind === "leader");
    expect(leaders).toHaveLength(3);
    expect(new Set(leaders.map((c) => c.controller))).toEqual(new Set(["a", "b", "c"]));
    // Total cards = 3 dealt leaders + every non-leader/motorcade instance
    // (the other 5 leaders never enter the game at all).
    expect(state.cards).toHaveLength(3 + deckEligibleTotal);
  });

  it("deals a 5-card hand (leader + 4) under 6 players", () => {
    const state = setupGame({ playerIds: ["a", "b", "c"], seed: 1, cardData });
    for (const playerId of ["a", "b", "c"]) {
      const hand = state.cards.filter((c) => c.zone === "hand" && c.controller === playerId);
      expect(hand).toHaveLength(5);
    }
  });

  it("deals leader-only hands at 6+ players (no draw up to 5)", () => {
    const playerIds = ["a", "b", "c", "d", "e", "f"];
    const state = setupGame({ playerIds, seed: 1, cardData });
    for (const playerId of playerIds) {
      const hand = state.cards.filter((c) => c.zone === "hand" && c.controller === playerId);
      expect(hand).toHaveLength(1);
      expect(hand[0]!.kind).toBe("leader");
    }
  });

  it("starts the President out of play and the turn machine at draw phase", () => {
    const state = setupGame({ playerIds: ["a", "b"], seed: 1, cardData });
    expect(state.president).toEqual({ status: "notEntered", locationId: null });
    expect(state.turn.phase).toBe("draw");
    expect(state.turn.actionsRemaining).toBe(2);
    expect(state.turn.endgameTurnsRemaining).toBeNull();
    expect(state.players.map((p) => p.id)).toContain(state.turn.currentPlayerId);
    expect(state.resolutionStack).toEqual([]);
    expect(state.pendingPassiveQueue).toEqual([]);
  });

  it("is fully deterministic for a given seed", () => {
    const a = setupGame({ playerIds: ["a", "b", "c", "d"], seed: 99, cardData });
    const b = setupGame({ playerIds: ["a", "b", "c", "d"], seed: 99, cardData });
    expect(a).toEqual(b);
  });

  it("rejects player counts outside 2-8", () => {
    expect(() => setupGame({ playerIds: ["a"], seed: 1, cardData })).toThrow();
    const nine = Array.from({ length: 9 }, (_, i) => `p${i}`);
    expect(() => setupGame({ playerIds: nine, seed: 1, cardData })).toThrow();
  });
});
