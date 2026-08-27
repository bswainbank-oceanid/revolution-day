import type { FilteredCardInstance } from "@rev-day/engine";
import { CARD_BACK_URL, cardArtUrl } from "./art";

interface MiniCardProps {
  readonly card: FilteredCardInstance;
  readonly borderColor: string;
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
// Step 3 (static content pass) note: this always shows a face-down card
// as a plain back, even the viewer's own — that's the general rule for
// everyone else's cards, but the viewer's own blended cards are meant to
// get a different treatment (true art + a "still hidden" badge, per the
// interaction-design conversation). That carve-out is step 8's job
// (BUILD_PLAN.md); until then this deliberately under-informs about your
// own blended cards rather than half-implementing the badge.
export function MiniCard({ card, borderColor, style, onSelect, draggable, onDragStart, onDragEnd, targetable, targetSelected }: MiniCardProps) {
  const art = card.faceUp === false ? CARD_BACK_URL : cardArtUrl(card.defRef);
  const classes = ["mini-card"];
  if (onSelect) classes.push("mini-card-clickable");
  if (targetable) classes.push("mini-card-targetable");
  if (targetSelected) classes.push("mini-card-target-selected");
  return (
    <img
      src={art}
      alt=""
      className={classes.join(" ")}
      style={{ borderColor, ...style }}
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
  );
}
