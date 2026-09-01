import { useEffect, useRef } from "react";
import type { PlayerId } from "@rev-day/engine";
import { describeEntry } from "./gameText";
import { playerColorFor } from "./players";
import type { LogEntry } from "./useGame";

interface GameLogProps {
  readonly log: readonly LogEntry[];
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
}

export function GameLog({ log, humanPlayerId, botPlayerIds }: GameLogProps) {
  const linesRef = useRef<HTMLDivElement>(null);

  // Oldest to newest, newest at the bottom — matches a normal chat log,
  // so keep it scrolled to the bottom as new entries arrive.
  useEffect(() => {
    linesRef.current?.scrollTo({ top: linesRef.current.scrollHeight });
  }, [log.length]);

  return (
    <div className="game-log">
      <h3>GAME LOG</h3>
      <div className="game-log-lines" ref={linesRef}>
        {log.slice(-30).map((entry, i) => (
          // Same color-coding as the Action box: whoever actually took
          // this entry's action — the current player, or whoever was
          // responding/intercepting/reacting at the time.
          <p key={i} style={{ color: playerColorFor(entry.resultingState, entry.actingPlayerId) }}>
            {describeEntry(entry, humanPlayerId, botPlayerIds)}
          </p>
        ))}
      </div>
    </div>
  );
}
