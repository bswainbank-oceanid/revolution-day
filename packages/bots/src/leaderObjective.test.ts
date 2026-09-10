import { cardData, setupGame, winConditions } from "@rev-day/engine";
import type { BoardLayout, GameState } from "@rev-day/engine";
import { describe, expect, it } from "vitest";
import {
  computeProtectionTargets,
  forwardStepDistance,
  leaderLocationObjectiveFor,
  shouldDeployLocationLeaderNow,
  stagingLocationId,
  stepToward,
} from "./leaderObjective";

function freshGame(playerIds: readonly string[] = ["a", "b", "c"], seed = 1): GameState {
  return setupGame({ playerIds, seed, cardData });
}

describe("leaderLocationObjectiveFor", () => {
  it("resolves Wife's presidentEliminatedAt predicate to the Palace's location id", () => {
    const state = freshGame();
    const objective = leaderLocationObjectiveFor("Wife", winConditions, state.board);
    const palace = state.board.find((l) => l.name === "Palace")!;
    expect(objective.eliminateAtLocationId).toBe(palace.id);
  });

  it("is null for a leader with no location-gated predicate", () => {
    const state = freshGame();
    expect(leaderLocationObjectiveFor("Head of Security", winConditions, state.board).eliminateAtLocationId).toBeNull();
  });

  it("is null for an unknown defRef", () => {
    const state = freshGame();
    expect(leaderLocationObjectiveFor("Not A Real Leader", winConditions, state.board).eliminateAtLocationId).toBeNull();
  });
});

describe("stagingLocationId", () => {
  it("resolves to the location immediately before the win location", () => {
    const state = freshGame();
    const palace = state.board.find((l) => l.name === "Palace")!;
    const palaceIndex = state.board.findIndex((l) => l.id === palace.id);
    expect(stagingLocationId(state.board, palace.id)).toBe(state.board[palaceIndex - 1]!.id);
  });

  it("is undefined when the win location is the first on the board", () => {
    const state = freshGame();
    expect(stagingLocationId(state.board, state.board[0]!.id)).toBeUndefined();
  });
});

describe("forwardStepDistance", () => {
  const state = freshGame();
  const board = state.board;
  const street0 = board[0]!.id;
  const palace = board.find((l) => l.name === "Palace")!.id;

  it("counts forward steps along the linear board", () => {
    expect(forwardStepDistance(board, street0, palace)).toBe(board.length - 1);
  });

  it("is 0 for the same location", () => {
    expect(forwardStepDistance(board, palace, palace)).toBe(0);
  });

  it("is Infinity when the destination is behind the source (board doesn't wrap)", () => {
    expect(forwardStepDistance(board, palace, street0)).toBe(Infinity);
  });

  it("is Infinity for an unknown location id", () => {
    expect(forwardStepDistance(board, street0, "not-a-real-location")).toBe(Infinity);
  });
});

describe("shouldDeployLocationLeaderNow", () => {
  function withPresidentAt(state: GameState, locationId: string | null): GameState {
    return { ...state, president: locationId ? { status: "alive", locationId } : { status: "notEntered", locationId: null } };
  }

  it("is false when the leader has no location objective", () => {
    const state = freshGame();
    const filtered = { ...state, cards: state.cards };
    expect(shouldDeployLocationLeaderNow(filtered, { eliminateAtLocationId: null })).toBe(false);
  });

  it("is true once the President is within the distance threshold", () => {
    const state = freshGame();
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const nearPalace = state.board[state.board.length - 3]!.id; // 2 steps away
    const withPresident = withPresidentAt(state, nearPalace);
    expect(shouldDeployLocationLeaderNow(withPresident, { eliminateAtLocationId: palace })).toBe(true);
  });

  it("is false while the President is far away and the deck isn't low", () => {
    const state = freshGame();
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const farFromPalace = state.board[0]!.id;
    const withPresident = withPresidentAt(state, farFromPalace);
    expect(shouldDeployLocationLeaderNow(withPresident, { eliminateAtLocationId: palace })).toBe(false);
  });

  it("is true once the deck is low, regardless of the President's position", () => {
    const state = freshGame();
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const farFromPalace = state.board[0]!.id;
    let withPresident = withPresidentAt(state, farFromPalace);
    // Thin the deck down to the low-deck threshold.
    let deckSeen = 0;
    withPresident = {
      ...withPresident,
      cards: withPresident.cards.map((c) => {
        if (c.zone !== "deck") return c;
        deckSeen += 1;
        return deckSeen <= 6 ? c : { ...c, zone: "discard" as const };
      }),
    };
    expect(shouldDeployLocationLeaderNow(withPresident, { eliminateAtLocationId: palace })).toBe(true);
  });

  it("is false when the President hasn't entered yet and the deck isn't low", () => {
    const state = freshGame();
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const withPresident = withPresidentAt(state, null);
    expect(shouldDeployLocationLeaderNow(withPresident, { eliminateAtLocationId: palace })).toBe(false);
  });
});

describe("computeProtectionTargets", () => {
  it("includes the President's current and next location while he's alive", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const index = 1;
    const withPresident = { ...state, president: { status: "alive" as const, locationId: state.board[index]!.id } };
    const targets = computeProtectionTargets(withPresident, player, { eliminateAtLocationId: null });
    expect(targets.locationIds).toContain(state.board[index]!.id);
    expect(targets.locationIds).toContain(state.board[index + 1]!.id);
  });

  it("includes the location-gated leader's own location once she's in play there", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const wife = state.cards.find((c) => c.defRef === "Wife")!;
    const withWifeDeployed = {
      ...state,
      president: { status: "notEntered" as const, locationId: null },
      cards: state.cards.map((c) =>
        c.id === wife.id ? { ...c, zone: "inPlay" as const, locationId: palace, controller: player, faceUp: false } : c,
      ),
    };
    const targets = computeProtectionTargets(withWifeDeployed, player, { eliminateAtLocationId: palace });
    expect(targets.locationIds).toContain(palace);
  });

  it("is empty when the President hasn't entered and no leader is deployed", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const withPresident = { ...state, president: { status: "notEntered" as const, locationId: null } };
    const targets = computeProtectionTargets(withPresident, player, { eliminateAtLocationId: null });
    expect(targets.locationIds).toEqual([]);
  });
});

describe("stepToward", () => {
  const board: BoardLayout = freshGame().board;

  it("steps forward toward a farther-ahead desired location", () => {
    const from = board[1]!.id;
    const desired = board[board.length - 1]!.id;
    expect(stepToward(board, from, [desired])).toBe(board[2]!.id);
  });

  it("steps backward toward a desired location behind it", () => {
    const from = board[3]!.id;
    const desired = board[0]!.id;
    expect(stepToward(board, from, [desired])).toBe(board[2]!.id);
  });

  it("is undefined when already at the only desired location", () => {
    const from = board[2]!.id;
    expect(stepToward(board, from, [from])).toBeUndefined();
  });

  it("is undefined for an unknown source location", () => {
    expect(stepToward(board, "not-a-real-location", [board[0]!.id])).toBeUndefined();
  });
});
