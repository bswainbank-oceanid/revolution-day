import { useCallback, useState } from "react";
import { getAbilityEffects } from "@rev-day/engine";
import type { Action, FilteredGameState, PlayerId, WinConditionExplanation } from "@rev-day/engine";
import { ApiError, applyAction, botTurn, createGame } from "./api";
import { decider } from "./decider";
import { computeTrivialChooseTargets } from "./targetDecision";

// Fisher-Yates — used only to randomize starting seat order.
function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export interface LogEntry {
  readonly actingPlayerId: PlayerId;
  readonly action: Action;
  readonly resultingState: FilteredGameState;
}

export interface GameSession {
  readonly gameId: number;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  // Whoever the engine's own random roll picked to take the very first
  // turn (setupGame's startingPlayerId) — captured once, from the
  // pristine state createGame returns, and never updated again. Distinct
  // from seatIndex (mere array position at setup) — see players.ts's
  // playersInPlayOrder, which anchors the top ribbon on this rather than
  // seat order.
  readonly startingPlayerId: PlayerId;
  // The pristine state createGame returns, before anything — even the
  // starting player's own opening draw — has happened. Captured once,
  // same as startingPlayerId, so useTurnPlayback has a real "prior state"
  // to compare the very first log entry against (there's no log[-1] to
  // fall back on otherwise).
  readonly initialState: FilteredGameState;
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
  // Session-level trouble (network failure, 404 — the game itself is
  // gone) — shown as App.tsx's own banner, since there's no specific
  // attempted move for the Action Box to explain.
  readonly error: string | null;
  // Why the *last submitted action* was rejected (a 400 from applyAction
  // — an illegal move, not a network/session problem) — surfaced in the
  // Action Box's current-action quadrant instead of failing silently.
  // Cleared automatically at the start of the next act() call, success or
  // failure, same as `error` above.
  readonly actionError: string | null;
  readonly startNewGame: (botCount: number, secondDeck?: boolean) => Promise<void>;
  readonly act: (action: Action) => Promise<void>;
}

// Whatever the human's next submission should be with zero real choice
// involved, or null if a genuine decision is on the table. Covers the
// step 5 cases (mandatory draw, forced end-turn) plus step 6's: a pending
// ability effect that has only one possible submission (self/binding
// target, random selection, "all" mode, a forced/empty pool, the
// President as Wife's only possible target, etc. — see
// computeTrivialChooseTargets for the exact rules).
function computeAutoAction(state: FilteredGameState, humanPlayerId: PlayerId): Action | null {
  if (state.resolutionStack.length === 0) {
    if (state.turn.phase === "draw") return { type: "draw" };
    // A restricted action grant (see TurnState.restrictedAction) can
    // leave actionsRemaining at 0 while the player still has real plays
    // or activations available — forcing endTurn here would silently
    // discard it. The voluntary End Turn button stays available either
    // way, so a player with nothing left to spend it on (or who just
    // doesn't want to) isn't stuck — they just click it.
    if (state.turn.actionsRemaining === 0 && state.turn.restrictedAction === null) return { type: "endTurn" };
    return null;
  }
  const frame = state.resolutionStack[state.resolutionStack.length - 1]!;
  if (frame.kind !== "abilityResolution") return null;
  const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId);
  if (!sourceCard || sourceCard.defRef === null) return null;
  const definition = getAbilityEffects(sourceCard.defRef, frame.abilityIndex);
  const effect = definition?.effects[frame.effectIndex ?? 0];
  if (!effect) return null;
  const trivial = computeTrivialChooseTargets(state, sourceCard, humanPlayerId, effect);
  if (!trivial) return null;
  return trivial.locationIds
    ? { type: "chooseTargets", targetIds: trivial.targetIds, locationIds: trivial.locationIds }
    : { type: "chooseTargets", targetIds: trivial.targetIds };
}

