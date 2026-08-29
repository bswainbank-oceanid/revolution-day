import type { MouseEvent } from "react";
import type { FilteredCardInstance, FilteredGameState } from "@rev-day/engine";
import { PRESIDENT_TARGET_ID, presidentPseudoCard } from "@rev-day/engine";
import { locationArtUrl } from "./art";
import { playerColor, playersInSeatOrder } from "./players";
import type { ActiveCardPick, ActiveLocationPick } from "./useTargetSelection";

interface CityViewProps {
  readonly state: FilteredGameState;
  readonly onSelectLocation?: (locationId: string) => void;
  // Step 5: drag-and-drop play/move — a location tile highlights when a
  // card is being dragged and this tile is a legal drop target for it
  // (allowedDropLocationIds is recomputed in App.tsx from the dragged
  // card's zone: playable location types for a hand card, adjacency for
  // an in-play card), and accepts the drop via onDropCard.
  readonly allowedDropLocationIds?: ReadonlySet<string>;
  readonly onDropCard?: (locationId: string) => void;
  // Step 6: a location-only target choice (Traffic Cop's destination,
  // Anarchist's alarm location) — while active, tiles take over from
  // normal navigation: a candidate tile submits the choice on click,
  // everything else is inert.
  readonly locationPick?: ActiveLocationPick | null;
  // The President's marker is clickable — always to view him in the Card
  // Viewer, and (only when he's on a tile and a card-pick is active with
  // him as its one candidate, e.g. Wife's ability) to toggle him as the
  // target instead. See LocationView's MiniCards for the same duality.
  readonly onSelectCard?: (card: FilteredCardInstance) => void;
  readonly cardPick?: ActiveCardPick | null;
  readonly pickModeActive?: boolean;
}

// 3x2 grid in board (linear) order — DESIGN_NOTES.md: "Street / HQ /
// Street (top row), Arena / Street / Palace (bottom row)" is just
// state.board's own sequence chunked into two rows of 3, since the board
// itself is already laid out in that linear order.
export function CityView({
  state,
  onSelectLocation,
  allowedDropLocationIds,
  onDropCard,
  locationPick,
  onSelectCard,
  cardPick,
  pickModeActive,
}: CityViewProps) {
  let streetIndex = 0;
  const president = state.president;
  const isPresidentCandidate = cardPick?.candidates.some((c) => c.id === PRESIDENT_TARGET_ID) ?? false;
  const isPresidentSelected = cardPick?.selectedIds.includes(PRESIDENT_TARGET_ID) ?? false;

  const viewPresident = (e: MouseEvent) => {
    e.stopPropagation();
    onSelectCard?.(presidentPseudoCard(state));
  };
  const onPresidentMarkerClick = (e: MouseEvent) => {
    if (pickModeActive && isPresidentCandidate) {
      e.stopPropagation();
      cardPick!.toggle(presidentPseudoCard(state));
    } else {
      viewPresident(e);
    }
  };

  return (
    <div className="city-view">
      <h2>CITY VIEW</h2>
      <p className="president-status-line">PRESIDENT: {presidentStatusText(state)}</p>
      <div className="city-grid">
        {president.status === "notEntered" && (
          <div className="city-offboard">
            <img
              src="/cards/39_regime_president.png"
              alt="President"
              className={`city-president-marker${onSelectCard ? " city-president-clickable" : ""}`}
              onClick={onSelectCard ? viewPresident : undefined}
            />
            <span>OFF BOARD</span>
          </div>
        )}
        {state.board.map((location, index) => {
          const isStreet = location.type === "Street";
          const art = locationArtUrl(location.name ?? location.type, isStreet ? streetIndex++ : 0);
          const cardsHere = state.cards.filter((c) => c.zone === "inPlay" && c.locationId === location.id);
          const counts = new Map<string, number>();
          for (const card of cardsHere) {
            if (!card.controller) continue;
            counts.set(card.controller, (counts.get(card.controller) ?? 0) + 1);
          }
          const presidentHere = president.status === "alive" && president.locationId === location.id;
          const isDropTarget = allowedDropLocationIds?.has(location.id) ?? false;
          const isLocationPickCandidate = locationPick?.candidateLocationIds.includes(location.id) ?? false;
          const onClick = locationPick
            ? isLocationPickCandidate
              ? () => locationPick.choose(location.id)
              : undefined
            : onSelectLocation
              ? () => onSelectLocation(location.id)
              : undefined;
          return (
            <div key={location.id} className="city-tile">
              <button
                type="button"
                className={`city-tile-image${isDropTarget || isLocationPickCandidate ? " city-tile-drop-target" : ""}`}
                onClick={onClick}
                disabled={!onClick}
                onDragOver={isDropTarget ? (e) => e.preventDefault() : undefined}
                onDrop={
                  isDropTarget && onDropCard
                    ? (e) => {
                        e.preventDefault();
                        onDropCard(location.id);
                      }
                    : undefined
                }
              >
                <img src={art} alt="" />
                <span className="city-tile-badge">{index + 1}</span>
                <span className="city-tile-name">{location.name ?? location.type}</span>
                {presidentHere && (
                  <img
                    src="/cards/39_regime_president.png"
                    alt="President"
                    className={`city-president-marker city-president-on-tile${onSelectCard ? " city-president-clickable" : ""}${
                      pickModeActive && isPresidentCandidate ? " mini-card-targetable" : ""
                    }${isPresidentSelected ? " mini-card-target-selected" : ""}`}
                    onClick={onSelectCard ? onPresidentMarkerClick : undefined}
                  />
                )}
              </button>
              <div className="city-tile-chips">
                {counts.size === 0 ? (
                  <span className="hint">No cards here</span>
                ) : (
                  playersInSeatOrder(state)
                    .filter((p) => counts.has(p.id))
                    .map((p) => (
                      <span key={p.id} className="city-chip" style={{ background: playerColor(p.seatIndex) }}>
                        {counts.get(p.id)}
                      </span>
                    ))
                )}
              </div>
            </div>
          );
        })}
        {president.status === "survived" && (
          <div className="city-offboard city-offboard-right">
            <img
              src="/cards/39_regime_president.png"
              alt="President"
              className={`city-president-marker${onSelectCard ? " city-president-clickable" : ""}`}
              onClick={onSelectCard ? viewPresident : undefined}
            />
            <span>SURVIVED</span>
          </div>
        )}
      </div>
    </div>
  );
}

function presidentStatusText(state: FilteredGameState): string {
  const { president } = state;
  if (president.status === "notEntered") return "Not yet in play";
  if (president.status === "survived") return "Survived";
  if (president.status === "eliminated") return "Eliminated";
  const location = state.board.find((l) => l.id === president.locationId);
  const index = state.board.findIndex((l) => l.id === president.locationId);
  return `${location?.name ?? "Unknown"} (${ordinal(index + 1)})`;
}

function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}
