import type { Action, FilteredGameState, PlayerId, WinConditionExplanation } from "@rev-day/engine";

// Talks to packages/server's dev harness (see rev_day_engine_design
// memory) — not a hypothetical future API, the exact routes/shapes
// already exercised by packages/server/src/app.test.ts. Every call here
// passes viewerId, so the client only ever receives the filtered view —
// never the raw ground-truth GameState, even though the server would
// hand it over if asked.
//
// VITE_API_BASE_URL is baked in at build time (Vite convention — only
// import.meta.env.VITE_* vars are exposed to client code), so a deployed
// build points at its real server instead of localhost; set it in
// whatever hosts the client build (see DEPLOY.md).
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  readonly status: number;
  readonly gameOver: WinConditionExplanation | null;

  constructor(message: string, status: number, gameOver: WinConditionExplanation | null = null) {
    super(message);
    this.status = status;
    this.gameOver = gameOver;
  }
}

interface GameRow {
  readonly id: number;
  readonly createdAt: string;
  readonly playerIds: readonly PlayerId[];
  readonly seed: number;
  readonly state: FilteredGameState;
  readonly gameOver: WinConditionExplanation | null;
}

interface LoggedAction {
  readonly id: number;
  readonly gameId: number;
  readonly seq: number;
  readonly actingPlayerId: PlayerId;
  readonly action: Action;
  readonly resultingState: FilteredGameState;
  readonly createdAt: string;
}

interface ActionResult {
  readonly id: number;
  readonly state: FilteredGameState;
  readonly gameOver: WinConditionExplanation | null;
  readonly logged: LoggedAction;
}

interface BotTurnResult {
  readonly id: number;
  readonly state: FilteredGameState;
  readonly actionsTaken: number;
  readonly gameOver: WinConditionExplanation | null;
  readonly logged: readonly LoggedAction[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.gameOver ?? null);
  }
  return body as T;
}

export function createGame(
  playerIds: readonly PlayerId[],
  viewerId: PlayerId,
  seed?: number,
  secondDeck?: boolean,
): Promise<GameRow> {
  return request<GameRow>(`/games?viewerId=${encodeURIComponent(viewerId)}`, {
    method: "POST",
    body: JSON.stringify({ playerIds, seed, secondDeck }),
  });
}

export function getGame(id: number, viewerId: PlayerId): Promise<GameRow> {
  return request<GameRow>(`/games/${id}?viewerId=${encodeURIComponent(viewerId)}`);
}

export function applyAction(
  id: number,
  viewerId: PlayerId,
  actingPlayerId: PlayerId,
  action: Action,
): Promise<ActionResult> {
  return request<ActionResult>(`/games/${id}/actions?viewerId=${encodeURIComponent(viewerId)}`, {
    method: "POST",
    body: JSON.stringify({ actingPlayerId, action }),
  });
}

export function botTurn(id: number, viewerId: PlayerId, playerId: PlayerId): Promise<BotTurnResult> {
  return request<BotTurnResult>(`/games/${id}/bot-turn?viewerId=${encodeURIComponent(viewerId)}`, {
    method: "POST",
    body: JSON.stringify({ playerId }),
  });
}
