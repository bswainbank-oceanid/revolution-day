import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Placeholder schema proving the SQLite/Drizzle wiring end to end.
// Real schema (players, profiles, campaigns/scenarios, stats, game
// trajectory logs) gets designed alongside the engine's state model.
export const games = sqliteTable("games", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  state: text("state", { mode: "json" }).notNull(),
});
