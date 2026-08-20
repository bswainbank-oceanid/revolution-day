# Revolution Day — digital conversion

npm workspaces monorepo. See `export/DESIGN_REFERENCE.md` for the game's
visual/rules reference and `export/card_data.json` for the source card data
(copied into `packages/engine/src/data/` — re-copy there if the source changes).

## Packages

- `packages/engine` — pure game logic, no UI or network dependency. Runs
  in-browser (v1, solo vs bots) and in Node (v2, multiplayer authority).
- `packages/client` — React + Vite app. Imports the engine directly for v1.
- `packages/server` — Fastify + SQLite (libsql) via Drizzle. Persistence API
  for now (save/resume, profile stats, campaigns); becomes the multiplayer
  authority in v2.

## Commands (run from repo root)

```
npm install          # installs all workspaces
npm run dev:client    # Vite dev server
npm run dev:server    # Fastify dev server (tsx watch), SQLite file at
                       # packages/server/data/dev.sqlite
npm run typecheck     # tsc --noEmit across all packages
npm run test          # vitest across all packages
npm run build         # production build (currently client only)
```
