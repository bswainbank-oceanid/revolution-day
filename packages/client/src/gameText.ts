import { asCardInstance, cardData, getAbilities, PRESIDENT_TARGET_ID } from "@rev-day/engine";
import type { Action, FilteredGameState, PlayerId } from "@rev-day/engine";
import { playerLabel } from "./players";
import { resolveCard } from "./targetDecision";
import type { LogEntry } from "./useGame";

export function cardName(state: FilteredGameState, cardId: string): string {
  return resolveCard(state, cardId)?.defRef ?? "a card";
}

// "You have N more turns" / "Your Last Turn" once the President's
// elimination has started the endgame countdown (state.turn.
// endgameTurnsRemaining — null before then, set to 3*players.length+1 at
// the moment he dies and decremented by 1 on every single player's
// endTurn from there, see reducer.ts's applyEndTurn). That's a *shared*
// counter across every player, not a per-player one, but since rotation
// always proceeds seat-by-seat starting from whoever's turn is current,
// counting how many of the next `remaining` decrements land back on the
// current player is just remaining's distribution over players.length —
// no seat lookup needed as long as this is only read for the player whose
// turn it actually is right now (state.turn.currentPlayerId).
export function endgameTurnsLeftText(state: FilteredGameState): string | null {
  const remaining = state.turn.endgameTurnsRemaining;
  const playerCount = state.players.length;
  if (remaining === null || remaining < 1 || playerCount < 1) return null;
  const myTurnsLeft = Math.floor((remaining - 1) / playerCount) + 1;
  return myTurnsLeft === 1 ? "Your Last Turn" : `You have ${myTurnsLeft} more turns`;
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
  return number ? `${name} - ${number}` : name;
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

// True exactly on the entry where the President's own status flips to
// eliminated — used both to fold him into newlyEliminatedCardIds below
// and to flag that entry's line for special styling (see GameLog.tsx/
// ActivateAbilityBox.tsx's presidentEliminatedInEntry usage).
export function presidentEliminatedInEntry(priorState: FilteredGameState, resultingState: FilteredGameState): boolean {
  return priorState.president.status !== "eliminated" && resultingState.president.status === "eliminated";
}

// Same idea, one tier down: a player leader (kind: "leader" — the
// President's own pseudo-card also carries this kind, but he's never in
// state.cards, so there's no overlap with presidentEliminatedInEntry
// above) newly eliminated this entry — flagged for the milder gold
// treatment (see GameLog.tsx/ActivateAbilityBox.tsx).
export function leaderEliminatedInEntry(priorState: FilteredGameState, resultingState: FilteredGameState): boolean {
  const wasEliminated = new Set(priorState.cards.filter((c) => c.zone === "eliminated").map((c) => c.id));
  return resultingState.cards.some((c) => c.kind === "leader" && c.zone === "eliminated" && !wasEliminated.has(c.id));
}

// Every card newly in the "eliminated" zone this entry, plus the
// President's own sentinel id (PRESIDENT_TARGET_ID) when he's the one who
// just went down — a single ability can eliminate more than one target at
// once (Death Squad's "one or two targets", Suicide Bomber's
// random-target-then-self chain), so this is a list, not a single id.
function newlyEliminatedCardIds(priorState: FilteredGameState, resultingState: FilteredGameState): readonly string[] {
  const wasEliminated = new Set(priorState.cards.filter((c) => c.zone === "eliminated").map((c) => c.id));
  const cardIds = resultingState.cards.filter((c) => c.zone === "eliminated" && !wasEliminated.has(c.id)).map((c) => c.id);
  return presidentEliminatedInEntry(priorState, resultingState) ? [...cardIds, PRESIDENT_TARGET_ID] : cardIds;
}

// Which card's ability caused the elimination(s) this entry, and whether
// that ability is Activate or Response (per card_data.json — the only two
// ability types that exist) — the two things the elimination note needs
// to attribute. activateAbility/useResponse resolve immediately when the
// target was trivial (no real choice needed), so their own action already
// names the source directly; when a real choice WAS needed, the actual
// elimination lands on a later chooseTargets entry instead, sourced from
// whatever AbilityResolutionFrame is still open (protectedTargetingWindow
// etc. can sit briefly on top of it, hence scanning from the top down
// rather than assuming it's the last frame pushed). interceptMotorcade is
// a passive (motorcadeInterception), not an Activate/Response ability, so
// it gets a source but no ability-type qualifier. Anything else (a passive
// reactive queue, e.g.) has no single card to attribute — null.
function eliminationCause(
  priorState: FilteredGameState,
  resultingState: FilteredGameState,
  action: Action,
): { readonly sourceCardId: string; readonly abilityType: "Activate" | "Response" | null } | null {
  if (action.type === "activateAbility") return { sourceCardId: action.cardId, abilityType: "Activate" };
  if (action.type === "useResponse") return { sourceCardId: action.cardId, abilityType: "Response" };
  if (action.type === "interceptMotorcade") return { sourceCardId: action.cardId, abilityType: null };
  const frame = [...priorState.resolutionStack].reverse().find((f) => f.kind === "abilityResolution");
  if (!frame) return null;
  const sourceCard = resultingState.cards.find((c) => c.id === frame.sourceCardId);
  const instance = sourceCard ? asCardInstance(sourceCard) : null;
  const abilityType = instance ? (getAbilities(cardData, instance)[frame.abilityIndex]?.type ?? null) : null;
  return { sourceCardId: frame.sourceCardId, abilityType: abilityType === "Response" ? "Response" : "Activate" };
}

// "— eliminated {card} at {location} via {source}'s {Activate|Response}
// ability" per newly-eliminated card — location comes from priorState
// since eliminateCard clears locationId once a card is actually
// eliminated (see reducer.ts). The *name*, though, is read from
// resultingState, not priorState: a card that was still blended (face-down,
// identity hidden from this viewer) the instant before dying is fully
// revealed the instant it does — filterForPlayer never redacts an
// eliminated/discard card's defRef, regardless of faceUp (see its own
// comment) — so naming it from priorState would wrongly fall back to "a
// card" for exactly the cards this note matters most for. Self-eliminations
// (the interceptor sacrificing itself, Suicide Bomber's own second effect)
// skip the "via" clause — "eliminated X via X" doesn't add anything a
// reader doesn't already know from naming the card once.
function describeEliminations(priorState: FilteredGameState, resultingState: FilteredGameState, action: Action): string {
  const eliminatedIds = newlyEliminatedCardIds(priorState, resultingState);
  if (eliminatedIds.length === 0) return "";
  const cause = eliminationCause(priorState, resultingState, action);
  return eliminatedIds
    .map((id) => {
      // resolveCard (targetDecision.ts) special-cases PRESIDENT_TARGET_ID
      // into a pseudo-card with the same shape — the President's own
      // elimination reads identically to a real card's below.
      const priorCard = resolveCard(priorState, id);
      const resultCard = resolveCard(resultingState, id);
      const name = id === PRESIDENT_TARGET_ID ? "the President" : (resultCard?.defRef ?? cardName(resultingState, id));
      const at = locationName(priorState, priorCard?.locationId);
      const atClause = at ? ` at ${at}` : "";
      if (!cause || cause.sourceCardId === id) return ` — eliminated ${name}${atClause}.`;
      const sourceName = cardName(resultingState, cause.sourceCardId);
      const viaClause = cause.abilityType ? `${sourceName}'s ${cause.abilityType} ability` : sourceName;
      return ` — eliminated ${name}${atClause} via ${viaClause}.`;
    })
    .join("");
}

export function describeEntry(
  entry: LogEntry,
  priorState: FilteredGameState,
  humanPlayerId: PlayerId,
  botPlayerIds: readonly PlayerId[],
  startingPlayerId: PlayerId,
): string {
  // "You" reads more naturally than "Player 1" in first-person log
  // narration; other players still use the Player/Bot N scheme.
  const who =
    entry.actingPlayerId === humanPlayerId
      ? "You"
      : playerLabel(entry.resultingState, entry.actingPlayerId, humanPlayerId, botPlayerIds, startingPlayerId);
  const { action, resultingState } = entry;
  return baseDescription(who, action, resultingState, priorState) + describeEliminations(priorState, resultingState, action);
}

function baseDescription(who: string, action: Action, resultingState: FilteredGameState, priorState: FilteredGameState): string {
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
      return who === "You" ? "You ended your turn." : `${who} ended their turn.`;
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
