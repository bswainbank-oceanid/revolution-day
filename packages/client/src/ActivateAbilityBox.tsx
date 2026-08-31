import { cardData, getPassive, knownFaction } from "@rev-day/engine";
import type { Action, FilteredCardInstance, FilteredGameState, PlayerId, RestrictedActionGrant } from "@rev-day/engine";
import { usableActivateAbilities, usableResponseAbilities } from "./targetDecision";
import type { useTargetSelection } from "./useTargetSelection";

// "+2 play-only (Rebel)", "Unlimited activate-only (Regime) here" —
// summarizes whichever repeatable grant (Puppet-Master, Master Assassin,
// Commander General, Opposition Leader — see RestrictedActionGrant) is
// currently active, so the player knows it exists once actionsRemaining
// alone no longer tells the whole story.
function describeGrant(grant: RestrictedActionGrant): string {
  const amount = grant.amount === "unbounded" ? "Unlimited" : `+${grant.amount}`;
  const verb = grant.kind === "play" ? "play" : "activate";
  const faction = grant.faction ? ` (${grant.faction})` : "";
  const where = grant.locationId ? " here" : "";
  return `${amount} ${verb}-only${faction}${where}`;
}

interface ActivateAbilityBoxProps {
  readonly card: FilteredCardInstance | null;
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly act: (action: Action) => void;
  readonly selection: ReturnType<typeof useTargetSelection>;
  // While bot-turn playback is stepping, `state` here is the currently-
  // narrated intermediate state, not the true pending decision — showing
  // its resolutionStack-derived branches (Pass, Done, ...) would be
  // misleading even though they're disabled, so this takes over first.
  // While playing, `playbackCaption` carries the "who/how targeted" text
  // for whatever the Card Viewer is currently showing.
  readonly isPlaying?: boolean;
  readonly playbackCaption?: string | null;
  // True while a previous action is still in flight — every button here
  // submits (or starts building toward) a real act() call, so without
  // this a rapid double-click could fire a second submission before the
  // first one's resulting state (and resolution-stack frame) has come
  // back, sending a stale action type against whatever frame the server
  // has since moved on to.
  readonly disabled?: boolean;
}

