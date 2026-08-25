import { takeBotTurn } from "@rev-day/bots";
import { applyAction, cardData, evaluateWinConditions, setupGame, winConditions } from "@rev-day/engine";
import type { Action, GameState, PlayerId } from "@rev-day/engine";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { db } from "./db/client";
import { gameActions, games } from "./db/schema";

// Testing/dev harness: drives applyAction over HTTP so the engine can
// actually be exercised end to end (manual testing, and building toward
// the trajectory logs the locked persistence design calls for) — not the
// real v2 multiplayer-authoritative server. No per-player filtering yet
// (no filterForPlayer exists): full GameState in, full GameState out. See
// rev_day_architecture memory for the real v1/v2 plan this is separate
// from.
//
// Route setup lives here, factored out from index.ts's listen() call, so
// tests can build an app and use Fastify's inject() without binding a
// real port.
export function buildApp(options?: { logger?: boolean }) {
  const app = Fastify({ logger: options?.logger ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/games", async (request, reply) => {
    const body = request.body as { playerIds?: PlayerId[]; seed?: number } | undefined;
    const playerIds = body?.playerIds;
    if (!playerIds || playerIds.length < 2 || playerIds.length > 8) {
      return reply.code(400).send({ error: "playerIds must have 2-8 entries" });
    }
    const seed = body?.seed ?? Date.now();

    let state: GameState;
    try {
      state = setupGame({ playerIds, seed, cardData });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const [row] = await db.insert(games).values({ playerIds, seed, state }).returning();
    return row;
  });

  app.get("/games/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!row) {
      return reply.code(404).send({ error: `Game ${id} not found` });
    }
    return row;
  });

  // Applies one action, persists the resulting state, and logs the
  // action — the one real "play the game" endpoint. Illegal actions
  // (applyAction throwing) come back as 400s with the engine's own error
  // message rather than a 500, since "you can't do that right now" is
  // expected, routine feedback here, not a server fault.
  app.post("/games/:id/actions", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!row) {
      return reply.code(404).send({ error: `Game ${id} not found` });
    }

    const body = request.body as { actingPlayerId?: PlayerId; action?: Action } | undefined;
    if (!body?.actingPlayerId || !body.action) {
      return reply.code(400).send({ error: "actingPlayerId and action are required" });
    }

    let nextState: GameState;
    try {
      nextState = applyAction(row.state, body.actingPlayerId, body.action, cardData);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const priorActions = await db.query.gameActions.findMany({ where: eq(gameActions.gameId, id) });
    const seq = priorActions.length;

    await db.update(games).set({ state: nextState }).where(eq(games.id, id));
    const [logged] = await db
      .insert(gameActions)
      .values({
        gameId: id,
        seq,
        actingPlayerId: body.actingPlayerId,
        action: body.action,
        resultingState: nextState,
      })
      .returning();

    return { id, state: nextState, logged };
  });

  app.get("/games/:id/actions", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const gameRow = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!gameRow) {
      return reply.code(404).send({ error: `Game ${id} not found` });
    }
    return db.query.gameActions.findMany({ where: eq(gameActions.gameId, id), orderBy: gameActions.seq });
  });

  // Drives one bot's turn to completion (@rev-day/bots' takeBotTurn) —
  // this is what makes the harness actually playable today: a human
  // drives their own turns via POST .../actions, and calls this to make
  // a bot take its turn. Logs each individual action the bot took, same
  // shape and table as a human's actions, so a full game's trajectory
  // (bot moves included) stays queryable via GET .../actions either way.
  app.post("/games/:id/bot-turn", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!row) {
      return reply.code(404).send({ error: `Game ${id} not found` });
    }

    const body = request.body as { playerId?: PlayerId } | undefined;
    if (!body?.playerId) {
      return reply.code(400).send({ error: "playerId is required" });
    }

    const { state: nextState, actions } = takeBotTurn(row.state, body.playerId, cardData);

    await db.update(games).set({ state: nextState }).where(eq(games.id, id));

    const priorActions = await db.query.gameActions.findMany({ where: eq(gameActions.gameId, id) });
    let seq = priorActions.length;
    const logged = [];
    for (const step of actions) {
      const [loggedRow] = await db
        .insert(gameActions)
        .values({
          gameId: id,
          seq: seq++,
          actingPlayerId: step.actingPlayerId,
          action: step.action,
          resultingState: step.resultingState,
        })
        .returning();
      logged.push(loggedRow);
    }

    return { id, state: nextState, actionsTaken: logged.length, logged };
  });

  // A pure query, not something the engine triggers on its own — the
  // caller decides when checking makes sense (e.g. once
  // turn.endgameTurnsRemaining reaches 0, or the President survives past
  // the last location). Exposed here mainly to give evaluateWinConditions
  // a real caller at all, per rev_day_engine_design memory.
  app.get("/games/:id/winners", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!row) {
      return reply.code(404).send({ error: `Game ${id} not found` });
    }
    const winners = evaluateWinConditions(row.state, cardData, winConditions);
    return { winners: [...winners] };
  });

  return app;
}
