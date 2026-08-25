import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { Card } from "./Card";

interface HandProps {
  readonly state: FilteredGameState;
  readonly playerId: PlayerId;
  readonly selectedCardIds?: ReadonlySet<string>;
  readonly onCardClick?: (cardId: string) => void;
}

export function Hand({ state, playerId, selectedCardIds, onCardClick }: HandProps) {
  const hand = state.cards.filter((c) => c.zone === "hand" && c.controller === playerId);
  return (
    <div className="hand">
      <h3>Your hand</h3>
      <div className="hand-cards">
        {hand.length === 0 && <p className="hint">Empty</p>}
        {hand.map((card) => (
          <Card
            key={card.id}
            card={card}
            selected={selectedCardIds?.has(card.id) ?? false}
            onClick={onCardClick ? () => onCardClick(card.id) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