// Drives play forward until a *real* human decision is on the table,
// collecting every individual step along the way (not just the final
// state) — bot turns (a bot's own turn can itself pause on a decision
// belonging to a *different* bot, e.g. an alarm response — decider()
// names whoever's turn it actually is at each step, not necessarily the
// same bot that just went, so this keeps calling botTurn for whichever
// bot that is) and every human submission computeAutoAction says has no
// real choice — still submitted as a real action (the engine wants it
// logged even though there's no choice), just not surfaced as a button.
// See BUILD_PLAN.md's "no confirms anywhere" section.
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
      // Safety net: takeBotTurn (server side) already detects a bot with
      // no legal decision left and returns its input state unchanged
      // rather than looping forever itself — but decider() would then
      // keep naming the exact same player forever too, and without this
      // check *this* loop would call botTurn for them again and again
      // with no bound (a real freeze this caught: Puppet-Master's remote
      // activation committing with no candidate card left to actually
      // activate). No progress across a whole call is never legitimate
      // mid-turn, so surface it as an error instead of spinning.
      if (JSON.stringify(result.state) === JSON.stringify(current)) {
        throw new Error(`${nextPlayer} has no legal action available and got stuck — this is a bot/engine bug, not something to retry`);
      }
      for (const step of result.logged) {
        entries.push({ actingPlayerId: step.actingPlayerId, action: step.action, resultingState: step.resultingState });
      }
      current = result.state;
      if (result.gameOver) return { state: current, gameOver: result.gameOver, entries };
      continue;
    }

    const autoAction = computeAutoAction(current, humanPlayerId);
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
  const [actionError, setActionError] = useState<string | null>(null);

  const startNewGame = useCallback(async (botCount: number, secondDeck?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const humanPlayerId = "you";
      // 1-7 bots (2-8 players total) — setupGame's own supported range
      // (setup.ts throws outside 2-8), clamped here so a bad caller can't
      // send something the server would just reject.
      const clampedBotCount = Math.min(7, Math.max(1, Math.round(botCount)));
      const botPlayerIds = Array.from({ length: clampedBotCount }, (_, i) => `bot-${i + 1}`);
      // Seat order is exactly array order (setup.ts), so who goes first —
      // and thus who the top ribbon starts with — would otherwise always
      // be the human. Shuffle so any seat, human or bot, can lead.
      const seatOrder = shuffle([humanPlayerId, ...botPlayerIds]);
      const row = await createGame(seatOrder, humanPlayerId, undefined, secondDeck);
      const startingPlayerId = row.state.turn.currentPlayerId;
      const initialState = row.state;
      const { state, gameOver, entries } = await runUntilHumanDecision(row.id, humanPlayerId, row.state);
      setSession({ gameId: row.id, humanPlayerId, botPlayerIds, startingPlayerId, initialState, state, gameOver, log: entries });
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
      setActionError(null);
      try {
        const result = await applyAction(session.gameId, session.humanPlayerId, session.humanPlayerId, action);
        const ownEntry: LogEntry = { actingPlayerId: session.humanPlayerId, action, resultingState: result.state };
        if (result.gameOver) {
          setSession({ ...session, state: result.state, gameOver: result.gameOver, log: [...session.log, ownEntry] });
          return;
        }
        // Show the human's own result the moment *its own* request comes
        // back, rather than waiting on runUntilHumanDecision too — that
        // call can make several more round-trips of its own (one bot turn
        // at a time, however many bots there are) before it's the human's
        // turn again, and bundling all of that into a single state update
        // meant their own card only ever appeared already bundled together
        // with everything every bot did afterward, with no way to show it
        // separately first. useTurnPlayback's own beat-by-beat pacing only
        // gets a chance to work correctly if these arrive as two separate
        // log updates, not one.
        setSession({ ...session, state: result.state, gameOver: null, log: [...session.log, ownEntry] });
        const { state, gameOver, entries } = await runUntilHumanDecision(session.gameId, session.humanPlayerId, result.state);
        // Functional form — session has already moved on from the
        // `session` this closure captured (the update just above), so
        // building on that stale value here would silently drop it.
        setSession((prev) => (prev ? { ...prev, state, gameOver, log: [...prev.log, ...entries] } : prev));
      } catch (err) {
        // A 400 is applyAction rejecting the specific move just attempted
        // (an illegal action, not a session problem) — the Action Box
        // explains it directly instead of a generic banner. Anything else
        // (network failure, a 404 once the game itself is gone) is session-
        // level trouble with no specific move to explain, so it keeps
        // going through the general error banner instead.
        if (err instanceof ApiError && err.status === 400) {
          setActionError(err.message);
        } else {
          setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
          // A 404 means the game itself is gone (e.g. the server's dev
          // database got wiped/restarted underneath an open tab) — the
          // stale session.state would otherwise sit frozen forever, showing
          // whatever it last rendered with no way to recover except a full
          // page reload. Falling back to the New Game screen is the actual
          // correct state to be in once the game we're pointed at no longer
          // exists.
          if (err instanceof ApiError && err.status === 404) setSession(null);
        }
      } finally {
        setLoading(false);
      }
    },
    [session],
  );

  return { session, loading, error, actionError, startNewGame, act };
}
