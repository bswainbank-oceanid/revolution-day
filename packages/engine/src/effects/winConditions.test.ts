import { describe, expect, it } from "vitest";
import { cardData } from "../data/cardData";
import { winConditions } from "../data/winConditions";
import { setupGame } from "../setup";
import type { CardInstance } from "../state/cards";
import type { GameState, PlayerId } from "../state/game";
import { evaluateWinConditions } from "./winConditions";
import type { WinPredicate } from "./winConditions";

function baseState(playerIds: readonly string[] = ["a", "b", "c", "d", "e", "f", "g", "h"]): GameState {
  // 8 players so every leader is guaranteed to be dealt.
  return setupGame({ playerIds, seed: 1, cardData });
}

function place(state: GameState, cardId: string, locationId: string, controller: PlayerId): GameState {
  return {
    ...state,
    cards: state.cards.map((c) =>
      c.id === cardId ? { ...c, zone: "inPlay" as const, locationId, controller, faceUp: true } : c,
    ),
  };
}

function eliminate(state: GameState, cardId: string, eliminatedByPlayerId?: PlayerId): GameState {
  return {
    ...state,
    cards: state.cards.map((c) =>
      c.id === cardId
        ? { ...c, zone: "eliminated" as const, locationId: undefined, faceUp: undefined, eliminatedByPlayerId }
        : c,
    ),
  };
}

function leaderOwner(state: GameState, defRef: string): { card: CardInstance; playerId: PlayerId } {
  const card = state.cards.find((c) => c.kind === "leader" && c.defRef === defRef)!;
  return { card, playerId: card.controller! };
}

function nthOfDefRef(state: GameState, defRef: string, n: number): CardInstance {
  return state.cards.filter((c) => c.defRef === defRef)[n]!;
}

