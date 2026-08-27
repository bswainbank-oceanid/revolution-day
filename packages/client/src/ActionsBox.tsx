import type { FilteredGameState } from "@rev-day/engine";

interface ActionsBoxProps {
  readonly state: FilteredGameState;
}

// Step 3 (static content pass): shows real actionsRemaining, but the
// buttons are inert — mandatory draw/forced end-turn firing automatically
// and voluntary draw/end-turn/pass/Done are wired up in steps 5-6.
export function ActionsBox({ state }: ActionsBoxProps) {
  return (
    <div className="actions-box">
      <p className="actions-remaining-label">ACTIONS REMAINING</p>
      <p className="actions-remaining-count">{state.turn.actionsRemaining}</p>
      <button type="button" disabled>
        Draw
      </button>
    </div>
  );
}
