import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// A fresh temp SQLite file per test run, set *before* importing ./app (which
// transitively imports ./db/client and bootstraps the DB at module-load
// time) — keeps this suite from touching the real dev.sqlite.
process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "rev-day-server-test-")), "test.sqlite");
const { buildApp } = await import("./app");

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
    // 8 players so every leader is dealt — Head of Security's "President
    // not eliminated" is trivially satisfied with nobody having taken any
    // action yet, deterministically regardless of seed, so its player is
    // always among the (possibly multi-player) winner set.
    const created = await app.inject({
      method: "POST",
      url: "/games",
      payload: { playerIds: ["a", "b", "c", "d", "e", "f", "g", "h"], seed: 5 },
    });
    const { id, state } = created.json();
    const hosPlayerId = state.cards.find(
      (c: { kind: string; defRef: string; controller: string }) =>
        c.kind === "leader" && c.defRef === "Head of Security",
    ).controller;

    const res = await app.inject({ method: "GET", url: `/games/${id}/winners` });

    expect(res.statusCode).toBe(200);
    expect(res.json().winners).toContain(hosPlayerId);
  });
});
