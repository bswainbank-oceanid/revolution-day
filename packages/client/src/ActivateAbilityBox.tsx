import { getPassive } from "@rev-day/engine";
import type { Action, FilteredCardInstance, FilteredGameState, PlayerId } from "@rev-day/engine";
import { usableActivateAbilities, usableResponseAbilities } from "./targetDecision";
import type { useTargetSelection } from "./useTargetSelection";

interface ActivateAbilityBoxProps {
  readonly card: FilteredCardInstance | null;
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly act: (action: Action) => void;
  readonly selection: ReturnType<typeof useTargetSelection>;
  // Step 7: bot-turn playback owns the Card Viewer and camera while
  // stepping — this box goes read-only for that window rather than
  // showing (and reacting to) buttons for a card the human didn't select.
  readonly isPlaying?: boolean;
}

// Step 6 (BUILD_PLAN.md): real Activate/Response buttons, plus the Choose
// Targets/View Cards toggle once a real target choice is on the table.
// While a pick is active the box shows *that*, regardless of which card
// happens to be in the Card Viewer — per the locked design, viewing other
// cards ("View Cards" mode) never changes what's being chosen.
export function ActivateAbilityBox({ card, state, humanPlayerId, act, selection, isPlaying }: ActivateAbilityBoxProps) {
  const { cardPick, locationPick, respondingWith, startResponse, viewCardsMode, setViewCardsMode, unsupportedAbility } = selection;
  const topFrame = state.resolutionStack[state.resolutionStack.length - 1] ?? null;

  if (isPlaying) {
    return (
      <div className="activate-ability-box">
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">Watching the turn play out…</p>
      </div>
    );
  }

  if (unsupportedAbility) {
    return (
      <div className="activate-ability-box">
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">This ability isn't supported by the client yet.</p>
      </div>
    );
  }

  if (cardPick || locationPick) {
    const selectedCount = cardPick?.selectedIds.length ?? 0;
    return (
      <div className="activate-ability-box">
        <h3>{respondingWith ? "RESPOND" : "CHOOSE TARGETS"}</h3>
        {cardPick && (
          <>
            <p className="hint">
              {selectedCount} selected · {cardPick.candidates.length} eligible
            </p>
            <div className="target-mode-toggle">
              <button type="button" className={viewCardsMode ? "" : "active"} onClick={() => setViewCardsMode(false)}>
                Choose Targets
              </button>
              <button type="button" className={viewCardsMode ? "active" : ""} onClick={() => setViewCardsMode(true)}>
                View Cards
              </button>
            </div>
          </>
        )}
        {locationPick && <p className="hint">Click a highlighted location.</p>}
      </div>
    );
  }

  if (topFrame?.kind === "alarmResolution" && card && card.controller === humanPlayerId) {
    const responses = usableResponseAbilities(state, card, topFrame.triggeringCardId, humanPlayerId);
    return (
      <div className="activate-ability-box">
        <h3>RESPOND</h3>
        {responses.length === 0 ? (
          <p className="hint">No Response ability available on this card.</p>
        ) : (
          responses.map((r) => (
            <button key={r.abilityIndex} type="button" className="ability-button" onClick={() => startResponse(card.id, r.abilityIndex)}>
              {r.text}
            </button>
          ))
        )}
      </div>
    );
  }

  if (topFrame?.kind === "motorcadeInterceptionWindow" && card) {
    const eligible =
      card.controller === humanPlayerId &&
      card.zone === "inPlay" &&
      card.locationId === topFrame.presidentLocationId &&
      card.defRef !== null &&
      getPassive(card.defRef)?.kind === "motorcadeInterception";
    return (
      <div className="activate-ability-box">
        <h3>INTERCEPT MOTORCADE</h3>
        {eligible ? (
          <button type="button" className="ability-button" onClick={() => act({ type: "interceptMotorcade", cardId: card.id })}>
            Intercept — eliminate {card.defRef}
          </button>
        ) : (
          <p className="hint">This card cannot intercept the Motorcade.</p>
        )}
      </div>
    );
  }

  if (!card || card.defRef === null) {
    return (
      <div className="activate-ability-box">
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">No abilities</p>
      </div>
    );
  }

  const canAct = state.resolutionStack.length === 0 && state.turn.phase === "action" && state.turn.actionsRemaining > 0;
  const isOwnCard = card.controller === humanPlayerId && card.zone === "inPlay";
  const abilities = isOwnCard && canAct ? usableActivateAbilities(state, card, state.turn.usedAbilities, humanPlayerId) : [];

  return (
    <div className="activate-ability-box">
      <h3>ACTIVATE ABILITY</h3>
      {abilities.length === 0 ? (
        <p className="hint">No abilities{card.defRef === "President" ? " — Protected" : ""}</p>
      ) : (
        abilities.map((a) => (
          <button key={a.abilityIndex} type="button" className="ability-button" onClick={() => act({ type: "activateAbility", cardId: card.id, abilityIndex: a.abilityIndex })}>
            {a.text}
          </button>
        ))
      )}
    </div>
  );
}
