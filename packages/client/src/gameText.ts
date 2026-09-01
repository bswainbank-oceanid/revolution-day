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
// CityView's own numbered tile badges use this same board-index+1 scheme
// (see its city-tile-badge span), so this keeps every text mention of a
// location tagged with the same number the player sees on the tile itself.
export function locationNumber(state: FilteredGameState, locationId: string | null | undefined): number | null {
  if (!locationId) return null;
  const index = state.board.findIndex((l) => l.id === locationId);
  return index === -1 ? null : index + 1;
}

export function locationName(state: FilteredGameState, locationId: string | null | undefined): string | null {
  if (!locationId) return null;
  const location = state.board.find((l) => l.id === locationId);
  if (!location) return null;
  const number = locationNumber(state, locationId);
  const name = location.name ?? location.type;
  return number ? `${name} (${number})` : name;
}

// The "President's starting and ending locations" whenever a Motorcade
// actually moves him — covers both an uncontested play (moves immediately)
// and a delayed resolution once every eligible interceptor in the window
// has passed (see applyMotorcadeInterceptionWindowAction in reducer.ts).
// Empty once there's genuinely nothing to report: the window just opened
// (or is still mid-poll — resultingState still carries the frame either
// way, so this one check covers both), or the Motorcade did something
// other than move the President (the post-elimination "move a card you
// control" branch, or the no-op once he's already survived).
function motorcadeMoveSuffix(priorState: FilteredGameState, resultingState: FilteredGameState): string {
  const pendingWindow = resultingState.resolutionStack[resultingState.resolutionStack.length - 1];
  if (pendingWindow?.kind === "motorcadeInterceptionWindow") return "";
  if (priorState.president.status === "notEntered" && resultingState.president.status === "alive") {
    const end = locationName(resultingState, resultingState.president.locationId);
    return end ? ` — the President entered at ${end}` : "";
  }
  if (priorState.president.status === "alive" && resultingState.president.status === "alive") {
    const start = locationName(priorState, priorState.president.locationId);
    const end = locationName(resultingState, resultingState.president.locationId);
    return start && end && start !== end ? ` — the President moved from ${start} to ${end}` : "";
  }
  if (priorState.president.status === "alive" && resultingState.president.status === "survived") {
    const start = locationName(priorState, priorState.president.locationId);
    return start ? ` — the President survived at ${start}` : "";
  }
  return "";
}

// The move was cancelled — the President just stays put, so there's only
// one location to report, not a start/end pair.
function motorcadeInterceptedSuffix(resultingState: FilteredGameState): string {
  const at = resultingState.president.status === "alive" ? locationName(resultingState, resultingState.president.locationId) : null;
  return at ? ` — the President remains at ${at}` : "";
}

export function describeEntry(
  entry: LogEntry,
  priorState: FilteredGameState,
  humanPlayerId: PlayerId,
  botPlayerIds: readonly PlayerId[],
): string {
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
      return `${who} played a Motorcade${motorcadeMoveSuffix(priorState, resultingState)}.`;
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
      return `${who} intercepted the Motorcade${motorcadeInterceptedSuffix(resultingState)}.`;
    case "passIntercept":
      return `${who} let the Motorcade through${motorcadeMoveSuffix(priorState, resultingState)}.`;
    case "playReactive":
      return `${who} played reactive cards.`;
    case "passReactive":
      return `${who} passed.`;
  }
}
