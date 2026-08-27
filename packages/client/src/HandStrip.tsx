import type { FilteredCardInstance, FilteredGameState, PlayerId } from "@rev-day/engine";
import { cardArtUrl } from "./art";

interface HandStripProps {
  readonly state: FilteredGameState;
  readonly playerId: PlayerId;
  readonly onSelectCard?: (card: FilteredCardInstance) => void;
  readonly canDrag?: (card: FilteredCardInstance) => boolean;
  readonly onDragStart?: (card: FilteredCardInstance) => void;
  readonly onDragEnd?: () => void;
}

export function HandStrip({ state, playerId, onSelectCard, canDrag, onDragStart, onDragEnd }: HandStripProps) {
  const hand = state.cards.filter((c) => c.zone === "hand" && c.controller === playerId);
  return (
    <div className="hand-strip">
      <h3 style={{ color: "var(--marker-crimson)" }}>YOUR HAND</h3>
      <div className="hand-strip-cards">
        {hand.length === 0 && <p className="hint">Empty</p>}
        {hand.map((card) => {
          const draggable = canDrag?.(card) ?? false;
          return (
            <img
              key={card.id}
              src={cardArtUrl(card.defRef)}
              alt={card.defRef ?? ""}
              className={`hand-strip-card${onSelectCard ? " hand-strip-card-clickable" : ""}`}
              onClick={onSelectCard ? () => onSelectCard(card) : undefined}
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