// Merged box: houses every button/selection previously split between this
// box (card-specific activate/response/intercept) and the old ActionsBox
// (turn-level draw/end-turn/pass/Done) — and, via the persistent status
// header below, always shows the player's current status/choice rather
// than only reacting once a decision is pending.
export function ActivateAbilityBox({
  card,
  state,
  humanPlayerId,
  act,
  selection,
  isPlaying,
  playbackCaption,
  disabled,
}: ActivateAbilityBoxProps) {
  const { cardPick, locationPick, respondingWith, startResponse, viewCardsMode, setViewCardsMode, unsupportedAbility } = selection;
  const topFrame = state.resolutionStack[state.resolutionStack.length - 1] ?? null;

  const canTakeTurnAction = state.resolutionStack.length === 0 && state.turn.phase === "action";
  const deckCount = state.cards.filter((c) => c.zone === "deck").length;
  const canDraw = canTakeTurnAction && state.turn.actionsRemaining > 0 && deckCount > 0;
  const canEndTurn = canTakeTurnAction;

  // Always visible, regardless of which branch below is active — actions-
  // remaining context doesn't disappear just because a pick/alarm/
  // intercept window opened on top of it.
  const statusHeader = (
    <div className="activate-ability-status">
      <p className="actions-remaining-label">ACTIONS REMAINING</p>
      <p className="actions-remaining-count">{state.turn.actionsRemaining}</p>
      {state.turn.restrictedAction && (
        <p className="hint restricted-play-actions">{describeGrant(state.turn.restrictedAction)}</p>
      )}
      {isPlaying && playbackCaption && <p className="hint playback-caption">{playbackCaption}</p>}
    </div>
  );

  if (isPlaying) {
    return (
      <div className="activate-ability-box">
        {statusHeader}
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">Watching the turn play out…</p>
      </div>
    );
  }

  if (unsupportedAbility) {
    return (
      <div className="activate-ability-box">
        {statusHeader}
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">This ability isn't supported by the client yet.</p>
      </div>
    );
  }

  if (cardPick || locationPick) {
    const selectedCount = cardPick?.selectedIds.length ?? 0;
    return (
      <div className="activate-ability-box">
        {statusHeader}
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
            {cardPick.done && (
              <button type="button" className="flow-button" disabled={disabled} onClick={cardPick.done}>
                Done
              </button>
            )}
          </>
        )}
        {locationPick && <p className="hint">Click a highlighted location.</p>}
      </div>
    );
  }

  if (topFrame?.kind === "alarmResolution" && !respondingWith) {
    const responses = card && card.controller === humanPlayerId ? usableResponseAbilities(state, card, topFrame.triggeringCardId, topFrame.locationId, humanPlayerId) : [];
    return (
      <div className="activate-ability-box">
        {statusHeader}
        <h3>RESPOND</h3>
        <p className="hint">Respond, or pass.</p>
        <button type="button" className="flow-button" disabled={disabled} onClick={() => act({ type: "passResponse" })}>
          Pass
        </button>
        {card && card.controller === humanPlayerId ? (
          responses.length === 0 ? (
            <p className="hint">No Response ability available on this card.</p>
          ) : (
            responses.map((r) => (
              <button
                key={r.abilityIndex}
                type="button"
                className="ability-button"
                disabled={disabled}
                onClick={() => startResponse(card.id, r.abilityIndex)}
              >
                {r.text}
              </button>
            ))
          )
        ) : (
          <p className="hint">Select one of your own cards to respond, or pass.</p>
        )}
      </div>
    );
  }

  if (topFrame?.kind === "motorcadeInterceptionWindow") {
    const eligible =
      !!card &&
      card.controller === humanPlayerId &&
      card.zone === "inPlay" &&
      card.locationId === topFrame.presidentLocationId &&
      card.defRef !== null &&
      getPassive(card.defRef)?.kind === "motorcadeInterception";
    return (
      <div className="activate-ability-box">
        {statusHeader}
        <h3>INTERCEPT MOTORCADE</h3>
        <p className="hint">Intercept, or let it through.</p>
        <button type="button" className="flow-button" disabled={disabled} onClick={() => act({ type: "passIntercept" })}>
          Pass
        </button>
        {eligible ? (
          <button
            type="button"
            className="ability-button"
            disabled={disabled}
            onClick={() => act({ type: "interceptMotorcade", cardId: card!.id })}
          >
            Intercept — eliminate {card!.defRef}
          </button>
        ) : (
          <p className="hint">This card cannot intercept the Motorcade.</p>
        )}
      </div>
    );
  }

  // Default: nothing pending — show the currently-viewed card's abilities
  // (if any) alongside the turn-level Draw/End Turn controls.
  const activateGrant = state.turn.restrictedAction?.kind === "activate" ? state.turn.restrictedAction : null;
  const cardQualifiesForActivateGrant =
    !!card &&
    activateGrant !== null &&
    (activateGrant.amount === "unbounded" || activateGrant.amount > 0) &&
    (activateGrant.faction === null || knownFaction(cardData, card) === activateGrant.faction) &&
    (activateGrant.locationId === null || card.locationId === activateGrant.locationId);
  const canActivate =
    canTakeTurnAction && (state.turn.actionsRemaining > 0 || cardQualifiesForActivateGrant);
  const isOwnCard = !!card && card.controller === humanPlayerId && card.zone === "inPlay";
  const abilities = card && isOwnCard && canActivate ? usableActivateAbilities(state, card, state.turn.usedAbilities, humanPlayerId) : [];

  return (
    <div className="activate-ability-box">
      {statusHeader}
      <h3>ACTIVATE ABILITY</h3>
      {!card || card.defRef === null ? (
        <p className="hint">No abilities</p>
      ) : abilities.length === 0 ? (
        <p className="hint">No abilities{card.defRef === "President" ? " — Protected" : ""}</p>
      ) : (
        abilities.map((a) => (
          <button
            key={a.abilityIndex}
            type="button"
            className="ability-button"
            disabled={disabled}
            onClick={() => act({ type: "activateAbility", cardId: card.id, abilityIndex: a.abilityIndex })}
          >
            {a.text}
          </button>
        ))
      )}
      <button type="button" className="flow-button" disabled={disabled || !canDraw} onClick={() => act({ type: "draw" })}>
        Draw
      </button>
      <button type="button" className="flow-button" disabled={disabled || !canEndTurn} onClick={() => act({ type: "endTurn" })}>
        End Turn
      </button>
    </div>
  );
}
