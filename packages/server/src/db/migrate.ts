import { mkdirSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

// Real migration path, once `npm run db:generate` has produced files in
// ./drizzle from the schema. Not required yet — src/db/client.ts bootstraps
// the dev database directly while the schema is still taking shape.
const DB_PATH = process.env.DATABASE_PATH ?? "data/dev.sqlite";
mkdirSync("data", { recursive: true });

const client = createClient({ url: `file:${DB_PATH}` });
const db = drizzle(client);

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations applied.");
client.close();
