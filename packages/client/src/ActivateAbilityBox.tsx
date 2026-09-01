import type { ReactNode } from "react";
import { cardData, getPassive, knownFaction } from "@rev-day/engine";
import type {
  Action,
  FilteredCardInstance,
  FilteredGameState,
  PlayerId,
  ResolutionFrame,
  RestrictedActionGrant,
} from "@rev-day/engine";
import { describeEntry } from "./gameText";
import { playerColorFor, playerLabel } from "./players";
import { usableActivateAbilities, usableResponseAbilities } from "./targetDecision";
import type { useTargetSelection } from "./useTargetSelection";
import type { LogEntry } from "./useGame";

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

// Whoever's decision this particular frame is waiting on — same shape as
// decider() (client/decider.ts), just per-frame instead of only the top
// of the stack, since the whole point of the breadcrumb is showing every
// level at once.
function frameActorId(frame: ResolutionFrame): PlayerId {
  return frame.kind === "abilityResolution" ? frame.actingPlayerId : frame.order[frame.nextIndex]!;
}

// One breadcrumb line per resolution-stack frame — "current action stack"
// in the Upper Right quadrant. Deliberately terse (this is a small
// sidebar, not the Game Log): names the card where one's involved, and
// who the *next* decision in that frame belongs to.
function describeFrame(
  state: FilteredGameState,
  frame: ResolutionFrame,
  humanPlayerId: PlayerId,
  botPlayerIds: readonly PlayerId[],
): string {
  const who = (id: PlayerId) => (id === humanPlayerId ? "You" : playerLabel(state, id, humanPlayerId, botPlayerIds));
  const cardName = (id: string) => state.cards.find((c) => c.id === id)?.defRef ?? "a card";
  switch (frame.kind) {
    case "abilityResolution":
      return `${who(frame.actingPlayerId)} resolving ${cardName(frame.sourceCardId)}'s ability`;
    case "alarmResolution":
      return `Alarm (${cardName(frame.triggeringCardId)}) — awaiting ${who(frame.order[frame.nextIndex]!)}`;
    case "protectedTargetingWindow":
      return `Protected reveal — awaiting ${who(frame.order[frame.nextIndex]!)}`;
    case "motorcadeInterceptionWindow":
      return `Motorcade — awaiting ${who(frame.order[frame.nextIndex]!)}`;
    case "reactivePassiveWindow":
      return `Reactive window (${cardName(frame.sourceCardId)}) — awaiting ${who(frame.order[frame.nextIndex]!)}`;
  }
}

interface ActivateAbilityBoxProps {
  readonly card: FilteredCardInstance | null;
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  // For the Upper Right quadrant's "most recent action" fallback once the
  // resolution stack is empty — see describeFrame's own comment for the
  // stack-non-empty case.
  readonly log: readonly LogEntry[];
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
  // "Check Opponent's Turns" — see useTurnPlayback's own comments. A
  // persistent setting, not tied to any particular pending decision, so
  // it (and the Continue button it reveals) renders in a fixed spot in
  // the Bottom Left quadrant regardless of which branch below is active.
  readonly checkOpponentTurns: boolean;
  readonly onCheckOpponentTurnsChange: (checked: boolean) => void;
  readonly awaitingContinue: boolean;
  readonly onContinue: () => void;
  // The current player, or whoever's responding/intercepting/reacting
  // mid-turn (App.tsx's own decider()/playbackActorId resolution) — the
  // whole box's base text color, matching the Game Log's own per-line
  // color-coding. The Upper Right breadcrumb overrides this per line,
  // since a nested frame can belong to a *different* player than the one
  // who opened it.
  readonly actionPlayerId: PlayerId;
}

