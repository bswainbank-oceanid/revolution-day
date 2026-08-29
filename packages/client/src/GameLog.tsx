import { useEffect, useRef } from "react";
import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { playerLabel } from "./players";
import { resolveCard } from "./targetDecision";
import type { LogEntry } from "./useGame";

function cardName(state: FilteredGameState, cardId: string): string {
  return resolveCard(state, cardId)?.defRef ?? "a card";
}

// The board is fixed and small (6 locations), so a plain lookup by id is
// plenty — same source of truth CityView/LocationView use for names.
function locationName(state: FilteredGameState, locationId: string | undefined): string | null {
  if (!locationId) return null;
  const location = state.board.find((l) => l.id === locationId);
  return location ? (location.name ?? location.type) : null;
}

function describeEntry(entry: LogEntry, humanPlayerId: PlayerId, botPlayerIds: readonly PlayerId[]): string {
  // "You" reads more naturally than "Player 1" in first-person log
  // narration; other players still use the Player/Bot N scheme.
  const who = entry.actingPlayerId === humanPlayerId ? "You" : playerLabel(entry.resultingState, entry.actingPlayerId, humanPlayerId, botPlayerIds);
  const { action, resultingState } = entry;
  switch (action.type) {
    case "draw":
      return `${who} drew a card.`;
    case "playCard": {
      const at = locationName(resultingState, action.locationId);
      return `${who} played ${cardName(resultingState, action.cardId)}${at ? ` at ${at}` : ""}.`;
    }
    case "playMotorcade":
      return `${who} played a Motorcade.`;
    case "moveCard": {
      const at = locationName(resultingState, action.toLocationId);
      return `${who} moved ${cardName(resultingState, action.cardId)}${at ? ` to ${at}` : ""}.`;
    }
    case "activateAbility": {
      const card = resultingState.cards.find((c) => c.id === action.cardId);
      const at = locationName(resultingState, card?.locationId);
      return `${who} activated ${cardName(resultingState, action.cardId)}${at ? ` at ${at}` : ""}.`;
    }
    case "endTurn":
      return entry.actingPlayerId === humanPlayerId ? "You ended your turn." : `${who} ended their turn.`;
    case "chooseTargets":
      return `${who} chose targets.`;
    case "useResponse":
      return `${who} responded with ${cardName(resultingState, action.cardId)}.`;
    case "passResponse":
      return `${who} passed.`;
    case "revealBlended":
      return `${who} revealed blended cards.`;
    case "passReveal":
      return `${who} passed on revealing.`;
    case "interceptMotorcade":
      return `${who} intercepted the Motorcade.`;
    case "passIntercept":
      return `${who} let the Motorcade through.`;
    case "playReactive":
      return `${who} played reactive cards.`;
    case "passReactive":
      return `${who} passed.`;
  }
}

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
          <p key={i}>{describeEntry(entry, humanPlayerId, botPlayerIds)}</p>
        ))}
      </div>
    </div>
  );
}
