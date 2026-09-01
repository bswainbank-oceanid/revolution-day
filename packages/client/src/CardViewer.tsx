import type { FilteredCardInstance, PlayerId } from "@rev-day/engine";
import { cardFaceUrl, isOwnBlended } from "./art";

// The eliminated-card X marks the printed photo, not the card as a whole —
// centering on the full card would land it over the name/text instead.
// card_data.json bakes no crop metadata for the photo, so these are fixed
// fractions of the full card image, measured directly off the exported
// PNGs. Three distinct art templates exist: the President's is wider and
// more centered than a leader or non-leader card's, despite the President
// pseudo-card carrying kind: "leader" itself (see filteredTargeting.ts's
// presidentPseudoCard) — hence checking defRef first.
const PORTRAIT_CENTER = {
  president: { top: "48%", left: "50.5%" },
  leader: { top: "38.5%", left: "59.5%" },
  nonLeader: { top: "36.5%", left: "59.5%" },
  motorcade: { top: "34.5%", left: "50%" },
} as const;

function portraitCenter(card: FilteredCardInstance): { readonly top: string; readonly left: string } {
  if (card.defRef === "President") return PORTRAIT_CENTER.president;
  if (card.kind === "motorcade") return PORTRAIT_CENTER.motorcade;
  return card.kind === "leader" ? PORTRAIT_CENTER.leader : PORTRAIT_CENTER.nonLeader;
}

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
        {isEliminated && <span className="eliminated-x" style={portraitCenter(card)}>✕</span>}
        {ownBlended && (
          <span className="blend-badge" title="Blended — hidden from other players">
            👁
          </span>
        )}
      </div>
    </div>
  );
}