// Four fixed quadrants (per the user's own spec): Upper Left is who's
// deciding and their remaining actions: Bottom Left is turn-level flow
// (Draw/End Turn, Check Opponent's Turns) — both always rendered
// regardless of what's pending, same as the old always-visible status
// header. Upper Right is the current action log (the resolution stack as
// a breadcrumb, or just the most recent logged action once it's empty).
// Bottom Right is whatever's actually clickable about the pending
// decision — ability/response/intercept buttons and their explanatory
// heading/hints.
export function ActivateAbilityBox({
  card,
  state,
  humanPlayerId,
  botPlayerIds,
  log,
  act,
  selection,
  isPlaying,
  playbackCaption,
  disabled,
  checkOpponentTurns,
  onCheckOpponentTurnsChange,
  awaitingContinue,
  onContinue,
  actionPlayerId,
}: ActivateAbilityBoxProps) {
  const { cardPick, locationPick, respondingWith, startResponse, viewCardsMode, setViewCardsMode, unsupportedAbility } = selection;
  const topFrame = state.resolutionStack[state.resolutionStack.length - 1] ?? null;
  const actionColor = playerColorFor(state, actionPlayerId);

  const canTakeTurnAction = state.resolutionStack.length === 0 && state.turn.phase === "action";
  const deckCount = state.cards.filter((c) => c.zone === "deck").length;
  const canDraw = canTakeTurnAction && state.turn.actionsRemaining > 0 && deckCount > 0;
  const canEndTurn = canTakeTurnAction;

  // Upper Left: always visible — actions-remaining context doesn't
  // disappear just because a pick/alarm/intercept window opened on top
  // of it.
  const upperLeft = (
    <div className="activate-ability-status">
      <p className="current-player-label">{playerLabel(state, actionPlayerId, humanPlayerId, botPlayerIds)}</p>
      <p className="actions-remaining-label">ACTIONS REMAINING</p>
      <p className="actions-remaining-count">{state.turn.actionsRemaining}</p>
      {state.turn.restrictedAction && (
        <p className="hint restricted-play-actions">{describeGrant(state.turn.restrictedAction)}</p>
      )}
    </div>
  );

  // Bottom Left: "Your Turn Options" — Draw/End Turn are always rendered
  // (disabled via the same canDraw/canEndTurn either way), not only in
  // the default no-pending-decision branch, so this quadrant's contents
  // never shift around; Check Opponent's Turns is the same
  // persistent-setting reasoning as before.
  const bottomLeft = (
    <>
      <button type="button" className="flow-button" disabled={disabled || !canDraw} onClick={() => act({ type: "draw" })}>
        Draw
      </button>
      <button type="button" className="flow-button" disabled={disabled || !canEndTurn} onClick={() => act({ type: "endTurn" })}>
        End Turn
      </button>
      <div className="check-opponent-turns">
        <label className="check-opponent-turns-label">
          <input
            type="checkbox"
            checked={checkOpponentTurns}
            onChange={(e) => onCheckOpponentTurnsChange(e.target.checked)}
          />
          Check Opponent's Turns
        </label>
        {checkOpponentTurns && (
          <button type="button" className="flow-button" disabled={!awaitingContinue} onClick={onContinue}>
            Continue
          </button>
        )}
      </div>
    </>
  );

  // Upper Right: the live resolution stack as a color-coded breadcrumb —
  // each line can belong to a *different* player than whoever opened the
  // outer frame (e.g. you activate an ability, an opponent's alarm
  // response is now what's actually pending), so each line sets its own
  // color rather than inheriting the box's own actionColor. Falls back to
  // just the single most recent logged action once the stack is empty.
  let upperRight: ReactNode;
  if (isPlaying) {
    upperRight = <p className="hint">{playbackCaption ?? "Watching the turn play out…"}</p>;
  } else if (state.resolutionStack.length > 0) {
    upperRight = (
      <ul className="action-log-stack">
        {state.resolutionStack.map((frame, i) => (
          <li key={i} style={{ color: playerColorFor(state, frameActorId(frame)) }}>
            {describeFrame(state, frame, humanPlayerId, botPlayerIds)}
          </li>
        ))}
      </ul>
    );
  } else {
    const lastEntry = log[log.length - 1];
    upperRight = lastEntry ? (
      <p className="hint" style={{ color: playerColorFor(lastEntry.resultingState, lastEntry.actingPlayerId) }}>
        {describeEntry(lastEntry, humanPlayerId, botPlayerIds)}
      </p>
    ) : (
      <p className="hint">No actions yet.</p>
    );
  }

  // Bottom Right: the pending decision's own heading/hints and every
  // card-specific button (ability/response/intercept/target-mode/Done) —
  // everything except the turn-level Draw/End Turn, which live in Bottom
  // Left instead.
  let bottomRight: ReactNode;

  if (isPlaying) {
    bottomRight = (
      <>
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">Watching the turn play out…</p>
      </>
    );
  } else if (unsupportedAbility) {
    bottomRight = (
      <>
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">This ability isn't supported by the client yet.</p>
      </>
    );
  } else if (cardPick || locationPick) {
    const selectedCount = cardPick?.selectedIds.length ?? 0;
    bottomRight = (
      <>
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
      </>
    );
  } else if (topFrame?.kind === "alarmResolution" && !respondingWith) {
    const responses = card && card.controller === humanPlayerId ? usableResponseAbilities(state, card, topFrame.triggeringCardId, topFrame.locationId, humanPlayerId) : [];
    bottomRight = (
      <>
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
      </>
    );
  } else if (topFrame?.kind === "motorcadeInterceptionWindow") {
    const eligible =
      !!card &&
      card.controller === humanPlayerId &&
      card.zone === "inPlay" &&
      card.locationId === topFrame.presidentLocationId &&
      card.defRef !== null &&
      getPassive(card.defRef)?.kind === "motorcadeInterception";
    bottomRight = (
      <>
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
      </>
    );
  } else {
    // Default: nothing pending — show the currently-viewed card's
    // abilities, if any.
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

    bottomRight = (
      <>
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
      </>
    );
  }

  return (
    <div className="activate-ability-box" style={{ color: actionColor }}>
      <div className="activate-ability-tl">{upperLeft}</div>
      <div className="activate-ability-bl">{bottomLeft}</div>
      <div className="activate-ability-tr">{upperRight}</div>
      <div className="activate-ability-br">{bottomRight}</div>
    </div>
  );
}
