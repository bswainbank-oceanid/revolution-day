import type { FilteredCardInstance, PlayerId } from "@rev-day/engine";
import { cardFaceUrl, isOwnBlended } from "./art";

interface CardViewerProps {
  readonly card: FilteredCardInstance | null;
  readonly controllerLabel: string | null;
  readonly viewerId: PlayerId;
  readonly draggable?: boolean;
  readonly onDragStart?: (card: FilteredCardInstance) => void;
  readonly onDragEnd?: () => void;
}

// The full card art is already the complete designed face (name, deploy
// locations, attributes, win conditions, ability text — all baked into
// the PNG, confirmed against export/cards/*.png directly), so this is
// mostly "render it large" rather than reconstructing the card layout.
//
// Step 5 note: the viewed card doubles as a drag source (BUILD_PLAN.md's
// "drag from hand or the Card Viewer onto a location") — draggable only
// when App.tsx's canDrag(card) says it's actually the human's own
// hand/in-play card with a real turn action available.
//
// Step 8: the viewer's own blended cards show their true art (defRef is
// always known for own cards) plus a small eye badge in the upper-right
// corner, clear of the printed name/icons/ability text — a distinct
// treatment from anyone else's blended card, which stays a plain back
// (see art.ts's cardFaceUrl/isOwnBlended).
export function CardViewer({ card, controllerLabel, viewerId, draggable, onDragStart, onDragEnd }: CardViewerProps) {
  if (!card) {
    return (
      <div className="card-viewer card-viewer-empty">
        <p className="hint">No card selected</p>
      </div>
    );
  }
  const art = cardFaceUrl(card, viewerId);
  const isEliminated = card.zone === "eliminated";
  const ownBlended = isOwnBlended(card, viewerId);

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
        <img
          src={art}
          alt=""
          className={`card-viewer-art${draggable ? " card-viewer-art-draggable" : ""}`}
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
        {isEliminated && <span className="eliminated-x">✕</span>}
        {ownBlended && (
          <span className="blend-badge" title="Blended — hidden from other players">
            👁
          </span>
        )}
      </div>
    </div>
  );
}
