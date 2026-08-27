import { useState } from "react";
import "./App.css";
import { ActionsBox } from "./ActionsBox";
import { ActivateAbilityBox } from "./ActivateAbilityBox";
import { CardViewer } from "./CardViewer";
import { CityView } from "./CityView";
import { GameCanvas } from "./GameCanvas";
import { GameChat } from "./GameChat";
import { GameLog } from "./GameLog";
import { HandStrip } from "./HandStrip";
import { LocationView } from "./LocationView";
import { TurnRibbon } from "./TurnRibbon";
import { useGame } from "./useGame";

// Step 3 of BUILD_PLAN.md: static content pass — every region rendering
// real game data, no interactivity yet beyond a *temporary* debug City/
// Location toggle (real navigation, via tile clicks and the brown-
// background click, is step 4 — this exists purely so LocationView can be
// visually verified now rather than staying unexercised).
function App() {
  const { session, loading, error, startNewGame } = useGame();
  const [debugLocationId, setDebugLocationId] = useState<string | null>(null);

  if (!session) {
    return (
      <main className="new-game">
        <h1>Revolution Day</h1>
        <p>Solo vs. bots — this session is you plus 2 bots.</p>
        {error && <p className="error">{error}</p>}
        <button type="button" onClick={startNewGame} disabled={loading}>
          {loading ? "Starting…" : "New Game"}
        </button>
      </main>
    );
  }

  const { state, humanPlayerId, botPlayerIds, log } = session;
  const viewedCard = state.cards.find((c) => c.kind === "leader" && c.controller === humanPlayerId) ?? null;

  return (
    <>
      <div className="debug-view-toggle">
        <button type="button" onClick={() => setDebugLocationId(null)}>
          [debug] City View
        </button>
        {state.board.map((l) => (
          <button key={l.id} type="button" onClick={() => setDebugLocationId(l.id)}>
            [debug] {l.name ?? l.type}
          </button>
        ))}
      </div>
      <GameCanvas
        ribbon={<TurnRibbon state={state} humanPlayerId={humanPlayerId} botPlayerIds={botPlayerIds} log={log} />}
        left={
          <>
            <CardViewer card={viewedCard} controllerLabel={viewedCard ? "You" : null} />
            <ActivateAbilityBox card={viewedCard} />
          </>
        }
        center={
          debugLocationId ? (
            <LocationView
              state={state}
              locationId={debugLocationId}
              humanPlayerId={humanPlayerId}
              botPlayerIds={botPlayerIds}
              onBackgroundClick={() => setDebugLocationId(null)}
            />
          ) : (
            <CityView state={state} onSelectLocation={setDebugLocationId} />
          )
        }
        right={
          <>
            <GameLog log={log} humanPlayerId={humanPlayerId} botPlayerIds={botPlayerIds} />
            <GameChat />
          </>
        }
        bottom={
          <>
            <HandStrip state={state} playerId={humanPlayerId} />
            <ActionsBox state={state} />
          </>
        }
      />
    </>
  );
}

export default App;
