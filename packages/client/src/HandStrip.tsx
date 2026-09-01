import type { FilteredCardInstance, FilteredGameState, PlayerId } from "@rev-day/engine";
import { cardArtUrl } from "./art";
import { playerColor } from "./players";
import type { ActiveCardPick } from "./useTargetSelection";

interface HandStripProps {
  readonly state: FilteredGameState;
  readonly playerId: PlayerId;
  readonly onSelectCard?: (card: FilteredCardInstance) => void;
  readonly canDrag?: (card: FilteredCardInstance) => boolean;
  readonly onDragStart?: (card: FilteredCardInstance) => void;
  readonly onDragEnd?: () => void;
  // Step 6: a "play" or reactive-window pick draws its candidates from
  // the hand — same candidate/selected/toggle handling as MiniCard's.
  readonly cardPick?: ActiveCardPick | null;
  readonly pickModeActive?: boolean;
}

export function HandStrip({ state, playerId, onSelectCard, canDrag, onDragStart, onDragEnd, cardPick, pickModeActive }: HandStripProps) {
  // state.cards is one flat array fixed at game setup — a card's position
  // never changes (draw/play/return-to-hand only flip its zone in place),
  // and drawing always takes the lowest remaining deck-zone index, so
  // array order among a player's hand cards already tracks draw order,
  // oldest first. Reversed here so newest-drawn renders first (leftmost,
  // per hand-strip-cards' right-justified layout — see App.css).
  const hand = [...state.cards.filter((c) => c.zone === "hand" && c.controller === playerId)].reverse();
  const seatIndex = state.players.find((p) => p.id === playerId)?.seatIndex ?? 0;
  return (
    <div className="hand-strip">
      <h3 style={{ color: playerColor(seatIndex) }}>YOUR HAND</h3>
      <div className="hand-strip-cards">
        {hand.length === 0 && <p className="hint">Empty</p>}
        {hand.map((card) => {
          const isCandidate = cardPick?.candidates.some((c) => c.id === card.id) ?? false;
          const isSelected = cardPick?.selectedIds.includes(card.id) ?? false;
          const onClick = pickModeActive ? (isCandidate ? () => cardPick!.toggle(card) : undefined) : onSelectCard ? () => onSelectCard(card) : undefined;
          const draggable = !pickModeActive && (canDrag?.(card) ?? false);
          const classes = ["hand-strip-card"];
          if (onClick) classes.push("hand-strip-card-clickable");
          if (pickModeActive && isCandidate) classes.push("hand-strip-card-targetable");
          if (isSelected) classes.push("hand-strip-card-target-selected");
          return (
            <img
              key={card.id}
              src={cardArtUrl(card.defRef)}
              alt={card.defRef ?? ""}
              className={classes.join(" ")}
              onClick={onClick}
              draggable={draggable}
              onDragStart={
                draggable && onDragStart
                  ? (e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", card.id);
                      onDragStart(card);
                    }
                  : undefined
              }
              onDragEnd={onDragEnd}
            />
          );
        })}
      </div>
    </div>
  );
}
