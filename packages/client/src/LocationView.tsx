import type { FilteredCardInstance, FilteredGameState, PlayerId } from "@rev-day/engine";
import { MiniCard } from "./MiniCard";
import { locationArtUrl, cardArtUrl, CARD_BACK_URL } from "./art";
import { playerColor, playerLabel, playersInSeatOrder } from "./players";

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
}: LocationViewProps) {
  const location = state.board.find((l) => l.id === locationId);
  if (!location) return null;
  const streetIndex = state.board.filter((l) => l.type === "Street").findIndex((l) => l.id === locationId);
  const art = locationArtUrl(location.name ?? location.type, Math.max(streetIndex, 0));
  const seats = assignSeats(state, humanPlayerId);
  const president = state.president;
  const presidentHere = president.status === "alive" && president.locationId === locationId;

  const seatProps = { state, locationId, humanPlayerId, botPlayerIds, onSelectCard, canDrag, onCardDragStart, onCardDragEnd };

  return (
    <div className="location-view-bg" onClick={onBackgroundClick}>
      <h2>LOCATION VIEW — {location.name ?? location.type}</h2>
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
          {presidentHere && <img src={cardArtUrl("President")} alt="President" className="location-president-marker" />}
        </div>
        <Seat {...seatProps} seat="tr" playerIds={seats.get("tr") ?? []} />
        <Seat {...seatProps} seat="bl" playerIds={seats.get("bl") ?? []} />
        <div />
        <Seat {...seatProps} seat="br" playerIds={seats.get("br") ?? []} />
        <div />
        <Seat {...seatProps} seat="bottomCenter" playerIds={seats.get("bottomCenter") ?? []} />
        <div />
      </div>
    </div>
  );
}

function Seat({
  state,
  seat,
  playerIds,
  locationId,
  humanPlayerId,
  botPlayerIds,
  onSelectCard,
  canDrag,
  onCardDragStart,
  onCardDragEnd,
}: {
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
}) {
  return (
    <div className={`location-seat location-seat-${seat}`} onClick={(e) => e.stopPropagation()}>
      {playerIds.map((playerId) => (
        <SeatCluster
          key={playerId}
          state={state}
          playerId={playerId}
          locationId={locationId}
          humanPlayerId={humanPlayerId}
          botPlayerIds={botPlayerIds}
          onSelectCard={onSelectCard}
          canDrag={canDrag}
          onCardDragStart={onCardDragStart}
          onCardDragEnd={onCardDragEnd}
        />
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
}: {
  readonly state: FilteredGameState;
  readonly playerId: PlayerId;
  readonly locationId: string;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly onSelectCard?: (card: FilteredCardInstance) => void;
  readonly canDrag?: (card: FilteredCardInstance) => boolean;
  readonly onCardDragStart?: (card: FilteredCardInstance) => void;
  readonly onCardDragEnd?: () => void;
}) {
  const seatIndex = state.players.find((p) => p.id === playerId)?.seatIndex ?? 0;
  const color = playerColor(seatIndex);
  const cards = state.cards.filter((c) => c.zone === "inPlay" && c.locationId === locationId && c.controller === playerId);
  const isHuman = playerId === humanPlayerId;

  // An empty seat is still drawn (SEATING_SPEC.md: "never omitted, so
  // 'this is you' is never ambiguous") — for the local player only; other
  // empty seats simply don't render (they're not seated here at all).
  if (cards.length === 0 && !isHuman) return null;

  return (
    <div className="seat-cluster">
      <span className="seat-cluster-label" style={{ color }}>
        {playerLabel(state, playerId, humanPlayerId, botPlayerIds)}
      </span>
      <div className="seat-cluster-cards">
        {cards.length === 0 ? (
          <img src={CARD_BACK_URL} alt="" className="mini-card seat-cluster-empty" style={{ borderColor: color, opacity: 0.25 }} />
        ) : (
          cards.map((card, i) => (
            <MiniCard
              key={card.id}
              card={card}
              borderColor={color}
              style={{ marginLeft: i === 0 ? 0 : -34 }}
              onSelect={onSelectCard}
              draggable={canDrag?.(card) ?? false}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}
