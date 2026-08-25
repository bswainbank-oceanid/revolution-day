import "./App.css";
import { GameScreen } from "./GameScreen";
import { useGame } from "./useGame";

function App() {
  const { session, loading, error, startNewGame, act } = useGame();

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

  return <GameScreen session={session} loading={loading} error={error} act={act} />;
}

export default App;
