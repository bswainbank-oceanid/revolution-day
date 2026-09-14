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

// `eliminated`/`discard` cards are always treated as fully revealed here,
// regardless of whether they were still blended (face-down) the instant
// before — confirmed as the actual intended ruling (not just a
// bot-decision-making shortcut): elimination itself reveals a card
// immediately, rather than deferring to the printed "all blended
// characters are revealed at the end of the game" rule, which only
// describes what happens to whatever's *still alive and blended* by then.
// The reducer already discards the "was it face-down when it died" fact
// (clears `faceUp` on elimination), so there'd be no state left to key a
// deferred reveal off of even if the game end-only reading were wanted
// instead.
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
