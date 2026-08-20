import { getEngineInfo } from "@rev-day/engine";
import "./App.css";

function App() {
  const info = getEngineInfo();

  return (
    <main className="scaffold-check">
      <h1>{info.game}</h1>
      <p>Client scaffold is wired to the engine package.</p>
      <ul>
        <li>Leaders loaded: {info.leaderCount}</li>
        <li>Non-leader cards loaded: {info.nonLeaderCount}</li>
        <li>Locations: {info.locations.join(" → ")}</li>
      </ul>
    </main>
  );
}

export default App;
