import type { FilteredCardInstance, PlayerId } from "@rev-day/engine";
import { cardFaceUrl, isOwnBlended } from "./art";

interface MiniCardProps {
  readonly card: FilteredCardInstance;
  readonly borderColor: string;
  readonly viewerId: PlayerId;
  readonly style?: React.CSSProperties;
  readonly onSelect?: (card: FilteredCardInstance) => void;
  readonly draggable?: boolean;
  readonly onDragStart?: (card: FilteredCardInstance) => void;
  readonly onDragEnd?: () => void;
  // Step 6: real target highlighting during an active card-pick — a
  // distinct visual from the plain "clickable to view" state.
  readonly targetable?: boolean;
  readonly targetSelected?: boolean;
}

// The small overlapping-cluster card used in Location View seats and the
// ribbon's deck stack — matches SEATING_SPEC.md: legibility of individual
// cards isn't the goal here, just "whose card, face-up or down."
//
// Step 8: the viewer's own blended cards show their true art plus a small
// eye badge in the upper-right corner — same treatment and badge as
// CardViewer, via the shared art.ts helpers, so the two never drift.
// Anyone else's blended card stays a plain back (no defRef to show).
export function MiniCard({
  card,
  borderColor,
  viewerId,
  style,
  onSelect,
  draggable,
  onDragStart,
  onDragEnd,
  targetable,
  targetSelected,
}: MiniCardProps) {
  const art = cardFaceUrl(card, viewerId);
  const ownBlended = isOwnBlended(card, viewerId);
  const classes = ["mini-card"];
  if (onSelect) classes.push("mini-card-clickable");
  if (targetable) classes.push("mini-card-targetable");
  if (targetSelected) classes.push("mini-card-target-selected");
  return (
    <span className="mini-card-wrap" style={style}>
      <img
        src={art}
        alt=""
        className={classes.join(" ")}
        style={{ borderColor }}
        draggable={draggable}
        onClick={
          onSelect
            ? (e) => {
                e.stopPropagation();
                onSelect(card);
              }
            : undefined
        }
        onDragStart={
          draggable && onDragStart
            ? (e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", card.id);
                onDragStart(card);
              }
            : undefined
        }
        onDragEnd={onDragEnd}
      />
      {ownBlended && (
        <span className="mini-card-blend-badge" title="Blended — hidden from other players">
          👁
        </span>
      )}
    </span>
  );
}
