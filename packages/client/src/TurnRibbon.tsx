import type { FilteredGameState, PlayerId } from "@rev-day/engine";
import { CARD_BACK_URL } from "./art";
import { handCountFor, leaderNameFor, playerColor, playerLabel, playersInSeatOrder } from "./players";
import type { LogEntry } from "./useGame";

interface TurnRibbonProps {
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly log: readonly LogEntry[];
}

export function TurnRibbon({ state, humanPlayerId, botPlayerIds, log }: TurnRibbonProps) {
  const deckCount = state.cards.filter((c) => c.zone === "deck").length;
  const turnNumber = 1 + log.filter((e) => e.action.type === "endTurn").length;

  return (
    <div className="turn-ribbon">
      <div className="deck-indicator">
        <h2>TURN {turnNumber}</h2>
        <img src={CARD_BACK_URL} alt="Deck" className="deck-back" />
        <span>{deckCount} cards left</span>
      </div>
      <div className="player-panels">
        {playersInSeatOrder(state).map((p) => (
          <PlayerPanel key={p.id} state={state} playerId={p.id} humanPlayerId={humanPlayerId} botPlayerIds={botPlayerIds} seatIndex={p.seatIndex} />
        ))}
      </div>
    </div>
  );
}

function PlayerPanel({
  state,
  playerId,
  humanPlayerId,
  botPlayerIds,
  seatIndex,
}: {
  readonly state: FilteredGameState;
  readonly playerId: PlayerId;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  readonly seatIndex: number;
}) {
  const isCurrentTurn = state.turn.currentPlayerId === playerId;
  const handCount = handCountFor(state, playerId);
  const color = playerColor(seatIndex);

  return (
    <div className={`player-panel${isCurrentTurn ? " player-panel-active" : ""}`} style={{ borderColor: isCurrentTurn ? "var(--gold)" : undefined }}>
      {isCurrentTurn && <span className="current-turn-tag">CURRENT TURN</span>}
      <h3 style={{ color }}>{playerLabel(state, playerId, humanPlayerId, botPlayerIds)}</h3>
      <p className="leader-name">{leaderNameFor(state, playerId)}</p>
      <div className="hand-fan">
        {Array.from({ length: Math.min(handCount, 6) }).map((_, i) => (
          <img key={i} src={CARD_BACK_URL} alt="" className="hand-fan-card" style={{ left: `${i * 14}px` }} />
        ))}
      </div>
      <span className="hand-count">{handCount} cards</span>
    </div>
  );
}
