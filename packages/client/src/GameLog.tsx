import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { playerLabel } from "./players";
import type { LogEntry } from "./useGame";

function cardName(state: FilteredGameState, cardId: string): string {
  return state.cards.find((c) => c.id === cardId)?.defRef ?? "a card";
}

function describeEntry(entry: LogEntry, humanPlayerId: PlayerId, botPlayerIds: readonly PlayerId[]): string {
  // "You" reads more naturally than "Player 1" in first-person log
  // narration; other players still use the Player/Bot N scheme.
  const who = entry.actingPlayerId === humanPlayerId ? "You" : playerLabel(entry.resultingState, entry.actingPlayerId, humanPlayerId, botPlayerIds);
  const { action, resultingState } = entry;
  switch (action.type) {
    case "draw":
      return `${who} drew a card.`;
    case "playCard":
      return `${who} played ${cardName(resultingState, action.cardId)}.`;
    case "playMotorcade":
      return `${who} played a Motorcade.`;
    case "moveCard":
      return `${who} moved ${cardName(resultingState, action.cardId)}.`;
    case "activateAbility":
      return `${who} activated ${cardName(resultingState, action.cardId)}.`;
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
  return (
    <div className="game-log">
      <h3>GAME LOG</h3>
      <div className="game-log-lines">
        {log
          .slice(-30)
          .reverse()
          .map((entry, i) => (
            <p key={i}>{describeEntry(entry, humanPlayerId, botPlayerIds)}</p>
          ))}
      </div>
    </div>
  );
}
