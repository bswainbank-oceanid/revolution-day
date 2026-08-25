import type { CardInstance } from "../state/cards";
import type { GameState, PlayerId } from "../state/game";

// A card as seen by a specific viewer — `defRef` is redacted (null) when
// its identity shouldn't be visible to them. Everything else (kind, zone,
// controller, locationId, faceUp) stays: you can see the table layout and
// card backs, just not a hidden face.
export type FilteredCardInstance = Omit<CardInstance, "defRef"> & { readonly defRef: string | null };

// A per-player view of GameState — a distinct type, not just GameState
// with some fields blanked out, so hiding information is enforced by the
// type system rather than convention. `rng` is omitted entirely (the seed
// must never reach a client — see rev_day_architecture memory).
export interface FilteredGameState extends Omit<GameState, "rng" | "cards"> {
  readonly cards: readonly FilteredCardInstance[];
}

// Deliberately minimal, built for the bot package's decision-making
// rather than a full human-facing client (see rev_day_engine_design
// memory's known gaps). One documented simplification: `eliminated`/
// `discard` cards are treated as fully revealed, even though a card that
// died while still blended should technically stay hidden until game
// end ("all blended characters are revealed at the end of the game") —
// the reducer already discards the "was it face-down when it died" fact
// (clears `faceUp` on elimination), so tracking that properly would need
// new state. Harmless for a bot, which never targets already-dead cards;
// would matter for a real human-facing client later.
function isHiddenFromViewer(card: CardInstance, viewerId: PlayerId): boolean {
  if (card.controller === viewerId) return false; // always see your own cards
  if (card.zone === "deck") return true; // nobody sees deck contents
  if (card.zone === "hand") return true; // another player's hand
  if (card.zone === "inPlay") return card.faceUp === false; // face-down and not yours
  return false; // discard/eliminated — see the simplification above
}

export function filterForPlayer(state: GameState, viewerId: PlayerId): FilteredGameState {
  // Listed field by field (rather than destructuring rng away) so it's
  // unambiguous at a glance that rng is excluded, not just discarded.
  return {
    board: state.board,
    players: state.players,
    cards: state.cards.map((card) => (isHiddenFromViewer(card, viewerId) ? { ...card, defRef: null } : card)),
    president: state.president,
    turn: state.turn,
    resolutionStack: state.resolutionStack,
    pendingPassiveQueue: state.pendingPassiveQueue,
  };
}
