import { useCallback, useState } from "react";
import type { Action, FilteredGameState, PlayerId, WinConditionExplanation } from "@rev-day/engine";
import { ApiError, applyAction, botTurn, createGame } from "./api";
import { decider } from "./decider";

export interface GameSession {
  readonly gameId: number;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly state: FilteredGameState;
  readonly gameOver: WinConditionExplanation | null;
}

interface UseGameResult {
  readonly session: GameSession | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly startNewGame: () => Promise<void>;
  readonly act: (action: Action) => Promise<void>;
}

// Runs bot turns until it's the human's decision again, or the game ends.
// A bot's own turn can itself pause on a decision belonging to a
// *different* bot (e.g. an alarm response) — decider() names whoever's
// turn it actually is at each step, not necessarily the same bot that
// just went, so this keeps calling botTurn for whichever bot that is.
async function runBotsUntilHumanOrOver(
  gameId: number,
  humanPlayerId: PlayerId,
  state: FilteredGameState,
): Promise<{ state: FilteredGameState; gameOver: WinConditionExplanation | null }> {
  let current = state;
  for (;;) {
    const nextPlayer = decider(current);
    if (nextPlayer === humanPlayerId) return { state: current, gameOver: null };
    const result = await botTurn(gameId, humanPlayerId, nextPlayer);
    current = result.state;
    if (result.gameOver) return { state: current, gameOver: result.gameOver };
  }
}

export function useGame(): UseGameResult {
  const [session, setSession] = useState<GameSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startNewGame = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const humanPlayerId = "you";
      const botPlayerIds = ["bot-1", "bot-2"];
      const row = await createGame([humanPlayerId, ...botPlayerIds], humanPlayerId);
      const { state, gameOver } = await runBotsUntilHumanOrOver(row.id, humanPlayerId, row.state);
      setSession({ gameId: row.id, humanPlayerId, botPlayerIds, state, gameOver });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const act = useCallback(
    async (action: Action) => {
      if (!session || session.gameOver) return;
      setLoading(true);
      setError(null);
      try {
        const result = await applyAction(session.gameId, session.humanPlayerId, session.humanPlayerId, action);
        if (result.gameOver) {
          setSession({ ...session, state: result.state, gameOver: result.gameOver });
          return;
        }
        const { state, gameOver } = await runBotsUntilHumanOrOver(session.gameId, session.humanPlayerId, result.state);
        setSession({ ...session, state, gameOver });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
        // A 404 means the game itself is gone (e.g. the server's dev
        // database got wiped/restarted underneath an open tab) — the
        // stale session.state would otherwise sit frozen forever, showing
        // whatever it last rendered with no way to recover except a full
        // page reload. Falling back to the New Game screen is the actual
        // correct state to be in once the game we're pointed at no longer
        // exists.
        if (err instanceof ApiError && err.status === 404) setSession(null);
      } finally {
        setLoading(false);
      }
    },
    [session],
  );

  return { session, loading, error, startNewGame, act };
}