describe("evaluateWinConditions: real per-leader predicate data (all AND'd)", () => {
  it("Head of Security wins only when BOTH survives AND the President is not eliminated", () => {
    let state = baseState();
    const { playerId, card: hos } = leaderOwner(state, "Head of Security");
    state = place(state, hos.id, "loc-0", playerId);

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(true);
  });

  it("Head of Security does NOT win from surviving alone once the President is eliminated (the reported bug)", () => {
    let state = baseState();
    const { playerId, card: hos } = leaderOwner(state, "Head of Security");
    state = place(state, hos.id, "loc-0", playerId); // survives: true
    state = { ...state, president: { status: "eliminated", locationId: null, eliminatedAtLocationId: "loc-0" } };

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Head of Security does NOT win from the President being safe alone if its own leader died", () => {
    let state = baseState();
    const { playerId, card: hos } = leaderOwner(state, "Head of Security");
    state = eliminate(state, hos.id); // survives: false; President still never entered — notEliminated: true

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Wife wins only if the President was eliminated specifically at the Palace", () => {
    const state = baseState();
    const { playerId } = leaderOwner(state, "Wife");
    const palaceId = state.board.find((l) => l.name === "Palace")!.id;
    const streetId = state.board.find((l) => l.name === "Street")!.id;

    const atPalace = { ...state, president: { status: "eliminated" as const, locationId: null, eliminatedAtLocationId: palaceId } };
    expect(evaluateWinConditions(atPalace, cardData, winConditions).has(playerId)).toBe(true);

    const elsewhere = { ...state, president: { status: "eliminated" as const, locationId: null, eliminatedAtLocationId: streetId } };
    expect(evaluateWinConditions(elsewhere, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Commander General wins only when President-eliminated AND survives AND Regime majority at HQ all hold", () => {
    let state = baseState();
    const { playerId, card: cg } = leaderOwner(state, "Commander General");
    const hqId = state.board.find((l) => l.name === "HQ")!.id;
    const guard1 = nthOfDefRef(state, "Republican Guard", 0);
    const guard2 = nthOfDefRef(state, "Republican Guard", 1);
    const rebel = nthOfDefRef(state, "Gunman", 0);
    state = place(state, cg.id, hqId, playerId); // survives: true
    state = place(state, guard1.id, hqId, "a");
    state = place(state, guard2.id, hqId, "a");
    state = place(state, rebel.id, hqId, "b");
    state = { ...state, president: { status: "eliminated", locationId: null, eliminatedAtLocationId: "loc-0" } };

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(true);
  });

  it("Commander General does not win if it died itself, even with the President eliminated and a Regime majority at HQ", () => {
    let state = baseState();
    const { playerId, card: cg } = leaderOwner(state, "Commander General");
    const hqId = state.board.find((l) => l.name === "HQ")!.id;
    const guard1 = nthOfDefRef(state, "Republican Guard", 0);
    const guard2 = nthOfDefRef(state, "Republican Guard", 1);
    state = eliminate(state, cg.id); // survives: false
    state = place(state, guard1.id, hqId, "a");
    state = place(state, guard2.id, hqId, "a");
    state = { ...state, president: { status: "eliminated", locationId: null, eliminatedAtLocationId: "loc-0" } };

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Commander General does not win on a tied or losing count at HQ, even alive with the President eliminated", () => {
    let state = baseState();
    const { playerId, card: cg } = leaderOwner(state, "Commander General");
    const hqId = state.board.find((l) => l.name === "HQ")!.id;
    const elsewhere = state.board.find((l) => l.name !== "HQ")!.id;
    const guard = nthOfDefRef(state, "Republican Guard", 0);
    const rebel = nthOfDefRef(state, "Gunman", 0);
    state = place(state, cg.id, elsewhere, playerId); // survives, but not at HQ — doesn't skew its own tally
    state = place(state, guard.id, hqId, "a");
    state = place(state, rebel.id, hqId, "b"); // 1-1 tie, not a majority
    state = { ...state, president: { status: "eliminated", locationId: null, eliminatedAtLocationId: "loc-0" } };

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Heir Apparent wins via 'no other surviving leaders' only while its own leader is also still alive", () => {
    let state = baseState();
    const { playerId, card: heir } = leaderOwner(state, "Heir Apparent");
    state = place(state, heir.id, "loc-0", playerId); // survives: true
    for (const c of state.cards) {
      if (c.kind === "leader" && c.id !== heir.id) state = eliminate(state, c.id);
    }

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(true);
  });

  it("Heir Apparent does NOT win if its own leader also died, even with no other surviving leaders", () => {
    let state = baseState();
    const { playerId } = leaderOwner(state, "Heir Apparent");
    for (const c of state.cards) {
      if (c.kind === "leader") state = eliminate(state, c.id); // Heir Apparent included — survives: false
    }

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Opposition Leader wins with a rebel present at 5+ locations, only while it survives", () => {
    let state = baseState();
    const { playerId, card: oppLeader } = leaderOwner(state, "Opposition Leader");
    state = place(state, oppLeader.id, "loc-0", playerId);
    const rebelDefRefs = ["Gunman", "Assassin", "Mr. Lucky", "Martyr", "Journalist"];
    for (let i = 0; i < 5; i++) {
      const card = nthOfDefRef(state, rebelDefRefs[i]!, 0);
      state = place(state, card.id, state.board[i]!.id, "a");
    }

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(true);
  });

  it("Opposition Leader does not win with a rebel at only 4 locations, even alive", () => {
    let state = baseState();
    const { playerId, card: oppLeader } = leaderOwner(state, "Opposition Leader");
    state = place(state, oppLeader.id, "loc-0", playerId);
    const rebelDefRefs = ["Gunman", "Assassin", "Mr. Lucky", "Martyr"];
    for (let i = 0; i < 4; i++) {
      const card = nthOfDefRef(state, rebelDefRefs[i]!, 0);
      state = place(state, card.id, state.board[i]!.id, "a");
    }

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Opposition Leader does not win from a 5-location rebel spread alone if it died itself", () => {
    let state = baseState();
    const { playerId, card: oppLeader } = leaderOwner(state, "Opposition Leader");
    state = eliminate(state, oppLeader.id); // survives: false
    const rebelDefRefs = ["Gunman", "Assassin", "Mr. Lucky", "Martyr", "Journalist"];
    for (let i = 0; i < 5; i++) {
      const card = nthOfDefRef(state, rebelDefRefs[i]!, 0);
      state = place(state, card.id, state.board[i]!.id, "a");
    }

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Master Assassin wins by eliminating the President with a card they control, while alive", () => {
    let state = baseState();
    const { playerId, card: assassin } = leaderOwner(state, "Master Assassin");
    state = place(state, assassin.id, "loc-0", playerId); // survives: true
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: "loc-0", eliminatedByPlayerId: playerId },
    };
    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(true);
  });

  it("Master Assassin does NOT win from the President kill alone if it died itself (the 'or' clause doesn't bypass 'survives')", () => {
    let state = baseState();
    const { playerId, card: assassin } = leaderOwner(state, "Master Assassin");
    state = eliminate(state, assassin.id); // survives: false
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: "loc-0", eliminatedByPlayerId: playerId },
    };
    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Master Assassin does not win from a President kill attributed to someone else, even while alive", () => {
    let state = baseState();
    const { playerId, card: assassin } = leaderOwner(state, "Master Assassin");
    const other = state.players.find((p) => p.id !== playerId)!.id;
    state = place(state, assassin.id, "loc-0", playerId);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: "loc-0", eliminatedByPlayerId: other },
    };
    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });

  it("Master Assassin wins by eliminating 2 leaders with cards they control, while alive", () => {
    let state = baseState();
    const { playerId, card: assassin } = leaderOwner(state, "Master Assassin");
    const otherLeaders = state.cards.filter((c) => c.kind === "leader" && c.id !== assassin.id);
    state = place(state, assassin.id, "loc-0", playerId);
    state = eliminate(state, otherLeaders[0]!.id, playerId);
    state = eliminate(state, otherLeaders[1]!.id, playerId);

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(true);
  });

  it("Master Assassin does not win from just 1 leader elimination, even while alive", () => {
    let state = baseState();
    const { playerId, card: assassin } = leaderOwner(state, "Master Assassin");
    const otherLeaders = state.cards.filter((c) => c.kind === "leader" && c.id !== assassin.id);
    state = place(state, assassin.id, "loc-0", playerId);
    state = eliminate(state, otherLeaders[0]!.id, playerId);

    expect(evaluateWinConditions(state, cardData, winConditions).has(playerId)).toBe(false);
  });
});

