import type { Action, FilteredGameState } from "@rev-day/engine";

interface ActionsBoxProps {
  readonly state: FilteredGameState;
  readonly onAct: (action: Action) => void;
  readonly disabled: boolean;
}

// Step 5 (BUILD_PLAN.md): the mandatory draw and forced end-turn fire
// automatically (useGame's runUntilHumanDecision) and never reach here —
// this box only ever shows the two genuine voluntary choices: draw early
// as one of your two actions, or end your turn before they're spent.
// Target-selection's Done button (variable-count selections) is step 6.
export function ActionsBox({ state, onAct, disabled }: ActionsBoxProps) {
  const canTakeTurnAction = state.resolutionStack.length === 0 && state.turn.phase === "action";
  const deckCount = state.cards.filter((c) => c.zone === "deck").length;
  const canDraw = canTakeTurnAction && state.turn.actionsRemaining > 0 && deckCount > 0;
  const canEndTurn = canTakeTurnAction;

  return (
    <div className="actions-box">
      <p className="actions-remaining-label">ACTIONS REMAINING</p>
      <p className="actions-remaining-count">{state.turn.actionsRemaining}</p>
      <button type="button" disabled={disabled || !canDraw} onClick={() => onAct({ type: "draw" })}>
        Draw
      </button>
      <button type="button" disabled={disabled || !canEndTurn} onClick={() => onAct({ type: "endTurn" })}>
        End Turn
      </button>
    </div>
  );
}
