import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GameState } from "@rev-day/engine";
import type { FastifyInstance } from "fastify";

// A fresh temp SQLite file per test run, set *before* importing ./app (which
// transitively imports ./db/client and bootstraps the DB at module-load
// time) — keeps this suite from touching the real dev.sqlite.
process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "rev-day-server-test-")), "test.sqlite");
const { buildApp } = await import("./app");
const { db } = await import("./db/client");
const { games } = await import("./db/schema");

let app: FastifyInstance;

beforeAll(() => {
  app = buildApp();
});

afterAll(async () => {
  await app.close();
});

describe("POST /games", () => {
  it("creates a game and returns its initial state", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/games",
      payload: { playerIds: ["a", "b", "c"], seed: 1 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTypeOf("number");
    expect(body.seed).toBe(1);
    expect(body.state.turn.phase).toBe("draw");
    expect(body.state.players).toHaveLength(3);
  });

  it("rejects an out-of-range player count", async () => {
    const res = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a"] } });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /games/:id", () => {
  it("returns 404 for an unknown game", async () => {
    const res = await app.inject({ method: "GET", url: "/games/999999" });
    expect(res.statusCode).toBe(404);
  });

  it("round-trips a created game's state", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/games",
      payload: { playerIds: ["a", "b", "c"], seed: 2 },
    });
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/games/${id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });
});

describe("POST /games/:id/actions", () => {
  it("applies a legal action, persists the new state, and logs it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/games",
      payload: { playerIds: ["a", "b", "c"], seed: 3 },
    });
    const { id, state } = created.json();
    const player = state.turn.currentPlayerId;

    const res = await app.inject({
      method: "POST",
      url: `/games/${id}/actions`,
      payload: { actingPlayerId: player, action: { type: "draw" } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state.turn.phase).toBe("action"); // mandatory draw resolved

    const fetched = await app.inject({ method: "GET", url: `/games/${id}` });
    expect(fetched.json().state.turn.phase).toBe("action"); // persisted, not just returned

    const actions = await app.inject({ method: "GET", url: `/games/${id}/actions` });
    const logged = actions.json();
    expect(logged).toHaveLength(1);
    expect(logged[0].actingPlayerId).toBe(player);
    expect(logged[0].action).toEqual({ type: "draw" });
  });

  it("returns 400 (not 500) for an illegal action, and leaves the stored state unchanged", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/games",
      payload: { playerIds: ["a", "b", "c"], seed: 4 },
    });
    const { id, state } = created.json();
    const notCurrentPlayer = state.players.find((p: { id: string }) => p.id !== state.turn.currentPlayerId).id;

    const res = await app.inject({
      method: "POST",
      url: `/games/${id}/actions`,
      payload: { actingPlayerId: notCurrentPlayer, action: { type: "draw" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("turn");

    const fetched = await app.inject({ method: "GET", url: `/games/${id}` });
    expect(fetched.json().state.turn.phase).toBe("draw"); // unchanged
  });

  it("returns 404 for an unknown game", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/games/999999/actions",
      payload: { actingPlayerId: "a", action: { type: "draw" } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /games/:id/winners", () => {
  it("evaluates win conditions against the game's current stored state", async () => {
    // Every leader's win conditions are AND'd (see rev_day_engine_design
    // memory) and every leader's list includes at least one condition
    // that's false at a totally fresh, untouched state (most need
    // "survives", which requires actually being in play — leaders start
    // in hand) — so a brand-new game deterministically has zero winners,
    // regardless of which leaders were dealt to whom. Still a real check
    // that this endpoint actually calls evaluateWinConditions and wires
    // the result through correctly, not a placeholder.
    const created = await app.inject({
      method: "POST",
      url: "/games",
      payload: { playerIds: ["a", "b", "c", "d", "e", "f", "g", "h"], seed: 5 },
    });
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/games/${id}/winners` });

    expect(res.statusCode).toBe(200);
    expect(res.json().winners).toEqual([]);
  });
});

describe("POST /games/:id/bot-turn", () => {
  it("plays a bot's turn, persists the result, and logs each action taken", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/games",
      payload: { playerIds: ["a", "b", "c"], seed: 6 },
    });
    const { id, state } = created.json();
    const player = state.turn.currentPlayerId;

    const res = await app.inject({ method: "POST", url: `/games/${id}/bot-turn`, payload: { playerId: player } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actionsTaken).toBeGreaterThan(0);
    expect(body.logged).toHaveLength(body.actionsTaken);
    expect(body.logged[0].actingPlayerId).toBe(player);
    expect(body.logged[0].action).toEqual({ type: "draw" });

    const fetched = await app.inject({ method: "GET", url: `/games/${id}` });
    expect(fetched.json().state).toEqual(body.state); // persisted, not just returned

    const actions = await app.inject({ method: "GET", url: `/games/${id}/actions` });
    expect(actions.json()).toHaveLength(body.actionsTaken);
  });

  it("returns 400 without a playerId", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 7 } });
    const { id } = created.json();

    const res = await app.inject({ method: "POST", url: `/games/${id}/bot-turn`, payload: {} });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown game", async () => {
    const res = await app.inject({ method: "POST", url: "/games/999999/bot-turn", payload: { playerId: "a" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("?viewerId= filtering", () => {
  it("omitting viewerId still returns the full, unfiltered state (existing behavior)", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 8 } });
    const state = created.json().state;
    expect(state.rng).toBeDefined();
    const othersHand = state.cards.find((c: { zone: string; controller: string }) => c.zone === "hand" && c.controller !== "a");
    expect(othersHand.defRef).not.toBeNull();
  });

  it("POST /games?viewerId= returns the initial state filtered for that player", async () => {
    const res = await app.inject({ method: "POST", url: "/games?viewerId=a", payload: { playerIds: ["a", "b", "c"], seed: 9 } });
    const state = res.json().state;
    expect(state.rng).toBeUndefined();
    const othersHand = state.cards.find((c: { zone: string; controller: string }) => c.zone === "hand" && c.controller !== "a");
    expect(othersHand.defRef).toBeNull();
    const ownHand = state.cards.find((c: { zone: string; controller: string }) => c.zone === "hand" && c.controller === "a");
    expect(ownHand.defRef).not.toBeNull();
  });

  it("GET /games/:id?viewerId= returns the filtered state", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 10 } });
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/games/${id}?viewerId=b` });

    expect(res.statusCode).toBe(200);
    const state = res.json().state;
    expect(state.rng).toBeUndefined();
    const othersHand = state.cards.find((c: { zone: string; controller: string }) => c.zone === "hand" && c.controller !== "b");
    expect(othersHand.defRef).toBeNull();
  });

  it("rejects a viewerId that isn't a player in the game", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 11 } });
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/games/${id}?viewerId=nobody` });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("nobody");
  });

  it("filters state and each logged action's resultingState across /actions and /bot-turn", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 12 } });
    const { id, state } = created.json();
    const player = state.turn.currentPlayerId;

    const actionRes = await app.inject({
      method: "POST",
      url: `/games/${id}/actions?viewerId=${player}`,
      payload: { actingPlayerId: player, action: { type: "draw" } },
    });
    const actionBody = actionRes.json();
    expect(actionBody.state.rng).toBeUndefined();
    expect(actionBody.logged.resultingState.rng).toBeUndefined();

    const otherPlayer = state.players.find((p: { id: string }) => p.id !== player).id;
    const botRes = await app.inject({ method: "POST", url: `/games/${id}/bot-turn?viewerId=${otherPlayer}`, payload: { playerId: player } });
    const botBody = botRes.json();
    expect(botBody.state.rng).toBeUndefined();
    for (const entry of botBody.logged) {
      expect(entry.resultingState.rng).toBeUndefined();
    }

    const listRes = await app.inject({ method: "GET", url: `/games/${id}/actions?viewerId=${otherPlayer}` });
    for (const entry of listRes.json()) {
      expect(entry.resultingState.rng).toBeUndefined();
    }
  });
});

describe("game over", () => {
  // Forces the game one endTurn away from the post-elimination countdown
  // expiring, without actually having to play out 3*playerIds.length real
  // turns through the API — this suite is testing the server's detection/
  // finalization wiring, not the engine's own turn-counting (that's
  // covered directly in the engine's reducer.test.ts).
  async function forceOneTurnFromGameOver(id: number, state: GameState) {
    await db
      .update(games)
      .set({ state: { ...state, turn: { ...state.turn, phase: "action", actionsRemaining: 0, endgameTurnsRemaining: 1 } } })
      .where(eq(games.id, id));
  }

  it("ends the game mid-action when the endgame countdown reaches 0, and rejects further actions", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 20 } });
    const { id, state } = created.json();
    const player = state.turn.currentPlayerId;
    await forceOneTurnFromGameOver(id, state);

    const res = await app.inject({
      method: "POST",
      url: `/games/${id}/actions`,
      payload: { actingPlayerId: player, action: { type: "endTurn" } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gameOver).not.toBeNull();
    expect(body.gameOver.winners).toBeInstanceOf(Array);
    expect(body.gameOver.losers).toBeInstanceOf(Array);
    expect(body.gameOver.outcomes).toHaveLength(3);
    expect(body.state.turn.endgameTurnsRemaining).toBe(0);

    // Persisted, not just returned in this one response.
    const fetched = await app.inject({ method: "GET", url: `/games/${id}` });
    expect(fetched.json().gameOver).toEqual(body.gameOver);

    // Further actions — human or bot — are rejected outright, permanently.
    const again = await app.inject({
      method: "POST",
      url: `/games/${id}/actions`,
      payload: { actingPlayerId: player, action: { type: "draw" } },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().gameOver).toEqual(body.gameOver);

    const botAgain = await app.inject({ method: "POST", url: `/games/${id}/bot-turn`, payload: { playerId: player } });
    expect(botAgain.statusCode).toBe(409);
    expect(botAgain.json().gameOver).toEqual(body.gameOver);
  });

  it("reveals face-down cards in the persisted state once the game ends", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 21 } });
    const { id, state } = created.json();
    const player = state.turn.currentPlayerId;

    const blendCard = state.cards.find((c: { kind: string }) => c.kind === "nonLeader");
    const cards = state.cards.map((c: { id: string }) =>
      c.id === blendCard.id
        ? { ...c, zone: "inPlay", locationId: state.board[0].id, controller: player, faceUp: false }
        : c,
    );
    await db
      .update(games)
      .set({
        state: {
          ...state,
          cards,
          turn: { ...state.turn, phase: "action", actionsRemaining: 0, endgameTurnsRemaining: 1 },
        },
      })
      .where(eq(games.id, id));

    const res = await app.inject({
      method: "POST",
      url: `/games/${id}/actions`,
      payload: { actingPlayerId: player, action: { type: "endTurn" } },
    });

    const revealedCard = res.json().state.cards.find((c: { id: string }) => c.id === blendCard.id);
    expect(revealedCard.faceUp).toBe(true);
  });

  it("ends the game mid bot-turn and truncates any steps the bot would have taken afterward", async () => {
    const created = await app.inject({ method: "POST", url: "/games", payload: { playerIds: ["a", "b", "c"], seed: 22 } });
    const { id, state } = created.json();
    const player = state.turn.currentPlayerId;
    await forceOneTurnFromGameOver(id, state);

    // With phase "action" and actionsRemaining already 0, the bot's very
    // first (and only) decision is forced straight to endTurn — see
    // decideTurnAction in packages/bots — so this deterministically ends
    // the game on the bot's first step, exercising the truncation path
    // rather than a full, non-deterministic bot turn.
    const res = await app.inject({ method: "POST", url: `/games/${id}/bot-turn`, payload: { playerId: player } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actionsTaken).toBe(1);
    expect(body.gameOver).not.toBeNull();
    expect(body.logged).toHaveLength(1);
    expect(body.logged[0].action).toEqual({ type: "endTurn" });
    expect(body.state.turn.endgameTurnsRemaining).toBe(0);
  });
});
