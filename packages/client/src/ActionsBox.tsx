import type { Action, FilteredGameState } from "@rev-day/engine";
import type { useTargetSelection } from "./useTargetSelection";

interface ActionsBoxProps {
  readonly state: FilteredGameState;
  readonly onAct: (action: Action) => void;
  readonly disabled: boolean;
  readonly selection: ReturnType<typeof useTargetSelection>;
  // Step 7: while bot-turn playback is stepping, `state` here is the
  // currently-narrated intermediate state, not the true pending decision
  // — showing its resolutionStack-derived branches (Pass, Done, ...) would
  // be misleading even though they're disabled, so this takes over first.
  readonly isPlaying?: boolean;
}

// Step 6 (BUILD_PLAN.md): general, non-card-specific flow control — the
// two voluntary turn actions (from step 5), plus every pass* variant and
// the Done button for a variable-count target selection. The mandatory
// draw/forced end-turn and every trivial target choice never reach here —
// useGame's runUntilHumanDecision already auto-submits those.
export function ActionsBox({ state, onAct, disabled, selection, isPlaying }: ActionsBoxProps) {
  const topFrame = state.resolutionStack[state.resolutionStack.length - 1] ?? null;

  if (isPlaying) {
    return (
      <div className="actions-box">
        <p className="hint">Watching the turn play out…</p>
      </div>
    );
  }

  if (topFrame?.kind === "alarmResolution" && !selection.respondingWith) {
    return (
      <div className="actions-box">
        <p className="hint">Respond, or pass.</p>
        <button type="button" disabled={disabled} onClick={() => onAct({ type: "passResponse" })}>
          Pass
        </button>
      </div>
    );
  }

  if (topFrame?.kind === "motorcadeInterceptionWindow") {
    return (
      <div className="actions-box">
        <p className="hint">Intercept, or let it through.</p>
        <button type="button" disabled={disabled} onClick={() => onAct({ type: "passIntercept" })}>
          Pass
        </button>
      </div>
    );
  }

  if (selection.cardPick?.done) {
    return (
      <div className="actions-box">
        <p className="hint">{selection.cardPick.selectedIds.length} selected</p>
        <button type="button" disabled={disabled} onClick={selection.cardPick.done}>
          Done
        </button>
      </div>
    );
  }

  const canTakeTurnAction = state.resolutionStack.length === 0 && state.turn.phase === "action";
  const deckCount = state.cards.filter((c) => c.zone === "deck").length;
  const canDraw = canTakeTurnAction && state.turn.actionsRemaining > 0 && deckCount > 0;
  const canEndTurn = canTakeTurnAction;

  return (
    <div className="actions-box">
      <p className="actions-remaining-label">ACTIONS REMAINING</p>
      <p className="actions-remaining-count">{state.turn.actionsRemaining}</p>
      {state.turn.restrictedPlayActions > 0 && (
        <p className="hint restricted-play-actions">+{state.turn.restrictedPlayActions} play-only</p>
      )}
      <button type="button" disabled={disabled || !canDraw} onClick={() => onAct({ type: "draw" })}>
        Draw
      </button>
      <button type="button" disabled={disabled || !canEndTurn} onClick={() => onAct({ type: "endTurn" })}>
        End Turn
      </button>
    </div>
  );
}
