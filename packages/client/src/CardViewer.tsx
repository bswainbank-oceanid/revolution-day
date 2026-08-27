import type { FilteredCardInstance } from "@rev-day/engine";
import { CARD_BACK_URL, cardArtUrl } from "./art";

interface CardViewerProps {
  readonly card: FilteredCardInstance | null;
  readonly controllerLabel: string | null;
}

// The full card art is already the complete designed face (name, deploy
// locations, attributes, win conditions, ability text — all baked into
// the PNG, confirmed against export/cards/*.png directly), so this is
// mostly "render it large" rather than reconstructing the card layout.
//
// Step 3 note: same face-down handling as MiniCard — a face-down card
// (even the viewer's own) shows a plain back for now; the true-art +
// "still blended" badge for the viewer's own cards is step 8.
export function CardViewer({ card, controllerLabel }: CardViewerProps) {
  if (!card) {
    return (
      <div className="card-viewer card-viewer-empty">
        <p className="hint">No card selected</p>
      </div>
    );
  }
  const art = card.faceUp === false ? CARD_BACK_URL : cardArtUrl(card.defRef);
  const isEliminated = card.zone === "eliminated";

  return (
    <div className="card-viewer">
      {controllerLabel && (
        <p className="card-viewer-label">
          Controlled by:
          <br />
          <strong>{controllerLabel}</strong>
        </p>
      )}
      <div className="card-viewer-art-wrap">
        <img src={art} alt="" className="card-viewer-art" />
        {isEliminated && <span className="eliminated-x">✕</span>}
      </div>
    </div>
  );
}
