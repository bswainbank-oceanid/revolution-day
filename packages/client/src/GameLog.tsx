import { useEffect, useRef } from "react";
import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { describeEntry, leaderEliminatedInEntry, presidentEliminatedInEntry } from "./gameText";
import { playerColorFor } from "./players";
import type { LogEntry } from "./useGame";

interface GameLogProps {
  readonly log: readonly LogEntry[];
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  // The pristine pre-game state — same role as buildBeats' own use of it
  // in useTurnPlayback.ts: describeEntry needs each entry's *prior* state
  // (e.g. to report the President's location before a Motorcade moved
  // him), and there's no log[-1] to fall back on for the very first entry.
  readonly initialState: FilteredGameState;
}

export function GameLog({ log, humanPlayerId, botPlayerIds, initialState }: GameLogProps) {
  const linesRef = useRef<HTMLDivElement>(null);

  // Oldest to newest, newest at the bottom — matches a normal chat log,
  // so keep it scrolled to the bottom as new entries arrive.
  useEffect(() => {
    linesRef.current?.scrollTo({ top: linesRef.current.scrollHeight });
  }, [log.length]);

  // Keep each rendered entry's real index into the full log (not the
  // sliced-to-30 array) so priorState lines up correctly.
  const visible = log.length > 30 ? log.slice(-30) : log;
  const startIndex = log.length - visible.length;

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
              {describeEntry(entry, priorState, humanPlayerId, botPlayerIds)}
            </p>
          );
        })}
      </div>
    </div>
  );
}
