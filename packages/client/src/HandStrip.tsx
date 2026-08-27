import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { cardArtUrl } from "./art";

interface HandStripProps {
  readonly state: FilteredGameState;
  readonly playerId: PlayerId;
}

export function HandStrip({ state, playerId }: HandStripProps) {
  const hand = state.cards.filter((c) => c.zone === "hand" && c.controller === playerId);
  return (
    <div className="hand-strip">
      <h3 style={{ color: "var(--marker-crimson)" }}>YOUR HAND</h3>
      <div className="hand-strip-cards">
        {hand.length === 0 && <p className="hint">Empty</p>}
        {hand.map((card) => (
          <img key={card.id} src={cardArtUrl(card.defRef)} alt={card.defRef ?? ""} className="hand-strip-card" />
        ))}
      </div>
    </div>
  );
}
