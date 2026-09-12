import { useEffect, useRef } from "react";
import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { describeEntry, leaderEliminatedInEntry, presidentEliminatedInEntry } from "./gameText";
import { playerColorFor } from "./players";
import type { LogEntry } from "./useGame";

interface GameLogProps {
  readonly log: readonly LogEntry[];
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly startingPlayerId: PlayerId;
  // The pristine pre-game state — same role as buildBeats' own use of it
  // in useTurnPlayback.ts: describeEntry needs each entry's *prior* state
  // (e.g. to report the President's location before a Motorcade moved
  // him), and there's no log[-1] to fall back on for the very first entry.
  readonly initialState: FilteredGameState;
  // How many of `log`'s entries playback has actually narrated so far
  // (useTurnPlayback's own revealedLogLength) — without this the log
  // would dump every entry the instant the server responds, running
  // ahead of whatever beat is still being paced or paused on
  // awaitingContinue next to it. Defaults to log.length so this still
  // reads correctly on the rare render where playback hasn't mounted yet.
  readonly revealedLength?: number;
}

export function GameLog({ log, humanPlayerId, botPlayerIds, startingPlayerId, initialState, revealedLength }: GameLogProps) {
  const linesRef = useRef<HTMLDivElement>(null);
  const revealed = log.slice(0, revealedLength ?? log.length);

  // Oldest to newest, newest at the bottom — matches a normal chat log,
  // so keep it scrolled to the bottom as new entries arrive. Keyed on the
  // *revealed* count, not the raw log, so this fires again — and the tempo
  // pause between beats is visible as the log growing one line at a time —
  // each time playback reveals another entry, not just when the server
  // hands back a whole new batch.
  useEffect(() => {
    linesRef.current?.scrollTo({ top: linesRef.current.scrollHeight });
  }, [revealed.length]);

  // Keep each rendered entry's real index into the full log (not the
  // sliced-to-30 array) so priorState lines up correctly.
  const visible = revealed.length > 30 ? revealed.slice(-30) : revealed;
  const startIndex = revealed.length - visible.length;

  return (
    <div className="game-log">
      <h3>GAME LOG</h3>
      <div className="game-log-lines" ref={linesRef}>
        {visible.map((entry, i) => {
          const globalIndex = startIndex + i;
          const priorState = globalIndex > 0 ? log[globalIndex - 1]!.resultingState : initialState;
          const presidentDown = presidentEliminatedInEntry(priorState, entry.resultingState);
          const leaderDown = !presidentDown && leaderEliminatedInEntry(priorState, entry.resultingState);
          const specialClass = presidentDown ? "president-eliminated-line" : leaderDown ? "leader-eliminated-line" : undefined;
          return (
            // Same color-coding as the Action box: whoever actually took
            // this entry's action — the current player, or whoever was
            // responding/intercepting/reacting at the time. The President's
            // own elimination (and, one tier down, a player leader's)
            // overrides that with a fixed gold treatment instead — a rare,
            // game-defining event that should read as louder than the
            // normal per-player color-coding.
            <p key={globalIndex} className={specialClass} style={specialClass ? undefined : { color: playerColorFor(entry.resultingState, entry.actingPlayerId) }}>
              {describeEntry(entry, priorState, humanPlayerId, botPlayerIds, startingPlayerId)}
            </p>
          );
        })}
      </div>
    </div>
  );
}
