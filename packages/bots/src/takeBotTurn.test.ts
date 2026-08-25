import { cardData, setupGame } from "@rev-day/engine";
import type { GameState } from "@rev-day/engine";
import { describe, expect, it } from "vitest";
import { takeBotTurn } from "./takeBotTurn";

function freshGame(playerIds: readonly string[] = ["a", "b", "c"], seed = 1): GameState {
  return setupGame({ playerIds, seed, cardData });
}

describe("takeBotTurn", () => {
  it("plays a full turn without throwing, ending with control passed on", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;

    const { state: resolved, actions } = takeBotTurn(state, player, cardData);

    // Either it's genuinely someone/something else's decision now, or the
    // bot is still mid-resolution waiting on another player (e.g. an
    // alarm it triggered) — either way, it must not still be sitting at
    // an untouched top-level "draw" for itself with nothing having
    // happened.
    const stillFreshDrawForBot =
      resolved.resolutionStack.length === 0 && resolved.turn.currentPlayerId === player && resolved.turn.phase === "draw";
    expect(stillFreshDrawForBot).toBe(false);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.actingPlayerId).toBe(player);
    expect(actions[0]!.action).toEqual({ type: "draw" });
    expect(actions[0]!.resultingState.turn.phase).toBe("action"); // mandatory draw resolved
  });

  it("consumes the mandatory draw at least once (deck shrinks)", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const deckBefore = state.cards.filter((c) => c.zone === "deck").length;

    const { state: resolved } = takeBotTurn(state, player, cardData);
    const deckAfter = resolved.cards.filter((c) => c.zone === "deck").length;

    // The mandatory draw always removes at least one card from the deck
    // (a full deck at game start, so it never hits the empty-deck path) —
    // true regardless of whatever else the bot does with its budgeted
    // actions afterward, unlike hand size, which playing cards can shrink.
    expect(deckAfter).toBeLessThan(deckBefore);
  });

  it("runs many full games of several bot-only turns each without throwing", () => {
    for (let seed = 0; seed < 15; seed++) {
      let state = freshGame(["a", "b", "c"], seed);
      for (let turn = 0; turn < 6; turn++) {
        const player = state.turn.currentPlayerId;
        expect(() => {
          state = takeBotTurn(state, player, cardData).state;
        }).not.toThrow();
      }
    }
  });

  it("does nothing when it isn't the given player's decision", () => {
    let state = freshGame(["a", "b", "c"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;

    const { state: resolved, actions } = takeBotTurn(state, other, cardData);

    expect(resolved).toBe(state); // unchanged — not other's turn to decide anything
    expect(actions).toEqual([]);
  });
});
