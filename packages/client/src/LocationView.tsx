import type { MouseEvent } from "react";
import type { FilteredCardInstance, FilteredGameState, PlayerId } from "@rev-day/engine";
import { PRESIDENT_TARGET_ID, presidentPseudoCard } from "@rev-day/engine";
import { MiniCard } from "./MiniCard";
import { locationArtUrl, cardArtUrl } from "./art";
import { locationName } from "./gameText";
import { playerColor, playerLabel, playersInSeatOrder } from "./players";
import type { ActiveCardPick } from "./useTargetSelection";

type SeatName = "bottomCenter" | "bl" | "tl" | "tr" | "br";

// SEATING_SPEC.md's fixed clockwise walk with its documented overflow
// exception: 6th player shares bottom-center, 7th stacks at BL, 8th
// stacks at BR — TL/TR are always single-occupant, never a "natural"
// continuation of the rotation. This literal 8-slot table matches the
// spec (and all 3 reference screenshots) more directly than simulating a
// generic clockwise wrap.
const SEAT_ORDER: readonly SeatName[] = ["bottomCenter", "bl", "tl", "tr", "br", "bottomCenter", "bl", "br"];

function assignSeats(state: FilteredGameState, localPlayerId: PlayerId): Map<SeatName, PlayerId[]> {
  const seated = playersInSeatOrder(state);
  const localIndex = seated.findIndex((p) => p.id === localPlayerId);
  const rotated = localIndex === -1 ? seated : [...seated.slice(localIndex), ...seated.slice(0, localIndex)];

  const seats = new Map<SeatName, PlayerId[]>();
  rotated.forEach((player, i) => {
    const seat = SEAT_ORDER[i];
    if (!seat) return; // beyond 8 players — not reachable, SEATING_SPEC.md doesn't cover it either
    const existing = seats.get(seat) ?? [];
    seats.set(seat, [...existing, player.id]);
  });
  return seats;
}

interface LocationViewProps {
  readonly state: FilteredGameState;
  readonly locationId: string;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly onBackgroundClick?: () => void;
  readonly onSelectCard?: (card: FilteredCardInstance) => void;
  // Step 5: an in-play MiniCard the human controls is itself a drag
  // source here (moveCard, adjacency-only); the location image is a drop
  // target for whatever's currently being dragged (from here, the hand
  // strip, or the Card Viewer) — see App.tsx for the shared drag state.
  readonly canDrag?: (card: FilteredCardInstance) => boolean;
  readonly onCardDragStart?: (card: FilteredCardInstance) => void;
  readonly onCardDragEnd?: () => void;
  readonly isDropTarget?: boolean;
  readonly onDropCard?: (locationId: string) => void;
  // Step 6: while a card-pick is active and not in View Cards mode, a
  // candidate MiniCard's click toggles it as a target instead of
  // selecting it into the Card Viewer, and non-candidates go inert.
  readonly cardPick?: ActiveCardPick | null;
  readonly pickModeActive?: boolean;
}

