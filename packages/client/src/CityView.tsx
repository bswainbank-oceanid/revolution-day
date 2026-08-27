import type { FilteredGameState } from "@rev-day/engine";
import { locationArtUrl } from "./art";
import { playerColor, playersInSeatOrder } from "./players";

interface CityViewProps {
  readonly state: FilteredGameState;
  readonly onSelectLocation?: (locationId: string) => void;
}

// 3x2 grid in board (linear) order — DESIGN_NOTES.md: "Street / HQ /
// Street (top row), Arena / Street / Palace (bottom row)" is just
// state.board's own sequence chunked into two rows of 3, since the board
// itself is already laid out in that linear order.
export function CityView({ state, onSelectLocation }: CityViewProps) {
  let streetIndex = 0;
  const president = state.president;

  return (
    <div className="city-view">
      <h2>CITY VIEW</h2>
      <p className="president-status-line">PRESIDENT: {presidentStatusText(state)}</p>
      <div className="city-grid">
        {president.status === "notEntered" && (
          <div className="city-offboard">
            <img src="/cards/39_regime_president.png" alt="President" className="city-president-marker" />
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
          return (
            <div key={location.id} className="city-tile">
              <button
                type="button"
                className="city-tile-image"
                onClick={onSelectLocation ? () => onSelectLocation(location.id) : undefined}
                disabled={!onSelectLocation}
              >
                <img src={art} alt="" />
                <span className="city-tile-badge">{index + 1}</span>
                <span className="city-tile-name">{location.name ?? location.type}</span>
                {presidentHere && (
                  <img src="/cards/39_regime_president.png" alt="President" className="city-president-marker city-president-on-tile" />
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
            <img src="/cards/39_regime_president.png" alt="President" className="city-president-marker" />
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
