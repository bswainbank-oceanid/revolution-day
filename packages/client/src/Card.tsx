import type { FilteredCardInstance } from "@rev-day/engine";
import { cardArtUrl } from "./art";

interface CardProps {
  readonly card: FilteredCardInstance;
  readonly selected?: boolean;
  readonly onClick?: () => void;
}

export function Card({ card, selected, onClick }: CardProps) {
  const label = card.defRef ?? "Hidden";
  return (
    <button
      type="button"
      className={`card${selected ? " card-selected" : ""}${onClick ? " card-clickable" : ""}`}
      onClick={onClick}
      disabled={!onClick}
      title={label}
    >
      <img src={cardArtUrl(card.defRef)} alt={label} className="card-art" />
      <span className="card-label">{label}</span>
      {card.faceUp === false && <span className="card-facedown-badge">face-down</span>}
    </button>
  );
}
