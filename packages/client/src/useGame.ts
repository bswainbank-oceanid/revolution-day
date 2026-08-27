import { useCallback, useState } from "react";
import type { Action, FilteredGameState, PlayerId, WinConditionExplanation } from "@rev-day/engine";
import { ApiError, applyAction, botTurn, createGame } from "./api";
import { decider } from "./decider";

export interface LogEntry {
  readonly actingPlayerId: PlayerId;
  readonly action: Action;
  readonly resultingState: FilteredGameState;
}

export interface GameSession {
  readonly gameId: number;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly state: FilteredGameState;
  readonly gameOver: WinConditionExplanation | null;
  // Every individual action taken this session, human's and bots', in
  // order — GameLog renders this, and it's also the shape step 7's
  // playback choreography will step through instead of jumping straight
  // to the final post-bot-turn state.
  readonly log: readonly LogEntry[];
}

interface UseGameResult {
  readonly session: GameSession | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly startNewGame: () => Promise<void>;
  readonly act: (action: Action) => Promise<void>;
}

// Drives play forward until a *real* human decision is on the table,
// collecting every individual step along the way (not just the final
// state). Three things happen automatically along the way, none of them a
// genuine choice:
//   - bot turns (a bot's own turn can itself pause on a decision belonging
//     to a *different* bot, e.g. an alarm response — decider() names
//     whoever's turn it actually is at each step, not necessarily the same
//     bot that just went, so this keeps calling botTurn for whichever bot
//     that is)
//   - the human's mandatory start-of-turn draw (turn.phase === "draw")
//   - the human's forced end-turn once actionsRemaining hits 0
// Both human cases are still submitted as real actions (the engine wants
// them logged even though there's no choice), just not surfaced as
// buttons — see BUILD_PLAN.md's "no confirms anywhere" section.
async function runUntilHumanDecision(
  gameId: number,
  humanPlayerId: PlayerId,
  state: FilteredGameState,
): Promise<{ state: FilteredGameState; gameOver: WinConditionExplanation | null; entries: LogEntry[] }> {
  let current = state;
  const entries: LogEntry[] = [];
  for (;;) {
    const nextPlayer = decider(current);
    if (nextPlayer !== humanPlayerId) {
      const result = await botTurn(gameId, humanPlayerId, nextPlayer);
      for (const step of result.logged) {
        entries.push({ actingPlayerId: step.actingPlayerId, action: step.action, resultingState: step.resultingState });
      }
      current = result.state;
      if (result.gameOver) return { state: current, gameOver: result.gameOver, entries };
      continue;
    }

    const isTurnActionMoment = current.resolutionStack.length === 0;
    const autoAction: Action | null = !isTurnActionMoment
      ? null
      : current.turn.phase === "draw"
        ? { type: "draw" }
        : current.turn.actionsRemaining === 0
          ? { type: "endTurn" }
          : null;
    if (!autoAction) return { state: current, gameOver: null, entries };

    const result = await applyAction(gameId, humanPlayerId, humanPlayerId, autoAction);
    entries.push({ actingPlayerId: humanPlayerId, action: autoAction, resultingState: result.state });
    current = result.state;
    if (result.gameOver) return { state: current, gameOver: result.gameOver, entries };
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
      const { state, gameOver, entries } = await runUntilHumanDecision(row.id, humanPlayerId, row.state);
      setSession({ gameId: row.id, humanPlayerId, botPlayerIds, state, gameOver, log: entries });
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
        const ownEntry: LogEntry = { actingPlayerId: session.humanPlayerId, action, resultingState: result.state };
        if (result.gameOver) {
          setSession({ ...session, state: result.state, gameOver: result.gameOver, log: [...session.log, ownEntry] });
          return;
        }
        const { state, gameOver, entries } = await runUntilHumanDecision(session.gameId, session.humanPlayerId, result.state);
        setSession({ ...session, state, gameOver, log: [...session.log, ownEntry, ...entries] });
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
