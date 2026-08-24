import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_PATH ?? "data/dev.sqlite";
mkdirSync(dirname(DB_PATH), { recursive: true });

const client = createClient({ url: `file:${DB_PATH}` });

// Dev-only bootstrap so `npm run dev` (and tests) work without running
// drizzle-kit migrations first. Once the schema stabilizes, switch to
// `db:generate` + `db:migrate` and drop this.
await client.execute(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (current_timestamp),
    player_ids TEXT NOT NULL,
    seed INTEGER NOT NULL,
    state TEXT NOT NULL
  )
`);
await client.execute(`
  CREATE TABLE IF NOT EXISTS game_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id),
    seq INTEGER NOT NULL,
    acting_player_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resulting_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (current_timestamp)
  )
`);

export const db = drizzle(client, { schema });
