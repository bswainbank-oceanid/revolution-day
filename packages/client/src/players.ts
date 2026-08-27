import type { FilteredGameState, PlayerId } from "@rev-day/engine";

// Fixed per-player colors for the whole game (not tied to seat position,
// per DESIGN_NOTES.md) — assigned by seatIndex order, the one stable
// per-player ordering available. Only the first 6 are "final" brand
// colors; 7/8 are documented placeholders in DESIGN_NOTES.md.
const PLAYER_COLORS = [
  "var(--marker-crimson)",
  "var(--marker-cobalt)",
  "var(--rebel-light)", // "green" in DESIGN_NOTES.md's list
  "var(--marker-lemon)",
  "var(--marker-violet)",
  "var(--marker-amber)",
  "var(--marker-teal)",
  "#e91e8c", // magenta placeholder for an 8th player, per DESIGN_NOTES.md
];

export function playersInSeatOrder(state: FilteredGameState): readonly FilteredGameState["players"][number][] {
  return [...state.players].sort((a, b) => a.seatIndex - b.seatIndex);
}

export function playerColor(seatIndex: number): string {
  return PLAYER_COLORS[seatIndex % PLAYER_COLORS.length]!;
}

// A player's leader is only nameable if its identity is currently known
// to the viewer — always true for your own leader (filterForPlayer keeps
// it visible regardless of zone/faceUp), true for an opponent's only once
// it's been played face-up (or is attribute-less and thus never hidden).
// Still in hand, or blended face-down, both read as "Unknown Leader".
export function leaderNameFor(state: FilteredGameState, playerId: PlayerId): string {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  return leader?.defRef ?? "Unknown Leader";
}

export function handCountFor(state: FilteredGameState, playerId: PlayerId): number {
  return state.cards.filter((c) => c.zone === "hand" && c.controller === playerId).length;
}

// No real names yet — "Player N"/"Bot N" by play (seat) order, so turn
// order stays legible even before names exist; "(You)" is appended
// separately since who's human doesn't depend on seat position.
export function playerLabel(
  state: FilteredGameState,
  playerId: PlayerId,
  humanPlayerId: PlayerId,
  botPlayerIds: readonly PlayerId[],
): string {
  const seatIndex = state.players.find((p) => p.id === playerId)?.seatIndex ?? 0;
  const kind = botPlayerIds.includes(playerId) ? "Bot" : "Player";
  const suffix = playerId === humanPlayerId ? " (You)" : "";
  return `${kind} ${seatIndex + 1}${suffix}`;
}
