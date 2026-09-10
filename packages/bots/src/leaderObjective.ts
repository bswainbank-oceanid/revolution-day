import type { BoardLayout, FilteredGameState, PlayerId, WinPredicate } from "@rev-day/engine";

// Non-null only for a leader whose win condition is a location-gated
// presidentEliminatedAt predicate (currently: Wife -> Palace). Deliberately
// separate from PresidentObjective (eliminate/protect/neutral) rather than
// folding a location into it — every existing PresidentObjective check
// stays untouched, and a leader with no location predicate gets
// eliminateAtLocationId: null everywhere below, which every function in
// this file treats as "no location-aware behavior, do nothing extra."
export interface LeaderLocationObjective {
  readonly eliminateAtLocationId: string | null;
}

// Doesn't recurse into `{type: "or"}` wrappers the way presidentObjectiveFor
// does — no current leader nests a presidentEliminatedAt predicate inside
// an "or" (only Master Assassin uses "or", and not for this predicate
// type). Add recursion here if that ever changes.
export function leaderLocationObjectiveFor(
  leaderDefRef: string,
  winConditions: Readonly<Record<string, readonly WinPredicate[]>>,
  board: BoardLayout,
): LeaderLocationObjective {
  const predicates = winConditions[leaderDefRef] ?? [];
  const locationPredicate = predicates.find(
    (p): p is Extract<WinPredicate, { type: "presidentEliminatedAt" }> => p.type === "presidentEliminatedAt",
  );
  if (!locationPredicate) return { eliminateAtLocationId: null };
  const location = board.find((l) => l.name === locationPredicate.locationName);
  return { eliminateAtLocationId: location?.id ?? null };
}

// Forward-step distance from `fromLocationId` to `toLocationId` along the
// board's own array order — how many Motorcade plays (by anyone, not just
// this player) would deliver the President there from his current spot.
// The board is linear, not cyclic: Palace is always the final location
// (see reducer.ts's computeForwardMove — moving past the last location
// sets the President to "survived", off the board, ending the game), so
// this is plain index subtraction, not modulo. Returns Infinity if either
// id is unknown, or if `toLocationId` is behind `fromLocationId` (already
// passed — can't happen for a still-"alive" President given the above,
// but keeps this safe to call speculatively).
export function forwardStepDistance(board: BoardLayout, fromLocationId: string, toLocationId: string): number {
  const fromIndex = board.findIndex((l) => l.id === fromLocationId);
  const toIndex = board.findIndex((l) => l.id === toLocationId);
  if (fromIndex === -1 || toIndex === -1 || toIndex < fromIndex) return Infinity;
  return toIndex - fromIndex;
}

// Two independent triggers for getting a location-gated leader (Wife) off
// the bench, whichever fires first:
// - The President is close enough to her win location that the next
//   Motorcade play or two (by anyone) could plausibly deliver him —
//   waiting any longer risks her still being in hand when he arrives.
// - The deck is running low: once it's empty, any player holding a
//   Motorcade card must play it immediately and for free (card_data.json's
//   "forced empty-deck rule"), so his movement stops being a predictable
//   turn-by-turn thing and becomes a bursty scramble with no safe window
//   to react within — she needs to already be in play before that starts,
//   regardless of his current distance.
const DEPLOY_DISTANCE_THRESHOLD = 2;
const DECK_LOW_THRESHOLD = 6;

export function shouldDeployLocationLeaderNow(state: FilteredGameState, objective: LeaderLocationObjective): boolean {
  if (!objective.eliminateAtLocationId) return false;
  const deckSize = state.cards.filter((c) => c.zone === "deck").length;
  if (deckSize <= DECK_LOW_THRESHOLD) return true;
  if (state.president.status !== "alive" || !state.president.locationId) return false;
  return forwardStepDistance(state.board, state.president.locationId, objective.eliminateAtLocationId) <= DEPLOY_DISTANCE_THRESHOLD;
}

// The single location immediately before the win location along the
// board's fixed order — e.g. one step before the Palace. A Motorcade
// interceptor (Throng of Admirers / Angry Mob) sacrifices itself to
// cancel the *next* move attempted from wherever it's standing when that
// move is played, so this is where one needs to be stationed to control
// the final approach: cancelling the move that would deliver the
// President onto the win location itself, on demand, rather than leaving
// his arrival to chance. Undefined if the win location is the very first
// board location (no location precedes it) — not reachable with the
// current board layout, but kept honest rather than assuming index 0.
export function stagingLocationId(board: BoardLayout, eliminateAtLocationId: string): string | undefined {
  const index = board.findIndex((l) => l.id === eliminateAtLocationId);
  return index > 0 ? board[index - 1]!.id : undefined;
}

export interface ProtectionTargets {
  readonly locationIds: readonly string[];
}

// Where this player's Regime cards should currently be routed to keep
// findProtectorCards coverage live (targeting.ts: a Protected leader is
// shielded by other active, visible, same-faction, non-Protected cards at
// their own location) — the President's own location plus his single
// predicted next stop (covers "before he arrives" as well as "he's here
// now"), and this player's own location-gated leader's location once
// she's actually in play there. Recomputed fresh every decision: both the
// President's position and whether the leader has been deployed yet can
// change every turn.
export function computeProtectionTargets(
  state: FilteredGameState,
  playerId: PlayerId,
  objective: LeaderLocationObjective,
): ProtectionTargets {
  const ids = new Set<string>();
  if (state.president.status === "alive" && state.president.locationId) {
    ids.add(state.president.locationId);
    const index = state.board.findIndex((l) => l.id === state.president.locationId);
    const next = index === -1 ? undefined : state.board[index + 1];
    if (next) ids.add(next.id);
  }
  if (objective.eliminateAtLocationId) {
    const leaderHere = state.cards.some(
      (c) =>
        c.zone === "inPlay" &&
        c.controller === playerId &&
        c.kind === "leader" &&
        c.locationId === objective.eliminateAtLocationId,
    );
    if (leaderHere) ids.add(objective.eliminateAtLocationId);
  }
  return { locationIds: [...ids] };
}

// Which single adjacent step from `fromLocationId` makes progress toward
// the nearest of `desiredLocationIds` — pure index math along the same
// linear board forwardStepDistance walks. Returns undefined if there's no
// adjacent id (shouldn't happen for anything decideMoveCard already
// filtered to movable) or `fromLocationId` is already at its nearest
// desired location (nothing to step toward).
export function stepToward(board: BoardLayout, fromLocationId: string, desiredLocationIds: readonly string[]): string | undefined {
  const fromIndex = board.findIndex((l) => l.id === fromLocationId);
  if (fromIndex === -1) return undefined;
  const desiredIndexes = desiredLocationIds
    .map((id) => board.findIndex((l) => l.id === id))
    .filter((i) => i !== -1 && i !== fromIndex);
  if (desiredIndexes.length === 0) return undefined;
  const nearest = desiredIndexes.reduce((a, b) => (Math.abs(a - fromIndex) <= Math.abs(b - fromIndex) ? a : b));
  const nextIndex = nearest > fromIndex ? fromIndex + 1 : fromIndex - 1;
  return board[nextIndex]?.id;
}
