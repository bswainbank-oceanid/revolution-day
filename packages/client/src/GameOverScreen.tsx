import type { FilteredGameState, PlayerId, WinConditionExplanation, WinPredicate } from "@rev-day/engine";
import { playerLabel } from "./players";

interface GameOverScreenProps {
  readonly gameOver: WinConditionExplanation;
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
}

// Step 9 (BUILD_PLAN.md): carried over from the first slice largely as-is,
// per the plan — the one real change is player labels ("Player N"/"Bot N"
// via the shared playerLabel helper, matching every other screen) instead
// of raw player IDs.
export function GameOverScreen({ gameOver, state, humanPlayerId, botPlayerIds }: GameOverScreenProps) {
  const label = (playerId: PlayerId) => playerLabel(state, playerId, humanPlayerId, botPlayerIds);

  return (
    <div className="game-over">
      <h2>Game Over</h2>
      {gameOver.winners.length > 0 ? (
        <p>Winners: {gameOver.winners.map(label).join(", ")}</p>
      ) : (
        <p>Nobody won{gameOver.allPlayersWouldWin ? " — every condition was met, so by the rules nobody wins" : ""}.</p>
      )}
      <table className="outcomes-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Leader</th>
            <th>Condition</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {gameOver.outcomes.map((outcome) =>
            outcome.predicates.length === 0 ? (
              <tr key={outcome.playerId}>
                <td>{label(outcome.playerId)}</td>
                <td>{outcome.leaderDefRef ?? "—"}</td>
                <td colSpan={2}>No leader in play</td>
              </tr>
            ) : (
              outcome.predicates.map((p, i) => (
                <tr key={`${outcome.playerId}-${i}`}>
                  {i === 0 && (
                    <>
                      <td rowSpan={outcome.predicates.length}>
                        {label(outcome.playerId)} {outcome.won ? "🏆" : ""}
                      </td>
                      <td rowSpan={outcome.predicates.length}>{outcome.leaderDefRef}</td>
                    </>
                  )}
                  <td>{describePredicate(p.predicate)}</td>
                  <td>{p.satisfied ? "✅" : "❌"}</td>
                </tr>
              ))
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function describePredicate(predicate: WinPredicate): string {
  switch (predicate.type) {
    case "presidentStatus":
      return predicate.value === "eliminated" ? "President eliminated" : "President not eliminated";
    case "presidentEliminatedAt":
      return `President eliminated at ${predicate.locationName}`;
    case "survives":
      return "Survives";
    case "noOtherSurvivingLeaders":
      return "No other surviving leaders";
    case "factionMajority":
      return `${predicate.faction} majority at ${predicate.locationName}`;
    case "locationSpread":
      return `${predicate.faction} presence at ${predicate.minLocations}+ locations`;
    case "eliminatedByControlled":
      return predicate.target === "president"
        ? "Eliminated the President with your own cards"
        : `Eliminated ${predicate.target.leaderCount} leaders with your own cards`;
    case "metaNoFactionLeaderWins":
      return `No ${predicate.faction} leader wins`;
    case "metaNoOtherPlayerWins":
      return "No other player wins";
    case "or":
      return predicate.predicates.map(describePredicate).join(" OR ");
  }
}
