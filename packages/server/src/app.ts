import cors from "@fastify/cors";
import { takeBotTurn } from "@rev-day/bots";
import {
  applyAction,
  cardData,
  evaluateWinConditions,
  explainWinConditions,
  filterForPlayer,
  isGameOver,
  revealAllBlendedCards,
  setupGame,
  winConditions,
} from "@rev-day/engine";
import type { Action, FilteredGameState, GameState, PlayerId, WinConditionExplanation } from "@rev-day/engine";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import { db } from "./db/client";
import { gameActions, games } from "./db/schema";

// Testing/dev harness: drives applyAction over HTTP so the engine can
// actually be exercised end to end (manual testing, and building toward
// the trajectory logs the locked persistence design calls for) — not the
// real v2 multiplayer-authoritative server. Every route returning `state`
// accepts an optional `?viewerId=` query param: given, the response's
// `state` is filterForPlayer'd for that player instead of the full
// ground-truth GameState (rng, hidden hands/deck, face-down cards all
// redacted). Omitted, callers get the full state — the existing behavior,
// still relied on by the bot harness's own tests and anything doing
// server-side introspection. See rev_day_architecture memory for the real
// v1/v2 plan this harness is separate from.
//
// Route setup lives here, factored out from index.ts's listen() call, so
// tests can build an app and use Fastify's inject() without binding a
// real port.
export function buildApp(options?: { logger?: boolean }) {
  const app = Fastify({ logger: options?.logger ?? false });

  // The Vite client dev server runs on a different origin (localhost:5173
  // vs. this server's 3001) — the browser blocks cross-origin fetches
  // without this. Dev-only allowlist, matching the "internal project, not
  // a public release yet" threat model in rev_day_architecture memory;
  // revisit once there's a real deployed client origin to allow instead.
  void app.register(cors, { origin: "http://localhost:5173" });

  // Resolves the optional `?viewerId=` query param against the game's
  // actual player list — silently treating a typo'd/unknown id as "no
  // filtering" would be a confusing way to leak full state, so it's a 400
  // instead (the route returns right after, matching the existing
  // not-found/validation style below). Returns "invalid" only once the
  // 400 has already been sent; undefined means "no filtering requested".
  function resolveViewerId(
    request: { query: unknown },
    playerIds: readonly PlayerId[],
    reply: FastifyReply,
  ): PlayerId | undefined | "invalid" {
    const viewerId = (request.query as { viewerId?: string }).viewerId;
    if (viewerId === undefined) return undefined;
    if (!playerIds.includes(viewerId)) {
      reply.code(400).send({ error: `viewerId '${viewerId}' is not a player in this game` });
      return "invalid";
    }
    return viewerId;
  }

  function maybeFilterState(state: GameState, viewerId: PlayerId | undefined): GameState | FilteredGameState {
    return viewerId === undefined ? state : filterForPlayer(state, viewerId);
  }

  // If `state` has just reached one of the two end states (checked after
  // every applied action — the game can end mid-turn, not just at a turn
  // boundary), reveals every still-blended card and computes the winners/
  // losers/why breakdown. Returns `{ state, gameOver }` either way — state
  // is the revealed version once over, otherwise unchanged — so callers
  // can use it directly as "what to persist" without a separate branch.
  function checkGameOver(state: GameState): { state: GameState; gameOver: WinConditionExplanation | null } {
    if (!isGameOver(state)) return { state, gameOver: null };
    const revealed = revealAllBlendedCards(state);
    return { state: revealed, gameOver: explainWinConditions(revealed, cardData, winConditions) };
  }

  // Shared guard for both action-applying routes: once a game's gameOver
  // is set, it's set permanently (see schema.ts) — no further actions are
  // legal, human or bot. Sends the 409 itself, matching resolveViewerId's
  // style, since a real gameOver payload is more useful here than a bare
  // error string.
  function rejectIfAlreadyOver(
    row: { gameOver: WinConditionExplanation | null },
    viewerId: PlayerId | undefined,
    state: GameState,
    reply: FastifyReply,
  ): boolean {
    if (row.gameOver === null) return false;
    reply.code(409).send({ error: "This game is already over", gameOver: row.gameOver, state: maybeFilterState(state, viewerId) });
    return true;
  }

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

    const viewerId = resolveViewerId(request, playerIds, reply);
    if (viewerId === "invalid") return;

    const [row] = await db.insert(games).values({ playerIds, seed, state }).returning();
    return { ...row, state: maybeFilterState(row!.state, viewerId) };
  });

  app.get("/games/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!row) {
      return reply.code(404).send({ error: `Game ${id} not found` });
    }
    const viewerId = resolveViewerId(request, row.playerIds, reply);
    if (viewerId === "invalid") return;
    return { ...row, state: maybeFilterState(row.state, viewerId) };
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
    const viewerId = resolveViewerId(request, row.playerIds, reply);
    if (viewerId === "invalid") return;
    if (rejectIfAlreadyOver(row, viewerId, row.state, reply)) return;

    let appliedState: GameState;
    try {
      appliedState = applyAction(row.state, body.actingPlayerId, body.action, cardData);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const { state: nextState, gameOver } = checkGameOver(appliedState);

    const priorActions = await db.query.gameActions.findMany({ where: eq(gameActions.gameId, id) });
    const seq = priorActions.length;

    await db.update(games).set({ state: nextState, gameOver }).where(eq(games.id, id));
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

    return {
      id,
      state: maybeFilterState(nextState, viewerId),
      gameOver,
      logged: { ...logged, resultingState: maybeFilterState(logged!.resultingState, viewerId) },
    };
  });

  app.get("/games/:id/actions", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const gameRow = await db.query.games.findFirst({ where: eq(games.id, id) });
    if (!gameRow) {
      return reply.code(404).send({ error: `Game ${id} not found` });
    }
    const viewerId = resolveViewerId(request, gameRow.playerIds, reply);
    if (viewerId === "invalid") return;
    const rows = await db.query.gameActions.findMany({ where: eq(gameActions.gameId, id), orderBy: gameActions.seq });
    return rows.map((row) => ({ ...row, resultingState: maybeFilterState(row.resultingState, viewerId) }));
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
    const viewerId = resolveViewerId(request, row.playerIds, reply);
    if (viewerId === "invalid") return;
    if (rejectIfAlreadyOver(row, viewerId, row.state, reply)) return;

    const { state: computedState, actions } = takeBotTurn(row.state, body.playerId, cardData);

    const priorActions = await db.query.gameActions.findMany({ where: eq(gameActions.gameId, id) });
    let seq = priorActions.length;
    const logged = [];
    // The game can end mid-turn, including partway through a bot's own
    // turn (e.g. its own Motorcade play pushes the President past the
    // last location) — checked after each individual step, not just once
    // at the end, so any steps takeBotTurn computed *after* the game
    // actually ended are discarded here rather than persisted/logged.
    let finalState = computedState;
    let gameOver: WinConditionExplanation | null = null;
    for (const step of actions) {
      const { state: resultingState, gameOver: stepGameOver } = checkGameOver(step.resultingState);
      const [loggedRow] = await db
        .insert(gameActions)
        .values({
          gameId: id,
          seq: seq++,
          actingPlayerId: step.actingPlayerId,
          action: step.action,
          resultingState,
        })
        .returning();
      logged.push({ ...loggedRow!, resultingState: maybeFilterState(loggedRow!.resultingState, viewerId) });
      if (stepGameOver) {
        finalState = resultingState;
        gameOver = stepGameOver;
        break;
      }
    }

    await db.update(games).set({ state: finalState, gameOver }).where(eq(games.id, id));

    return { id, state: maybeFilterState(finalState, viewerId), actionsTaken: logged.length, gameOver, logged };
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