describe("evaluateWinConditions: meta-condition fixed point", () => {
  // Bespoke predicate maps, deliberately not the real per-leader data —
  // Head of Security's actual "President not eliminated" predicate always
  // fires unless the President is eliminated, which in turn always
  // satisfies Commander General/Guerrilla Commander's own direct
  // "presidentStatus: eliminated" predicate too — so with the *real* 8-leader
  // ruleset there's no reachable state where a meta-condition is the only
  // thing deciding a winner. These tests isolate the fixed-point mechanism
  // itself instead, reusing real leader card instances (for kind/faction)
  // with a substitute predicate map.
  function metaState(): { state: GameState; regime: PlayerId; rebel: PlayerId } {
    // 8 players so every leader instance actually exists (setupGame only
    // instantiates `playerIds.length` of the 8 leaders) — the bespoke
    // `predicates` maps below only cover 2 of them, so the other 6 stay
    // inert (an empty predicate list never wins) and don't interfere.
    let state = baseState();
    const { playerId: regime, card: hos } = leaderOwner(state, "Head of Security"); // Regime
    const { playerId: rebel } = leaderOwner(state, "Guerrilla Commander"); // Rebel
    state = place(state, hos.id, "loc-0", regime); // "survives" requires actually being in play
    return { state, regime, rebel };
  }

  it("metaNoFactionLeaderWins is false while a same-faction leader independently wins", () => {
    const { state, rebel } = metaState();
    const predicates: Record<string, readonly WinPredicate[]> = {
      "Head of Security": [{ type: "survives" }],
      "Guerrilla Commander": [{ type: "metaNoFactionLeaderWins", faction: "Regime" }],
    };
    // Both leaders are still in play — Head of Security (Regime) wins via
    // "survives", so Guerrilla Commander's meta-condition must be false.
    const winners = evaluateWinConditions(state, cardData, predicates);
    expect(winners.has(rebel)).toBe(false);
  });

  it("metaNoFactionLeaderWins becomes true once that faction's leader stops winning", () => {
    const { state: base, regime, rebel } = metaState();
    const predicates: Record<string, readonly WinPredicate[]> = {
      "Head of Security": [{ type: "survives" }],
      "Guerrilla Commander": [{ type: "metaNoFactionLeaderWins", faction: "Regime" }],
    };
    const { card: hos } = leaderOwner(base, "Head of Security");
    const state = eliminate(base, hos.id); // Head of Security no longer "survives"

    const winners = evaluateWinConditions(state, cardData, predicates);
    expect(winners.has(regime)).toBe(false);
    expect(winners.has(rebel)).toBe(true);
  });

  it("metaNoOtherPlayerWins is false while another player independently wins", () => {
    const { state, rebel } = metaState();
    const predicates: Record<string, readonly WinPredicate[]> = {
      "Head of Security": [{ type: "survives" }],
      "Guerrilla Commander": [{ type: "metaNoOtherPlayerWins" }],
    };
    const winners = evaluateWinConditions(state, cardData, predicates);
    expect(winners.has(rebel)).toBe(false);
  });

  it("metaNoOtherPlayerWins becomes true once nobody else's condition holds", () => {
    const { state: base, rebel } = metaState();
    const predicates: Record<string, readonly WinPredicate[]> = {
      "Head of Security": [{ type: "survives" }],
      "Guerrilla Commander": [{ type: "metaNoOtherPlayerWins" }],
    };
    const { card: hos } = leaderOwner(base, "Head of Security");
    const state = eliminate(base, hos.id);

    const winners = evaluateWinConditions(state, cardData, predicates);
    expect(winners.has(rebel)).toBe(true);
  });

  it("empties the winner set if literally every player would win", () => {
    let state = baseState();
    // Every leader is actually placed in play (not left in hand — a
    // fresh setupGame() deals them there, where "survives" is false) so
    // "survives" is genuinely true for everyone, exercising the real
    // "all players win" case rather than the empty set arising by
    // accident because nobody actually met their condition.
    for (const leader of state.cards.filter((c) => c.kind === "leader")) {
      state = place(state, leader.id, "loc-0", leader.controller!);
    }
    const predicates: Record<string, readonly WinPredicate[]> = Object.fromEntries(
      cardData.leaders.map((l) => [l.name, [{ type: "survives" } satisfies WinPredicate]]),
    );
    const winners = evaluateWinConditions(state, cardData, predicates);
    expect(winners.size).toBe(0);
  });

  it("evaluates an explicit 'or' among nested predicates within an otherwise-AND'd list", () => {
    let state = baseState();
    const { playerId, card: assassin } = leaderOwner(state, "Master Assassin");
    state = place(state, assassin.id, "loc-0", playerId); // survives: true
    const predicates: Record<string, readonly WinPredicate[]> = {
      "Master Assassin": [
        {
          type: "or",
          predicates: [
            { type: "eliminatedByControlled", target: "president" },
            { type: "eliminatedByControlled", target: { leaderCount: 2 } },
          ],
        },
        { type: "survives" },
      ],
    };

    // Neither branch of the "or" holds yet.
    expect(evaluateWinConditions(state, cardData, predicates).has(playerId)).toBe(false);

    // Satisfying just one branch (the President) is enough for the "or",
    // and "survives" (the separate AND'd sentence) already holds.
    const withPresidentKilled = {
      ...state,
      president: { status: "eliminated" as const, locationId: null, eliminatedByPlayerId: playerId },
    };
    expect(evaluateWinConditions(withPresidentKilled, cardData, predicates).has(playerId)).toBe(true);

    // The other branch (2 leaders) also independently satisfies the "or"
    // — needs a second other leader, hence 8 players in baseState().
    const otherLeaders = state.cards.filter((c) => c.kind === "leader" && c.id !== assassin.id);
    const withTwoLeadersKilled = eliminate(eliminate(state, otherLeaders[0]!.id, playerId), otherLeaders[1]!.id, playerId);
    expect(evaluateWinConditions(withTwoLeadersKilled, cardData, predicates).has(playerId)).toBe(true);
  });
});
