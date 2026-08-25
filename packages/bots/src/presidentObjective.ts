import type { WinPredicate } from "@rev-day/engine";

export type PresidentObjective = "eliminate" | "protect" | "neutral";

// Derived directly from the already-structured win-condition data — no
// hardcoded per-leader list. Any predicate wanting the President
// eliminated (presidentStatus:"eliminated", presidentEliminatedAt,
// eliminatedByControlled:"president") sets the objective to "eliminate";
// presidentStatus:"notEliminated" sets it to "protect"; a leader whose
// conditions never mention him at all is "neutral". If a leader somehow
// wanted both (none currently do), "eliminate" wins — acting on him is a
// stronger, more legible signal than staying passive. Recurses into
// `{type: "or"}` wrappers (Master Assassin's "eliminate the President or
// 2 leaders" nests eliminatedByControlled:"president" one level down,
// not as a flat top-level entry).
export function presidentObjectiveFor(
  leaderDefRef: string,
  winConditions: Readonly<Record<string, readonly WinPredicate[]>>,
): PresidentObjective {
  const predicates = winConditions[leaderDefRef] ?? [];
  let wantsEliminated = false;
  let wantsAlive = false;

  const scan = (predicate: WinPredicate): void => {
    if (predicate.type === "presidentStatus") {
      if (predicate.value === "eliminated") wantsEliminated = true;
      else wantsAlive = true;
    } else if (predicate.type === "presidentEliminatedAt") {
      wantsEliminated = true;
    } else if (predicate.type === "eliminatedByControlled" && predicate.target === "president") {
      wantsEliminated = true;
    } else if (predicate.type === "or") {
      predicate.predicates.forEach(scan);
    }
  };
  predicates.forEach(scan);

  if (wantsEliminated) return "eliminate";
  if (wantsAlive) return "protect";
  return "neutral";
}
