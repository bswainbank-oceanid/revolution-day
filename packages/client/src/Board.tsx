import type { FilteredGameState } from "@rev-day/engine";
import { Card } from "./Card";
import { locationArtUrl } from "./art";

interface BoardProps {
  readonly state: FilteredGameState;
  readonly selectedCardIds?: ReadonlySet<string>;
  readonly onCardClick?: (cardId: string) => void;
  readonly selectedLocationIds?: ReadonlySet<string>;
  readonly onLocationClick?: (locationId: string) => void;
}

export function Board({ state, selectedCardIds, onCardClick, selectedLocationIds, onLocationClick }: BoardProps) {
  let streetIndex = 0;
  return (
    <div className="board">
      {state.board.map((location) => {
        const cardsHere = state.cards.filter((c) => c.zone === "inPlay" && c.locationId === location.id);
        const isStreet = location.type === "Street";
        const art = locationArtUrl(location.name ?? location.type, isStreet ? streetIndex++ : 0);
        const presidentHere = state.president.status === "alive" && state.president.locationId === location.id;
        const selected = selectedLocationIds?.has(location.id) ?? false;
        return (
          <div key={location.id} className={`location${selected ? " location-selected" : ""}`}>
            <button
              type="button"
              className="location-tile"
              onClick={onLocationClick ? () => onLocationClick(location.id) : undefined}
              disabled={!onLocationClick}
            >
              <img src={art} alt={location.name ?? location.type} />
              <span className="location-label">{location.name ?? location.type}</span>
              {presidentHere && <span className="president-marker" title="The President">★</span>}
            </button>
            <div className="location-cards">
              {cardsHere.map((card) => (
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
      })}
    </div>
  );
}
