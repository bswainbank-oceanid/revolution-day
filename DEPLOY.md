# Deploying to Render (free tier)

Two separate Render services, both built from this same repo: a **Static Site** for
`packages/client` and a **Web Service** for `packages/server`.

**Known trade-off of the free tier** (see the chat history / commit context if you want the
full reasoning): the server's SQLite database is not on a persistent disk, and the free web
service spins down after 15 minutes with no HTTP requests — including mid-game, since nothing
polls the server while a player is just thinking. If that happens, that game's row is gone and
the next action against it 404s. Acceptable for a hobby/demo deploy; not for anything where a
broken game mid-play matters.

## 1. Push to GitHub

Render deploys from a GitHub (or GitLab) repo — this repo already has a remote
(`bswainbank-oceanid/revolution-day`), so just make sure the branch you want deployed is pushed.

## 2. Create the server (Web Service)

In the Render dashboard: **New > Web Service**, connect this repo.

- **Root Directory**: leave blank (repo root) — this is an npm workspaces monorepo, so
  `@rev-day/server`'s dependency on `@rev-day/bots`/`@rev-day/engine` (the `"*"` workspace
  protocol in its `package.json`) only resolves if `npm install` runs from the repo root, not
  from `packages/server` alone.
- **Runtime**: Node
- **Build Command**: `npm install`
- **Start Command**: `npm run start -w packages/server`
- **Instance Type**: Free
- **Environment Variables**:
  - `CLIENT_ORIGIN` — the static site's URL from step 3 below (CORS). You won't have this yet
    on the first pass — use a placeholder like `https://placeholder.onrender.com` and come back
    to fix it after step 3.
  - `DATABASE_PATH` — optional, defaults to `data/dev.sqlite` (fine to leave unset; it's
    ephemeral either way on the free tier, see the trade-off note above).

Deploy it, then note the URL Render assigns (`https://<something>.onrender.com`) — you'll need
it in step 3. `GET https://<that-url>/health` should return `{"status":"ok"}` once it's live.

## 3. Create the client (Static Site)

**New > Static Site**, same repo.

- **Root Directory**: leave blank (repo root), same reasoning as above.
- **Build Command**: `npm install && npm run build -w packages/client`
- **Publish Directory**: `packages/client/dist`
- **Environment Variables**:
  - `VITE_API_BASE_URL` — the server's URL from step 2, e.g.
    `https://rev-day-server.onrender.com`. This is baked in at *build* time (Vite convention —
    only `VITE_*` vars reach client code, and only as of the build that read them), so changing
    it later means triggering a new deploy, not just an env var update.

Deploy it, note its URL.

## 4. Wire the two together

Go back to the **server** service's environment variables and set `CLIENT_ORIGIN` to the
static site's real URL from step 3 (replacing the placeholder). Save — Render redeploys/restarts
the service automatically on an env var change.

## 5. Verify

Open the static site's URL, start a game, and confirm actions go through (open the browser's
network tab if anything looks stuck — a CORS error there almost always means `CLIENT_ORIGIN`
doesn't exactly match the static site's origin, protocol and all).

## Local dev is unaffected

Neither `VITE_API_BASE_URL` nor `CLIENT_ORIGIN` need to be set locally — both default to
`localhost:5173`/`localhost:3001`, matching `npm run dev:client` / `npm run dev:server` as
before.
