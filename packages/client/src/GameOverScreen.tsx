import type { WinConditionExplanation, WinPredicate } from "@rev-day/engine";

interface GameOverScreenProps {
  readonly gameOver: WinConditionExplanation;
}

export function GameOverScreen({ gameOver }: GameOverScreenProps) {
  return (
    <div className="game-over">
      <h2>Game Over</h2>
      {gameOver.winners.length > 0 ? (
        <p>Winners: {gameOver.winners.join(", ")}</p>
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
                <td>{outcome.playerId}</td>
                <td>{outcome.leaderDefRef ?? "—"}</td>
                <td colSpan={2}>No leader in play</td>
              </tr>
            ) : (
              outcome.predicates.map((p, i) => (
                <tr key={`${outcome.playerId}-${i}`}>
                  {i === 0 && (
                    <>
                      <td rowSpan={outcome.predicates.length}>
                        {outcome.playerId} {outcome.won ? "🏆" : ""}
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