export function LocationView({
  state,
  locationId,
  humanPlayerId,
  botPlayerIds,
  onBackgroundClick,
  onSelectCard,
  canDrag,
  onCardDragStart,
  onCardDragEnd,
  isDropTarget,
  onDropCard,
  cardPick,
  pickModeActive,
}: LocationViewProps) {
  const location = state.board.find((l) => l.id === locationId);
  if (!location) return null;
  const streetIndex = state.board.filter((l) => l.type === "Street").findIndex((l) => l.id === locationId);
  const art = locationArtUrl(location.name ?? location.type, Math.max(streetIndex, 0));
  const seats = assignSeats(state, humanPlayerId);
  const president = state.president;
  const presidentHere = president.status === "alive" && president.locationId === locationId;
  const isPresidentCandidate = cardPick?.candidates.some((c) => c.id === PRESIDENT_TARGET_ID) ?? false;
  const isPresidentSelected = cardPick?.selectedIds.includes(PRESIDENT_TARGET_ID) ?? false;
  const onPresidentMarkerClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (pickModeActive && isPresidentCandidate) cardPick!.toggle(presidentPseudoCard(state));
    else onSelectCard?.(presidentPseudoCard(state));
  };

  const seatProps = {
    state,
    locationId,
    humanPlayerId,
    botPlayerIds,
    onSelectCard,
    canDrag,
    onCardDragStart,
    onCardDragEnd,
    cardPick,
    pickModeActive,
  };

  return (
    <div className="location-view-bg" onClick={pickModeActive ? undefined : onBackgroundClick}>
      <h2>LOCATION VIEW — {locationName(state, locationId) ?? location.name ?? location.type}</h2>
      <div className="location-view-grid">
        <Seat {...seatProps} seat="tl" playerIds={seats.get("tl") ?? []} />
        <div
          className={`location-image-wrap${isDropTarget ? " location-image-drop-target" : ""}`}
          onClick={(e) => e.stopPropagation()}
          onDragOver={isDropTarget ? (e) => e.preventDefault() : undefined}
          onDrop={
            isDropTarget && onDropCard
              ? (e) => {
                  e.preventDefault();
                  onDropCard(locationId);
                }
              : undefined
          }
        >
          <img src={art} alt="" />
          {presidentHere && (
            <img
              src={cardArtUrl("President")}
              alt="President"
              className={`location-president-marker${onSelectCard ? " city-president-clickable" : ""}${
                pickModeActive && isPresidentCandidate ? " mini-card-targetable" : ""
              }${isPresidentSelected ? " mini-card-target-selected" : ""}`}
              onClick={onSelectCard ? onPresidentMarkerClick : undefined}
            />
          )}
        </div>
        <Seat {...seatProps} seat="tr" playerIds={seats.get("tr") ?? []} />
        <Seat {...seatProps} seat="bl" playerIds={seats.get("bl") ?? []} />
        <div />
        <Seat {...seatProps} seat="br" playerIds={seats.get("br") ?? []} />
        {/* bottomCenter's own grid-column:1/4 spans the whole row on its
            own — no filler cells needed here, and adding any would push
            it into a phantom extra row (auto-placement fills row 3's
            first cell before reaching this spanning item), adding dead
            vertical space between the location image and the cards
            below it. */}
        <Seat {...seatProps} seat="bottomCenter" playerIds={seats.get("bottomCenter") ?? []} />
      </div>
    </div>
  );
}

interface SeatProps {
  readonly state: FilteredGameState;
  readonly seat: SeatName;
  readonly playerIds: readonly PlayerId[];
  readonly locationId: string;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly onSelectCard?: (card: FilteredCardInstance) => void;
  readonly canDrag?: (card: FilteredCardInstance) => boolean;
  readonly onCardDragStart?: (card: FilteredCardInstance) => void;
  readonly onCardDragEnd?: () => void;
  readonly cardPick?: ActiveCardPick | null;
  readonly pickModeActive?: boolean;
}

function Seat({ seat, playerIds, ...rest }: SeatProps) {
  return (
    <div className={`location-seat location-seat-${seat}`} onClick={(e) => e.stopPropagation()}>
      {playerIds.map((playerId) => (
        <SeatCluster key={playerId} playerId={playerId} {...rest} />
      ))}
    </div>
  );
}

function SeatCluster({
  state,
  playerId,
  locationId,
  humanPlayerId,
  botPlayerIds,
  onSelectCard,
  canDrag,
  onCardDragStart,
  onCardDragEnd,
  cardPick,
  pickModeActive,
}: Omit<SeatProps, "seat" | "playerIds"> & { readonly playerId: PlayerId }) {
  const seatIndex = state.players.find((p) => p.id === playerId)?.seatIndex ?? 0;
  const color = playerColor(seatIndex);
  const cards = state.cards.filter((c) => c.zone === "inPlay" && c.locationId === locationId && c.controller === playerId);

  // Only render a cluster where a player actually has cards at this
  // location — including the human's own seat (a deliberate deviation
  // from SEATING_SPEC.md's "never omitted" rule, per explicit direction).
  if (cards.length === 0) return null;

  return (
    <div className="seat-cluster">
      <span className="seat-cluster-label" style={{ color }}>
        {playerLabel(state, playerId, humanPlayerId, botPlayerIds)}
      </span>
      <div className="seat-cluster-cards">
        {cards.map((card, i) => {
          const isCandidate = cardPick?.candidates.some((c) => c.id === card.id) ?? false;
          const isSelected = cardPick?.selectedIds.includes(card.id) ?? false;
          const onSelect = pickModeActive ? (isCandidate ? () => cardPick!.toggle(card) : undefined) : onSelectCard;
          return (
            <MiniCard
              key={card.id}
              card={card}
              borderColor={color}
              viewerId={humanPlayerId}
              style={{ marginLeft: i === 0 ? 0 : -22 }}
              onSelect={onSelect}
              draggable={!pickModeActive && (canDrag?.(card) ?? false)}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
              targetable={pickModeActive && isCandidate}
              targetSelected={isSelected}
            />
          );
        })}
      </div>
    </div>
  );
}
