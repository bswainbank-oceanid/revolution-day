import { getEngineInfo } from "@rev-day/engine";
import Fastify from "fastify";
import { db } from "./db/client";
import { games } from "./db/schema";

const app = Fastify({ logger: true });

// Proves the server can import the shared engine package (the same one
// the client uses for v1 solo play) and will host it as the multiplayer
// authority in v2.
app.get("/health", async () => {
  return { status: "ok", engine: getEngineInfo() };
});

// Smoke-test routes for the persistence layer. Real save/resume,
// profile stats, and campaign endpoints replace these once the
// engine's state model and action interface exist.
app.post("/games", async (request) => {
  const state = (request.body as { state?: unknown })?.state ?? {};
  const [row] = await db.insert(games).values({ state: JSON.stringify(state) }).returning();
  return row;
});

app.get("/games", async () => {
  return db.select().from(games).all();
});

const PORT = Number(process.env.PORT ?? 3001);

app
  .listen({ port: PORT })
  .then(() => app.log.info(`Revolution Day server listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
