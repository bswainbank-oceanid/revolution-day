import type { Action, GameState, PlayerId, WinConditionExplanation } from "@rev-day/engine";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Testing/dev harness schema — not the real v1/v2 persistence design
// (profiles, campaigns, stats — see rev_day_architecture memory). Exists
// to let applyAction actually be driven end to end over HTTP: create a
// game, submit actions, inspect state and the resulting trajectory log.
export const games = sqliteTable("games", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  playerIds: text("player_ids", { mode: "json" }).notNull().$type<readonly PlayerId[]>(),
  seed: integer("seed").notNull(),
  state: text("state", { mode: "json" }).notNull().$type<GameState>(),
  // Null until isGameOver(state) first becomes true (checked by the server
  // after every applied action, since the game can end mid-turn — see
  // rev_day_engine_design memory); set exactly once, at that moment, and
  // never cleared. Its presence is what makes a game "over": once set,
  // POST .../actions and .../bot-turn refuse to apply anything further.
  gameOver: text("game_over", { mode: "json" }).$type<WinConditionExplanation | null>(),
});

// One row per successfully-applied action — the "state, action taken,
// resulting state" trajectory shape the locked persistence design calls
// for (see rev_day_architecture memory), scoped down for the harness: no
// legal-actions-at-that-point column yet, since the engine has no
// legal-action enumerator built.
export const gameActions = sqliteTable("game_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: integer("game_id")
    .notNull()
    .references(() => games.id),
  seq: integer("seq").notNull(),
  actingPlayerId: text("acting_player_id").notNull(),
  action: text("action", { mode: "json" }).notNull().$type<Action>(),
  resultingState: text("resulting_state", { mode: "json" }).notNull().$type<GameState>(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});
