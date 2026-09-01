import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { playerLabel } from "./players";
import { resolveCard } from "./targetDecision";
import type { LogEntry } from "./useGame";

export function cardName(state: FilteredGameState, cardId: string): string {
  return resolveCard(state, cardId)?.defRef ?? "a card";
}

// Same fallback as cardName for a card whose identity isn't known to the
// viewer, but distinguishes *why*: still face-down (a blended card, in
// which case there's something concrete to say even without a name) from
// genuinely unknown (defRef null for any other reason — the plain "a
// card" fallback, e.g. once it's already been revealed and the log entry
// is stale, or the viewer never had visibility at all).
export function cardNameOrBlended(state: FilteredGameState, cardId: string): string {
  const card = resolveCard(state, cardId);
  if (!card) return "a card";
  if (card.defRef !== null) return card.defRef;
  return card.faceUp === false ? "a blended card" : "a card";
}

// The board is fixed and small (6 locations), so a plain lookup by id is
// plenty — same source of truth CityView/LocationView use for names.
export function locationName(state: FilteredGameState, locationId: string | undefined): string | null {
  if (!locationId) return null;
  const location = state.board.find((l) => l.id === locationId);
  return location ? (location.name ?? location.type) : null;
}

export function describeEntry(entry: LogEntry, humanPlayerId: PlayerId, botPlayerIds: readonly PlayerId[]): string {
  // "You" reads more naturally than "Player 1" in first-person log
  // narration; other players still use the Player/Bot N scheme.
  const who = entry.actingPlayerId === humanPlayerId ? "You" : playerLabel(entry.resultingState, entry.actingPlayerId, humanPlayerId, botPlayerIds);
  const { action, resultingState } = entry;
  switch (action.type) {
    case "draw":
      return `${who} drew a card.`;
    case "playCard": {
      const at = locationName(resultingState, action.locationId);
      return `${who} played ${cardNameOrBlended(resultingState, action.cardId)}${at ? ` at ${at}` : ""}.`;
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
